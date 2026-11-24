// FirstLight — buy every pump.fun coin early, sell the spike, cut the deep fade.
//
// What the dev data actually shows: a coin bought soon after its curve starts attracting SOL
// spikes above its early price far more often than it fades first — and the spikes that persist
// past the harness's 2-slot fill lag are worth catching, while the fleeting ones are not. Dip-
// buying the fade loses, and holding with no take-profit cap loses worse (the fade eats the
// early gains). So:
//   - enter once, early, with a single 0.03 SOL buy as soon as the per-reply size cap allows
//     it (real reserves first reach ~3 SOL) and while the price is still near creation;
//   - sell the whole position at +50%, at -50%, or after 3600 slots (~24 min) held;
//   - never add to a position (topping up at higher prices measurably destroys the edge),
//     never re-enter a coin that was exited.
// One entry per coin, fast turnover: only 5 positions may be open at once and the guardrail
// needs round trips on at least 20 coins, so a position that never spikes is sold on time and
// the slot goes to the next new coin.
//
// Everything here is a pure function of the batches the harness sends: no clock, no randomness,
// no environment, no I/O. The two graded executions therefore produce byte-identical logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type Mark,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// ---- tunables (v2) ----
const BUY_SIZE = 30_000_000n; // 0.03 SOL, one buy per coin, no adds
const MIN_REAL_SOL = 3_000_000_000n; // enter once real reserves reach ~3 SOL
const MAX_REAL_SOL = 6_000_000_000n; // ...and not after they passed ~6 SOL (edge decays fast)
const TAKE_PROFIT = 0.5; // sell a spike that persists past the fill lag (best of 0.3/0.5/0.8/no-cap)
const STOP_LOSS = 0.5; // loose: cut only a deep fade
const MAX_HOLD_SLOTS = 3600; // ~24 min: free the slot for the next new coin
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 3000;
const MAX_ENTRIES_PER_BATCH = 3;
const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30
const BPS = 10_000n;

interface CoinBook {
  /** A buy was sent (or a position is/was held): never enter this coin again. */
  decided: boolean;
  entryPrice: number;
  entrySlot: number;
  /** A sell is in flight: do not send another. */
  exiting: boolean;
}

const books = new Map<Pubkey, CoinBook>();

function bookFor(mint: Pubkey): CoinBook {
  let b = books.get(mint);
  if (b === undefined) {
    b = { decided: false, entryPrice: 0, entrySlot: -1, exiting: false };
    books.set(mint, b);
  }
  return b;
}

/** Marginal price in SOL per token from virtual reserves. */
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

/**
 * What selling `tokens` would pay right now, curve fees deducted, against the given
 * reserves. Uses the constant-product quote and never credits more than the real reserves.
 */
function exitValue(virtualQuote: bigint, virtualToken: bigint, realQuote: bigint, tokens: bigint): bigint {
  if (tokens <= 0n || virtualToken + tokens === 0n) return 0n;
  let out = (tokens * virtualQuote) / (virtualToken + tokens);
  if (out > realQuote) out = realQuote;
  const fee = (out * CURVE_FEE_BPS + BPS - 1n) / BPS;
  return out - fee;
}

/** Per-reply buy cap with a small safety margin (our own flow shifts reserves slightly). */
function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const touched: Pubkey[] = [];

    // 1. Coins that traded this batch, in event order (deduped).
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      if (touched[touched.length - 1] !== e.mint) touched.push(e.mint);
    }

    // 2. Reconcile fills: a resolved sell frees the coin for good; a failed buy re-opens it.
    for (const f of batch.fills) {
      const b = books.get(f.mint);
      if (b === undefined) continue;
      if (f.side === 'sell') {
        b.exiting = false;
        if (!state.positions.has(f.mint)) {
          b.entrySlot = -1;
        }
      } else if (f.status !== 'filled' && !state.positions.has(f.mint)) {
        let stillOut = false;
        for (const o of state.pending.values()) {
          if (o.order.mint === f.mint && o.order.side === 'buy') stillOut = true;
        }
        if (!stillOut) {
          // The opening buy never landed: the coin may be entered again while in window.
          b.decided = false;
          b.entrySlot = -1;
        }
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, Mark>();
    for (const m of batch.marks) marks.set(m.mint, m);
    const busy = new Set<Pubkey>();
    for (const o of state.pending.values()) busy.add(o.order.mint);

    // 3. Exits on held positions, mints in sorted order (deterministic).
    const held = [...state.positions.keys()].sort();
    for (const mint of held) {
      if (orders.length >= cap) break;
      const h = state.positions.get(mint)!;
      const b = bookFor(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete || b.exiting) continue;
      const mark = marks.get(mint);
      const vq = mark !== undefined ? BigInt(mark.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mark !== undefined ? BigInt(mark.virtual_token_reserves) : curve.virtual_token_reserves;
      const rq = mark !== undefined ? BigInt(mark.real_quote_reserves) : curve.real_quote_reserves;
      const value = exitValue(vq, vt, rq, h.token_amount);
      const cost = h.cost_lamports;
      const gain = cost > 0n ? Number(value - cost) / Number(cost) : 0;
      const sinceEntry = b.entrySlot < 0 ? 0 : slot - b.entrySlot;
      const takeProfit = gain >= TAKE_PROFIT;
      const stopLoss = gain <= -STOP_LOSS;
      const stale = b.entrySlot >= 0 && sinceEntry >= MAX_HOLD_SLOTS;
      if (!takeProfit && !stopLoss && !stale) continue;
      if (busy.has(mint)) continue;
      orders.push({
        side: 'sell',
        mint,
        token_amount: h.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      b.exiting = true;
    }

    // 4. New entries: one early buy per coin, only inside the real-reserve window.
    let entries = 0;
    let open = state.committedPositionCount();
    for (const mint of touched) {
      if (orders.length >= cap || entries >= MAX_ENTRIES_PER_BATCH) break;
      if (open >= state.hello.caps.max_open_positions) break;
      if (state.positions.has(mint) || busy.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const b = bookFor(mint);
      if (b.decided) continue;
      const real = curve.real_quote_reserves;
      if (real < MIN_REAL_SOL) continue;
      if (real > MAX_REAL_SOL) {
        // Too late for this coin: the early-entry edge is gone. Never reconsider it.
        b.decided = true;
        continue;
      }
      if (curve.trades < 2) continue;
      const sizeCap = buyCap(state, mint);
      if (sizeCap < BUY_SIZE) continue;
      if (state.freeCashLamports() - BUY_SIZE - tx < 0n) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BUY_SIZE, max_slippage_bps: BUY_SLIPPAGE_BPS });
      b.decided = true;
      b.entryPrice = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      b.entrySlot = slot;
      b.exiting = false;
      busy.add(mint);
      entries++;
      open++;
    }
    return orders;
  },
});
