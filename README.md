# Pump.fun Bot Sprint — Early-Runner Momentum

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/BrianChen33/pumpfun-replay-riidzhsn-20261127/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/BrianChen33/pumpfun-replay-riidzhsn-20261127/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

An entry for the [make.fun](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) bounty
"Pump.fun Bot Sprint: Make Bot And Win". A TypeScript bot that trades
10 SOL of paper money on a pump.fun replay. Best net PnL wins.

## Strategy

Early-runner momentum — written from scratch for this competition
(hand-written by Muse in session; GPT-6.2 advised the design and reviewed
the code, no ChatGPT-written code is used). Offline analysis of the dev
dataset showed coins spike fast and then fade: the forward maximum return
is strongly positive for coins up 25–120% within ~10–50 s of their first
trade, on large net inflows with many distinct buyers, while forward
close returns are negative almost everywhere. So the bot buys the move
early and harvests the spike with a tight trailing stop:

- **Entry:** 25–120 slots after the first trade, price up 25–120% from
  the first trade, net inflow 2.5+ SOL since the first trade (cumulative
  life stats, never truncated), 10+ distinct non-creator buyers, buy
  share 60%+, 15+ trades, real reserve 8+ SOL; candidates ranked by a
  flow/momentum score. Extra filters: recent 75-slot net inflow must
  still be positive, no big creator sell in the last 150 slots, no
  single buyer dominating buys, and no vertical spike in the last
  3 slots. No near-high requirement — buying the top is what killed
  stricter variants.
- **Sizing:** 0.10 SOL standard, 0.15 SOL on strong runners; 0.04 SOL
  only for relaxed-gate candidates in qualification mode; capped at
  70 bps of real reserve; at most 3 open positions, 0.90 SOL total
  exposure; no re-entry on a traded mint.
- **Exits:** hard stop −12%, momentum-failure exit −6% with negative
  flow, value-based trailing stop (activates +15%, sell on a 10%
  giveback of peak value), no-progress exit after ~240 s without ever
  reaching +5% peak, max hold ~480 s (extended to ~960 s for strong
  winners with positive flow), exit on flow collapse (severe outflow
  exits at any profit level).
- **Qualification pacing:** targets 24 qualifying distinct-mint round
  trips on a 6 h schedule; loosens entry (age to 600 slots, reserve to
  5 SOL, smaller size) when 1+ behind schedule after ~18 min.
  Qualification is counted from actual closes with bought >= 0.02 SOL,
  matching the official rule (any close counts at >= 0.01 SOL).

## Local results (dev window, 24 h)

- Net PnL −0.367 SOL, 105 round trips / 105 distinct mints, win rate
  28.6%, max drawdown 4.4% — edge is thin on this window and the final
  runs on fresh 6 h data, so the design optimises for qualification
  safety plus a fat right tail (best single trade +0.082 SOL) rather
  than dev-window PnL alone. Determinism verified (double-run action
  logs identical). 2x-fee sensitivity: −0.589 SOL.

## Layout

- `main.ts` — the bot (single entrypoint, runs as `node main.ts`)
- `vendor/makefun-bot.ts` — the kit's replay/v2 bot shim (copied from the kit)
- `.makefun/owner.json` — claim file naming the entry wallet
