/**
 * Overlay (popup / upsell / popover) detection + dismissal.
 *
 * Two layers:
 *   1. The REAL page-side probe expression emitted by core/ui.js is executed
 *      in a node:vm against a small fake DOM (tests/popup_dom.js), so the
 *      selector logic, control preference (own dismiss control first, generic
 *      close/X second), and the post-click re-check are genuinely exercised —
 *      not mocked away.
 *   2. The Node-side wiring (overlayState, captureScreenshot + frameChart
 *      reporting) is asserted through _deps injection.
 *
 * No live TradingView required; live verification is recorded in the PR body.
 */
import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import vm from 'node:vm';
import { installCdpMocks, resetCdpMocks, cleanupConnection, fakeCdpClient } from './helpers/mock-cdp.js';
import { detectPopups, dismissPopups } from '../src/core/ui.js';
import { registerUiTools } from '../src/tools/ui.js';
import { overlayState, uiState } from '../src/core/health.js';
import { dismissBlockingOverlays, captureScreenshot } from '../src/core/capture.js';
import { frameChart } from '../src/core/chart.js';
import { makeDom, overlayHtml } from './helpers/popup-dom.js';

/** Execute the real page-side expression against a fake DOM, JSON-normalized. */
function domEvaluate(dom) {
  return async (expression) => {
    const sandbox = { document: dom.document, window: dom.window };
    vm.createContext(sandbox);
    return JSON.parse(JSON.stringify(vm.runInContext(expression, sandbox)));
  };
}

describe('detectPopups — page-side logic against a real (fake) DOM', () => {
  it('returns [] when no overlay is present', async () => {
    const dom = makeDom([]);
    const r = await detectPopups({ evaluate: domEvaluate(dom) });
    assert.deepEqual(r, []);
  });

  it('detects the subscription upsell modal and lists its controls', async () => {
    const dom = makeDom([overlayHtml.subscriptionUpsell()]);
    const r = await detectPopups({ evaluate: domEvaluate(dom) });
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'subscription_upsell');
    assert.equal(r[0].title, 'Subscription upsell modal');
    assert.ok(r[0].text.includes('Take your subscription to the next level'));
    assert.ok(r[0].buttons.includes("Don't need"));
  });

  it('detects the get-realtime prompt and the new-feature tour', async () => {
    const dom = makeDom([overlayHtml.getRealtime(), overlayHtml.newFeatureTour()]);
    const r = await detectPopups({ evaluate: domEvaluate(dom) });
    const ids = r.map(o => o.id).sort();
    assert.deepEqual(ids, ['get_realtime_prompt', 'new_feature_tour']);
  });

  it('ignores chart chrome that merely contains the word "upgrade"', async () => {
    const dom = makeDom([overlayHtml.upgradeMenuItem()]);
    const r = await detectPopups({ evaluate: domEvaluate(dom) });
    assert.deepEqual(r, []);
  });

  it('ignores hidden (collapsed) overlay containers', async () => {
    const dom = makeDom([overlayHtml.subscriptionUpsell({ visible: false })]);
    const r = await detectPopups({ evaluate: domEvaluate(dom) });
    assert.deepEqual(r, []);
  });
});

describe('dismissPopups — control preference and honesty', () => {
  it('clicks the overlay\'s own "Don\'t need" control and confirms it is gone', async () => {
    const dom = makeDom([overlayHtml.subscriptionUpsell()]);
    const r = await dismissPopups({ evaluate: domEvaluate(dom) });
    assert.deepEqual(r.remaining, []);
    assert.equal(r.dismissed.length, 1);
    assert.equal(r.dismissed[0].id, 'subscription_upsell');
    assert.equal(r.dismissed[0].via, 'own_control');
    assert.equal(r.dismissed[0].control_text, "Don't need");
    assert.equal(dom.document.clicks.filter(c => c === "Don't need").length, 1);
  });

  it('falls back to the generic close control when no dismiss text matches', async () => {
    // "Upgrade now" / "Learn more"-only modal: no Don't-need-style label,
    // but the conventional Close button is present.
    const dom = makeDom([overlayHtml.subscriptionUpsell({ dismissText: null, closeText: 'Close' })]);
    const r = await dismissPopups({ evaluate: domEvaluate(dom) });
    assert.deepEqual(r.remaining, []);
    assert.equal(r.dismissed[0].via, 'close_fallback');
    assert.equal(r.dismissed[0].control_text, 'Close');
  });

  it('reports the overlay as remaining when no control can dismiss it', async () => {
    const dom = makeDom([overlayHtml.subscriptionUpsell({ dismissText: null, includeClose: false })]);
    const r = await dismissPopups({ evaluate: domEvaluate(dom) });
    // Nothing reported dismissed; the overlay stays as concrete evidence.
    assert.deepEqual(r.dismissed, []);
    assert.equal(r.remaining.length, 1);
    assert.equal(r.remaining[0].id, 'subscription_upsell');
    assert.equal(dom.document.clicks.length, 0, 'nothing was clicked');
  });

  it('reports remaining when the click does not clear the overlay', async () => {
    // A control that reports success but leaves the modal mounted (the
    // false-success case this must not paper over).
    const dom = makeDom([overlayHtml.subscriptionUpsell({ sticky: true })]);
    const r = await dismissPopups({ evaluate: domEvaluate(dom) });
    assert.deepEqual(r.dismissed, []);
    assert.equal(r.remaining.length, 1);
    assert.equal(r.remaining[0].id, 'subscription_upsell');
  });

  it('is a safe no-op with nothing present', async () => {
    const dom = makeDom([]);
    const r = await dismissPopups({ evaluate: domEvaluate(dom) });
    assert.deepEqual(r, { dismissed: [], remaining: [] });
    assert.equal(dom.document.clicks.length, 0);
  });

  it('dismisses an icon-only close via its accessible label', async () => {
    const dom = makeDom([overlayHtml.subscriptionUpsell({ dismissText: null, includeClose: false, iconClose: true })]);
    const r = await dismissPopups({ evaluate: domEvaluate(dom) });
    assert.deepEqual(r.remaining, []);
    assert.equal(r.dismissed[0].via, 'close_fallback');
  });
});

describe('overlayState / uiState wiring', () => {
  afterEach(() => resetCdpMocks());

  it('uiState reports remaining overlays without clicking (read-only)', async () => {
    const detected = [{ id: 'subscription_upsell', title: 'Subscription upsell modal', text: 'Take your subscription…', buttons: ["Don't need"] }];
    installCdpMocks({
      evaluate: async (expr) => {
        if (expr.includes('aria-modal') || expr.includes('overlays[i].match')) return detected;
        // Everything else the uiState probe needs — return inert shapes.
        return null;
      },
    });
    const r = await uiState();
    assert.equal(r.overlays.present, true);
    assert.equal(r.overlays.remaining.length, 1);
    assert.equal(r.overlays.remaining[0].id, 'subscription_upsell');
    assert.deepEqual(r.overlays.dismissed, []);
  });

  it('uiState still succeeds when overlay detection throws', async () => {
    installCdpMocks({
      evaluate: async (expr) => {
        if (expr.includes('aria-modal') || expr.includes('overlays[i].match')) throw new Error('CDP hiccup');
        return null;
      },
    });
    const r = await uiState();
    assert.equal(r.success, true);
    assert.equal(r.overlays.present, false);
    assert.deepEqual(r.overlays.remaining, []);
  });

  it('overlayState(true) distinguishes dismissed from remaining', async () => {
    const dom = makeDom([overlayHtml.subscriptionUpsell()]);
    const evaluate = domEvaluate(dom);
    const r = await overlayState(true, { evaluate, detectPopups, dismissPopups });
    assert.equal(r.dismissed.length, 1);
    assert.equal(r.dismissed[0].id, 'subscription_upsell');
    assert.equal(r.dismissed[0].via, 'own_control');
    assert.equal(r.dismissed[0].control_text, "Don't need");
    assert.deepEqual(r.remaining, []);
    assert.equal(r.present, false);
  });

  it('overlayState(true) keeps an undismissable overlay as evidence', async () => {
    const dom = makeDom([overlayHtml.getRealtime({ controls: [] })]);
    const r = await overlayState(true, { evaluate: domEvaluate(dom), detectPopups, dismissPopups });
    assert.deepEqual(r.dismissed, []);
    assert.equal(r.remaining.length, 1);
    assert.equal(r.remaining[0].id, 'get_realtime_prompt');
    assert.equal(r.remaining[0].unhandled, 'none');
    assert.equal(r.present, true);
  });

  it('overlayState(true) reports a sticky overlay that survived its own click', async () => {
    const dom = makeDom([overlayHtml.subscriptionUpsell({ sticky: true })]);
    const r = await overlayState(true, { evaluate: domEvaluate(dom), detectPopups, dismissPopups });
    assert.deepEqual(r.dismissed, []);
    assert.equal(r.remaining.length, 1);
    assert.equal(r.remaining[0].id, 'subscription_upsell');
    assert.equal(dom.document.clicks.length, 1, 'the control WAS clicked — honestly reported');
  });
});

describe('capture + frame overlay reporting', () => {
  const written = [];
  afterEach(() => {
    resetCdpMocks();
    for (const p of written) { try { unlinkSync(p); } catch {} }
    written.length = 0;
  });
  after(cleanupConnection);

  const frameDeps = (overlayResult) => ({
    evaluate: async () => undefined,
    waitForChartReady: async () => true,
    captureScreenshot: async (args) => ({ success: true, method: 'mock', ...args }),
    dismissBlockingOverlays: async () => overlayResult,
  });

  it('captureScreenshot reports what it dismissed when an overlay was cleared', async () => {
    installCdpMocks({ getClient: async () => fakeCdpClient() });
    const dom = makeDom([overlayHtml.subscriptionUpsell()]);
    const r = await captureScreenshot({
      filename: 'popup-overlay-cleared',
      _deps: { evaluate: domEvaluate(dom) },
    });
    assert.equal(r.success, true);
    assert.equal(r.overlays_dismissed.length, 1);
    assert.equal(r.overlays_dismissed[0].id, 'subscription_upsell');
    assert.equal(r.overlays_dismissed[0].via, 'own_control');
    assert.deepEqual(r.overlays_remaining, []);
    written.push(r.file_path);
  });

  it('captureScreenshot surfaces a still-present overlay instead of guessing', async () => {
    installCdpMocks({ getClient: async () => fakeCdpClient() });
    const dom = makeDom([overlayHtml.getRealtime({ controls: [] })]);
    const r = await captureScreenshot({
      filename: 'popup-overlay-still-up',
      _deps: { evaluate: domEvaluate(dom) },
    });
    assert.equal(r.success, true);
    assert.deepEqual(r.overlays_dismissed, []);
    assert.equal(r.overlays_remaining.length, 1);
    assert.equal(r.overlays_remaining[0].id, 'get_realtime_prompt');
    written.push(r.file_path);
  });

  it('captureScreenshot skips the overlay preflight when told to', async () => {
    installCdpMocks({ getClient: async () => fakeCdpClient() });
    const dom = makeDom([overlayHtml.subscriptionUpsell()]);
    const r = await captureScreenshot({
      filename: 'popup-overlay-skipped',
      dismiss_overlays: false,
      _deps: { evaluate: domEvaluate(dom) },
    });
    assert.equal(r.success, true);
    assert.equal(r.overlays_dismissed, undefined, 'no preflight → no overlay fields');
    assert.equal(dom.document.clicks.length, 0, 'nothing was clicked');
    written.push(r.file_path);
  });

  it('dismissBlockingOverlays returns null (no fields) when the chart is clean', async () => {
    const pre = await dismissBlockingOverlays({ _deps: { evaluate: async () => ({ dismissed: [], remaining: [] }) } });
    assert.equal(pre, null);
  });

  it('dismissBlockingOverlays never throws — a detection failure is reported', async () => {
    const pre = await dismissBlockingOverlays({
      _deps: { evaluate: async () => { throw new Error('CDP hiccup'); } },
    });
    assert.equal(pre.remaining.length, 0);
    assert.match(pre.error, /CDP hiccup/);
  });

  it('frameChart runs the overlay preflight and reports it in the result', async () => {
    const dismissed = [{ id: 'get_realtime_prompt', title: 'Get-realtime-data upgrade prompt', via: 'own_control', control_text: "Don't need" }];
    const r = await frameChart({ from: 1700000000, to: 1700001000, _deps: frameDeps({ dismissed, remaining: [] }) });
    assert.equal(r.success, true);
    assert.equal(r.overlays_dismissed.length, 1);
    assert.equal(r.overlays_dismissed[0].id, 'get_realtime_prompt');
    assert.deepEqual(r.overlays_remaining, []);
  });

  it('frameChart keeps a still-present overlay in the result as evidence', async () => {
    const remaining = [{ id: 'subscription_upsell', title: 'Subscription upsell modal', text: 'Take your subscription…', buttons: [] }];
    const r = await frameChart({ from: 1700000000, to: 1700001000, _deps: frameDeps({ dismissed: [], remaining }) });
    assert.equal(r.success, true);
    assert.deepEqual(r.overlays_dismissed, []);
    assert.equal(r.overlays_remaining.length, 1);
    assert.equal(r.overlays_remaining[0].id, 'subscription_upsell');
  });

  it('frameChart does not re-run the preflight inside its screenshot', async () => {
    let captured = null;
    const r = await frameChart({
      from: 1700000000, to: 1700001000, screenshot: true,
      _deps: {
        evaluate: async () => undefined,
        waitForChartReady: async () => true,
        dismissBlockingOverlays: async () => null,
        captureScreenshot: async (args) => { captured = args; return { success: true, method: 'mock' }; },
      },
    });
    assert.equal(r.success, true);
    assert.equal(captured.dismiss_overlays, false, 'nested screenshot skips the second probe');
  });

  it('frameChart tolerates an overlay-preflight failure', async () => {
    const r = await frameChart({
      from: 1700000000, to: 1700001000,
      _deps: {
        evaluate: async () => undefined,
        waitForChartReady: async () => true,
        captureScreenshot: async () => ({}),
        dismissBlockingOverlays: async () => { throw new Error('probe exploded'); },
      },
    });
    assert.equal(r.success, true);
    assert.equal(r.overlays_dismissed, undefined);
  });
});

// --- tool surface (ui_dismiss_popups) ---------------------------------------

describe('ui_dismiss_popups tool', () => {
  function captureTool() {
    const registered = [];
    const server = { tool: (name, desc, schema, handler) => registered.push({ name, desc, schema, handler }) };
    registerUiTools(server);
    return registered.find(t => t.name === 'ui_dismiss_popups');
  }

  it('is registered alongside the existing ui tools', () => {
    const t = captureTool();
    assert.ok(t, 'ui_dismiss_popups must be registered');
    assert.match(t.desc, /subscription upsell/);
  });

  it('returns a structured failure (isError) when the probe cannot run', async () => {
    const t = captureTool();
    const res = await t.handler({}, { detectPopups: async () => { throw new Error('CDP hiccup'); } });
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.success, false);
    assert.match(body.error, /CDP hiccup/);
    assert.deepEqual(body.dismissed, []);
    assert.deepEqual(body.remaining_overlays, []);
  });

  it('reports cleared overlays vs what is still covering the chart', async () => {
    const t = captureTool();
    const res = await t.handler({}, {
      detectPopups: async () => [
        { id: 'subscription_upsell', title: 'Subscription upsell modal', text: 'Take your subscription…', buttons: [] },
        { id: 'get_realtime_prompt', title: 'Get-realtime-data upgrade prompt', text: '…', buttons: [] },
        { id: 'new_feature_tour', title: 'New-feature tour', text: '…', buttons: [] },
      ],
      dismissPopups: async () => ({
        dismissed: [{ id: 'subscription_upsell', title: 'Subscription upsell modal', via: 'own_control', control_text: "Don't need" }],
        remaining: [
          { id: 'get_realtime_prompt', title: 'Get-realtime-data upgrade prompt', text: '…', buttons: [], unhandled: false },
          { id: 'new_feature_tour', title: 'New-feature tour', text: '…', buttons: [], unhandled: true },
        ],
      }),
    });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.success, false, 'a remaining overlay is not a clean bill of health');
    assert.equal(res.isError, true);
    assert.equal(body.dismissed.length, 1);
    assert.equal(body.dismissed[0].via, 'own_control');
    assert.equal(body.unhandled.length, 1);
    assert.equal(body.unhandled[0].id, 'new_feature_tour');
    assert.equal(body.remaining_overlays.length, 1);
    assert.equal(body.remaining_overlays[0].id, 'get_realtime_prompt');
  });

  it('is a clean success when nothing is up', async () => {
    const t = captureTool();
    const res = await t.handler({}, { detectPopups: async () => [] });
    assert.ok(!res.isError, 'no isError flag on a clean dismissal');
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.success, true);
    assert.deepEqual(body.dismissed, []);
    assert.deepEqual(body.remaining_overlays, []);
  });
});