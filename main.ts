// cbBTC Dual-Engine Mean-Reversion Scalper & Capitulation Runner
// Strategy: cbBTC 1-minute Orca Whirlpool pool replay on Solana.
// Combines a 2.0% shallow dip scalp engine and a 2.2% capitulation deep dip runner.
// Optimized for strict risk-adjusted net PnL and zero execution rejects.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const LOOKBACK_BARS = 60;
const DEEP_DROP_BPS = 220;
const SCALP_DROP_BPS = 200;
const DEEP_TP_BPS = 370;
const SCALP_TP_BPS = 100;
const MAX_SLIPPAGE_BPS = 100;

interface PositionTracker {
  isDeep: boolean;
  entryPrice: bigint;
  highestPrice: bigint;
  entryBar: number;
}

const history: number[] = [];
let tracker: PositionTracker | null = null;

await runBars({
  onBatch(state: BarsState, batch) {
    const symbol = state.hello.symbols[0]?.symbol ?? 'CBBTC';
    const closePrice = state.close(symbol);
    if (closePrice === null) return [];

    const c = Number(closePrice);
    history.push(c);
    if (history.length > LOOKBACK_BARS + 1) {
      history.shift();
    }

    const { caps, fees } = state.hello;
    const held = state.positions.get(symbol);

    if (held !== undefined && held.qty > 0n) {
      if (!tracker) {
        tracker = {
          isDeep: true,
          entryPrice: closePrice,
          highestPrice: closePrice,
          entryBar: batch.seq,
        };
      }

      if (closePrice > tracker.highestPrice) {
        tracker.highestPrice = closePrice;
      }

      const barsHeld = batch.seq - tracker.entryBar;
      const gainBps = Number(((closePrice - tracker.entryPrice) * 10000n) / tracker.entryPrice);
      const dropFromHighBps = Number(((tracker.highestPrice - closePrice) * 10000n) / tracker.highestPrice);

      let shouldExit = false;

      if (tracker.isDeep) {
        if (gainBps >= DEEP_TP_BPS) {
          shouldExit = true;
        } else if (gainBps >= 250 && dropFromHighBps >= 80) {
          shouldExit = true;
        } else if (barsHeld >= 120 && gainBps >= 40) {
          shouldExit = true;
        } else if (gainBps <= -400) {
          shouldExit = true;
        }
      } else {
        if (gainBps >= SCALP_TP_BPS) {
          shouldExit = true;
        } else if (barsHeld >= 50 && gainBps >= 40) {
          shouldExit = true;
        } else if (gainBps <= -250) {
          shouldExit = true;
        }
      }

      if (shouldExit) {
        tracker = null;
        return [
          {
            side: 'sell',
            symbol,
            qty: held.qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          } as SellInput,
        ];
      }

      return [];
    }

    tracker = null;
    if (history.length < LOOKBACK_BARS) return [];

    const max60 = Math.max(...history.slice(0, -1));
    const dropBps = Math.round(((max60 - c) / max60) * 10000);

    let isDeepEntry = false;
    let shouldEnter = false;

    if (dropBps >= DEEP_DROP_BPS) {
      isDeepEntry = true;
      shouldEnter = true;
    } else if (dropBps >= SCALP_DROP_BPS) {
      isDeepEntry = false;
      shouldEnter = true;
    }

    if (shouldEnter && state.cash > BigInt(fees.min_notional_quote_units)) {
      tracker = {
        isDeep: isDeepEntry,
        entryPrice: closePrice,
        highestPrice: closePrice,
        entryBar: batch.seq,
      };

      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      let stake = state.cash;
      if (stake > byWeight) stake = byWeight;

      return [
        {
          side: 'buy',
          symbol,
          notional_quote_units: stake,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        } as BuyInput,
      ];
    }

    return [];
  },
});
