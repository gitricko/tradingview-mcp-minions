import { z } from 'zod';
import { boolish } from './_validation.js';
import { jsonResult } from './_format.js';
import * as core from '../core/strategy.js';

export function registerStrategyTools(server) {
  server.tool(
    'strategy_set_deep_bt_range',
    'Set the Deep Backtesting date range in the Strategy Tester header via the calendar picker. Opens the date-range modal, fills both YYYY-MM-DD inputs via React-friendly setter, clicks the locale-appropriate submit button (Select / Sélectionner / Apply / OK), verifies the displayed range updated. Requires the Strategy Tester panel to be open and a strategy to be loaded on the chart.',
    {
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start date YYYY-MM-DD (e.g., "2024-01-01")'),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('End date YYYY-MM-DD (e.g., "2024-12-31")'),
    },
    async ({ from, to }) => {
      try { return jsonResult(await core.setDeepBacktestRange({ from, to })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'strategy_read_deep_stats',
    'Read the Strategy Tester panel\'s key stats, performance-analysis cards and trade count straight off the DOM panel — the only surface that carries Premium Deep Backtest results. While a DEEP range is selected, the internal _reportData still holds the STANDARD backtest, so data_get_strategy_results / data_get_trades / data_get_equity will show different numbers; this tool reports the mode it observed ("deep" or "standard") plus the date range so the two can never be mixed. Guards the brief "undefined" window while a deep run recomputes: if the key-stat cards are mid-refresh it reports recomputing:true instead of returning garbage. Requires the Strategy Tester panel to be open.',
    {
      wait: boolish.optional().describe('Poll until the panel holds real values (key-stat cards stop showing undefined) instead of returning a recomputing:true result (default false)'),
      wait_timeout_ms: z.coerce.number().optional().describe('Max time to poll when wait:true (default 45000)'),
    },
    async ({ wait, wait_timeout_ms }) => {
      try {
        return jsonResult(await core.readDeepStats({
          wait,
          wait_timeout_ms,
        }));
      }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'strategy_get_equity_summary',
    'Read the equity chart legend numbers (Cumulative P&L / Buy & hold / Margin calls) from the Strategy Tester panel. The equity CURVE is canvas-rendered and has no readable data surface, so this tool returns only the legend values, never a point series. Reports the mode (deep/standard) it observed. Requires the Strategy Tester panel to be open.',
    {},
    async () => {
      try { return jsonResult(await core.getEquitySummary()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'strategy_get_deep_trades',
    'Read the per-trade table on the Strategy Tester "List of trades" tab, scrolling and de-duplicating the virtualised rows (only ~12 of N rows are in the DOM at a time). Works in both deep and standard mode and reports which. The empty-table case returns trade_count: 0 with a note, not an error. max_trades caps how many rows are returned (default 500). Requires the Strategy Tester panel to be open.',
    {
      max_trades: z.coerce.number().optional().describe('Maximum trades to return (default 500, capped at 5000)'),
    },
    async ({ max_trades }) => {
      try { return jsonResult(await core.getDeepTrades({ max_trades })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
