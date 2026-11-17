import { register } from '../router.js';
import * as core from '../../core/chart.js';
import * as healthCore from '../../core/health.js';

register('state', {
  description: 'Get current chart state (symbol, TF, studies)',
  handler: () => core.getState(),
});

register('symbol', {
  description: 'Get or set the chart symbol',
  handler: async (opts, positionals) => {
    const sym = positionals[0];
    if (sym) return core.setSymbol({ symbol: sym });
    const state = await core.getState();
    return { success: true, symbol: state.symbol, resolution: state.resolution };
  },
});

register('timeframe', {
  description: 'Get or set the chart timeframe',
  handler: async (opts, positionals) => {
    const tf = positionals[0];
    if (tf) return core.setTimeframe({ timeframe: tf });
    const state = await core.getState();
    return { success: true, resolution: state.resolution, symbol: state.symbol };
  },
});

register('type', {
  description: 'Get or set the chart type (Candles, Line, etc.)',
  handler: async (opts, positionals) => {
    const ct = positionals[0];
    if (ct) return core.setType({ chart_type: ct });
    const state = await core.getState();
    const typeNames = ['Bars', 'Candles', 'Line', 'Area', 'Renko', 'Kagi', 'PointAndFigure', 'LineBreak', 'HeikinAshi', 'HollowCandles'];
    return { success: true, chart_type: typeNames[state.chartType] || state.chartType, type_num: state.chartType };
  },
});

register('info', {
  description: 'Get detailed symbol metadata',
  handler: () => core.symbolInfo(),
});

register('search', {
  description: 'Search for symbols by name or keyword',
  handler: (opts, positionals) => {
    if (!positionals[0]) throw new Error('Query required. Usage: tv search AAPL');
    return core.symbolSearch({ query: positionals.join(' ') });
  },
});

register('range', {
  description: 'Get or set the visible chart range',
  options: {
    from: { type: 'string', description: 'Start timestamp (unix seconds)' },
    to: { type: 'string', description: 'End timestamp (unix seconds)' },
  },
  handler: async (opts) => {
    if (opts.from && opts.to) return core.setVisibleRange({ from: Number(opts.from), to: Number(opts.to) });
    return core.getVisibleRange();
  },
});

register('frame', {
  description: 'Frame the chart to a time window with full candle visibility (price axis auto-scaled to those bars — the fix for clipped/hidden candles). Provide --from/--to (unix seconds) or --date (+ --session).',
  options: {
    from: { type: 'string', description: 'Window start, unix seconds' },
    to: { type: 'string', description: 'Window end, unix seconds' },
    date: { type: 'string', description: 'Calendar day (ISO, e.g. 2024-01-15)' },
    session: { type: 'string', description: 'Session: us_regular (09:30-16:00) or full_day' },
    symbol: { type: 'string', description: 'Optional symbol to switch to first' },
    timeframe: { type: 'string', description: 'Optional timeframe to switch to first' },
    time_zone: { type: 'string', description: 'UTC offset in hours for date/session (e.g. -5)' },
    screenshot: { type: 'string', description: '1/true to capture a screenshot proof' },
    region: { type: 'string', description: 'Screenshot region: full|chart|strategy_tester' },
  },
  handler: async (opts) => {
    const args = {};
    if (opts.from) args.from = Number(opts.from);
    if (opts.to) args.to = Number(opts.to);
    if (opts.date) args.date = opts.date;
    if (opts.session) args.session = opts.session;
    if (opts.symbol) args.symbol = opts.symbol;
    if (opts.timeframe) args.timeframe = opts.timeframe;
    if (opts.time_zone) args.time_zone = Number(opts.time_zone);
    if (opts.screenshot) args.screenshot = ['1','true','yes','on'].includes(String(opts.screenshot).toLowerCase());
    if (opts.region) args.screenshot_region = opts.region;
    if (!args.from && !args.to && !args.date) throw new Error('Provide --from + --to (unix seconds) or --date (+ optional --session).');
    return core.frameChart(args);
  },
});

register('scroll', {
  description: 'Scroll the chart to a specific date',
  handler: (opts, positionals) => {
    if (!positionals[0]) throw new Error('Date required. Usage: tv scroll 2025-01-15');
    return core.scrollToDate({ date: positionals[0] });
  },
});

register('discover', {
  description: 'Report which TradingView API paths are available',
  handler: () => healthCore.discover(),
});

register('ui-state', {
  description: 'Get current UI state (panels, buttons)',
  handler: () => healthCore.uiState(),
});
