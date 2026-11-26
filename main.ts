// Pump.fun Bot Sprint — paper-trading bot (agent-fun/replay/v2).
//
// Wiring only: the strategy lives in strategy.ts. This file hands it to the
// vendored SDK shim's runBot loop, which owns the wire (one JSON line in, one
// reply per batch out).
//
// The bot is deterministic: its orders depend only on the hello, the batch
// events and the fills, never on the clock or Math.random, so the two grading
// executions produce byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { LateCurveRider } from './strategy.ts';

const strategy = new LateCurveRider();

// Hand the strategy's two callbacks to the SDK loop and let it drive: the
// shim reads batches from the wire, asks onBatch for orders, and writes the
// replies back. Nothing else is needed here.
await runBot({
  onHello(state) {
    strategy.onHello(state);
  },
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
});
