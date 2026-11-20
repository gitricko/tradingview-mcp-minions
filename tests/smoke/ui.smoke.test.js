/**
 * Smoke tests — src/core/ui.js.
 * Pure helpers (modifierMask, resolveKey, scrollDelta, findLayoutMatch)
 * are already unit-tested. These cover the CDP-dependent exports.
 */
import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installCdpMocks, resetCdpMocks, cleanupConnection, fakeCdpClient } from '../helpers/mock-cdp.js';
import * as ui from '../../src/core/ui.js';

describe('core/ui.js — smoke', () => {
  afterEach(() => resetCdpMocks());
  after(cleanupConnection);

  it('test_click_smoke', async () => {
    installCdpMocks({
      evaluate: async () => ({ found: true, tag: 'button', text: 'Save', aria_label: null, data_name: null }),
    });
    const r = await ui.click({ by: 'text', value: 'Save' });
    assert.equal(r.success, true);
    assert.equal(r.clicked.tag, 'button');
  });

  it('test_click_smoke_notFound', async () => {
    installCdpMocks({ evaluate: async () => ({ found: false }) });
    await assert.rejects(ui.click({ by: 'text', value: 'Ghost' }), /No matching element/);
  });

  it('test_openPanel_smoke_bottomPanel', async () => {
    installCdpMocks({ evaluate: async () => ({ was_open: false, performed: 'opened' }) });
    const r = await ui.openPanel({ panel: 'pine-editor', action: 'open' });
    assert.equal(r.success, true);
    assert.equal(r.performed, 'opened');
  });

  it('test_openPanel_smoke_sidePanel', async () => {
    installCdpMocks({ evaluate: async () => ({ was_open: true, performed: 'closed' }) });
    const r = await ui.openPanel({ panel: 'watchlist', action: 'toggle' });
    assert.equal(r.success, true);
    assert.equal(r.performed, 'closed');
  });

  it('test_fullscreen_smoke', async () => {
    installCdpMocks({ evaluate: async () => ({ found: true }) });
    const r = await ui.fullscreen();
    assert.equal(r.success, true);
    assert.equal(r.action, 'fullscreen_toggled');
  });

  it('test_layoutList_smoke', async () => {
    installCdpMocks({
      evaluateAsync: async () => ({
        layouts: [{ id: 'L1', name: 'Day Trading', symbol: 'AAPL', resolution: '5' }],
        source: 'internal_api',
      }),
    });
    const r = await ui.layoutList({ _deps: { saved_charts_retry_delay_ms: 0 } });
    assert.equal(r.success, true);
    assert.equal(r.layout_count, 1);
    assert.equal(r.layouts[0].name, 'Day Trading');
  });

  it('test_layoutList_reports_timeout_error_when_lookup_fails', async () => {
    // Every retry attempt times out (no fallback source reachable): the list
    // is empty and the error is surfaced (layoutList has no fallback of its
    // own — it just shares the retry helper).
    installCdpMocks({
      evaluateAsync: async () => ({ layouts: null, error: 'getSavedCharts timed out', source: 'internal_api' }),
    });
    const r = await ui.layoutList({ _deps: { saved_charts_attempts: 2, saved_charts_retry_delay_ms: 0 } });
    assert.equal(r.success, true);
    assert.equal(r.layout_count, 0);
    assert.match(r.error, /getSavedCharts timed out/);
  });

  it('test_layoutList_recovers_a_stall_on_a_later_retry', async () => {
    // The flaky case: the first two lookups stall (timeout), the third
    // returns the list — the bounded retry must recover it.
    const seq = [
      { layouts: null, error: 'getSavedCharts timed out', source: 'internal_api' },
      { layouts: null, error: 'getSavedCharts timed out', source: 'internal_api' },
      { layouts: [{ id: 'L1', name: 'Day Trading', symbol: 'AAPL', resolution: '5' }], source: 'internal_api' },
    ];
    let i = 0;
    installCdpMocks({
      evaluateAsync: async () => seq[Math.min(i++, seq.length - 1)],
    });
    const r = await ui.layoutList({ _deps: { saved_charts_attempts: 3, saved_charts_retry_delay_ms: 0 } });
    assert.equal(r.layout_count, 1);
    assert.equal(r.layouts[0].name, 'Day Trading');
    assert.equal(r.error, undefined);
    assert.equal(i, 3, 'two failures then a success');
  });

  // Shared evaluate() mock for layoutSwitch: the dialog probe returns the
  // given dialog state; the verification probe (document.title + header
  // layout-selector label) returns the given { title, header_label }.
  const switchEvaluate = (dialog, verifiedState) => async (expression) => {
    if (expression.includes('layout-verify-probe')) return verifiedState;
    return dialog;
  };

  // Staged evaluateAsync() mock: layoutSwitch now makes several page calls in
  // sequence (saved-list lookup, match, load-by-id, and — only when the
  // lookup exhausts its retry budget — the layout-picker fallback). Route each
  // to its configured result by the distinguishing substring in the expression.
  const switchStages = ({ lookup, match, load, picker }, dialog, verifiedState) => {
    const log = [];
    let lookupCalls = 0;
    const evaluateAsync = async (expr) => {
      if (expr.includes('matchEntry')) { log.push('match'); return match; }
      if (expr.includes('loadChartFromServer')) { log.push('load'); return load; }
      if (expr.includes('save-load-menu')) { log.push('picker'); return picker; }
      log.push('lookup');
      if (Array.isArray(lookup)) {
        const v = lookup[Math.min(lookupCalls, lookup.length - 1)];
        lookupCalls += 1;
        return v;
      }
      return lookup;
    };
    const evaluate = switchEvaluate(dialog, verifiedState);
    return { evaluateAsync, evaluate, log };
  };

  it('test_layoutSwitch_smoke_no_dialog', async () => {
    const m = switchStages(
      {
        lookup: { layouts: [{ id: 'L1', name: 'Day Trading', url: 'slug1' }], source: 'internal_api' },
        match: { id: 'L1', name: 'Day Trading', slug: 'slug1' },
        load: { ok: true, id: 'L1', name: 'Day Trading', slug: 'slug1' },
      },
      { present: false }, { title: '', header_label: 'Day Trading' },
    );
    installCdpMocks({ evaluateAsync: m.evaluateAsync, evaluate: m.evaluate });
    const r = await ui.layoutSwitch({ name: 'Day Trading', _deps: { saved_charts_retry_delay_ms: 0 } });
    assert.equal(r.success, true);
    assert.equal(r.layout, 'Day Trading');
    assert.equal(r.layout_id, 'L1');
    assert.equal(r.action, 'switched');
    assert.equal(r.method, 'loadChartFromServer');
    assert.equal(r.verified, true);
    assert.equal(r.discarded_unsaved_changes, false);
    assert.deepEqual(m.log, ['lookup', 'match', 'load'], 'primary path: lookup→match→load, no picker');
  });

  it('test_layoutSwitch_smoke_blocked_by_unsaved_dialog', async () => {
    const m = switchStages(
      {
        lookup: { layouts: [{ id: 'L1', name: 'Day Trading', url: 'slug1' }], source: 'internal_api' },
        match: { id: 'L1', name: 'Day Trading', slug: 'slug1' },
        load: { ok: true, id: 'L1', name: 'Day Trading', slug: 'slug1' },
      },
      { present: true, button_text: 'Open anyway' }, { title: '', header_label: 'Day Trading' },
    );
    installCdpMocks({ evaluateAsync: m.evaluateAsync, evaluate: m.evaluate });
    const r = await ui.layoutSwitch({ name: 'Day Trading', _deps: { saved_charts_retry_delay_ms: 0 } });
    assert.equal(r.success, false);
    assert.equal(r.unsaved_dialog_present, true);
    assert.equal(r.blocking_button_text, 'Open anyway');
    assert.match(r.error, /discard_unsaved/);
  });

  it('test_layoutSwitch_smoke_discard_opt_in', async () => {
    const m = switchStages(
      {
        lookup: { layouts: [{ id: 'L1', name: 'Day Trading', url: 'slug1' }], source: 'internal_api' },
        match: { id: 'L1', name: 'Day Trading', slug: 'slug1' },
        load: { ok: true, id: 'L1', name: 'Day Trading', slug: 'slug1' },
      },
      { present: true, button_text: 'Discard' }, { title: '', header_label: 'Day Trading' },
    );
    installCdpMocks({ evaluateAsync: m.evaluateAsync, evaluate: m.evaluate });
    const r = await ui.layoutSwitch({ name: 'Day Trading', discard_unsaved: true, _deps: { saved_charts_retry_delay_ms: 0 } });
    assert.equal(r.success, true);
    assert.equal(r.discarded_unsaved_changes, true);
    assert.equal(r.verified, true);
  });

  it('test_layoutSwitch_smoke_primary_rejects_url_fallback_verified', async () => {
    // 2026-11-18 bug scenario: loadChartFromServer rejects (404 to
    // /chart/undefined/json/); the page navigates via the slug URL and the
    // title confirms the layout landed.
    const m = switchStages(
      {
        lookup: { layouts: [{ id: '42', name: 'Agent', url: 'agSlug' }], source: 'internal_api' },
        match: { id: '42', name: 'Agent', slug: 'agSlug' },
        load: {
          ok: true, method: 'url_navigation', id: '42', name: 'Agent', slug: 'agSlug',
          primary_error: 'loadChartFromServer rejected: HTTP 404 (https://www.tradingview.com/chart/undefined/json/)',
        },
      },
      { present: false }, { title: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView', header_label: 'Agent' },
    );
    installCdpMocks({ evaluateAsync: m.evaluateAsync, evaluate: m.evaluate });
    const r = await ui.layoutSwitch({ name: 'Agent', _deps: { saved_charts_retry_delay_ms: 0 } });
    assert.equal(r.success, true);
    assert.equal(r.method, 'url_navigation');
    assert.equal(r.layout, 'Agent');
    assert.equal(r.layout_id, '42');
    assert.equal(r.verified, true);
    assert.equal(r.action, 'switched');
  });

  it('test_layoutSwitch_smoke_both_paths_fail', async () => {
    // Saved-list resolved, entry matched, but loadChartFromServer failed and
    // the entry has no "url" slug for the URL fallback: a hard failure.
    const m = switchStages(
      {
        lookup: { layouts: [{ id: '42', name: 'Agent', url: null }], source: 'internal_api' },
        match: { id: '42', name: 'Agent', slug: null },
        load: { ok: false, error: 'loadChartFromServer rejected: HTTP 404 (https://www.tradingview.com/chart/undefined/json/)', id: '42', name: 'Agent' },
      },
      { present: false }, { title: '', header_label: null },
    );
    installCdpMocks({ evaluateAsync: m.evaluateAsync, evaluate: m.evaluate });
    // Same failure contract as "Layout not found": throws with the real
    // reason; CLI/tool wrappers surface it as a failed result.
    await assert.rejects(ui.layoutSwitch({ name: 'Agent', _deps: { saved_charts_retry_delay_ms: 0 } }), /loadChartFromServer failed.*HTTP 404/);
  });

  it('test_layoutSwitch_smoke_lookup_exhausted_picker_fallback_succeeds', async () => {
    // The new flaky-path contract: the saved-list lookup exhausts its retry
    // budget, so layoutSwitch falls through to the layout picker (clicks the
    // matching row by name). Verification confirms the switch landed — a
    // timed-out lookup is NON-fatal, so this is a success.
    const failLookup = { layouts: null, error: 'getSavedCharts timed out', source: 'internal_api' };
    const m = switchStages(
      {
        lookup: [failLookup, failLookup],
        match: null,
        load: null,
        picker: { ok: true, name: 'Agent', slug: 'agSlug', before_href: 'https://www.tradingview.com/chart/iv1KqN27/', after_href: 'https://www.tradingview.com/chart/agSlug/' },
      },
      { present: false }, { title: '', header_label: 'Agent' },
    );
    installCdpMocks({ evaluateAsync: m.evaluateAsync, evaluate: m.evaluate });
    const r = await ui.layoutSwitch({ name: 'Agent', _deps: { saved_charts_attempts: 2, saved_charts_retry_delay_ms: 0, verify_timeout_ms: 400, verify_poll_ms: 100 } });
    assert.equal(r.success, true);
    assert.equal(r.method, 'layout_picker');
    assert.equal(r.layout, 'Agent');
    assert.equal(r.verified, true);
    assert.ok(m.log.includes('picker'), 'picker fallback ran after the lookup budget');
  });

  it('test_layoutSwitch_smoke_lookup_exhausted_picker_also_fails', async () => {
    // When BOTH the saved-list lookup and the picker fallback fail, only then
    // is the switch reported as a failure (before any verification).
    const failLookup = { layouts: null, error: 'getSavedCharts timed out', source: 'internal_api' };
    const m = switchStages(
      {
        lookup: [failLookup, failLookup],
        match: null, load: null,
        picker: { error: 'layout "Agent" not found in the layout picker' },
      },
      { present: false }, { title: '', header_label: 'DayTradeVP' },
    );
    installCdpMocks({ evaluateAsync: m.evaluateAsync, evaluate: m.evaluate });
    const r = await ui.layoutSwitch({ name: 'Agent', _deps: { saved_charts_attempts: 2, saved_charts_retry_delay_ms: 0 } });
    assert.equal(r.success, false);
    assert.equal(r.action, 'lookup_and_fallback_failed');
    assert.match(r.error, /getSavedCharts timed out/);
    assert.match(r.error, /layout-picker fallback also failed/);
  });

  it('test_layoutSwitch_smoke_not_found_in_list', async () => {
    // The list resolved fine but no entry matches the requested name: a
    // genuine "not found" input error (throws; does NOT fall to the picker,
    // because the lookup itself succeeded).
    const m = switchStages(
      {
        lookup: { layouts: [{ id: '42', name: 'Agent', url: 'agSlug' }], source: 'internal_api' },
        match: null, load: null, picker: null,
      },
      { present: false }, { title: '', header_label: null },
    );
    installCdpMocks({ evaluateAsync: m.evaluateAsync, evaluate: m.evaluate });
    await assert.rejects(ui.layoutSwitch({ name: 'DoesNotExist', _deps: { saved_charts_retry_delay_ms: 0 } }), /not found/);
    assert.ok(!m.log.includes('picker'), 'not-found must not fall to the picker');
  });

  it('test_layoutSwitch_smoke_numeric_id_primary_loads', async () => {
    // A numeric ID skips the saved-list lookup entirely and loads by ID;
    // verification is skipped (no name to look for), so verified is null.
    const m = switchStages(
      { lookup: null, match: null, load: { ok: true, id: '42', name: null, slug: null }, picker: null },
      { present: false }, { title: '', header_label: null },
    );
    installCdpMocks({ evaluateAsync: m.evaluateAsync, evaluate: m.evaluate });
    const r = await ui.layoutSwitch({ name: '42', _deps: { saved_charts_retry_delay_ms: 0 } });
    assert.equal(r.success, true);
    assert.equal(r.method, 'loadChartFromServer');
    assert.equal(r.layout_id, '42');
    assert.equal(r.verified, null, 'numeric ID path skips verification');
    assert.ok(!m.log.includes('lookup'), 'numeric path does not read the saved list');
  });

  it('test_layoutSwitch_smoke_verification_timeout', async () => {
    // Switch path completed but no signal confirmed the layout — this is
    // exactly the false-success the 2026-11-18 bug produced. Mirrors the
    // live 3.4.1 observation: the title stays the static app title and the
    // header label still shows the previous layout.
    const m = switchStages(
      {
        lookup: { layouts: [{ id: '42', name: 'Agent', url: 'agSlug' }], source: 'internal_api' },
        match: { id: '42', name: 'Agent', slug: 'agSlug' },
        load: { ok: true, method: 'url_navigation', id: '42', name: 'Agent', slug: 'agSlug', primary_error: 'loadChartFromServer rejected: HTTP 404' },
      },
      { present: false }, { title: 'Live stock, index, futures, Forex and Bitcoin charts on TradingView', header_label: 'DayTradeVP' },
    );
    installCdpMocks({ evaluateAsync: m.evaluateAsync, evaluate: m.evaluate });
    const r = await ui.layoutSwitch({ name: 'Agent', _deps: { saved_charts_retry_delay_ms: 0, verify_timeout_ms: 400, verify_poll_ms: 100 } });
    assert.equal(r.success, false);
    assert.equal(r.verified, false);
    assert.equal(r.observed_title, 'Live stock, index, futures, Forex and Bitcoin charts on TradingView');
    assert.equal(r.observed_header_label, 'DayTradeVP');
    assert.equal(r.method, 'url_navigation');
    assert.match(r.error, /no header element with exact text "Agent"/);
    assert.match(r.error, /does not contain it/);
    assert.match(r.error, /loadChartFromServer rejected/);
  });

  it('test_layoutSwitch_smoke_title_signal_only', async () => {
    // Older/browser-style build where the header label is absent but the
    // page title carries the layout name — the title remains an accepted
    // additional signal.
    const m = switchStages(
      {
        lookup: { layouts: [{ id: 'L1', name: 'Scalper', url: 'scSlug' }], source: 'internal_api' },
        match: { id: 'L1', name: 'Scalper', slug: 'scSlug' },
        load: { ok: true, id: 'L1', name: 'Scalper', slug: 'scSlug' },
      },
      { present: false }, { title: 'TradingView - Scalper', header_label: null },
    );
    installCdpMocks({ evaluateAsync: m.evaluateAsync, evaluate: m.evaluate });
    const r = await ui.layoutSwitch({ name: 'Scalper', _deps: { saved_charts_retry_delay_ms: 0 } });
    assert.equal(r.success, true);
    assert.equal(r.verified, true);
  });

  it('test_keyboard_smoke', async () => {
    installCdpMocks({ getClient: async () => fakeCdpClient() });
    const r = await ui.keyboard({ key: 'Enter', modifiers: ['ctrl'] });
    assert.equal(r.success, true);
    assert.deepEqual(r.modifiers, ['ctrl']);
  });

  it('test_typeText_smoke', async () => {
    installCdpMocks({ getClient: async () => fakeCdpClient() });
    const r = await ui.typeText({ text: 'hello' });
    assert.equal(r.success, true);
    assert.equal(r.typed, 'hello');
    assert.equal(r.length, 5);
  });

  it('test_hover_smoke', async () => {
    installCdpMocks({
      getClient: async () => fakeCdpClient(),
      evaluate: async () => ({ x: 100, y: 200, tag: 'button' }),
    });
    const r = await ui.hover({ by: 'aria-label', value: 'Save' });
    assert.equal(r.success, true);
    assert.equal(r.hovered.x, 100);
  });

  it('test_scroll_smoke', async () => {
    installCdpMocks({
      getClient: async () => fakeCdpClient(),
      evaluate: async () => ({ x: 600, y: 400 }),
    });
    const r = await ui.scroll({ direction: 'down', amount: 200 });
    assert.equal(r.success, true);
    assert.equal(r.direction, 'down');
    assert.equal(r.amount, 200);
  });

  it('test_mouseClick_smoke_singleClick', async () => {
    installCdpMocks({ getClient: async () => fakeCdpClient() });
    const r = await ui.mouseClick({ x: 100, y: 200 });
    assert.equal(r.success, true);
    assert.equal(r.button, 'left');
    assert.equal(r.double_click, false);
  });

  it('test_mouseClick_smoke_doubleClick', async () => {
    installCdpMocks({ getClient: async () => fakeCdpClient() });
    const r = await ui.mouseClick({ x: 100, y: 200, button: 'right', double_click: true });
    assert.equal(r.button, 'right');
    assert.equal(r.double_click, true);
  });

  it('test_findElement_smoke_css', async () => {
    installCdpMocks({
      evaluate: async () => ({
        dpr: 1.25,
        elements: [
          { tag: 'button', text: 'Save', aria_label: null, data_name: 'save', x: 0, y: 0, width: 80, height: 32, device_x: 50, device_y: 20, visible: true },
        ],
      }),
    });
    const r = await ui.findElement({ query: 'button', strategy: 'css' });
    assert.equal(r.success, true);
    assert.equal(r.count, 1);
    assert.equal(r.device_pixel_ratio, 1.25, 'dpr surfaced for callers');
    assert.equal(r.elements[0].device_x, 50, 'device_x exposed');
  });

  it('test_findElement_smoke_text', async () => {
    installCdpMocks({
      evaluate: async () => ({
        dpr: 1,
        elements: [
          { tag: 'span', text: 'Alerts', aria_label: null, data_name: null, x: 100, y: 100, width: 50, height: 20, device_x: 125, device_y: 110, visible: true },
        ],
      }),
    });
    const r = await ui.findElement({ query: 'Alerts' });
    assert.equal(r.strategy, 'text');
    assert.equal(r.count, 1);
    assert.equal(r.device_pixel_ratio, 1);
  });

  it('test_mouseClick_smoke_selector_path_scales_by_dpr', async () => {
    // selector path: getBoundingClientRect → CSS coords → multiply by dpr.
    // The test verifies the CDP dispatch is invoked at scaled coords.
    const dispatched = [];
    const fakeClient = {
      Input: {
        dispatchMouseEvent: async (args) => { dispatched.push(args); },
      },
      close: async () => {},
    };
    installCdpMocks({
      getClient: async () => fakeClient,
      evaluate: async () => ({
        found: true,
        visible: true,
        dpr: 1.5,
        cssX: 200,
        cssY: 100,
        cssW: 40,
        cssH: 30,
      }),
    });
    const r = await ui.mouseClick({ selector: 'button[aria-label="Bar replay"]' });
    assert.equal(r.success, true);
    // 200 * 1.5 = 300, 100 * 1.5 = 150
    assert.equal(r.x, 300);
    assert.equal(r.y, 150);
    assert.equal(r.resolved.dpr, 1.5);
    // 3 dispatches: mouseMoved + mousePressed + mouseReleased
    assert.equal(dispatched.length, 3);
    assert.equal(dispatched[0].x, 300);
    assert.equal(dispatched[1].y, 150);
  });

  it('test_mouseClick_smoke_selector_not_found_throws', async () => {
    installCdpMocks({
      getClient: async () => ({ Input: { dispatchMouseEvent: async () => {} }, close: async () => {} }),
      evaluate: async () => ({ found: false }),
    });
    await assert.rejects(
      ui.mouseClick({ selector: 'button[aria-label="Nope"]' }),
      /did not match/,
    );
  });

  it('test_mouseClick_smoke_raw_xy_path_unchanged', async () => {
    const dispatched = [];
    installCdpMocks({
      getClient: async () => ({
        Input: { dispatchMouseEvent: async (a) => { dispatched.push(a); } },
        close: async () => {},
      }),
    });
    const r = await ui.mouseClick({ x: 500, y: 250 });
    assert.equal(r.success, true);
    assert.equal(r.x, 500);
    assert.equal(r.y, 250);
    assert.equal(r.selector, undefined, 'no selector field on raw-xy path');
    assert.equal(dispatched[0].x, 500);
  });

  // uiEvaluate was removed in security PR #54 (the unrestricted-JS hole).
});
