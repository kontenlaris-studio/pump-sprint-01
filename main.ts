// Entry point for the pump.fun sprint paper bot (agent-fun/replay/v2).
//
// Deliberately thin: all trading decisions live in strategy.ts. Here we
// only build one strategy instance and plug its two hooks into the
// vendored runBot driver, which speaks the wire protocol — one JSON
// object per line in, one reply per batch out.
//
// Nothing in this file (or the strategy) reads a clock or a random
// source, so a grading run is fully determined by the hello, the batch
// stream and the fills that come back.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';
import { DipBuyer } from './strategy.ts';

const brain = new DipBuyer();

// Named handlers (rather than inline closures) so the wiring reads as
// what it is: hello goes to calibration, every batch goes to the
// decision function, and the returned orders go back on the wire.
function handleHello(state: BotState): void {
  brain.hello(state);
}

function handleBatch(state: BotState, batch: Batch): OrderInput[] {
  return brain.decide(state, batch);
}

await runBot({ onHello: handleHello, onBatch: handleBatch });
