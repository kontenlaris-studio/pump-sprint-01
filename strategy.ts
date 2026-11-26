// Dip-bounce scalper for the pump.fun sprint tape (agent-fun/replay/v2).
//
// What the dev tape taught us, the expensive way: chasing momentum gets
// run over, and anything that trades often pays the curve fee plus the
// 105k-lamport tx fee so many times that the drag eats the edge. So this
// bot is built around scarcity — it would rather miss a trade than take
// a mediocre one:
//
//   * A coin gets exactly one shot. One buy, ever: no averaging in, no
//     splitting an order across fills, no second bite after an exit.
//   * The only entry is a proven coin in a dip. Young (seen within its
//     first ~3000 slots), already holding 10-60 SOL of real reserves,
//     bought by at least 8 distinct wallets besides the creator, creator
//     still holding — and now trading 30-60% under its all-time high
//     while fresh buy flow in the last 75 slots beats sell flow and
//     totals at least 0.4 SOL. That is a crowd coming back to a
//     discounted coin, the one pattern that kept paying on this tape.
//   * Exits are rules, not opinions: +22% take-profit, -12% hard stop,
//     a trailing exit that arms at +12% and fires 10% off the peak,
//     a 500-slot time limit, and an immediate bail if the creator sells.
//
// Sizing: 0.15 SOL a shot (never more than the harness's own per-coin
// cap, never under 0.05 SOL where fees dominate), at most 4 positions
// open, and 0.5 SOL of cash always left untouched. All arithmetic is
// bigint; the bot is a pure function of hello + batches + fills, so
// repeated grading runs produce identical order streams.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

const ONE_SOL = LAMPORTS_PER_SOL;
const TEN_K = 10_000n;
// Prices are carried as quote-per-token scaled by this factor so every
// comparison below stays in exact integer math.
const PRICE_UNIT = 1_000_000_000n;

// ---- knobs ------------------------------------------------------------------

const knobs = {
  youngestAge: 15, // slots a coin must exist before it can be bought
  oldestAge: 3_000, // slots after which a dip is stale news
  floorReserves: 10n * ONE_SOL, // real SOL on the curve: proof of life
  ceilReserves: 60n * ONE_SOL, // beyond this the cheap multiple is gone
  fewestBuyers: 8, // distinct non-creator buyers required
  mostBuyers: 200, // an absurd crowd this fast means something is off
  dipShallowBps: 3_000n, // must sit at least 30% under the high
  dipDeepBps: 6_000n, // but no more than 60% under: that is a death spiral
  flowWindow: 75, // slots of tape that count as "right now"
  flowMinBuy: (ONE_SOL * 2n) / 5n, // 0.4 SOL of recent buying required
  stake: (ONE_SOL * 15n) / 100n, // 0.15 SOL per coin
  stakeFloor: ONE_SOL / 20n, // under 0.05 SOL the fees own the trade
  bookLimit: 4, // max simultaneous positions
  cashReserve: ONE_SOL / 2n, // 0.5 SOL never committed
  buySlipBps: 700,
  gainBps: 2_200n, // take profit at +22%
  lossBps: 1_200n, // hard stop at -12%
  trailArmBps: 1_200n, // trailing exit arms at +12%
  trailGiveBps: 1_000n, // ...and fires after giving back 10% from peak
  holdLimit: 500, // slots; after this the scalp thesis has expired
  sellSlipBps: 2_500,
  sweepEvery: 1_000, // slots between memory sweeps
  forgetAfter: 6_000, // slots after which an untouched coin is dropped
};

// Spot price implied by a pair of virtual reserves, scaled by
// PRICE_UNIT. An empty token side yields 0, which callers read as
// "no usable price".
function impliedPrice(vQuote: bigint, vToken: bigint): bigint {
  return vToken > 0n ? (vQuote * PRICE_UNIT) / vToken : 0n;
}

interface TapeTrade {
  slot: number;
  lamports: bigint;
  wasBuy: boolean;
}

// Everything remembered about one mint from the event stream.
interface Tape {
  creator: string;
  bornSlot: number;
  peakPrice: bigint;
  creatorGone: boolean;
  finished: boolean;
  boughtLamports: bigint;
  crowd: Set<string>;
  window: TapeTrade[];
}

interface OpenPosition {
  openedSlot: number;
  bestValue: bigint;
  exitQueued: boolean;
}

function blankTape(creator: string, slot: number, vQuote: bigint, vToken: bigint): Tape {
  return {
    creator,
    bornSlot: slot,
    peakPrice: impliedPrice(vQuote, vToken),
    creatorGone: false,
    finished: false,
    boughtLamports: 0n,
    crowd: new Set<string>(),
    window: [],
  };
}

export class DipBuyer {
  private tapes = new Map<string, Tape>();
  private open = new Map<string, OpenPosition>();
  private tried = new Set<string>();
  private awaiting = new Set<string>();
  private lastSweep = 0;

  hello(_state: BotState): void {
    // Nothing to calibrate: every parameter is fixed above, which is
    // what keeps the bot a pure function of the tape.
  }

  decide(state: BotState, batch: Batch): OrderInput[] {
    this.absorbFills(state, batch);
    this.absorbEvents(batch);

    const out: OrderInput[] = [];
    this.huntExits(state, batch, out);
    this.huntEntries(state, batch, out);

    if (batch.slot - this.lastSweep >= knobs.sweepEvery) {
      this.lastSweep = batch.slot;
      this.sweep(batch.slot);
    }
    return out;
  }

  // ---- absorbing what already happened --------------------------------------

  // Fills are the source of truth for what we hold: a filled buy opens
  // a position, a filled sell closes it, and harness housekeeping fills
  // (client ids starting with "_") flatten whatever they name.
  private absorbFills(state: BotState, batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.client_id.startsWith('_')) {
        this.open.delete(fill.mint);
        continue;
      }
      if (fill.side === 'buy') {
        this.awaiting.delete(fill.mint);
        if (fill.status === 'filled' && !this.open.has(fill.mint)) {
          this.open.set(fill.mint, { openedSlot: batch.slot, bestValue: 0n, exitQueued: false });
        }
      } else {
        const pos = this.open.get(fill.mint);
        if (pos) pos.exitQueued = false;
        if (fill.status === 'filled') this.open.delete(fill.mint);
      }
    }
    // Any position the state no longer reports is gone; forget it too.
    for (const mint of this.open.keys()) {
      if (!state.positions.has(mint)) this.open.delete(mint);
    }
  }

  private absorbEvents(batch: Batch): void {
    for (const ev of batch.events) {
      // Completion notices carry no reserve snapshot, so they are
      // handled before any reserve math happens.
      if (ev.event === 'CompleteEvent') {
        const tape = this.tapes.get(ev.mint);
        if (tape) tape.finished = true;
        continue;
      }

      const vQuote = BigInt(ev.virtual_quote_reserves);
      const vToken = BigInt(ev.virtual_token_reserves);

      if (ev.event === 'CreateEvent') {
        if (!this.tapes.has(ev.mint)) {
          this.tapes.set(ev.mint, blankTape(ev.creator, ev.slot, vQuote, vToken));
        }
        continue;
      }
      // A trade. If it is the first sign of this mint, start its tape
      // from this very event.
      let tape = this.tapes.get(ev.mint);
      if (!tape) {
        tape = blankTape(ev.creator, ev.slot, vQuote, vToken);
        this.tapes.set(ev.mint, tape);
      }

      const priceNow = impliedPrice(vQuote, vToken);
      if (priceNow > tape.peakPrice) tape.peakPrice = priceNow;

      const lamports = BigInt(ev.sol_amount);
      if (ev.is_buy) {
        tape.boughtLamports += lamports;
        if (ev.user !== tape.creator) tape.crowd.add(ev.user);
      } else if (ev.user === tape.creator) {
        tape.creatorGone = true;
      }

      tape.window.push({ slot: ev.slot, lamports, wasBuy: ev.is_buy });
      while (tape.window.length > 0 && ev.slot - tape.window[0].slot > knobs.flowWindow) {
        tape.window.shift();
      }
    }
  }

  // ---- exits ------------------------------------------------------------------

  // Current liquidation value of a holding, straight off the curve.
  private valueOf(state: BotState, mint: string): bigint {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (!pos || !curve || curve.virtual_token_reserves <= 0n) return 0n;
    return (pos.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
  }

  private huntExits(state: BotState, batch: Batch, out: OrderInput[]): void {
    for (const [mint, pos] of this.open) {
      const holding = state.positions.get(mint);
      if (!holding || pos.exitQueued) continue;

      const value = this.valueOf(state, mint);
      if (value > pos.bestValue) pos.bestValue = value;
      const cost = holding.cost_lamports;
      const tape = this.tapes.get(mint);

      const hitGain = value > 0n && value * TEN_K >= cost * (TEN_K + knobs.gainBps);
      const hitLoss = value > 0n && value * TEN_K <= cost * (TEN_K - knobs.lossBps);
      const hitTrail =
        pos.bestValue > 0n &&
        pos.bestValue * TEN_K >= cost * (TEN_K + knobs.trailArmBps) &&
        value * TEN_K <= pos.bestValue * (TEN_K - knobs.trailGiveBps);
      const tooOld = batch.slot - pos.openedSlot >= knobs.holdLimit;

      if ((tape !== undefined && tape.creatorGone) || hitGain || hitLoss || hitTrail || tooOld) {
        pos.exitQueued = true;
        out.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: knobs.sellSlipBps,
        });
      }
    }
  }

  // ---- entries ----------------------------------------------------------------

  // Sums the tape's recent window into buy-side and sell-side lamport
  // totals. Entries compare the two; nothing else reads the window.
  private flowTotals(tape: Tape): { buys: bigint; sells: bigint } {
    let buys = 0n;
    let sells = 0n;
    for (const t of tape.window) {
      if (t.wasBuy) buys += t.lamports;
      else sells += t.lamports;
    }
    return { buys, sells };
  }

  private huntEntries(state: BotState, batch: Batch, out: OrderInput[]): void {
    const cap = Math.min(knobs.bookLimit, state.hello.caps.max_open_positions);
    let committed = state.committedPositionCount();
    if (committed >= cap) return;

    for (const [mint, tape] of this.tapes) {
      if (committed >= cap) break;
      if (out.length >= state.hello.caps.max_orders_per_batch) break;

      // One shot per coin: never re-enter, never double up.
      if (this.open.has(mint) || this.awaiting.has(mint) || this.tried.has(mint)) continue;
      if (tape.finished || tape.creatorGone) continue;

      const age = batch.slot - tape.bornSlot;
      if (age < knobs.youngestAge || age > knobs.oldestAge) continue;

      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      if (curve.real_quote_reserves < knobs.floorReserves) continue;
      if (curve.real_quote_reserves > knobs.ceilReserves) continue;

      if (tape.crowd.size < knobs.fewestBuyers || tape.crowd.size > knobs.mostBuyers) continue;
      if (tape.boughtLamports <= 0n) continue;

      // The discount: under the peak, but not in free fall.
      const spot = impliedPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (spot <= 0n || tape.peakPrice <= 0n) continue;
      if (spot * TEN_K > tape.peakPrice * (TEN_K - knobs.dipShallowBps)) continue;
      if (spot * TEN_K < tape.peakPrice * (TEN_K - knobs.dipDeepBps)) continue;

      // The bounce: recent flow must lean buy-side and be big enough.
      const flow = this.flowTotals(tape);
      if (flow.buys < knobs.flowMinBuy || flow.buys <= flow.sells) continue;

      // Sizing: our stake, clipped by the harness cap, and only if the
      // cash buffer survives the trade.
      const ceiling = state.maxBuyLamports(mint);
      if (ceiling <= 0n) continue;
      const size = knobs.stake < ceiling ? knobs.stake : ceiling;
      if (size < knobs.stakeFloor) continue;
      if (state.freeCashLamports() - size < knobs.cashReserve) continue;

      this.tried.add(mint);
      this.awaiting.add(mint);
      committed += 1;
      out.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: knobs.buySlipBps });
    }
  }

  // ---- housekeeping -------------------------------------------------------------

  // Drop tapes for coins that are old, untouched and not ours, so the
  // maps stay proportional to the live part of the tape.
  private sweep(slot: number): void {
    for (const [mint, tape] of this.tapes) {
      if (this.open.has(mint) || this.awaiting.has(mint)) continue;
      if (slot - tape.bornSlot > knobs.forgetAfter) this.tapes.delete(mint);
    }
  }
}
