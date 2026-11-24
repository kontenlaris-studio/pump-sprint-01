// Late-curve strength rider for the pump.fun sprint (agent-fun/replay/v2).
//
// The sprint grades a short window, so this bot takes the opposite end of the
// curve from a launch chaser. Most pump.fun coins die with under 10 SOL of
// real reserves; the few that fill a third of the curve have already survived
// the sniper phase, the first dumps and the creator's patience test. This bot
// buys only those proven runners, and only while they are still strong:
//
//   - real reserves at or past RESERVE_FLOOR (a third of the way to
//     graduation), with the price at or near its all-time high;
//   - the last FLOW_WINDOW slots still rising, with buying broad (many
//     distinct wallets) and dominant;
//   - the creator has never sold.
//
// Positions are few and sized up, because a late-curve runner either
// graduates (the harness closes the position at completion, at the final
// curve) or rolls over quickly. Exits are therefore tight: a 20% hard stop,
// a trailing stop that arms early, a maximum hold, and an instant exit on a
// creator sell. One exception: once a held coin is within a few SOL of
// graduation, flow noise no longer sells it — only the hard stop and the
// trailing stop apply, so the completion close is not given away.
//
// Everything is a pure function of the hello, the batch events and the fills:
// integer (bigint) math only, no clock, no environment, no randomness, so the
// two graded executions produce byte-identical action logs.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// ---- entry tuning -----------------------------------------------------------
const RESERVE_FLOOR = 30n * SOL; // real SOL reserves: a proven runner
const NEAR_GRADUATION = 78n * SOL; // past this, hold for the completion close
const FLOW_WINDOW = 90; // slots of flow history behind every decision
const MIN_BUY_SHARE_BPS = 6_000; // buys are at least 60% of window flow
const MIN_WINDOW_BUY = 2n * SOL; // and at least 2 SOL of buys in absolute terms
const MIN_DISTINCT_BUYERS = 6;
const MIN_RISE_BPS = 500; // price up at least 5% across the window
const MAX_DIP_FROM_HIGH_BPS = 500; // within 5% of the all-time high
const SIZE = (SOL * 6n) / 10n; // 0.60 SOL per position
const MAX_POSITIONS = 3;
const CASH_BUFFER = SOL; // never commit the last SOL
const BUY_SLIPPAGE_BPS = 500;
const REENTRY_COOLDOWN = 900; // slots to sit out a mint after exiting it

// ---- exit tuning ------------------------------------------------------------
const HARD_STOP_BPS = 2_000; // value 20% under cost: sell everything
const TRAIL_ARM_BPS = 3_000; // trailing arms once value is 30% over cost
const TRAIL_DROP_BPS = 2_000; // then sell 20% under the peak value
const MAX_HOLD_SLOTS = 3_600; // ~24 minutes at 0.4 s slots
const SELL_SLIPPAGE_BPS = 800;

interface FlowTrade {
  slot: number;
  sol: bigint;
  buy: boolean;
  user: string;
  price: bigint;
}

interface MintWatch {
  creator: string;
  createdSlot: number;
  creatorSold: boolean;
  complete: boolean;
  lastSlot: number;
  lastPrice: bigint;
  athPrice: bigint; // all-time high price seen on this curve
  window: FlowTrade[];
}

interface Held {
  entrySlot: number;
  peakValue: bigint;
  sellPending: boolean;
}

const PRICE_SCALE = 1_000_000_000n;

function priceOf(vQuote: bigint, vToken: bigint): bigint {
  if (vToken <= 0n) return 0n;
  return (vQuote * PRICE_SCALE) / vToken;
}

export class LateCurveRider {
  private watch = new Map<string, MintWatch>();
  private held = new Map<string, Held>();
  private cooldownUntil = new Map<string, number>();
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
        if (fill.status === 'filled') {
          this.held.delete(mint);
          this.cooldownUntil.set(mint, batch.slot + REENTRY_COOLDOWN);
        }
      }
    }
    for (const mint of [...this.held.keys()]) {
      if (!state.positions.has(mint)) this.held.delete(mint);
    }
  }

  private foldEvents(batch: Batch): void {
    for (const ev of batch.events) {
      if (ev.event === 'CreateEvent') {
        if (!this.watch.has(ev.mint)) {
          const p = priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
          this.watch.set(ev.mint, {
            creator: ev.creator,
            createdSlot: ev.slot,
            creatorSold: false,
            complete: false,
            lastSlot: ev.slot,
            lastPrice: p,
            athPrice: p,
            window: [],
          });
        }
        continue;
      }
      if (ev.event === 'CompleteEvent') {
        const w = this.watch.get(ev.mint);
        if (w) w.complete = true;
        continue;
      }
      let w = this.watch.get(ev.mint);
      if (!w) {
        w = {
          creator: ev.creator,
          createdSlot: ev.slot,
          creatorSold: false,
          complete: false,
          lastSlot: ev.slot,
          lastPrice: 0n,
          athPrice: 0n,
          window: [],
        };
        this.watch.set(ev.mint, w);
      }
      w.lastSlot = ev.slot;
      w.lastPrice = priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
      if (w.lastPrice > w.athPrice) w.athPrice = w.lastPrice;
      if (ev.user === w.creator && !ev.is_buy) w.creatorSold = true;

      // Track the rolling window only once a curve is within reach of the
      // reserve floor; cheaper mints cost a price and a counter only.
      if (BigInt(ev.real_quote_reserves) >= RESERVE_FLOOR / 3n || this.held.has(ev.mint) || this.buyPending.has(ev.mint)) {
        w.window.push({ slot: ev.slot, sol: BigInt(ev.sol_amount), buy: ev.is_buy, user: ev.user, price: w.lastPrice });
        while (w.window.length > 0 && ev.slot - w.window[0].slot > FLOW_WINDOW) w.window.shift();
      }
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
      const w = this.watch.get(mint);
      const curve = state.curves.get(mint);
      const nearGraduation = curve !== undefined && curve.real_quote_reserves >= NEAR_GRADUATION;

      let exit = false;
      if (w && w.creatorSold) exit = true;
      else if (value > 0n && value * 10_000n <= cost * BigInt(10_000 - HARD_STOP_BPS)) exit = true;
      else if (
        h.peakValue > 0n &&
        h.peakValue * 10_000n >= cost * BigInt(10_000 + TRAIL_ARM_BPS) &&
        value * 10_000n <= h.peakValue * BigInt(10_000 - TRAIL_DROP_BPS)
      ) {
        exit = true;
      } else if (!nearGraduation && slot - h.entrySlot >= MAX_HOLD_SLOTS) exit = true;

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

    for (const [mint, w] of this.watch) {
      if (committed >= maxPos) break;
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (this.held.has(mint) || this.buyPending.has(mint)) continue;
      if (w.complete || w.creatorSold) continue;
      if ((this.cooldownUntil.get(mint) ?? -1) > slot) continue;

      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      if (curve.real_quote_reserves < RESERVE_FLOOR) continue;

      // Strength: at the highs and still rising, broadly bought.
      if (w.athPrice <= 0n || w.lastPrice <= 0n) continue;
      if (w.lastPrice * 10_000n < w.athPrice * BigInt(10_000 - MAX_DIP_FROM_HIGH_BPS)) continue;
      if (w.window.length === 0) continue;
      const startPrice = w.window[0].price;
      if (startPrice <= 0n) continue;
      if (w.lastPrice * 10_000n < startPrice * BigInt(10_000 + MIN_RISE_BPS)) continue;

      let buySol = 0n;
      let sellSol = 0n;
      const buyers = new Set<string>();
      for (const t of w.window) {
        if (t.buy) {
          buySol += t.sol;
          buyers.add(t.user);
        } else {
          sellSol += t.sol;
        }
      }
      const flow = buySol + sellSol;
      if (flow <= 0n) continue;
      if (buySol < MIN_WINDOW_BUY) continue;
      if (buySol * 10_000n < flow * BigInt(MIN_BUY_SHARE_BPS)) continue;
      if (buyers.size < MIN_DISTINCT_BUYERS) continue;

      let size = SIZE;
      const cap = state.maxBuyLamports(mint);
      if (cap <= 0n) continue;
      if (size > cap) size = cap;
      if (state.freeCashLamports() - size < CASH_BUFFER) continue;
      if (size < SOL / 10n) continue; // under 0.10 SOL the fees eat the trade

      this.buyPending.add(mint);
      committed += 1;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
    }
  }

  // ---- memory ---------------------------------------------------------------

  private prune(slot: number): void {
    for (const [mint, w] of this.watch) {
      if (this.held.has(mint) || this.buyPending.has(mint)) continue;
      if (slot - w.lastSlot > 3_000) this.watch.delete(mint);
    }
    for (const [mint, until] of this.cooldownUntil) {
      if (until <= slot) this.cooldownUntil.delete(mint);
    }
  }
}
