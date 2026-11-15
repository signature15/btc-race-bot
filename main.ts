
// Five-leg de-sequenced dip-reversion & capitulation swing bot for cbBTC (make.fun 24h race)
import { runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_RT = 15;
const NO_ENTRY_AFTER = 1410;
const MAX_SLIPPAGE_BPS = 100;
const RSI_PERIOD = 14;
const DEPTH_WINDOW = 240;
const DEPTH_MIN = 0.6;
const DEPTH_MAX = 1.0;

type LegKind = 'range' | 'flush' | 'scalp' | 'mid' | 'late';

interface ExitConfig {
  tp: number;
  trail: number;
  stop: number;
  hold: number;
  rsiExit: number | null;
  rsiMin: number;
}

const EXITS: Record<LegKind, ExitConfig> = {
  range: { tp: 0.010, trail: 0.010, stop: 0.015, hold: 100, rsiExit: null, rsiMin: 0.0 },
  flush: { tp: 0.045, trail: 0.015, stop: 0.020, hold: 400, rsiExit: 85.0, rsiMin: 0.010 },
  scalp: { tp: 0.012, trail: 0.010, stop: 0.015, hold: 150, rsiExit: 80.0, rsiMin: 0.010 },
  mid:   { tp: 0.004, trail: 0.010, stop: 0.015, hold: 150, rsiExit: null, rsiMin: 0.0 },
  late:  { tp: 0.015, trail: 0.010, stop: 0.010, hold: 40, rsiExit: null, rsiMin: 0.0 },
};

const closes: number[] = [];
const highs: number[] = [];
const lows: number[] = [];
const depths: number[] = [];

let roundTrips = 0;
let entryKind: LegKind | null = null;
let entryPrice: number | null = null;
let peakPrice: number | null = null;
let heldBars = 0;
let pendingKind: LegKind | null = null;

function rsi14(): number | null {
  if (closes.length < RSI_PERIOD + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - RSI_PERIOD; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (gains + losses === 0) return 50.0;
  return (100.0 * gains) / (gains + losses);
}

function depthFactor(): number {
  if (depths.length < DEPTH_WINDOW || depths[depths.length - 1]! <= 0) return 1.0;
  let sum = 0;
  for (let i = depths.length - DEPTH_WINDOW; i < depths.length; i++) {
    sum += depths[i]!;
  }
  const meanD = sum / DEPTH_WINDOW;
  const f = meanD / depths[depths.length - 1]!;
  if (f < DEPTH_MIN) return DEPTH_MIN;
  if (f > DEPTH_MAX) return DEPTH_MAX;
  return f;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const k = state.seq;
    const bar = batch.bars[0];
    if (bar !== undefined) {
      const ps = 10 ** (state.hello.symbols[0]?.price_scale ?? 5);
      closes.push(Number(bar.c) / ps);
      highs.push(Number(bar.h) / ps);
      lows.push(Number(bar.l) / ps);
      depths.push(Number(bar.c_depth[0] ?? 0n) / 1_000_000);
    }

    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = Number(fill.price);
        entryKind = pendingKind;
        peakPrice = entryPrice;
        heldBars = 0;
      } else if (fill.side === 'sell') {
        entryPrice = null;
        entryKind = null;
        peakPrice = null;
        heldBars = 0;
        roundTrips += 1;
      }
    }

    if (state.warmingUp || bar === undefined) return [];

    const pos = state.positions.get(SYMBOL);
    const holding = pos !== undefined && pos.qty > 0n;
    const closeRaw = Number(bar.c);
    const ps = 10 ** (state.hello.symbols[0]?.price_scale ?? 5);

    if (holding && entryKind !== null) {
      heldBars += 1;
      if (peakPrice === null || closeRaw > peakPrice) {
        peakPrice = closeRaw;
      }
      const entryUsd = (entryPrice ?? closeRaw) / ps;
      const peakUsd = (peakPrice ?? closeRaw) / ps;
      const curUsd = closes[closes.length - 1]!;
      const ex = EXITS[entryKind];

      let exit = false;
      if (curUsd >= entryUsd * (1.0 + ex.tp)) exit = true;
      else if (curUsd <= peakUsd * (1.0 - ex.trail)) exit = true;
      else if (curUsd <= entryUsd * (1.0 - ex.stop)) exit = true;
      else if (k >= 1438) exit = true;
      else {
        const r = rsi14();
        if (ex.rsiExit !== null && r !== null && r >= ex.rsiExit && curUsd >= entryUsd * (1.0 + ex.rsiMin)) {
          exit = true;
        } else if (heldBars >= ex.hold) {
          exit = true;
        }
      }

      if (exit) {
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } as SellInput];
      }
      return [];
    }

    if (roundTrips >= MAX_RT || k >= NO_ENTRY_AFTER || k < 20) return [];
    const r = rsi14();
    if (r === null) return [];

    const nMin = BigInt(state.hello.fees.min_notional_quote_units);

    const tryBuy = (kind: LegKind): OrderInput[] => {
      const factor = depthFactor();
      const n = BigInt(Math.floor(Number(state.cash) * factor));
      if (n >= nMin) {
        pendingKind = kind;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: n, max_slippage_bps: MAX_SLIPPAGE_BPS } as BuyInput];
      }
      return [];
    };

    const curClose = closes[closes.length - 1]!;

    // Leg R (range): shallow dip after a real decline, close near the low
    if (k >= 240) {
      let h120 = 0;
      let low120 = Infinity;
      for (let i = k - 119; i <= k; i++) {
        if (highs[i]! > h120) h120 = highs[i]!;
        if (lows[i]! < low120) low120 = lows[i]!;
      }
      let h240 = 0;
      for (let i = k - 239; i <= k; i++) {
        if (highs[i]! > h240) h240 = highs[i]!;
      }
      const dip120 = (h120 - curClose) / h120;
      const dip240 = (h240 - curClose) / h240;
      const ret120 = (curClose - closes[k - 120]!) / closes[k - 120]!;
      const ret60 = (curClose - closes[k - 60]!) / closes[k - 60]!;
      const nearLow = (curClose - low120) / low120 <= 0.005;
      const upBar = closes.length >= 2 && curClose > closes[closes.length - 2]!;

      if (dip120 >= 0.010 && dip120 <= 0.018 && dip240 >= 0.025 && r <= 40.0 && ret120 <= -0.010 && ret60 <= -0.005 && nearLow && upBar) {
        return tryBuy('range');
      }
    }

    // Leg A (trough): deep flush off a recent 240-bar high
    if (k >= 240) {
      let h240 = 0;
      for (let i = k - 239; i <= k; i++) {
        if (highs[i]! > h240) h240 = highs[i]!;
      }
      const dip240 = (h240 - curClose) / h240;
      if (dip240 >= 0.040 && r <= 25.0) {
        return tryBuy('flush');
      }
    }

    // Leg C (banded scalp): dip120 band + dip240 floor + cold RSI + up-bar
    if (k >= 120) {
      let h120 = 0;
      for (let i = k - 119; i <= k; i++) {
        if (highs[i]! > h120) h120 = highs[i]!;
      }
      let h240 = 0;
      for (let i = Math.max(0, k - 239); i <= k; i++) {
        if (highs[i]! > h240) h240 = highs[i]!;
      }
      const dip120 = (h120 - curClose) / h120;
      const dip240 = (h240 - curClose) / h240;
      const upBar = closes.length >= 2 && curClose > closes[closes.length - 2]!;
      if (dip120 >= 0.022 && dip120 <= 0.025 && dip240 >= 0.033 && r <= 28.0 && upBar) {
        return tryBuy('scalp');
      }
    }

    // Leg D (mid-dip): mid dip240 band + dip120 floor + cold RSI, no up-bar
    if (k >= 240) {
      let h240 = 0;
      for (let i = k - 239; i <= k; i++) {
        if (highs[i]! > h240) h240 = highs[i]!;
      }
      let h120 = 0;
      for (let i = k - 119; i <= k; i++) {
        if (highs[i]! > h120) h120 = highs[i]!;
      }
      const dip240 = (h240 - curClose) / h240;
      const dip120 = (h120 - curClose) / h120;
      if (dip240 >= 0.035 && dip240 < 0.040 && dip120 >= 0.025 && r <= 20.0) {
        return tryBuy('mid');
      }
    }

    // Leg E (late-session oversold recovery): bar 1402-1405
    if (k >= 1402 && k <= 1405) {
      let h60 = 0;
      for (let i = k - 59; i <= k; i++) {
        if (highs[i]! > h60) h60 = highs[i]!;
      }
      const dip60 = (h60 - curClose) / h60;
      if (dip60 >= 0.010 && r <= 35.0) {
        return tryBuy('late');
      }
    }

    return [];
  },
});
