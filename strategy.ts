// Selective launch scalper for the pump.fun sprint (agent-fun/replay/v2).
//
// Lessons from grading every approach on the dev tape: momentum riding loses
// heavily, mean reversion churns itself to death on fees, and even the kit's
// launch sniper bleeds ~0.47 SOL — almost all of it fee drag from hundreds of
// small fills. This bot therefore trades as little as possible while still
// clearing the guardrail bar (round trips of at least 0.01 SOL on at least 20
// coins, drawdown under 50%):
//
//   - One buy per coin, ever. No adds, no order splitting, no re-entries:
//     every extra fill pays the 105k-lamport tx fee plus curve fees again.
//   - Entries only on a real dip: a young coin that already proved it can
//     draw a crowd (broad buying, real reserves, creator not sold), whose
//     price has fallen 30-55% from its high, and where buyers are stepping
//     back in right now. Chasing run-ups graded just as badly as riding
//     them late; the bounce is the only repeatable move on this tape.
//   - Exits are fast and mechanical: take profit at +22%, hard stop at -12%,
//     a trailing stop once up 12%, a 500-slot maximum hold, and an instant
//     exit the moment the creator sells.
//
// Stake is 0.15 SOL: large enough that the ~2.5% round-trip curve fee is a
// small share of a winning trade, small enough that a full book of losers
// cannot threaten the drawdown cap. Everything is a pure function of the
// hello, the batches and the fills — integer math only, no clock, no
// randomness — so the two graded executions agree byte for byte.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
const BPS = 10_000n;

// ---- entry tuning -----------------------------------------------------------
const MIN_AGE = 15; // slots after create before a first buy may be decided
const MAX_AGE = 3_000; // dips can take a while: watch the first ~20 minutes
const MIN_REAL = 10n * SOL; // curve must hold real SOL: alive, not a ghost
const MAX_REAL = 60n * SOL; // past this the easy multiple is usually gone
const MIN_BUYERS = 8; // distinct non-creator buyers: broad demand
const MAX_BUYERS = 200; // more than this in minutes smells bundled
const MIN_DIP_BPS = 3_000n; // price at least 30% under its all-time high
const MAX_DIP_BPS = 6_000n; // but not 60% under: that is a collapse, not a dip
const MIN_RECENT_BUY = (SOL * 2n) / 5n; // at least 0.4 SOL of buys in the recent window
const RECENT_WINDOW = 75; // slots of flow that count as "recent"
const STAKE = (SOL * 15n) / 100n; // 0.15 SOL per coin, one shot
const MIN_STAKE = SOL / 20n; // under 0.05 SOL the fees eat the trade
const MAX_POSITIONS = 4;
const CASH_FLOOR = SOL / 2n; // keep a half-SOL buffer uncommitted
const BUY_SLIPPAGE_BPS = 700;

// ---- exit tuning ------------------------------------------------------------
const TAKE_PROFIT_BPS = 2_200n; // +22% over cost: a bounce is sold, not married
const HARD_STOP_BPS = 1_200n; // -12% under cost: the dip was a collapse after all
const TRAIL_ARM_BPS = 1_200n; // trailing arms at +12%
const TRAIL_DROP_BPS = 1_000n; // then sells 10% under the peak value
const MAX_HOLD_SLOTS = 500; // ~3.3 minutes: a scalp, not an investment
const SELL_SLIPPAGE_BPS = 2_500;

const PRICE_SCALE = 1_000_000_000n;

function priceOf(vQuote: bigint, vToken: bigint): bigint {
  if (vToken <= 0n) return 0n;
  return (vQuote * PRICE_SCALE) / vToken;
}

interface FlowTrade {
  slot: number;
  sol: bigint;
  buy: boolean;
  user: string;
}

interface Coin {
  creator: string;
  createdSlot: number;
  createPrice: bigint;
  athPrice: bigint;
  creatorSold: boolean;
  complete: boolean;
  buySol: bigint;
  sellSol: bigint;
  buyers: Set<string>;
  trades: number;
  recent: FlowTrade[];
}

interface Held {
  entrySlot: number;
  peakValue: bigint;
  sellPending: boolean;
}

export class LateCurveRider {
  private coins = new Map<string, Coin>();
  private held = new Map<string, Held>();
  private attempted = new Set<string>();
  private buyPending = new Set<string>();
  private lastPrune = 0;

  onHello(_state: BotState): void {
    // Fixed parameters only: the run stays a pure function of the batches.
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    this.foldFills(state, batch);
    this.foldEvents(batch);

    const orders: OrderInput[] = [];
    this.planExits(state, batch, orders);
    this.planEntries(state, batch, orders);

    if (batch.slot - this.lastPrune >= 1_000) {
      this.lastPrune = batch.slot;
      this.prune(batch.slot);
    }
    return orders;
  }

  // ---- bookkeeping ----------------------------------------------------------

  private foldFills(state: BotState, batch: Batch): void {
    for (const fill of batch.fills) {
      const mint = fill.mint;
      if (fill.client_id.startsWith('_')) {
        this.held.delete(mint); // harness close: completion, flatten, write-off
        continue;
      }
      if (fill.side === 'buy') {
        this.buyPending.delete(mint);
        if (fill.status === 'filled' && !this.held.has(mint)) {
          this.held.set(mint, { entrySlot: batch.slot, peakValue: 0n, sellPending: false });
        }
      } else {
        const h = this.held.get(mint);
        if (h) h.sellPending = false;
        if (fill.status === 'filled') this.held.delete(mint);
      }
    }
    for (const mint of [...this.held.keys()]) {
      if (!state.positions.has(mint)) this.held.delete(mint);
    }
  }

  private foldEvents(batch: Batch): void {
    for (const ev of batch.events) {
      if (ev.event === 'CreateEvent') {
        if (!this.coins.has(ev.mint)) {
          this.coins.set(ev.mint, {
            creator: ev.creator,
            createdSlot: ev.slot,
            createPrice: priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves)),
            athPrice: priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves)),
            creatorSold: false,
            complete: false,
            buySol: 0n,
            sellSol: 0n,
            buyers: new Set<string>(),
            trades: 0,
            recent: [],
          });
        }
        continue;
      }
      if (ev.event === 'CompleteEvent') {
        const c = this.coins.get(ev.mint);
        if (c) c.complete = true;
        continue;
      }
      let c = this.coins.get(ev.mint);
      if (!c) {
        c = {
          creator: ev.creator,
          createdSlot: ev.slot,
          createPrice: priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves)),
          athPrice: priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves)),
          creatorSold: false,
          complete: false,
          buySol: 0n,
          sellSol: 0n,
          buyers: new Set<string>(),
          trades: 0,
          recent: [],
        };
        this.coins.set(ev.mint, c);
      }
      const sol = BigInt(ev.sol_amount);
      c.trades += 1;
      const tradePrice = priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
      if (tradePrice > c.athPrice) c.athPrice = tradePrice;
      if (ev.is_buy) {
        c.buySol += sol;
        if (ev.user !== c.creator) c.buyers.add(ev.user);
      } else {
        c.sellSol += sol;
        if (ev.user === c.creator) c.creatorSold = true;
      }
      c.recent.push({ slot: ev.slot, sol, buy: ev.is_buy, user: ev.user });
      while (c.recent.length > 0 && ev.slot - c.recent[0].slot > RECENT_WINDOW) c.recent.shift();
    }
  }

  private positionValue(state: BotState, mint: string): bigint {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (!pos || !curve || curve.virtual_token_reserves <= 0n) return 0n;
    return (pos.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
  }

  // ---- exits ----------------------------------------------------------------

  private planExits(state: BotState, batch: Batch, orders: OrderInput[]): void {
    const slot = batch.slot;
    for (const [mint, h] of this.held) {
      const pos = state.positions.get(mint);
      if (!pos || h.sellPending) continue;
      const value = this.positionValue(state, mint);
      if (value > h.peakValue) h.peakValue = value;
      const cost = pos.cost_lamports;
      const c = this.coins.get(mint);

      let exit = false;
      if (c && c.creatorSold) exit = true;
      else if (value > 0n && value * BPS >= cost * (BPS + TAKE_PROFIT_BPS)) exit = true;
      else if (value > 0n && value * BPS <= cost * (BPS - HARD_STOP_BPS)) exit = true;
      else if (
        h.peakValue > 0n &&
        h.peakValue * BPS >= cost * (BPS + TRAIL_ARM_BPS) &&
        value * BPS <= h.peakValue * (BPS - TRAIL_DROP_BPS)
      ) {
        exit = true;
      } else if (slot - h.entrySlot >= MAX_HOLD_SLOTS) exit = true;

      if (exit) {
        h.sellPending = true;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }
  }

  // ---- entries --------------------------------------------------------------

  private planEntries(state: BotState, batch: Batch, orders: OrderInput[]): void {
    const slot = batch.slot;
    const maxPos = Math.min(MAX_POSITIONS, state.hello.caps.max_open_positions);
    let committed = state.committedPositionCount();
    if (committed >= maxPos) return;

    for (const [mint, c] of this.coins) {
      if (committed >= maxPos) break;
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (this.held.has(mint) || this.buyPending.has(mint) || this.attempted.has(mint)) continue;
      if (c.complete || c.creatorSold) continue;

      const age = slot - c.createdSlot;
      if (age < MIN_AGE || age > MAX_AGE) continue;

      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      if (curve.real_quote_reserves < MIN_REAL || curve.real_quote_reserves > MAX_REAL) continue;

      if (c.buyers.size < MIN_BUYERS || c.buyers.size > MAX_BUYERS) continue;
      if (c.buySol <= 0n) continue;

      // The dip: price well under the all-time high, but not in free fall.
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0n || c.athPrice <= 0n) continue;
      if (price * BPS > c.athPrice * (BPS - MIN_DIP_BPS)) continue;
      if (price * BPS < c.athPrice * (BPS - MAX_DIP_BPS)) continue;

      // Buyers must be stepping back in, outsizing the sellers right now.
      let recentBuy = 0n;
      let recentSell = 0n;
      for (const t of c.recent) {
        if (t.buy) recentBuy += t.sol;
        else recentSell += t.sol;
      }
      if (recentBuy < MIN_RECENT_BUY) continue;
      if (recentBuy <= recentSell) continue;

      let size = STAKE;
      const cap = state.maxBuyLamports(mint);
      if (cap <= 0n) continue;
      if (size > cap) size = cap;
      if (size < MIN_STAKE) continue;
      if (state.freeCashLamports() - size < CASH_FLOOR) continue;

      this.attempted.add(mint);
      this.buyPending.add(mint);
      committed += 1;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
    }
  }

  // ---- memory ---------------------------------------------------------------

  private prune(slot: number): void {
    for (const [mint, c] of this.coins) {
      if (this.held.has(mint) || this.buyPending.has(mint)) continue;
      if (slot - c.createdSlot > 6_000) this.coins.delete(mint);
    }
  }
}
