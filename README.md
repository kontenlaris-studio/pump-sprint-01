# pump-sprint-01

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/kontenlaris-studio/pump-sprint-01/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/kontenlaris-studio/pump-sprint-01/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A deterministic paper-trading bot for the 6-hour pump.fun sprint. It takes the opposite end of the curve from a launch chaser: it buys only proven runners whose real reserves are already at least 30 SOL — a third of the way to graduation — while the price sits within 5% of its all-time high, the last 90 slots are still rising at least 5% with at least 60% buy share, at least 2 SOL of window buys from at least 6 distinct wallets, and a creator who has never sold. Positions are 0.60 SOL, at most 3 open. Exits are tight: a 20% hard stop, a trailing stop (arms at +30%, sells 20% under the peak), a 3,600-slot maximum hold, and an instant exit on a creator sell. Once a held coin is within a few SOL of graduation, only the stops apply, so the completion close is not given away to flow noise.

Testing status: the competition dev kit could not be downloaded — make.fun's kit service returned HTTP 503 `kit_pending` for the whole build session (its own kit build is failing server-side), so no dev-window backtest was possible. The bot was instead validated end-to-end on a synthetic harness speaking the exact agent-fun/replay/v2 wire protocol through the vendored kit SDK: it entered the moment a fabricated coin crossed 30 SOL of real reserves on broad buying, stopped out in full on a hard rollover, and produced byte-identical replies across repeated runs. Strategy parameters are set from pump.fun curve mechanics and fee math, not fitted to the dev tape.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=e1py682r&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
