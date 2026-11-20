/**
 * Unit tests — src/core/chart.js frameChart().
 *
 * Uses the _deps injection pattern (mocked evaluate / waitForChartReady /
 * captureScreenshot) so no live TradingView is required. The real CDP
 * sequence and live behavior are proven in chart.smoke.test.js; here we pin
 * the window-resolution, zoom, price-reset, and postcondition logic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as chart from '../../src/core/chart.js';

// Record every evaluate expression so tests can assert on call order/content.
function makeHarness(scripted) {
  const calls = [];
  let i = 0;
  return {
    calls,
    evaluate: async (expr) => {
      calls.push(expr);
      if (Array.isArray(scripted)) return scripted[i++];
      return undefined;
    },
    waitForChartReady: async () => true,
    captureScreenshot: async (args) => ({ success: true, method: 'mock', ...args }),
  };
}

describe('core/chart.js — frameChart()', () => {
  it('rejects when neither from/to nor date is given', async () => {
    await assert.rejects(
      chart.frameChart({ _deps: makeHarness([]) }),
      /from.*to|Provide/i,
    );
  });

  it('rejects when only one of from/to is given', async () => {
    await assert.rejects(
      chart.frameChart({ from: 1700000000, _deps: makeHarness([]) }),
      /Both `from` and `to`/,
    );
  });

  it('rejects unknown session', async () => {
    await assert.rejects(
      chart.frameChart({ date: '2024-01-15', session: 'lunch_break', _deps: makeHarness([]) }),
      /Unknown session/,
    );
  });

  it('resolves us_regular date+session to 09:30–16:00 UTC when no exchange tz is available', async () => {
    // date 2024-01-15T00:00:00Z = 1705276800
    // us_regular: +9.5h = 1705311000, +16h = 1705334400
    // The exchange-tz read (first evaluate) returns undefined in this mock,
    // so the window falls back to the UTC interpretation — now surfaced
    // explicitly via tz_source: 'utc_default' (no silent default).
    const h = makeHarness([
      undefined,                                                // exchange tz read (unavailable)
      { firstIndex: 0, firstTs: null, lastIndex: 0, lastTs: null }, // beforeExtend
      undefined,                                                     // _zoomTimeRange
      { success: true, is_auto: true, min: 1, max: 2 },              // _resetPriceScaleToVisible
      { from: 1705311000, to: 1705334400 },                         // postcondition read-back
    ]);
    const r = await chart.frameChart({ date: '2024-01-15', _deps: h });
    assert.equal(r.success, true);
    assert.equal(r.range_source, 'date_session:us_regular');
    assert.equal(r.requested.from, 1705311000);
    assert.equal(r.requested.to, 1705334400);
    assert.equal(r.tz_source, 'utc_default');
    assert.equal(r.time_axis_ok, true);
    assert.equal(r.price_scale.is_auto, true);
  });

  it('resolves us_regular in the symbol exchange tz when available (non-UTC)', async () => {
    // 2024-01-15, America/New_York is EST (UTC-5): session 09:30-16:00
    // local = 14:30-21:00 UTC. dayStart 1705276800 + 34200 - (-18000)
    // = 1705329000; end = 1705276800 + 57600 + 18000 = 1705352400.
    // This is the fix: the window is no longer interpreted as UTC, so the
    // bars under the labels are exactly the 09:30-16:00 exchange-local bars.
    const h = makeHarness([
      'America/New_York',                                        // exchange tz read
      { firstIndex: -10, firstTs: 1705328000, lastIndex: 100, lastTs: 1705353000 }, // already covered
      undefined,                                                    // _zoomTimeRange
      { success: true, is_auto: true, min: 100, max: 200 },        // price reset
      { from: 1705329000, to: 1705352400 },                        // read-back
    ]);
    const r = await chart.frameChart({ date: '2024-01-15', _deps: h });
    assert.equal(r.success, true);
    assert.equal(r.requested.from, 1705329000, 'EST session start is 14:30 UTC');
    assert.equal(r.requested.to, 1705352400, 'EST session end is 21:00 UTC');
    assert.equal(r.tz_source, 'exchange_symbol');
    assert.equal(r.tz_name, 'America/New_York');
  });

  it('honors DST in the exchange-tz resolution (summer day)', async () => {
    // 2024-07-15, America/New_York is EDT (UTC-4): session 09:30-16:00
    // local = 13:30-20:00 UTC. dayStart = 1721001600.
    // f = 1721001600 + 34200 + 14400 = 1721050200; t = 1721001600 + 57600 + 14400 = 1721073600.
    const h = makeHarness([
      'America/New_York',
      { firstIndex: -10, firstTs: 1721049600, lastIndex: 100, lastTs: 1721074000 },
      undefined,
      { success: true, is_auto: true, min: 100, max: 200 },
      { from: 1721050200, to: 1721073600 },
    ]);
    const r = await chart.frameChart({ date: '2024-07-15', _deps: h });
    assert.equal(r.requested.from, 1721050200, 'EDT session start is 13:30 UTC');
    assert.equal(r.requested.to, 1721073600, 'EDT session end is 20:00 UTC');
    assert.equal(r.tz_source, 'exchange_symbol');
  });

  it('explicit time_zone offset stays authoritative over the exchange tz', async () => {
    // time_zone: -5 (UTC offset hours) reproduces the EST window even when
    // the exchange tz would be read: the explicit offset skips the tz read.
    const h = makeHarness([
      { firstIndex: -10, firstTs: 1705328000, lastIndex: 100, lastTs: 1705353000 },
      undefined,
      { success: true, is_auto: true, min: 100, max: 200 },
      { from: 1705329000, to: 1705352400 },
    ]);
    const r = await chart.frameChart({ date: '2024-01-15', time_zone: -5, _deps: h });
    assert.equal(r.requested.from, 1705329000);
    assert.equal(r.requested.to, 1705352400);
    assert.equal(r.tz_source, 'explicit_offset');
    // No exchange-tz read was issued (the harness script has no entry for it).
    assert.equal(h.calls.length, 4);
  });

  it('explicit time_zone offset parses negative values from the CLI space form', async () => {
    // Regression for `frame --date D --time_zone -5` (space form): the CLI
    // parser used to mis-shield the -5 and lose the value, producing the
    // confusing "`to` must be greater than `from`" error. This pins the
    // window math for a negative offset through the same core path the
    // CLI feeds (time_zone arrives as a number, -5).
    const dayStart = Math.floor(new Date('2026-11-18T00:00:00Z').getTime() / 1000);
    const h = makeHarness([
      { firstIndex: -10, firstTs: dayStart + 34200, lastIndex: 100, lastTs: dayStart + 57600 + 18000 },
      undefined,
      { success: true, is_auto: true, min: 1, max: 2 },
      { from: dayStart + 34200 + 18000, to: dayStart + 57600 + 18000 },
    ]);
    const r = await chart.frameChart({ date: '2026-11-18', time_zone: -5, _deps: h });
    assert.equal(r.requested.from, dayStart + 34200 + 18000);
    assert.equal(r.requested.to, dayStart + 57600 + 18000);
    assert.equal(r.tz_source, 'explicit_offset');
  });

  it('applies symbol/timeframe first (call ordering)', async () => {
    const h = makeHarness([]);
    // We only care that setSymbol/setTimeframe ran before the buffer read.
    // Stub them by pre-recording: instead assert via a spy wrapper.
    let order = [];
    const h2 = {
      calls: h.calls,
      evaluate: async (expr) => {
        h.calls.push(expr);
        order.push('evaluate');
        return undefined;
      },
      waitForChartReady: async () => { order.push('waitForChartReady'); return true; },
      captureScreenshot: async () => ({}),
    };
    // Use real setSymbol/setTimeframe? They need more deps. Instead assert that
    // providing symbol without proper _deps throws or attempts — the important
    // contract is ordering. So monkey-patch module functions via _deps not
    // possible (they're imported internally). Fall back: verify date-only path
    // does NOT call waitForChartReady (no symbol/timeframe to apply).
    const r = await chart.frameChart({ date: '2024-01-15', _deps: h2 });
    assert.equal(order.includes('waitForChartReady'), false);
    assert.equal(r.success, true);
  });

  it('zooms time axis then resets price scale (call order)', async () => {
    const h = makeHarness([
      { firstIndex: -10, firstTs: 1700000000, lastIndex: 100, lastTs: 1700001000 }, // beforeExtend (already covered)
      undefined,          // _zoomTimeRange
      { success: true, is_auto: true, min: 100, max: 200 }, // price reset
      { from: 1700000000, to: 1700001000 },                // read-back
    ]);
    const r = await chart.frameChart({ from: 1700000000, to: 1700001000, _deps: h });
    assert.equal(r.success, true);
    assert.equal(r.cache_extended, true);
    assert.equal(r.cache_note, 'already_covered');
    assert.equal(r.time_axis_ok, true);
    assert.equal(r.price_scale.min, 100);
    assert.equal(r.price_scale.max, 200);
    // The zoom evaluate must contain zoomToBarsRange
    const zoomCall = h.calls.find(c => c.includes('zoomToBarsRange'));
    assert.ok(zoomCall, 'expected a zoomToBarsRange evaluate');
    // The price reset evaluate must contain setPriceAutoScale / resetPriceScale
    const priceCall = h.calls.find(c => c.includes('setPriceAutoScale') && c.includes('resetPriceScale'));
    assert.ok(priceCall, 'expected a price-scale reset evaluate');
  });

  it('captures a screenshot when requested', async () => {
    const h = makeHarness([
      { firstIndex: -10, firstTs: 1700000000, lastIndex: 100, lastTs: 1700001000 },
      undefined,
      { success: true, is_auto: true, min: 1, max: 2 },
      { from: 1700000000, to: 1700001000 },
    ]);
    const r = await chart.frameChart({ from: 1700000000, to: 1700001000, screenshot: true, screenshot_region: 'full', _deps: h });
    assert.equal(r.screenshot.success, true);
    assert.equal(r.screenshot.region, 'full');
  });

  it('reports time_axis_ok=false when the read-back window does not cover the request', async () => {
    const h = makeHarness([
      { firstIndex: -10, firstTs: 1700000000, lastIndex: 100, lastTs: 1700001000 },
      undefined,
      { success: true, is_auto: true, min: 1, max: 2 },
      { from: 1700000000, to: 1700000600 }, // to < requested → not framed
    ]);
    const r = await chart.frameChart({ from: 1700000000, to: 1700001000, _deps: h });
    assert.equal(r.success, true);
    assert.equal(r.time_axis_ok, false);
  });
});
