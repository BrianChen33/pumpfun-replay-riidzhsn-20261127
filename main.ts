// Early-Runner Momentum v3 — a pump.fun paper-trading bot for make.fun's
// "Pump.fun Bot Sprint: Make Bot And Win" (pumpfun-replay/v2).
//
// Written from scratch in this session by Muse, guided by GPT-6.2 design
// advice (no ChatGPT-written code is used) and by offline analysis of the
// kit's dev dataset. The dataset says: coins spike fast and then fade —
// the forward maximum return is strongly positive for coins up 25-120%
// within ~10-50 s of their first trade, on large net inflows with many
// distinct buyers — while forward close returns are negative almost
// everywhere. So this bot buys the move early (not at the top: no
// near-high requirement) and harvests the spike with a trailing stop.
// Losers are cut at -12% after giving the spike room; winners ride with a
// value-based trailing stop (12% giveback of peak value). A qualification-aware
// mode loosens entry only enough to bank the 20 distinct-mint round trips the
// guardrails require. V8 fixes from the one-time GPT review: creator-excluded
// buyers, creator-sell and top-buyer concentration filters, cumulative life
// stats (no 400-trade truncation), slot-window anti-chase, recent-flow
// confirmation, prune-safe mint identity, earlier qualification pacing with
// preserved strong/normal sizing, peak-based no-progress, and bought-amount
// verified qualification counting (official rule counts ANY close — sell,
// complete, flatten, write-off — with bought >= 0.01 SOL).
//
// Determinism: every decision comes from replay slots, reserves and fills
// only. No clock, no randomness, no environment. Candidate order is fully
// sorted, so two runs produce byte-identical action logs.

import { runBot, LAMPORTS_PER_SOL, type BotState, type Batch, type OrderInput } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ config

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n
const BPS = 10_000n;

// Sizing (lamports of SOL to spend per buy, fees included).
const BASE_SIZE = 100_000_000n; // 0.10 SOL standard
const STRONG_SIZE = 150_000_000n; // 0.15 SOL strongest runners
const QUAL_SIZE = 40_000_000n; // 0.04 SOL qualification-mode
const MIN_BUY = 20_000_000n; // 0.02 SOL: 2x safety margin over the 0.01 SOL round-trip floor
const MAX_EXPOSURE_COST = 900_000_000n; // 0.90 SOL total cost across positions
const MAX_POSITIONS = 3; // concurrent open positions (harness hard cap is 5)
const RESERVE_CAP_BPS = 70n; // buy at most 70 bps of a mint's real SOL reserve

// Entry: early runner (primary). Age measured in slots from first trade
// (~2.5 slots per second). Buy the move while it is still developing:
// up 25-120% in the first ~10-50 s, on large net inflows with many
// distinct buyers. No near-high requirement — buying the top is what
// killed the stricter variant.
const ER_AGE_MIN = 25;
const ER_AGE_MAX = 120;
const ER_RUNUP_MIN = 1.25;
const ER_RUNUP_MAX = 2.2;
const ER_MIN_NETIN_SOL = 2.5; // net SOL inflow since first trade
const ER_MIN_BUYERS = 10; // distinct non-creator buyers since first trade
const ER_MIN_BUY_SHARE = 0.6; // buy share of SOL volume since first trade
const ER_MIN_TRADES = 15;
const ER_MIN_RESERVE_SOL = 8;
const ER_MIN_SCORE = 50; // gates alone score ~36; 50 demands real strength, not perfection
// Strong runner: bigger size.
const ER_STRONG_RUNUP = 1.8;
const ER_STRONG_NETIN_SOL = 5.0;
const ER_STRONG_BUYERS = 20;

// Shared entry gates.
const MAX_LAST3_SPIKE = 0.15; // reject a vertical spike in the last 3 slots

// Exits (returns measured on net liquidation proceeds vs cost incl. fees).
const HARD_SL = -0.12;
const FAIL_SL = -0.06; // with deteriorating flow
const TRAIL_ACTIVATE = 0.15;
const TRAIL_GIVEBACK = 0.1; // sell when value falls 10% below its peak value
const NO_PROGRESS_SLOTS = 600; // ~240 s without ever reaching +5% peak
const MAX_HOLD_SLOTS = 1200; // ~480 s; early runners fade fast
const EXTENDED_HOLD_SLOTS = 2400; // for strong winners with positive flow
const EXTEND_MIN_PEAK = 1.0;
const FLOW_COLLAPSE_SOL = -0.3; // net outflow over trailing 75 slots

// Qualification pacing (final window is 6 h ~= 54_000 slots at ~2.5 slots/s).
const QUAL_TARGET = 24;
const QUAL_WINDOW_SLOTS = 54_000;
const QUAL_DEFICIT_TRIGGER = 1; // start chasing as soon as we fall 1 behind pace
const QUAL_MODE_MIN_SLOTS = 2_700; // start pacing after ~18 min
const QUAL_RELAX_RUNUP = 1.15;
const QUAL_RELAX_AGE_MAX = 600;
const QUAL_RELAX_RESERVE_SOL = 5;
const QUAL_RELAX_NETIN_SOL = 1.0;
const QUAL_RELAX_BUYERS = 6;
const QUAL_RELAX_SCORE = 35;

// Entry quality filters (from the review).
const RECENT_FLOW_MIN_SOL = 0.3; // net inflow over trailing 75 slots (normal mode)
const RECENT_FLOW_MIN_SOL_QUAL = 0.1; // same, qualification mode
const CREATOR_SELL_MAX_SOL = 0.5; // reject if creator sold >= this over trailing 150 slots
const TOP_BUYER_MAX_SHARE = 0.65; // reject if one buyer dominates buys this much
const EXTOP_NET_MIN_SOL = 0.5; // net inflow excluding the top buyer, trailing 150 slots

const BUY_SLIPPAGE_BPS = 500; // early runners move fast; 3% rejected too many fills
const SELL_SLIPPAGE_BPS = 10000; // exits must execute even in a crash
const TX_FEE = 105_000n; // base + priority fee per order
const FEE_BPS = 95n + 30n; // protocol + creator, conservative estimate

// ------------------------------------------------------------------ helpers

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Net SOL a seller receives for t tokens at the curve's current reserves. */
function sellProceeds(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  const fee = ceilDiv(q * FEE_BPS, BPS);
  const net = q - fee - TX_FEE;
  return net > 0n ? net : 0n;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

// ------------------------------------------------------------------ per-mint flow tracking

interface TradePoint {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: string;
  price: number;
}

interface MintTrack {
  mint: string;
  creator: string;
  createdSlot: number;
  firstTradeSlot: number;
  firstPrice: number;
  high: number;
  highSlot: number;
  lastPrice: number;
  lastSlot: number;
  complete: boolean;
  trades: TradePoint[]; // recent trades, oldest first, pruned to a window
  // Cumulative life totals — never pruned, so life stats stay consistent
  // even when the recent-trades window is truncated.
  cumBuyVol: bigint;
  cumSellVol: bigint;
  cumBuyers: Set<string>;
  cumCreatorSellVol: bigint;
  cumTrades: number;
}

interface PositionAux {
  entrySlot: number;
  peakRet: number;
  boughtLamports: bigint; // cost when first seen; qualifies only if >= 2x the floor
}

const tracks = new Map<string, MintTrack>();
const aux = new Map<string, PositionAux>();
const qualified = new Set<string>(); // distinct mints with a closed round trip
const traded = new Set<string>(); // mints ever bought (no re-entry)
const activeMints = new Set<string>(); // mints with a trade in the last few slots
const diagEntries = { early: 0, late: 0, qual: 0 };
const diagExits = new Map<string, number>();
let startSlot = -1;
let batchesSeen = 0;

function trackFor(mint: string, slot: number): MintTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      mint,
      creator: '',
      createdSlot: slot,
      firstTradeSlot: -1,
      firstPrice: 0,
      high: 0,
      highSlot: slot,
      lastPrice: 0,
      lastSlot: slot,
      complete: false,
      trades: [],
      cumBuyVol: 0n,
      cumSellVol: 0n,
      cumBuyers: new Set<string>(),
      cumCreatorSellVol: 0n,
      cumTrades: 0,
    };
    tracks.set(mint, t);
  }
  return t;
}

/** Flow stats over the trailing `windowSlots` ending at `nowSlot`. */
function flowStats(t: MintTrack, nowSlot: number, windowSlots: number) {
  const from = nowSlot - windowSlots;
  let buyVol = 0n;
  let sellVol = 0n;
  let buys = 0;
  const buyers = new Map<string, bigint>();
  let creatorSellVol = 0n;
  let priceAtStart = 0;
  let seenStart = false;
  for (const p of t.trades) {
    if (p.slot < from) {
      // Price at the window start = the latest trade before the window.
      priceAtStart = p.price;
      seenStart = true;
      continue;
    }
    if (p.buy) {
      buys++;
      buyVol += p.sol;
      if (t.creator === '' || p.user !== t.creator) buyers.set(p.user, (buyers.get(p.user) ?? 0n) + p.sol);
    } else {
      sellVol += p.sol;
      if (p.user === t.creator) creatorSellVol += p.sol;
    }
  }
  let topBuyerShare = 0;
  let topBuyerVol = 0n;
  for (const v of buyers.values()) if (v > topBuyerVol) topBuyerVol = v;
  if (buyVol > 0n) topBuyerShare = Number(topBuyerVol) / Number(buyVol);
  const gross = buyVol + sellVol;
  const buyShare = gross > 0n ? Number(buyVol) / Number(gross) : 0;
  return {
    buyVol,
    sellVol,
    net: buyVol - sellVol,
    buys,
    buyers: buyers.size,
    topBuyerShare,
    topBuyerVol,
    buyShare,
    creatorSellVol,
    priceAtStart: seenStart ? priceAtStart : t.firstPrice,
  };
}

/** Flow stats since the mint's first trade (whole life so far). */
function lifeStats(t: MintTrack) {
  // Cumulative totals (never truncated). Creator is excluded from the buyer
  // count when known; unknown creator (no CreateEvent seen) counts all.
  let buyers = t.cumBuyers.size;
  if (t.creator !== '' && t.cumBuyers.has(t.creator)) buyers -= 1;
  const gross = t.cumBuyVol + t.cumSellVol;
  return {
    buyVol: t.cumBuyVol,
    sellVol: t.cumSellVol,
    net: t.cumBuyVol - t.cumSellVol,
    buyers,
    buyShare: gross > 0n ? Number(t.cumBuyVol) / Number(gross) : 0,
    creatorSellVol: t.cumCreatorSellVol,
    trades: t.cumTrades,
  };
}

/** Price of the latest trade at or before `slot`, else 0 (no sample). */
function priceAtOrBefore(t: MintTrack, slot: number): number {
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const p = t.trades[i]!;
    if (p.slot <= slot) return p.price;
  }
  return 0;
}

function scoreRunner(runUp: number, netInSol: number, buyers: number, buyShare: number): number {
  const runScore = 40 * Math.min(1, Math.max(0, runUp - 1) / 2);
  const flowScore = 30 * Math.min(1, Math.max(0, netInSol) / 5);
  const breadthScore = 20 * Math.min(1, buyers / 20);
  const shareScore = 10 * buyShare;
  return runScore + flowScore + breadthScore + shareScore;
}

// The bot state is threaded through onBatch; this holder lets helpers read
// the latest curves without passing state through every call.
let latestState: BotState | null = null;
function currentCurve(mint: string) {
  return latestState?.curves.get(mint);
}

function pruneTracks(nowSlot: number) {
  // Never delete the track: a mint that reappears must keep its original
  // creation/first-trade identity, or an old mint could pass as a new one.
  // Only drop the recent-trades window; cumulative stats survive.
  for (const [mint, t] of tracks) {
    if (nowSlot - t.lastSlot > 3000 && !traded.has(mint) && !latestState?.positions.has(mint)) {
      t.trades = [];
    }
  }
}

// ------------------------------------------------------------------ entries

interface Candidate {
  mint: string;
  score: number;
  size: bigint;
  kind: 'early';
  qual: boolean;
}

function evaluateEntry(t: MintTrack, nowSlot: number, qualMode: boolean): Candidate | null {
  if (t.complete || t.firstTradeSlot < 0 || t.firstPrice <= 0) return null;
  if (traded.has(t.mint)) return null;
  // Stale-activity guard (checked here, not after candidate generation).
  if (nowSlot - t.lastSlot > 10) return null;
  const curve = currentCurve(t.mint);
  if (curve === undefined || curve.complete) return null;
  const realReserveSol = Number(curve.real_quote_reserves) / 1e9;
  const minReserve = qualMode ? QUAL_RELAX_RESERVE_SOL : ER_MIN_RESERVE_SOL;
  if (realReserveSol < minReserve) return null;
  const age = nowSlot - t.firstTradeSlot;
  const ageMax = qualMode ? QUAL_RELAX_AGE_MAX : ER_AGE_MAX;
  if (age < ER_AGE_MIN || age > ageMax) return null;
  const price = t.lastPrice;
  if (price <= 0) return null;

  // Anti-chase: reject a vertical spike over the last 3 slots, measured by
  // slot window (not by a fixed count of recent trades).
  const base3 = priceAtOrBefore(t, nowSlot - 3);
  if (base3 > 0 && price > base3 * (1 + MAX_LAST3_SPIKE)) return null;

  const runUp = price / t.firstPrice;
  const life = lifeStats(t);
  const netInSol = Number(life.net) / 1e9;
  const minRunUp = qualMode ? QUAL_RELAX_RUNUP : ER_RUNUP_MIN;
  const minNetIn = qualMode ? QUAL_RELAX_NETIN_SOL : ER_MIN_NETIN_SOL;
  const minBuyers = qualMode ? QUAL_RELAX_BUYERS : ER_MIN_BUYERS;
  const minScore = qualMode ? QUAL_RELAX_SCORE : ER_MIN_SCORE;
  const score = scoreRunner(runUp, netInSol, life.buyers, life.buyShare);
  if (
    runUp < minRunUp ||
    runUp > ER_RUNUP_MAX ||
    netInSol < minNetIn ||
    life.buyers < minBuyers ||
    life.buyShare < ER_MIN_BUY_SHARE ||
    life.trades < ER_MIN_TRADES ||
    score < minScore
  ) {
    return null;
  }

  // Current-flow confirmation: the move must still be alive, not just a
  // stale cumulative print from an earlier pump that is now fading.
  const f75 = flowStats(t, nowSlot, 75);
  const minRecentFlow = qualMode ? RECENT_FLOW_MIN_SOL_QUAL : RECENT_FLOW_MIN_SOL;
  if (Number(f75.net) / 1e9 < minRecentFlow) return null;

  // Concentration + creator-risk filters over the trailing 150 slots.
  const f150 = flowStats(t, nowSlot, 150);
  if (Number(f150.creatorSellVol) / 1e9 >= CREATOR_SELL_MAX_SOL) return null;
  if (f150.topBuyerShare > TOP_BUYER_MAX_SHARE) return null;
  const exTopNetSol = Number(f150.buyVol - f150.topBuyerVol - f150.sellVol) / 1e9;
  if (exTopNetSol < EXTOP_NET_MIN_SOL) return null;

  const strong =
    runUp >= ER_STRONG_RUNUP && netInSol >= ER_STRONG_NETIN_SOL && life.buyers >= ER_STRONG_BUYERS;
  // Qualification mode only shrinks size for candidates that pass ONLY via
  // the relaxed gates; normal/strong candidates keep their normal size.
  const normalPass =
    runUp >= ER_RUNUP_MIN &&
    netInSol >= ER_MIN_NETIN_SOL &&
    life.buyers >= ER_MIN_BUYERS &&
    score >= ER_MIN_SCORE;
  const size = strong ? STRONG_SIZE : qualMode && !normalPass ? QUAL_SIZE : BASE_SIZE;
  return { mint: t.mint, score, size, kind: 'early', qual: qualMode && !normalPass };
}

// ------------------------------------------------------------------ exits

function exitReason(mint: string, nowSlot: number): string | null {
  const state = latestState;
  if (state === null) return null;
  const pos = state.positions.get(mint);
  const curve = state.curves.get(mint);
  if (pos === undefined || curve === undefined || curve.complete) return null;
  const a = aux.get(mint);
  if (a === undefined) return null;
  const tokens = pos.token_amount;
  const proceeds = sellProceeds(tokens, curve.virtual_quote_reserves, curve.virtual_token_reserves);
  const cost = pos.cost_lamports;
  if (cost <= 0n) return null;
  const ret = Number(proceeds - cost) / Number(cost);
  if (ret > a.peakRet) a.peakRet = ret;

  if (ret <= HARD_SL) return 'hard-sl';
  const held = nowSlot - a.entrySlot;
  const t0 = tracks.get(mint);
  if (ret <= FAIL_SL) {
    if (t0 !== undefined && flowStats(t0, nowSlot, 75).net < 0n) return 'fail-sl';
  }
  // Value-based trailing: 10% giveback of peak VALUE (not 10 ret points),
  // so a +100% winner tolerates a ~10% pullback instead of ~5%.
  if (a.peakRet >= TRAIL_ACTIVATE && 1 + ret <= (1 + a.peakRet) * (1 - TRAIL_GIVEBACK)) return 'trailing';
  // No-progress = never reached +5% peak within the window (peak-based, so a
  // coin that spiked to +14% and faded to +4% is NOT called no-progress —
  // the trailing stop owns that case).
  if (held >= NO_PROGRESS_SLOTS && a.peakRet < 0.05) return 'no-progress';
  const t = tracks.get(mint);
  const flowOk = t !== undefined && flowStats(t, nowSlot, 75).net > 0n;
  if (held >= MAX_HOLD_SLOTS) {
    if (a.peakRet >= EXTEND_MIN_PEAK && flowOk && held < EXTENDED_HOLD_SLOTS) return null;
    return 'max-hold';
  }
  if (t !== undefined) {
    const f75 = flowStats(t, nowSlot, 75);
    const flowSol = Number(f75.net) / 1e9;
    // Severe outflow exits at any profit level; mild outflow only when flat.
    if (flowSol <= -1.5) return 'flow-collapse';
    if (flowSol <= FLOW_COLLAPSE_SOL && ret < 0.05) return 'flow-collapse';
  }
  return null;
}

// ------------------------------------------------------------------ main loop

await runBot({
  onHello(_state) {
    // Nothing to precompute; the first batch sets the start slot.
  },

  onBatch(state, batch): OrderInput[] {
    latestState = state;
    batchesSeen++;
    const nowSlot = batch.slot;
    if (startSlot < 0) startSlot = nowSlot;

    // 1) Fold this batch's events into per-mint flow tracking.
    for (const e of batch.events) {
      const t = trackFor(e.mint, e.slot);
      activeMints.add(e.mint);
      if (e.event === 'CreateEvent') {
        t.creator = e.creator;
        t.createdSlot = e.slot;
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        t.high = p;
        t.lastPrice = p;
        t.lastSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (t.firstTradeSlot < 0) {
          t.firstTradeSlot = e.slot;
          t.firstPrice = p;
          t.high = p;
          t.highSlot = e.slot;
        } else if (p > t.high) {
          t.high = p;
          t.highSlot = e.slot;
        }
        t.lastPrice = p;
        t.lastSlot = e.slot;
        t.cumTrades++;
        if (e.is_buy) {
          t.cumBuyVol += BigInt(e.sol_amount);
          t.cumBuyers.add(e.user);
        } else {
          t.cumSellVol += BigInt(e.sol_amount);
          if (t.creator !== '' && e.user === t.creator) t.cumCreatorSellVol += BigInt(e.sol_amount);
        }
        t.trades.push({ slot: e.slot, buy: e.is_buy, sol: BigInt(e.sol_amount), user: e.user, price: p });
        // Keep only the trailing window we actually use (1500 slots).
        while (t.trades.length > 0 && nowSlot - t.trades[0]!.slot > 1500) t.trades.shift();
        if (t.trades.length > 400) t.trades.splice(0, t.trades.length - 400);
      } else if (e.event === 'CompleteEvent') {
        t.complete = true;
      }
      // No other event types exist in this SDK; unknown events are ignored. 
    }

    // 2) Reconcile positions with the harness account (fills, failures,
    //    harness closes). Never trust intended orders over fills.
    const live = new Set<string>();
    for (const [mint, pos] of state.positions) {
      live.add(mint);
      let a = aux.get(mint);
      if (a === undefined) {
        a = { entrySlot: nowSlot, peakRet: 0, boughtLamports: pos.cost_lamports };
        aux.set(mint, a);
      }
    }
    for (const mint of [...aux.keys()]) {
      if (!live.has(mint)) {
        // Position closed (sell fill, completion, flatten or write-off —
        // the official rule counts ANY close). Count it only if our buy was
        // >= 0.02 SOL, a 2x margin over the official 0.01 SOL floor, so the
        // internal pace is a conservative lower bound of the official count.
        const a = aux.get(mint)!;
        if (traded.has(mint) && a.boughtLamports >= MIN_BUY) qualified.add(mint);
        aux.delete(mint);
      }
    }
    // Record buys that filled (a position appearing means the buy filled).
    for (const mint of live) traded.add(mint);

    // 3) Exits first: manage what we hold before opening anything new.
    // Never send a second sell while one is still pending for the mint.
    const orders: OrderInput[] = [];
    const pendingSells = new Set<string>();
    const pendingBuys = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSells.add(p.order.mint);
      else pendingBuys.add(p.order.mint);
    }
    const exitMints = [...live].sort();
    for (const mint of exitMints) {
      if (pendingSells.has(mint)) continue;
      const reason = exitReason(mint, nowSlot);
      if (reason !== null) {
        diagExits.set(reason, (diagExits.get(reason) ?? 0) + 1);
        const pos = state.positions.get(mint)!;
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }

    // 3b) Drop stale activity BEFORE ranking candidates, so a mint with
    // no trade in the last 10 slots cannot win one last entry.
    for (const mint of [...activeMints]) {
      const t = tracks.get(mint);
      if (t === undefined || nowSlot - t.lastSlot > 10) activeMints.delete(mint);
    }

    // 4) Entries: rank active candidates, fill open slots.
    const elapsed = nowSlot - startSlot;
    const expectedQual = (QUAL_TARGET * elapsed) / QUAL_WINDOW_SLOTS;
    const qualMode =
      elapsed >= QUAL_MODE_MIN_SLOTS &&
      qualified.size < QUAL_TARGET &&
      qualified.size < expectedQual - QUAL_DEFICIT_TRIGGER;
    const openSlots = MAX_POSITIONS - state.committedPositionCount();
    if (openSlots > 0) {
      const candidates: Candidate[] = [];
      for (const mint of activeMints) {
        if (pendingBuys.has(mint)) continue;
        const t = tracks.get(mint);
        if (t === undefined) continue;
        const c = evaluateEntry(t, nowSlot, qualMode);
        if (c !== null) candidates.push(c);
      }
      // Deterministic order: score desc, mint asc on ties.
      candidates.sort((a, b) => b.score - a.score || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
      let cash = state.freeCashLamports();
      let spent = 0n;
      for (const c of candidates) {
        if (orders.length >= 16) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= MAX_POSITIONS) break;
        const curve = state.curves.get(c.mint);
        if (curve === undefined) continue;
        const reserveCap = (curve.real_quote_reserves * RESERVE_CAP_BPS) / BPS;
        let size = c.size < reserveCap ? c.size : reserveCap;
        if (size < MIN_BUY) continue;
        if (size > cash - spent - TX_FEE * 2n) size = cash - spent - TX_FEE * 2n;
        if (size < MIN_BUY) continue;
        const totalCost = [...state.positions.values()].reduce((s, p) => s + p.cost_lamports, 0n);
        if (totalCost + spent + size > MAX_EXPOSURE_COST) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
        if (c.qual) diagEntries.qual++;
        else diagEntries[c.kind]++;
        spent += size + TX_FEE;
      }
    }

    // 5) Housekeeping: prune idle tracks (identity-preserving).
    if (batchesSeen % 1000 === 0) pruneTracks(nowSlot);

    return orders;
  },

  onDone(state, _done) {
    // Final account already flattened by the harness; nothing to send.
    // Diagnostics only (stderr is not part of the action log). Positions
    // still open here were flattened by the harness after the last batch;
    // the official grader counts those closes too, so our qualified count
    // is a lower bound by at most the number of open positions.
    console.error(
      `[diag] entries early=${diagEntries.early} late=${diagEntries.late} qual=${diagEntries.qual} ` +
        `exits=${[...diagExits.entries()].map(([k, v]) => `${k}:${v}`).join(',')} ` +
        `qualified=${qualified.size} openAtEnd=${state.positions.size}`,
    );
  },
});
