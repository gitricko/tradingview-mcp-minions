import { register } from '../router.js';
import * as core from '../../core/strategy.js';

register('strategy', {
  description: 'Strategy Tester deep-backtest surface (panel DOM reads + broker settings)',
  subcommands: new Map([
    ['deep-stats', {
      description: 'Read panel key stats / performance cards / trade count (deep OR standard — reports which mode it read)',
      options: {
        wait: { type: 'boolean', short: 'w', description: 'Poll until the panel holds real values instead of returning recomputing:true' },
      },
      handler: (opts) => core.readDeepStats({ wait: opts.wait }),
    }],
    ['deep-trades', {
      description: 'Read the List of trades table (virtualised scroll/collect; deep OR standard)',
      options: {
        max: { type: 'string', short: 'n', description: 'Max trades to return (default 500, capped at 5000)' },
      },
      handler: (opts) => core.getDeepTrades({ max_trades: opts.max ? Number(opts.max) : undefined }),
    }],
    ['equity-summary', {
      description: 'Read the equity-chart LEGEND numbers (cumulative P&L / buy & hold / margin calls) — not the curve',
      handler: () => core.getEquitySummary(),
    }],
    ['broker-settings', {
      description: 'Write broker settings (capital, order size, pyramiding, commission, leverage, slippage) with read-back',
      options: {
        'initial-capital': { type: 'string', description: 'Initial capital, e.g. "100000"' },
        'order-size': { type: 'string', description: 'Default order size (% of equity), e.g. "100"' },
        pyramiding: { type: 'string', description: 'Max positions that may be added, e.g. "1"' },
        commission: { type: 'string', description: 'Commission value (unit is a separate dropdown), e.g. "0"' },
        'long-leverage': { type: 'string', description: 'Long leverage in "Nx" form, e.g. "1x"' },
        'short-leverage': { type: 'string', description: 'Short leverage in "Nx" form, e.g. "1x"' },
        slippage: { type: 'string', description: 'Slippage in ticks, e.g. "0"' },
      },
      handler: (opts) => core.setBrokerSettings({
        initial_capital: opts['initial-capital'],
        order_size: opts['order-size'],
        pyramiding: opts.pyramiding,
        commission: opts.commission,
        long_leverage: opts['long-leverage'],
        short_leverage: opts['short-leverage'],
        slippage: opts.slippage,
      }),
    }],
    ['set-deep-bt-range', {
      description: 'Set Deep Backtesting date range (YYYY-MM-DD from to)',
      handler: (opts, positionals) => {
        const [from, to] = positionals;
        if (!from || !to) throw new Error('Usage: tv strategy set-deep-bt-range YYYY-MM-DD YYYY-MM-DD');
        return core.setDeepBacktestRange({ from, to });
      },
    }],
  ]),
});