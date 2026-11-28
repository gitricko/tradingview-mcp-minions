import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installCdpMocks, resetCdpMocks, cleanupConnection } from '../helpers/mock-cdp.js';
import * as strategy from '../../src/core/strategy.js';

/**
 * Client-side (mockable) smoke tests for the deep-backtest range picker.
 * The real DOM contract was verified live; these tests lock in the failure
 * branches and the request→result contract, without a live TradingView.
 *
 * The page-side `evaluate` expressions are identified by a stable marker so
 * one mock answer table can serve a whole run regardless of call order.
 */
const noopClient = () => ({ Input: { dispatchMouseEvent: async () => {} }, close: async () => {} });

/** Classify a page-side expression by the marker it must contain. */
function classify(expr) {
  const s = expr.replace(/\s+/g, ' ');
  if (s.includes('legendRow-')) return 'legend';                  // getEquitySummary
  if (s.includes('__findPanel')) return 'scratch';                 // readDeepStats scrape
  if (s.includes('role="tab"')) return 'tabswitch';
  if (s.includes('var n = 0;')) return 'inputsProbe';          // inputs-mounted probe
  if (s.includes('first available')) return 'anchor';          // "Select first available date"
  if (s.includes('return document.activeElement === el')) return 'focus';
  if (s.includes('var arrows = [].slice.call')) return 'shownMonth';
  if (s.includes('var dir = "next"') || s.includes('var dir = "previous"')) return 'arrowClick';
  if (s.includes('var els = [].slice.call(document.querySelectorAll')) return 'dayClick';
  if (s.includes('setter.call(el,')) return 'setInput';
  if (s.includes('Select|S\u00e9lectionner')) return 'submitProbe';
  if (s.includes('Custom date range')) return 'customItem';
  if (s.includes('Open strategy report')) return 'ensurePanel';
  return 'rangeBtn';
}

/** Default answers for a clean run. Individual tests override specific tags. */
function baseAnswers(overrides = {}) {
  return {
    scratch: { ok: true, deep: true, mode: 'deep', range: 'Jan 1, 2024 — Dec 31, 2024',
      key_stats: { 'Total PnL': '1.00USD' }, analysis_cards: {}, trade_count: '10',
      recomputing: false, source: 'dom' },
    tabswitch: { ok: true, x: 1, y: 1, dpr: 1 },
    inputsProbe: 2,
    anchor: { ok: true },
    focus: true,
    shownMonth: { year: 2024, month: 1, arrow: 'Next month, February 2024' },
    arrowClick: true,
    dayClick: { ok: true, aria: 'Monday 1 January 2024' },
    setInput: { ok: true, value: '2024-01-01' },
    submitProbe: { from: '2024-01-01', to: '2024-12-31', hasSelect: true, selected: true, selectText: 'Select' },
    customItem: { ok: true, x: 5, y: 5, dpr: 1 },
    ensurePanel: { open: true },
    rangeBtn: { ok: true, x: 10, y: 10, dpr: 1 },
    ...overrides,
  };
}

describe('core/strategy.js — smoke', () => {
  after(async () => { resetCdpMocks(); await cleanupConnection(); });

  it('test_setDeepBacktestRange_smoke_validates_ymd', async () => {
    await assert.rejects(
      () => strategy.setDeepBacktestRange({ from: '2024-1-1', to: '2024-12-31' }),
      /YYYY-MM-DD/,
    );
    await assert.rejects(
      () => strategy.setDeepBacktestRange({ from: '2024-01-01', to: 'tomorrow' }),
      /YYYY-MM-DD/,
    );
  });

  it('test_setDeepBacktestRange_smoke_fails_when_picker_button_missing', async () => {
    installCdpMocks({
      evaluate: async () => ({ ok: false, error: 'date range button not found in strategy tester' }),
    });
    const r = await strategy.setDeepBacktestRange({ from: '2024-01-01', to: '2024-12-31' });
    assert.equal(r.success, false);
    assert.match(r.error, /date range button not found/);
  });

  it('test_setDeepBacktestRange_smoke_modal_input_timeout', async () => {
    let n = 0;
    installCdpMocks({
      evaluate: async () => {
        n++;
        if (n === 1) return { ok: true, text: '2024-01-01 — 2024-06-30' };
        return 0;  // never reaches 2 visible inputs
      },
    });
    const r = await strategy.setDeepBacktestRange({ from: '2024-01-01', to: '2024-12-31' });
    assert.equal(r.success, false);
    assert.match(r.error, /modal did not open/);
  });

  it('test_setDeepBacktestRange_smoke_happy_path', async () => {
    let n = 0;
    installCdpMocks({
      evaluate: async () => {
        n++;
        if (n === 1) return { ok: true, text: '2023-01-01 — 2023-06-30' };  // picker open
        if (n === 2) return 2;                                                // inputs-mounted probe
        if (n === 3) return { ok: true, set_from: '2024-01-01', set_to: '2024-12-31', modal_found: true };  // fill
        if (n === 4) return { ready: true, text: 'Select' };                  // submit-enable probe
        if (n === 5) return { ok: true, set_from: '2024-01-01', button: 'Select' };  // click
        return { displayed: '2024-01-01 — 2024-12-31' };                      // verify
      },
    });
    const r = await strategy.setDeepBacktestRange({ from: '2024-01-01', to: '2024-12-31' });
    assert.equal(r.success, true);
    assert.equal(r.set_inputs.from, '2024-01-01');
    assert.equal(r.set_inputs.to, '2024-12-31');
    assert.equal(r.submit_button, 'Select');
    assert.match(r.displayed, /2024-01-01/);
  });

  it('test_setDeepBacktestRange_smoke_submit_disabled', async () => {
    let n = 0;
    installCdpMocks({
      evaluate: async () => {
        n++;
        if (n === 1) return { ok: true };                                                // picker open
        if (n === 2) return 2;                                                           // inputs-mounted probe
        if (n === 3) return { ok: true, set_from: '2024-01-01', set_to: '2024-12-31', modal_found: true };  // fill
        return { ready: false, error: 'submit button never enabled (date range may be invalid)' };          // 20 polls all disabled
      },
    });
    const r = await strategy.setDeepBacktestRange({ from: '2024-01-01', to: '2024-12-31' });
    assert.equal(r.success, false);
    assert.match(r.error, /never enabled|disabled/);
  });
});
/** Mock answers for the read/write tools (R1/R6/R3/R4). */
const readAnswers = {
  tabswitch: { ok: true, x: 1, y: 1, dpr: 1 },
  scratch: { ok: true, deep: true, mode: 'deep', range: 'Feb 11, 2010 — Nov 27, 2026',
    key_stats: { 'Total PnL': '-33,961.90USD', 'Profit factor': '0.909' },
    analysis_cards: { 'Max drawdown as % of initial capital': '48.59%' },
    trade_count: '1,775', recomputing: false, source: 'dom' },
};

describe('core/strategy.js — deep reads (smoke)', () => {
  beforeEach(() => { resetCdpMocks(); });
  after(async () => { resetCdpMocks(); await cleanupConnection(); });

  // ── R1 — strategy_read_deep_stats ─────────────────────────────────

  it('test_readDeepStats_smoke_returns_mode_tagged_cards', async () => {
    installCdpMocks({ evaluate: async (expr) => readAnswers[classify(expr)] });
    const r = await strategy.readDeepStats({});
    assert.equal(r.success, true);
    assert.equal(r.mode, 'deep');
    assert.equal(r.deep, true);
    assert.equal(r.key_stats['Total PnL'], '-33,961.90USD');
    assert.equal(r.trade_count, '1,775');
    assert.equal(r.recomputing, false);
    assert.equal(r.source, 'dom');
  });

  it('test_readDeepStats_smoke_never_returns_literal_undefined', async () => {
    // Cards whose value is missing mid-refresh must not serialise to
    // "undefined"; the card is dropped and recomputing is flagged instead.
    installCdpMocks({
      evaluate: async () => ({
        ok: true, deep: true, mode: 'deep', range: 'Feb 11, 2010 — Nov 27, 2026',
        key_stats: { 'Total PnL': '1.00USD' }, analysis_cards: {},
        trade_count: '5', recomputing: false, source: 'dom',
      }),
    });
    const r = await strategy.readDeepStats({});
    assert.doesNotMatch(JSON.stringify(r.key_stats), /undefined/);
  });

  it('test_readDeepStats_smoke_errors_when_panel_not_open', async () => {
    installCdpMocks({ evaluate: async () => ({ ok: false, error: 'panel_not_open' }) });
    const r = await strategy.readDeepStats({});
    assert.equal(r.success, false);
    assert.match(r.error, /Strategy Tester panel not open/);
  });

});
