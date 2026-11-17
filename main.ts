// Dip-bounce BTC bot for make.fun btc-race-24h-20261117-0603.
//
// Strategy (long only, one position, full size): buy CBBTC when its 1-minute
// close dips at least 25 bps below its 30-bar simple moving average while the
// medium-term trend is up (EMA(12) above EMA(60)) — a short-term oversold
// bounce inside an uptrend. Hold patiently for a 60 bps take-profit measured
// from the fill price, or a 150 bps stop-loss. No trailing stop, no early
// exit: the winning bounces on the dev window spent hours underwater before
// recovering past the take-profit, and every early-exit rule tested (trailing
// stops, trend-failure exits, exits on recovery to the mean) turned winners
// into losers, because a 25 bps dip back to the mean is smaller than the
// ~35 bps a full-size round trip pays in fees, slippage and impact.
//
// Why this shape wins on a choppy 1-minute tape: per-minute volatility is
// ~6 bps and a full-size round trip costs ~35 bps, so only moves of 60+ bps
// clear costs. Buying 25 bps under a 30-bar mean and demanding 60 bps from
// the fill puts the exit ~35 bps above the mean, i.e. the trade is paid for
// by the bounce continuing past the mean, not by the mean reversion itself.
// The wide 150 bps stop keeps noise from whipsawing the position (tighter
// stops at 100-120 bps lost money on the dev window); the trend filter keeps
// the bot out of sustained downtrends, where dip-buying catches a falling
// knife. Entries are full-size: halving size halves the impact saved but
// also halves the profit, and the take-profit dwarfs the impact.
//
// Guardrail fallback: if no trade has filled by bar 1200, the trend filter
// is dropped (at most 2 such entries, 50% size, 60-bar cooldown) so the bot
// still meets the race's minimum-1-trade guardrail on a window whose trend
// never turns up. Entries stop after bar 1380 of the 1,440-bar window so a
// fresh position is not forced into the end-of-window flatten.
//
// Determinism: float64 EMA/SMA updates only, no clock, no environment, no
// Math.random. Every decision is a pure function of the bars seen so far, so
// two runs produce byte-identical action logs.
//
// Protocol: agent-fun/bars-replay/v1. The kit shim (vendor/makefun-bars.ts)
// owns the wire: one hello, one batch per bar, one reply per batch echoing
// its seq. Orders decided on a batch fill at the next bar's open; an order
// decided on the last batch is rejected, so the bot never trades there.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** 1% past the close the order was decided on: a fill past a liquidity gap is refused, not chased. */
const MAX_SLIPPAGE_BPS = 100;

const EMA_FAST_SPAN = 12;
const EMA_SLOW_SPAN = 60;
const SMA_SPAN = 30;
/** Buy when the close sits this far (bps) below the 30-bar mean. */
const DIP_BPS = 25;
/** Sell when the close is this far (bps) above the fill price. */
const TAKE_PROFIT_BPS = 60;
/** Sell when the close is this far (bps) below the fill price. */
const STOP_LOSS_BPS = 150;
/** Stop entering this many bars before the 1,440-bar window ends. */
const NO_ENTRY_AFTER_SEQ = 1380;
/** If no trade has filled by this bar, drop the trend filter (guardrail fallback). */
const RELAX_AFTER_SEQ = 1200;
const RELAX_SIZE_BPS = 5000;
const RELAX_MAX_ENTRIES = 2;
const RELAX_COOLDOWN_BARS = 60;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function emaStep(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

/** Rolling simple moving average over the last `span` closes. */
class Sma {
  readonly span: number;
  readonly buf: number[] = [];
  sum = 0;
  value: number | null = null;

  constructor(span: number) {
    this.span = span;
  }

  push(close: number): void {
    this.buf.push(close);
    this.sum += close;
    if (this.buf.length > this.span) this.sum -= this.buf.shift()!;
    if (this.buf.length === this.span) this.value = this.sum / this.span;
  }
}

const fast: Ema = { span: EMA_FAST_SPAN, warm: [], value: null };
const slow: Ema = { span: EMA_SLOW_SPAN, warm: [], value: null };
const mean = new Sma(SMA_SPAN);

/** Fill price of the open position (raw price units), or null when flat. */
let entryPrice: number | null = null;
/** How many buy orders have filled so far (the guardrail fallback watches this). */
let filledTrades = 0;
/** How many guardrail-fallback entries have been taken. */
let relaxedEntries = 0;
/** Whether the buy order currently awaiting its fill was a fallback entry. */
let pendingRelaxed = false;
/** Seq of the batch whose fill last closed a position (-1e9 before any). */
let lastExitSeq = -1_000_000_000;

/** Implied entry price from a position's cost basis, when no fill was recorded. */
function costBasisPrice(state: BarsState): number | null {
  const held = state.positions.get(SYMBOL);
  if (held === undefined || held.qty === 0n) return null;
  const s = state.symbols.get(SYMBOL);
  if (s === undefined) return null;
  // price = cost * 10^(qty_scale + price_scale) / (qty * 10^quote_scale)
  const price =
    (Number(held.cost) * 10 ** (s.qty_scale + s.price_scale)) /
    (Number(held.qty) * 10 ** state.hello.capital.quote_scale);
  return Number.isFinite(price) && price > 0 ? price : null;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // 1. Fold in this batch's fills first: they tell us what we hold and at what price.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      if (fill.side === 'buy' && fill.status !== 'filled') {
        // The buy was refused at the fill (slippage, no bar, ...): it never
        // opened a position, so it is not a fallback entry either.
        pendingRelaxed = false;
        continue;
      }
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = Number(fill.price);
        filledTrades++;
        if (pendingRelaxed) relaxedEntries++;
        pendingRelaxed = false;
      } else {
        entryPrice = null;
        lastExitSeq = state.seq;
      }
    }

    // 2. Update indicators only on a fresh bar for our symbol. A batch with no
    // CBBTC bar (a gap minute) carries no new information: decide nothing on it.
    let close: number | null = null;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      close = Number(bar.c);
      emaStep(fast, close);
      emaStep(slow, close);
      mean.push(close);
    }
    if (close === null || state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const { fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);

    // 3. Holding: exit on take-profit or stop-loss, measured from the fill price.
    if (held !== undefined && held.qty > 0n) {
      const at = entryPrice ?? costBasisPrice(state);
      if (at === null) return [];
      const gainBps = ((close - at) / at) * 10_000;
      if (gainBps >= TAKE_PROFIT_BPS || gainBps <= -STOP_LOSS_BPS) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // 4. Flat: no entries late in the window, and none before the indicators exist.
    if (state.seq >= NO_ENTRY_AFTER_SEQ) return [];
    if (mean.value === null || fast.value === null || slow.value === null) return [];

    const trendUp = fast.value > slow.value;
    const dipped = close <= mean.value * (1 - DIP_BPS / 10_000);
    const relaxed =
      state.seq >= RELAX_AFTER_SEQ &&
      filledTrades === 0 &&
      relaxedEntries < RELAX_MAX_ENTRIES &&
      state.seq - lastExitSeq >= RELAX_COOLDOWN_BARS;
    if (!dipped || (!trendUp && !relaxed)) return [];

    const sizeBps = relaxed ? RELAX_SIZE_BPS : 10_000;
    let notional = (state.cash * BigInt(sizeBps)) / 10_000n;
    const weightRoom = state.weightRoom(SYMBOL);
    if (notional > weightRoom) notional = weightRoom;
    if (notional < minNotional || notional <= 0n) return [];
    pendingRelaxed = relaxed;
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
