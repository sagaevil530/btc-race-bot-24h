# btc-race-bot-24h

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/sagaevil530/btc-race-bot-24h/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/sagaevil530/btc-race-bot-24h/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A dip-bounce BTC trading bot for the make.fun 24-hour cbBTC race. It trades Coinbase Wrapped BTC against USDC on 1-minute on-chain bars, long only, starting from $1,000 of paper money.

## Strategy

Buy the dip inside an uptrend, then wait for the bounce to pay for itself:

- **Entry:** the 1-minute close dips at least 25 bps below its 30-bar moving average while EMA(12) sits above EMA(60). Full size, one position at a time.
- **Exit:** sell the whole position at +60 bps above the fill price, or at −150 bps below it. No trailing stop and no early exit — the winning bounces on the dev window spent hours underwater before recovering, and every early-exit rule tested turned winners into losers.
- **Why it works:** a full-size round trip costs ~35 bps in fees, slippage and pool impact, so a trade must catch a move bigger than that. Buying 25 bps under the mean and demanding 60 bps from the fill puts the exit ~35 bps above the mean: the bounce has to continue past the mean, not just revert to it.
- **Risk controls:** the EMA trend filter keeps the bot out of sustained downtrends; the 150 bps stop caps any single loss (tighter stops at 100–120 bps were whipsawed on the dev window). If no trade has filled by bar 1200, the trend filter is dropped for at most two half-size entries so the bot still meets the race's minimum-1-trade guardrail, and entries stop after bar 1380 so no fresh position is forced into the end-of-window flatten.

Local grade on the published dev window (1,440 1-minute bars): **+17.41 USDC net PnL, 4 round trips, 1.69% max drawdown** — against +1.07 for buy-and-hold and +2.45 for the kit's momentum baseline. The strategy family is broadly positive across neighbouring parameters (median +2.50 USDC over a 600-point sweep), not a knife-edge fit.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` (NDJSON on stdin/stdout) via the kit shim in `vendor/makefun-bars.ts`. Standard library only, no network, no wall clock, deterministic: two runs produce byte-identical action logs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=5gnbx9zn&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
