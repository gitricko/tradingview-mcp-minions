/**
 * Core UI automation logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getClient as _getClient } from '../connection.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getClient: deps?.getClient || _getClient,
  };
}

// ── Known overlay set (popup / upsell / popover) ──────────────────────────
// TV pops subscription-upsell and marketing overlays over the chart with no
// way out via the chart APIs: a screenshot of a "Take your subscription to
// the next level" modal documents the modal, not the chart. Unlike the
// dialogs handled in core/dialog.js these are marketing surfaces, not
// "did you mean?" confirmations — they carry no user data and their own
// dismiss control is the intended exit, so they are safe to auto-dismiss.
//
// Each entry:
//   id      — stable key surfaced in results / ui-state
//   match   — regex tested against the overlay container's text
//   click   — regex tested against the overlay's own dismiss control
//             ("Don't need", "No thanks", …); tried FIRST
//   fallback— regex tried against a generic close/X control SECOND
//   title   — short human label
const KNOWN_OVERLAYS = [
  {
    id: 'subscription_upsell',
    match: /take your subscription to the next level/i,
    click: /^don'?t need$|^no,? thanks$|^no thanks$|^not now$|^maybe later$|^skip$|^don'?t upgrade$/i,
    fallback: /^close$|^dismiss$|^x$|^cancel$/i,
    title: 'Subscription upsell modal',
  },
  {
    id: 'get_realtime_prompt',
    match: /get real-?time data|upgrade to get real-?time|unlock real-?time data|real-?time data is delayed/i,
    click: /^don'?t need$|^no,? thanks$|^no thanks$|^not now$|^maybe later$|^skip$|^don'?t upgrade$|^continue with delayed data$|^later$/i,
    fallback: /^close$|^dismiss$|^x$|^cancel$/i,
    title: 'Get-realtime-data upgrade prompt',
  },
  {
    id: 'new_feature_tour',
    match: /what'?s new|new features? (in|on) tradingview|take a tour|product tour|new feature tour/i,
    click: /^skip$|^skip tour$|^don'?t need$|^no,? thanks$|^no thanks$|^not now$|^maybe later$|^close tour$/i,
    fallback: /^close$|^dismiss$|^x$|^cancel$|^got it$/i,
    title: 'New-feature / product tour',
  },
];

const KNOWN_OVERLAYS_JSON = JSON.stringify(
  KNOWN_OVERLAYS.map(o => ({
    id: o.id,
    match: o.match.source,
    click: o.click.source,
    fallback: o.fallback.source,
    title: o.title,
  }))
);

// Injected once per page-side probe (both detection and dismissal use it).
// The page-side closure returns JSON-serializable records only.
const OVERLAY_PROBE_HELPERS = `
    function textOf(el) {
      var t = '';
      try { t = (el.innerText || el.textContent || '').trim(); } catch (e) { t = ''; }
      return t;
    }
    function isVisible(el) {
      if (!el || !el.getBoundingClientRect) return false;
      var r = el.getBoundingClientRect();
      return (r.width > 0 && r.height > 0) && (el.offsetParent !== null || el.getClientRects().length > 0);
    }
    function labelOf(btn) {
      var t = (textOf(btn) || btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.getAttribute('data-name') || '').trim();
      return t;
    }
    function overlayContainers() {
      var sel = '[role="dialog"], [role="alertdialog"], [role="tooltip"], [aria-modal="true"], ' +
        '[class*="dialog"], [class*="Dialog"], ' +
        '[class*="popup"], [class*="Popup"], ' +
        '[class*="modal"], [class*="Modal"], ' +
        '[class*="overlay"], [class*="Overlay"], ' +
        '[class*="popover"], [class*="Popover"], ' +
        '[data-name*="dialog"], [data-name*="popup"], [data-name*="overlay"]';
      var seen = new Set();
      var out = [];
      var nodes = document.querySelectorAll(sel);
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(n);
      }
      return out;
    }
    function matchOverlay(el, overlays) {
      var txt = textOf(el);
      if (!txt || txt.length > 600) return null;
      for (var i = 0; i < overlays.length; i++) {
        if (new RegExp(overlays[i].match, 'i').test(txt)) return overlays[i];
      }
      return null;
    }
`;

/**
 * Detect TradingView's known marketing overlays WITHOUT clicking anything.
 *
 * Read-only counterpart of dismissPopups(): a frame that comes back blocked
 * can be traced to the overlay still covering the chart without mutating
 * state. Returns an array of { id, title, text, buttons } for every visible
 * matching overlay, sorted smallest-container-first (the innermost dialog,
 * not the full-screen backdrop parent).
 *
 * @param {object} [opts]
 * @param {Function} [opts.evaluate] - injected evaluate (test override)
 * @returns {Promise<Array<{id:string,title:string,text:string,buttons:string[]}>>}
 */
export async function detectPopups({ evaluate: evaluateFn } = {}) {
  const { evaluate } = _resolve({ evaluate: evaluateFn });
  const found = await evaluate(`
    (function() {
      var overlays = ${KNOWN_OVERLAYS_JSON};
      ${OVERLAY_PROBE_HELPERS}
      var hits = [];
      var containers = overlayContainers();
      for (var i = 0; i < containers.length; i++) {
        var el = containers[i];
        if (!isVisible(el)) continue;
        var pat = matchOverlay(el, overlays);
        if (!pat) continue;
        var btns = [];
        var controls = el.querySelectorAll('button, a, [role="button"], [role="link"]');
        for (var b = 0; b < controls.length && b < 10; b++) {
          var lab = labelOf(controls[b]);
          if (lab && lab.length < 60) btns.push(lab);
        }
        hits.push({ id: pat.id, title: pat.title, text: textOf(el).substring(0, 160), buttons: btns });
      }
      // Innermost first: a nested dialog matches its backdrop parent too; the
      // smaller container carries the actionable dismiss control.
      hits.sort(function(a, b) { return a.text.length - b.text.length; });
      // Dedup by overlay id — one entry per known overlay type.
      var seen = {};
      return hits.filter(function(h) {
        if (seen[h.id]) return false;
        seen[h.id] = true;
        return true;
      });
    })()
  `);
  return found || [];
}

/**
 * Dismiss TradingView's known subscription-upsell / get-realtime /
 * new-feature-tour overlays through their OWN dismiss control ("Don't need",
 * "No thanks", …), falling back to a generic close/X control.
 *
 * Safe to call when no overlay is present — returns [] and clicks nothing.
 * Marketing overlays only: no unsaved work or user data sits behind them, so
 * unlike core/dialog.js there is no destructive-discard gate here.
 *
 * @param {object} [opts]
 * @param {Function} [opts.evaluate] - injected evaluate (test override)
 * @returns {Promise<{dismissed:Array, remaining:Array}>}
 *   dismissed: [{ id, title, control, control_text, via: 'own_control'|'close_fallback' }]
 *   remaining: [{ id, title, text, buttons }] overlays still visible — the
 *     concrete evidence when a click did not clear the overlay.
 */
export async function dismissPopups({ evaluate: evaluateFn } = {}) {
  const { evaluate } = _resolve({ evaluate: evaluateFn });
  const result = await evaluate(`
    (function() {
      var overlays = ${KNOWN_OVERLAYS_JSON};
      ${OVERLAY_PROBE_HELPERS}
      var dismissed = [];
      var containers = overlayContainers();
      for (var i = 0; i < containers.length; i++) {
        var el = containers[i];
        if (!isVisible(el)) continue;
        var pat = matchOverlay(el, overlays);
        if (!pat) continue;
        // One attempt per overlay id per pass — clicking twice can reopen
        // or re-arm the surface on some TV builds.
        var already = false;
        for (var d = 0; d < dismissed.length; d++) { if (dismissed[d].id === pat.id) { already = true; break; } }
        if (already) continue;

        // Own-control pass: only text labels (aria-label/title/data-name resolve
        // them too, so an icon button with a dismiss WORD still counts).
        function findLabeledControl(rx) {
          var controls = el.querySelectorAll('button, a, [role="button"], [role="link"]');
          for (var c = 0; c < controls.length; c++) {
            if (!isVisible(controls[c])) continue;
            if (rx.test(labelOf(controls[c]))) return controls[c];
          }
          return null;
        }

        // Generic close pass: conventional close/X affordances, including
        // icon-only close buttons that expose no text label — reached for
        // those through their accessible attributes / close-ish class, then
        // lifted to the enclosing clickable control.
        function findCloseControl(rx) {
          var labeled = findLabeledControl(rx);
          if (labeled) return labeled;
          var iconSel = '[aria-label*="close" i], [aria-label*="dismiss" i], [data-name*="close" i], [data-name*="dismiss" i], [class*="close" i] svg, [class*="close" i] button, button[class*="close" i], a[class*="close" i], [role="button"][class*="close" i]';
          var icons = el.querySelectorAll(iconSel);
          for (var q = 0; q < icons.length; q++) {
            if (!isVisible(icons[q])) continue;
            var btn = icons[q].closest ? icons[q].closest('button, a, [role="button"]') : null;
            return btn && isVisible(btn) ? btn : icons[q];
          }
          return null;
        }

        // Own dismiss control FIRST ("Don't need", "No thanks", …); generic
        // close/X SECOND. Recorded separately so the result says which one
        // performed the dismissal.
        var control = findLabeledControl(new RegExp(pat.click, 'i'));
        var via = 'own_control';
        if (!control) {
          control = findCloseControl(new RegExp(pat.fallback, 'i'));
          via = 'close_fallback';
        }
        if (!control) {
          dismissed.push({ id: pat.id, title: pat.title, via: 'none', control: null, control_text: null });
          continue;
        }
        var before = textOf(el).substring(0, 40);
        try { control.click(); } catch (e) {
          dismissed.push({ id: pat.id, title: pat.title, via: 'error', control: null, control_text: null, error: String(e && e.message || e) });
          continue;
        }
        dismissed.push({
          id: pat.id, title: pat.title, via: via,
          control: control.tagName ? control.tagName.toLowerCase() : null,
          control_text: labelOf(control).substring(0, 40) || null,
          text_before_click: before,
        });
      }
      return dismissed;
    })()
  `);
  const attempted = result || [];
  // Failed attempts (no control matched, or the click threw) are kept with
  // their pre-click evidence — the caller gets the concrete overlay instead
  // of a guess. Successful attempts are re-checked below.
  const failed = attempted.filter(d => d.via === 'none' || d.via === 'error');
  const attemptedIds = new Set(attempted.map(d => d.id));
  const dismissed = attempted.map(d => ({
    id: d.id, title: d.title, via: d.via,
    ...(d.control ? { control: d.control } : {}),
    ...(d.control_text ? { control_text: d.control_text } : {}),
    ...(d.text_before_click ? { text: d.text_before_click } : {}),
    ...(d.error ? { error: d.error } : {}),
  }));
  // Post-click re-detection: what is actually still on screen now. An overlay
  // we clicked that remains visible is reported, not papered over.
  const stillThere = (await detectPopups({ evaluate })) || [];
  const surviving = stillThere.filter(o => attemptedIds.has(o.id));
  // A dismissal is only confirmed when we actually clicked a control AND the
  // overlay is no longer detected.
  const confirmed = dismissed.filter(d =>
    (d.via === 'own_control' || d.via === 'close_fallback') &&
    !surviving.some(o => o.id === d.id));
  // `remaining` = overlays still on screen after the attempt. A surviving
  // overlay that also had a failed attempt (no matching control, or the
  // click threw) is annotated `unhandled` so the caller gets the concrete
  // reason rather than a bare "still here".
  const failedById = new Map(failed.map(d => [d.id, d.via]));
  const remaining = surviving.map(o => ({
    ...o,
    ...(failedById.has(o.id) ? { unhandled: failedById.get(o.id) } : {}),
  }));
  return { dismissed: confirmed, remaining };
}

export async function click({ by, value, _deps }) {
  const { evaluate } = _resolve(_deps);
  const escaped = JSON.stringify(value);
  const result = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${escaped};
      var el = null;
      if (by === 'aria-label') el = document.querySelector('[aria-label="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'data-name') el = document.querySelector('[data-name="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"]');
        for (var i = 0; i < candidates.length; i++) {
          var text = candidates[i].textContent.trim();
          if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; }
        }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + value.replace(/"/g, '\\\\"') + '"]');
      if (!el) return { found: false };
      el.click();
      return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 80), aria_label: el.getAttribute('aria-label') || null, data_name: el.getAttribute('data-name') || null };
    })()
  `);
  if (!result || !result.found) throw new Error('No matching element found for ' + by + '="' + value + '"');
  return { success: true, clicked: result };
}

export async function openPanel({ panel, action, _deps }) {
  const { evaluate } = _resolve(_deps);
  const isBottomPanel = panel === 'pine-editor' || panel === 'strategy-tester';
  if (isBottomPanel) {
    const widgetName = panel === 'pine-editor' ? 'pine-editor' : 'backtesting';
    // TV Desktop 3.1.0 reworked the bottomWidgetBar: hideWidget() is gone,
    // showWidget()/activateScriptEditorTab() are silent no-ops, and
    // _enabledWidgets is empty. The toolbar buttons (data-name="pine-dialog-button"
    // and the strategy tester header button) toggle the panel in both eras —
    // we click them and infer open/close from a post-click visibility check.
    const result = await evaluate(`
      (function() {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        var panelName = ${JSON.stringify(panel)};
        var widgetName = ${JSON.stringify(widgetName)};
        var action = ${JSON.stringify(action)};

        function isPanelOpen() {
          // Canonical state across TV builds: the bottom-panel toggle button's
          // aria-label is "Collapse panel" when expanded and "Open panel" when
          // collapsed. Height thresholds were unreliable (bottom area is ~68px
          // even when collapsed because of the always-visible toolbar strip).
          var collapseBtn = document.querySelector('[data-name="toggle-visibility-button"]');
          if (collapseBtn) {
            var aria = (collapseBtn.getAttribute('aria-label') || '').toLowerCase();
            // "Collapse panel" => panel is currently open
            // "Open panel" => panel is currently closed
            if (aria.indexOf('collapse') !== -1) return isCorrectWidget();
            if (aria.indexOf('open') !== -1) return false;
          }
          // Older TV fallback: large bottom area + content visible
          var bottomArea = document.querySelector('[class*="layout__area--bottom"]');
          if (bottomArea && bottomArea.offsetHeight > 150) return isCorrectWidget();
          return false;
        }

        function isCorrectWidget() {
          // Even when the panel is open, it might be showing a different widget.
          // Verify the requested widget's content is actually rendered.
          if (panelName === 'pine-editor') {
            var monacoEl = document.querySelector('.monaco-editor.pine-editor-monaco');
            if (!monacoEl) return false;
            // Walk up to find an ancestor whose offsetHeight indicates real visibility.
            var rect = monacoEl.getBoundingClientRect();
            return rect.height > 50 && rect.width > 50;
          }
          if (panelName === 'strategy-tester') {
            var stratPanel = document.querySelector('[data-name="backtesting"]')
              || document.querySelector('[class*="strategyReport"]');
            if (!stratPanel) return false;
            var sr = stratPanel.getBoundingClientRect();
            return sr.height > 50 && sr.width > 50;
          }
          return true;
        }

        function findToolbarButton() {
          if (panelName === 'pine-editor') {
            return document.querySelector('[data-name="pine-dialog-button"]')
              || document.querySelector('[aria-label="Pine"]');
          }
          // strategy-tester
          return document.querySelector('[data-name="backtesting-button"]')
            || document.querySelector('[aria-label="Strategy Tester"]')
            || document.querySelector('[data-name="backtesting"]');
        }

        function callApi(open) {
          if (!bwb) return null;
          try {
            if (open) {
              if (panelName === 'pine-editor' && typeof bwb.activateScriptEditorTab === 'function') { bwb.activateScriptEditorTab(); return 'activateScriptEditorTab'; }
              if (typeof bwb.showWidget === 'function') { bwb.showWidget(widgetName); return 'showWidget'; }
            } else {
              // TV Desktop 3.1.0 removed hideWidget; the underscore-prefixed
              // _hideWidget is still present, and toggleWidget (public) closes
              // the panel when called with the currently-open widget.
              if (typeof bwb.hideWidget === 'function') { bwb.hideWidget(widgetName); return 'hideWidget'; }
              if (typeof bwb._hideWidget === 'function') { bwb._hideWidget(widgetName); return '_hideWidget'; }
              if (typeof bwb.toggleWidget === 'function') { bwb.toggleWidget(widgetName); return 'toggleWidget'; }
            }
          } catch(e) {}
          return null;
        }

        // The bottom-panel "Collapse panel" button (data-name=toggle-visibility-button)
        // is the explicit close UX in TV's UI on all builds — used as a fallback
        // when the API methods don't actually close the panel.
        function findCollapseButton() {
          return document.querySelector('[data-name="toggle-visibility-button"][aria-label*="Collapse" i]')
            || document.querySelector('[data-name="toggle-visibility-button"]');
        }

        var wasOpen = isPanelOpen();
        var performed = 'none';
        var apiAction = null;
        var clickedButton = false;

        // Only mutate state when needed. Idempotent on already-open / already-closed.
        if (action === 'open' || (action === 'toggle' && !wasOpen)) {
          if (wasOpen) {
            // Already open — only ensure the right tab is active.
            apiAction = callApi(true);
            var tabBtn = findToolbarButton();
            if (tabBtn) { tabBtn.click(); clickedButton = true; }
            performed = 'already_open';
          } else {
            // Closed → need to expand the panel AND select the right widget.
            // Order matters: toolbar tab first (may auto-expand on some builds),
            // then the API call, then the collapse-toggle as guarantee.
            var tabBtn = findToolbarButton();
            if (tabBtn) { tabBtn.click(); clickedButton = true; }
            apiAction = callApi(true);
            // Click the bottom-panel toggle-visibility button when its label
            // says "Open panel" — this is the canonical expand path on TV 3.1.0.
            var collapseToggle = findCollapseButton();
            if (collapseToggle && /open/i.test(collapseToggle.getAttribute('aria-label') || '')) {
              collapseToggle.click();
            }
            performed = 'opened';
          }
        } else if (action === 'close' || (action === 'toggle' && wasOpen)) {
          if (!wasOpen) {
            performed = 'already_closed';
          } else {
            // TV Desktop 3.1.0: hideWidget / _hideWidget / toggleWidget are all
            // silent no-ops on this build. The collapse-panel button is the
            // only path that actually closes. We try the API call (records
            // intent + works on older TV) and click the collapse button.
            apiAction = callApi(false);
            var collapseBtn = findCollapseButton();
            if (collapseBtn && /collapse/i.test(collapseBtn.getAttribute('aria-label') || '')) {
              collapseBtn.click();
              clickedButton = true;
            }
            performed = 'closed';
          }
        }

        return { was_open: wasOpen, performed: performed, api_action: apiAction, clicked_button: clickedButton };
      })()
    `);
    if (result && result.error) throw new Error(result.error);
    return { success: true, panel, action, was_open: result?.was_open ?? false, performed: result?.performed ?? 'unknown', api_action: result?.api_action, clicked_button: result?.clicked_button };
  } else {
    const selectorMap = {
      'watchlist': { dataName: 'base-watchlist-widget-button', ariaLabel: 'Watchlist', toolbarAnchor: '[data-name="right-toolbar"] [data-name="base"]' },
      'alerts': { dataName: 'alerts-button', ariaLabel: 'Alerts' },
      'trading': { dataName: 'trading-button', ariaLabel: 'Trading Panel' },
    };
    const sel = selectorMap[panel];
    const result = await evaluate(`
      (function() {
        var dataName = ${JSON.stringify(sel.dataName)};
        var ariaLabel = ${JSON.stringify(sel.ariaLabel)};
        var toolbarAnchor = ${JSON.stringify(sel.toolbarAnchor || null)};
        var action = ${JSON.stringify(action)};
        // Locale-independent anchor first (Desktop 3.4.0 removed the legacy
        // watchlist data-name); legacy anchors kept as fallbacks.
        var btn = (toolbarAnchor && document.querySelector(toolbarAnchor)) || document.querySelector('[data-name="' + dataName + '"]') || document.querySelector('[aria-label="' + ariaLabel + '"]');
        if (!btn) return { error: 'Button not found for panel: ' + ${JSON.stringify(panel)} };
        var isActive = btn.getAttribute('aria-pressed') === 'true' || btn.classList.contains('isActive') || btn.classList.toString().indexOf('active') !== -1 || btn.classList.toString().indexOf('Active') !== -1;
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        var sidebarOpen = !!(rightArea && rightArea.offsetWidth > 50);
        var isOpen = isActive && sidebarOpen;
        var performed = 'none';
        if (action === 'open' && !isOpen) { btn.click(); performed = 'opened'; }
        else if (action === 'close' && isOpen) { btn.click(); performed = 'closed'; }
        else if (action === 'toggle') { btn.click(); performed = isOpen ? 'closed' : 'opened'; }
        else { performed = isOpen ? 'already_open' : 'already_closed'; }
        return { was_open: isOpen, performed: performed };
      })()
    `);
    if (result && result.error) throw new Error(result.error);
    return { success: true, panel, action, was_open: result?.was_open ?? false, performed: result?.performed ?? 'unknown' };
  }
}

export async function fullscreen({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="header-toolbar-fullscreen"]');
      if (!btn) return { found: false };
      btn.click();
      return { found: true };
    })()
  `);
  if (!result || !result.found) throw new Error('Fullscreen button not found');
  return { success: true, action: 'fullscreen_toggled' };
}

// Bounded-retry budget for the saved-chart lookup. Live measurements on TV
// Desktop 3.4.1 (2026-11-18): getSavedCharts normally answers in ~180-400ms,
// but ~2 in 5 calls in a batch never invoke the callback at all, so the
// former hard 5s ceiling turned a recoverable stall into a failed
// layout_switch (2 of 5 switches in the PR #13 verification test). Three 5s
// attempts with a short gap between them covers a stalled lookup up to ~15s
// total while never hanging the caller.
// Bounded-retry budget for the saved-chart lookup. Live measurements on TV
// Desktop 3.4.1 (2026-11-18): getSavedCharts normally answers in
// ~180-400ms, but ~2 in 5 calls in a batch never invoke the callback at
// all, so the former hard 5s ceiling turned a recoverable stall into a
// failed layout_switch (2 of 5 switches in the PR #13 verification test).
// Three 3s attempts with a short gap between them keep the total cap
// around 10s while covering a stalled lookup. A per-attempt in-page
// fallback (the service's own cached chart list, see _SAVED_CHARTS_LOOKUP)
// usually recovers a stall within the first attempt, so a full-budget
// exhaustion is rare.
const SAVED_CHARTS_ATTEMPTS = 3;
const SAVED_CHARTS_TIMEOUT_MS = 3000;
const SAVED_CHARTS_RETRY_DELAY_MS = 400;

/**
 * One attempt at the saved-chart lookup, resolved by the page-side promise.
 *
 * Primary source is `TradingViewApi.getSavedCharts(cb)` — a callback API with
 * no rejection signal, which is why the timeout lives in-page. If the callback
 * never fires (the flaky case) we do not simply give up: the same entries are
 * readable from the internal promise-backed backend,
 * `_loadChartService._saveLoad.backend.getCharts()`, whose response carries
 * the identical entry shape (id/name/url/symbol/...) — verified live on
 * TV Desktop 3.4.1 (2026-11-18). The fallback fires ONLY when the callback is
 * silent, never when it answered (an answered empty list means the account
 * really has no layouts; the retry loop above handles retrying).
 */
const _SAVED_CHARTS_LOOKUP = (timeoutMs = SAVED_CHARTS_TIMEOUT_MS) => `
  new Promise(function(resolve) {
    var settled = false;
    function ok(charts, via) { if (settled) return; settled = true; resolve({ layouts: charts, source: 'internal_api', via: via }); }
    function fail(err) { if (settled) return; settled = true; resolve({ layouts: null, error: err, source: 'internal_api' }); }
    try {
      window.TradingViewApi.getSavedCharts(function(charts) {
        if (!charts || !Array.isArray(charts)) { fail('getSavedCharts returned no data'); return; }
        ok(charts, 'getSavedCharts');
      });
      setTimeout(function() {
        if (settled) return;
        // Callback never fired: fall back to the internal service, which
        // caches the same list the callback would have delivered.
        try {
          var svc = window.TradingViewApi._loadChartService;
          var st = svc && svc._state ? svc._state.value() : null;
          if (st && Array.isArray(st.chartList)) { ok(st.chartList, 'load_chart_service_state'); return; }
          var backend = svc && svc._saveLoad && svc._saveLoad.backend;
          if (backend && typeof backend.getCharts === 'function') {
            var p = backend.getCharts();
            if (p && typeof p.then === 'function') {
              p.then(function(charts) {
                if (Array.isArray(charts)) ok(charts, 'backend_getCharts');
                else fail('getSavedCharts timed out and backend getCharts returned no data');
              }, function() { fail('getSavedCharts timed out and backend getCharts rejected'); });
              return;
            }
          }
        } catch (e) {}
        fail('getSavedCharts timed out');
      }, ${timeoutMs});
    } catch(e) { fail(e && e.message ? e.message : String(e)); }
  })
`;

/**
 * Read the saved-layout list with bounded retries.
 *
 * Returns `{ layouts, source, via, error }` after up to `attempts` tries; the
 * first attempt that yields a list wins. A time-out / exception / no-data
 * result (layouts === null) is retried until the budget is exhausted, and the
 * last error is returned so callers report a real reason. An empty-but-valid
 * list IS an answer — an account with no layouts — and is not retried.
 */
async function _getSavedCharts({ evaluateAsync, attempts = SAVED_CHARTS_ATTEMPTS, timeoutMs = SAVED_CHARTS_TIMEOUT_MS, retryDelayMs = SAVED_CHARTS_RETRY_DELAY_MS }) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = (await evaluateAsync(_SAVED_CHARTS_LOOKUP(timeoutMs))) || { layouts: null, error: 'saved-chart lookup returned no data', source: 'internal_api' };
    if (Array.isArray(last.layouts)) return last;
    if (i < attempts - 1) await new Promise(r => setTimeout(r, retryDelayMs));
  }
  return last || { layouts: null, error: 'getSavedCharts timed out', source: 'internal_api' };
}

export async function layoutList({ _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  const layouts = await _getSavedCharts({
    evaluateAsync,
    attempts: _deps?.saved_charts_attempts,
    timeoutMs: _deps?.saved_charts_timeout_ms,
    retryDelayMs: _deps?.saved_charts_retry_delay_ms,
  });
  const list = Array.isArray(layouts?.layouts)
    ? layouts.layouts.map(function(c) { return { id: c.id || c.chartId || null, name: c.name || c.title || 'Untitled', symbol: c.symbol || null, resolution: c.resolution || null, modified: c.timestamp || c.modified || null }; })
    : [];
  return { success: true, layout_count: list.length, source: layouts?.source, layouts: list, error: layouts?.error };
}

/**
 * Poll the page until a visible element confirms the switch landed.
 *
 * Signals (checked in one probe, first hit wins — either one is enough):
 *   1. HEADER LABEL (reliable on TV Desktop 3.4.1, verified live by
 *      firstmate): a visible element in the header band (top < 60px) whose
 *      trimmed `innerText` is EXACTLY the layout name — this is the
 *      top-right layout-selector label, and it updates on every switch.
 *      `document.title` is NOT usable as the sole signal on 3.4.1: it stays
 *      the static app title ("Live stock, index, futures, Forex and Bitcoin
 *      charts on TradingView") after a successful switch.
 *   2. PAGE TITLE: `document.title` contains the layout name (works on
 *      browser-style chart pages, kept as an additional signal).
 *
 * Throws from the evaluate call (e.g. "Execution context was destroyed"
 * right after a navigation) are treated as "not yet ready" and polled past.
 *
 * Returns `{ verified, via, title, header_label }` — the observed evidence
 * on either outcome so a failure can report what the page actually showed.
 */
async function _verifyLayoutVisible({ expectedName, evaluate, timeoutMs = 10000, pollMs = 250 }) {
  const probe = `(
    function() {
      var expected = ${JSON.stringify(expectedName)};
      /*layout-verify-probe*/
      var title = '';
      try { title = document.title || ''; } catch (e) {}
      var headerLabel = null;
      try {
        var els = document.querySelectorAll('div,span,button,a');
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          if (el.offsetParent === null) continue;
          if ((el.innerText || '').trim() !== expected) continue;
          var r = el.getBoundingClientRect();
          if (r.top < 60) { headerLabel = expected; break; }
        }
      } catch (e) {}
      return { title: title, header_label: headerLabel };
    }
  )()`;
  const start = Date.now();
  let last = { title: null, header_label: null };
  while (Date.now() - start < timeoutMs) {
    let p = null;
    try { p = await evaluate(probe); } catch { p = null; }
    if (p) last = { title: p.title || null, header_label: p.header_label || null };
    // Exact match required: a header element showing a DIFFERENT layout
    // (e.g. the previous one still rendered after a failed switch) must not
    // verify as success — that is exactly the false-success this exists to
    // prevent. The in-page probe returns the expected name only on an exact
    // hit; this guard also protects against a stale/loose probe.
    if (last.header_label && String(last.header_label) === String(expectedName)) {
      return { verified: true, via: 'header_label', title: last.title, header_label: last.header_label };
    }
    if (last.title && last.title.toLowerCase().includes(String(expectedName).toLowerCase())) {
      return { verified: true, via: 'title', title: last.title, header_label: last.header_label };
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return { verified: false, via: null, title: last.title, header_label: last.header_label };
}

/**
 * Switch to a saved layout.
 *
 * If the current chart has unsaved changes (Pine code, indicator settings,
 * drawings, layout tweaks), TV shows a confirmation dialog before loading.
 * `discard_unsaved` controls what we do with that dialog:
 *
 *   - false (default, SAFE): refuse to proceed and return
 *     `{ success: false, unsaved_dialog_present: true }` so the caller can
 *     surface the choice to the user or call again with discard_unsaved:true.
 *   - true: click the destructive button (Open anyway / Don't save / Discard,
 *     localized) — destroys unsaved work irrevocably. Response carries
 *     `discarded_unsaved_changes: true` so the trace shows what happened.
 *
 * Previous behavior auto-discarded silently with no opt-in; that destroyed
 * Pine code without consent (high-severity finding from 2026-05-18 review).
 *
 * Path + honesty (2026-11-18 bug: TV Desktop 3.4.1's
 * `loadChartFromServer` promise rejects with HTTP 404 to
 * `/chart/undefined/json/`, and the old code fired it without awaiting,
 * reporting `success: true` while the visible chart never changed):
 *
 *   1. Lookup: the saved-chart list, read through `_getSavedCharts`
 *      (bounded retry — see SAVED_CHARTS_ATTEMPTS). A stall that exhausts
 *      the retry budget is NON-fatal for the switch itself: it falls
 *      through to the picker fallback (step 4) instead of failing here.
 *   2. Primary: `loadChartFromServer(chartId)` — AWAITED with a bounded
 *      timeout. A rejection/timeout is a failed primary path, never success.
 *   3. Fallback (verified-working on 3.4.1): `window.location.assign(
 *      'https://www.tradingview.com/chart/<slug>/')` using the layout
 *      entry's `url` (slug) field from the saved-chart list.
 *   4. Picker fallback (new): if the lookup itself exhausted its budget, the
 *      switch falls through to TV's own layout picker
 *      (`_PICKER_FALLBACK`), which finds the layout by name in the service's
 *      cached list and clicks its row — no saved-list lookup needed.
 *   5. Verification: poll up to ~10s for a visible element in the header
 *      band whose exact text is the layout name (the top-right layout
 *      selector label — the reliable signal on 3.4.1), with `document.title`
 *      containing the name as an additional signal. If neither confirms,
 *      the call returns `success: false` with the expected layout, the
 *      observed title/header evidence, and the primary-path error — success
 *      is never reported for a switch that did not happen. Only when the
 *      picker fallback ALSO fails do we report `success: false` before
 *      verification.
 *
 * The result carries `method` (`'loadChartFromServer'` | `'url_navigation'` |
 * `'layout_picker'`) so callers can see which path performed the switch.
 */
// In-page: switch to the layout matching `target` WITHOUT the saved-list
// lookup, by opening TV's own layout picker (the "Manage layouts" menu) and
// clicking the row whose name matches. Returns the slug of the picked chart.
//
// This is the fallback when the JS lookups above (`getSavedCharts` /
// `loadChartFromServer`) fail — e.g. the saved-list call stalls for its whole
// budget. The picker is rendered from the service's own cached list and its
// rows are anchors with `/chart/<slug>/` hrefs, verified live on TV Desktop
// 3.4.1 (2026-11-18).
const _PICKER_FALLBACK = (target) => `
  (function() {
    function fail(err) { return { error: err }; }
    function findMenuButton() {
      return document.querySelector('[data-name="save-load-menu"]')
        || document.querySelector('[aria-label="Manage layouts"]')
        || document.querySelector('[aria-label*="layouts" i]');
    }
    try {
      var target = ${JSON.stringify(target)};
      var menu = findMenuButton();
      if (!menu) return fail('layout picker button not found (data-name=save-load-menu)');
      menu.click();
      var norm = function(s) { return String(s || '').trim().toLowerCase(); };
      var t = norm(target);
      var before = location.href;
      // The picker grid renders asynchronously after the click.
      return new Promise(function(resolve) {
        var deadline = Date.now() + 4000;
        (function poll() {
          var as = document.querySelectorAll('a[href*="/chart/"]');
          var hit = null;
          for (var i = 0; i < as.length; i++) {
            var a = as[i];
            if (a.offsetParent === null) continue;
            var host = a.closest('[role="row"]') || a.parentElement || a;
            var txt = norm((host.innerText || '').split('\\n')[0]);
            // Compare on the first line only: rows render as
            // "<layout name>\n<symbol>, <TF>" so a symbol/TF can never
            // satisfy the requested name.
            if (txt === t || txt.indexOf(t) !== -1) { hit = a; break; }
          }
          if (hit) {
            try { hit.click(); }
            catch (e) { resolve(fail('layout row click threw: ' + (e && e.message))); return; }
            // The row navigates the page; give it a beat to start.
            setTimeout(function() {
              resolve({ ok: true, name: target, slug: (hit.getAttribute('href') || '').replace(/^.*\\/chart\\/([^\\/]+)\\/.*$/, '$1'), before_href: before, after_href: location.href });
            }, 300);
            return;
          }
          if (Date.now() > deadline) { resolve(fail('layout "' + target + '" not found in the layout picker')); return; }
          setTimeout(poll, 150);
        })();
      });
    } catch (e) { return fail(e && e.message ? e.message : String(e)); }
  })()
`;

// In-page: match a target layout name against a saved-chart entry list.
// Exact match first, then a case-insensitive substring match (legacy
// contract: a wrong-case or partial name still resolves).
const _MATCH_ENTRY = `
  function matchEntry(charts, target) {
    var want = String(target || '').toLowerCase();
    var i, name;
    for (i = 0; i < charts.length; i++) { name = (charts[i].name || charts[i].title || ''); if (name === target || name.toLowerCase() === want) return charts[i]; }
    for (i = 0; i < charts.length; i++) { name = (charts[i].name || charts[i].title || '').toLowerCase(); if (name.indexOf(want) !== -1) return charts[i]; }
    return null;
  }
`;

export async function layoutSwitch({ name, discard_unsaved = false, _deps }) {
  const { evaluate, evaluateAsync } = _resolve(_deps);
  const escaped = JSON.stringify(name);

  // In-page: load one layout by ID, falling back to URL-slug navigation when
  // the entry carries a slug (the verified-working path from PR #13).
  const _LOAD_BY_ID = (entry) => `
    new Promise(function(resolve) {
      var entry = ${JSON.stringify(entry)};
      function errText(e) {
        try {
          if (e && e.message) return e.message;
          if (e && e.statusText) return e.statusText + (e.status ? ' (status ' + e.status + ')' : '');
          return String(e);
        } catch (_) { return 'unknown error'; }
      }
      new Promise(function(res) {
        var p;
        try { p = window.TradingViewApi.loadChartFromServer(entry.id); }
        catch (e) { res({ ok: false, error: 'loadChartFromServer threw: ' + errText(e) }); return; }
        var done = false;
        var to = setTimeout(function() { if (!done) { done = true; res({ ok: false, error: 'loadChartFromServer timed out after 5000ms' }); } }, 5000);
        if (p && typeof p.then === 'function') {
          p.then(
            function() { if (done) return; done = true; clearTimeout(to); res({ ok: true }); },
            function(e) { if (done) return; done = true; clearTimeout(to); res({ ok: false, error: 'loadChartFromServer rejected: ' + errText(e) }); }
          );
        } else { done = true; clearTimeout(to); res({ ok: true }); }
      }).then(function(primary) {
        if (primary.ok || !entry.slug) {
          resolve({ ok: !!primary.ok, error: primary.error || (primary.ok ? null : 'no saved-layout "url" slug is available for the URL fallback'), id: entry.id, name: entry.name || null, slug: entry.slug || null });
          return;
        }
        try {
          window.location.assign('https://www.tradingview.com/chart/' + entry.slug + '/');
          resolve({ ok: true, method: 'url_navigation', id: entry.id, name: entry.name || null, slug: entry.slug, primary_error: primary.error });
        } catch (e) { resolve({ ok: false, error: 'URL navigation to chart slug "' + entry.slug + '" threw: ' + errText(e) + '. Primary error: ' + primary.error, id: entry.id, name: entry.name || null }); }
      });
    })
  `;

  let result = null;

  // ── Numeric ID: no saved-list lookup needed; load directly by ID ─────
  if (/^\d+$/.test(String(name))) {
    const byId = await evaluateAsync(_LOAD_BY_ID({ id: String(name), name: null, slug: null }));
    if (!byId) throw new Error('layoutSwitch: no result from page');
    if (byId.ok) {
      result = { kind: 'switched', method: byId.method || 'loadChartFromServer', id: byId.id, name: null, slug: null, source: 'internal_api' };
    } else {
      // Unchanged legacy contract: a failed numeric load throws, with the
      // note that no slug is available for the URL fallback in this path.
      throw new Error('Primary layout load failed and no saved-layout slug is available for the URL fallback. ' + byId.error);
    }
  } else {
    // ── Named switch: resolve the saved-list, then load ─────────────────
    const saved = await _getSavedCharts({
      evaluateAsync,
      attempts: _deps?.saved_charts_attempts,
      timeoutMs: _deps?.saved_charts_timeout_ms,
      retryDelayMs: _deps?.saved_charts_retry_delay_ms,
    });
    if (Array.isArray(saved.layouts)) {
      const matched = await evaluateAsync(`
        new Promise(function(resolve) {
          try {
            var charts = ${JSON.stringify(saved.layouts)};
            var target = ${escaped};
            ${_MATCH_ENTRY}
            var match = matchEntry(charts, target);
            resolve(match ? { id: match.id || match.chartId || null, name: match.name || match.title || null, slug: match.url || null } : null);
          } catch(e) { resolve({ __matchError: e && e.message ? e.message : String(e) }); }
        })
      `);
      if (matched && matched.__matchError) {
        result = { error: 'saved-layout matching failed: ' + matched.__matchError, source: saved.source };
      } else if (matched) {
        const primary = await evaluateAsync(_LOAD_BY_ID(matched));
        if (primary && primary.ok) {
          result = {
            kind: 'switched',
            method: primary.method || 'loadChartFromServer',
            id: primary.id,
            name: primary.name,
            slug: primary.slug,
            source: saved.source,
            primary_error: primary.primary_error,
          };
        } else {
          result = {
            error: 'loadChartFromServer failed and the saved-layout entry has no "url" slug for the URL fallback. Primary error: ' + (primary?.error || 'unknown'),
            id: primary?.id ?? matched.id,
            name: primary?.name ?? matched.name,
            source: saved.source,
          };
        }
      } else {
        // List resolved but no entry matches — a genuine "not found".
        result = { error: 'Layout "' + name + '" not found.', source: saved.source };
      }
    } else {
      result = { error: saved.error || 'saved-layout lookup failed', source: saved.source, lookup_failed: true };
    }
  }

  // The saved-list lookup failed (whole retry budget exhausted) — fall
  // through to the layout picker, which switches by name without needing
  // the list at all. Success is decided by the verification below, so this
  // only needs to report failure if the picker also fails.
  if (result.lookup_failed) {
    const picked = await evaluateAsync(_PICKER_FALLBACK(name));
    if (picked && picked.ok) {
      result = { kind: 'switched', method: 'layout_picker', id: null, name: picked.name || name, slug: picked.slug || null, source: 'internal_api', primary_error: result.error };
    } else {
      return {
        success: false,
        layout: name,
        action: 'lookup_and_fallback_failed',
        error: 'Saved-layout lookup failed (' + result.error + ') and the layout-picker fallback also failed (' + (picked?.error || 'no result') + ').',
      };
    }
  }

  if (!result) throw new Error('layoutSwitch: no result from page');
  // Layout not found / primary load failed with no URL fallback are input
  // errors (unchanged legacy contract: throw; CLI/tool wrappers surface
  // them as failures).
  if (result.error) throw new Error(result.error);

  // Wait briefly for TV to surface the unsaved-changes dialog (if any).
  await new Promise(r => setTimeout(r, 500));

  // Detect the dialog without clicking — caller's discard_unsaved choice
  // determines what we do with it.
  const dialogState = await evaluate(`
    (function() {
      var rx = /open anyway|don'?t save|discard|abrir mesmo|descartar|não salvar|abrir de todos|no guardar|ouvrir quand|ne pas enregistrer|abandonner|trotzdem öffnen|nicht speichern|verwerfen/i;
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].offsetParent === null) continue;
        var text = (btns[i].textContent || '').trim();
        if (rx.test(text)) {
          return { present: true, button_text: text };
        }
      }
      return { present: false };
    })()
  `);

  if (dialogState && dialogState.present && !discard_unsaved) {
    return {
      success: false,
      unsaved_dialog_present: true,
      blocking_button_text: dialogState.button_text,
      error: 'Current layout has unsaved changes. Pass discard_unsaved: true to proceed and lose them, or save the current layout first.',
    };
  }

  let discardedUnsavedChanges = false;
  if (dialogState && dialogState.present && discard_unsaved) {
    await evaluate(`
      (function() {
        var rx = /open anyway|don'?t save|discard|abrir mesmo|descartar|não salvar|abrir de todos|no guardar|ouvrir quand|ne pas enregistrer|abandonner|trotzdem öffnen|nicht speichern|verwerfen/i;
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          if (btns[i].offsetParent === null) continue;
          if (rx.test((btns[i].textContent || '').trim())) { btns[i].click(); return true; }
        }
        return false;
      })()
    `);
    discardedUnsavedChanges = true;
    await new Promise(r => setTimeout(r, 1000));
  }

  // Verify the switch actually landed before reporting success — the
  // 2026-11-18 false-success bug reported `switched` while the visible
  // chart never changed. On TV Desktop 3.4.1 the reliable signal is the
  // header layout-selector label (exact-text element, top < 60px);
  // `document.title` is an additional signal (firstmate live verification
  // 2026-11-18: title stays the static app title after a real switch).
  // Verification is skipped only when the caller gave a numeric ID (no
  // layout name to look for).
  const verifyTimeoutMs = _deps?.verify_timeout_ms || 10000;
  const verifyPollMs = _deps?.verify_poll_ms || 250;
  let verified = null;
  let observedTitle = null;
  if (result.name) {
    const v = await _verifyLayoutVisible({ expectedName: result.name, evaluate, timeoutMs: verifyTimeoutMs, pollMs: verifyPollMs });
    verified = v.verified;
    observedTitle = v.title;
    if (!verified) {
      return {
        success: false,
        layout: result.name,
        layout_id: result.id,
        source: result.source,
        method: result.method,
        verified: false,
        observed_title: observedTitle,
        observed_header_label: v.header_label || null,
        action: 'failed_verification',
        discarded_unsaved_changes: discardedUnsavedChanges,
        error: 'Layout switch to "' + result.name + '" did not take effect: no header element with exact text "' + result.name + '" (top < 60px) and page title "' + (observedTitle || '<empty>') + '" does not contain it' + (result.primary_error ? '. Primary path error: ' + result.primary_error : ''),
      };
    }
  }

  return {
    success: true,
    layout: result.name || name,
    layout_id: result.id,
    source: result.source,
    action: 'switched',
    method: result.method,
    verified: verified,
    ...(observedTitle ? { observed_title: observedTitle } : {}),
    discarded_unsaved_changes: discardedUnsavedChanges,
  };
}

// Single source of truth for { key → CDP { code, vk } }. Letters A–Z and
// digits 0–9 are added programmatically below to avoid a 36-row table.
// Previously, unmapped keys fell back to `code:'Key'+key.toUpperCase()`
// and `vk:key.toUpperCase().charCodeAt(0)`, which only happens to be
// correct for single ASCII letters — '/', '1', '.' and friends all
// dispatched with invalid codes (e.g. '/' became 'Key/' vk 47 instead
// of 'Slash' vk 191) and TV either ignored the event or routed it to
// the wrong hotkey.
const KEY_MAP = {
  Enter: { code: 'Enter', vk: 13 }, Escape: { code: 'Escape', vk: 27 }, Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 }, Delete: { code: 'Delete', vk: 46 }, Insert: { code: 'Insert', vk: 45 },
  ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', vk: 39 },
  ' ': { code: 'Space', vk: 32 }, Space: { code: 'Space', vk: 32 },
  Home: { code: 'Home', vk: 36 }, End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 }, PageDown: { code: 'PageDown', vk: 34 },
  F1: { code: 'F1', vk: 112 }, F2: { code: 'F2', vk: 113 }, F3: { code: 'F3', vk: 114 },
  F4: { code: 'F4', vk: 115 }, F5: { code: 'F5', vk: 116 }, F6: { code: 'F6', vk: 117 },
  F7: { code: 'F7', vk: 118 }, F8: { code: 'F8', vk: 119 }, F9: { code: 'F9', vk: 120 },
  F10: { code: 'F10', vk: 121 }, F11: { code: 'F11', vk: 122 }, F12: { code: 'F12', vk: 123 },
  '-': { code: 'Minus', vk: 189 }, '=': { code: 'Equal', vk: 187 },
  '[': { code: 'BracketLeft', vk: 219 }, ']': { code: 'BracketRight', vk: 221 },
  '\\': { code: 'Backslash', vk: 220 }, ';': { code: 'Semicolon', vk: 186 },
  "'": { code: 'Quote', vk: 222 }, ',': { code: 'Comma', vk: 188 },
  '.': { code: 'Period', vk: 190 }, '/': { code: 'Slash', vk: 191 },
  '`': { code: 'Backquote', vk: 192 },
};
for (let i = 0; i < 10; i++) KEY_MAP[String(i)] = { code: `Digit${i}`, vk: 48 + i };
for (let i = 0; i < 26; i++) {
  const lo = String.fromCharCode(97 + i);
  const up = String.fromCharCode(65 + i);
  const entry = { code: `Key${up}`, vk: 65 + i };
  KEY_MAP[lo] = entry;
  KEY_MAP[up] = entry;
}

export async function keyboard({ key, modifiers, _deps }) {
  const { getClient } = _resolve(_deps);
  const c = await getClient();
  let mod = 0;
  if (modifiers) {
    if (modifiers.includes('alt')) mod |= 1;
    if (modifiers.includes('ctrl')) mod |= 2;
    if (modifiers.includes('meta')) mod |= 4;
    if (modifiers.includes('shift')) mod |= 8;
  }
  const mapped = KEY_MAP[key];
  if (!mapped) {
    throw new Error(`ui_keyboard: unknown key "${key}". Pass a single letter/digit, a punctuation char from KEY_MAP, or a named key (Enter, Escape, Tab, Arrow*, F1–F12, etc.).`);
  }
  // Keep modifiers on the keyUp too — without them, a Ctrl+S keyUp
  // delivers a plain S to whatever input has focus on platforms that
  // re-fire on modifier release.
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: mod, key, code: mapped.code, windowsVirtualKeyCode: mapped.vk });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', modifiers: mod, key, code: mapped.code, windowsVirtualKeyCode: mapped.vk });
  return { success: true, key, modifiers: modifiers || [] };
}

export async function typeText({ text, _deps }) {
  const { getClient } = _resolve(_deps);
  const c = await getClient();
  await c.Input.insertText({ text });
  return { success: true, typed: text.substring(0, 100), length: text.length };
}

export async function hover({ by, value, _deps }) {
  const { evaluate, getClient } = _resolve(_deps);
  const coords = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${JSON.stringify(value)};
      var el = null;
      if (by === 'aria-label') {
        el = document.querySelector('[aria-label="' + value.replace(/"/g, '\\\\"') + '"]');
        if (!el) el = document.querySelector('[aria-label*="' + value.replace(/"/g, '\\\\"') + '"]');
      }
      else if (by === 'data-name') el = document.querySelector('[data-name="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], span, div');
        for (var i = 0; i < candidates.length; i++) { var text = candidates[i].textContent.trim(); if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; } }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + value.replace(/"/g, '\\\\"') + '"]');
      if (!el) return null;
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName.toLowerCase() };
    })()
  `);
  if (!coords) throw new Error('Element not found for ' + by + '="' + value + '"');
  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: coords.x, y: coords.y });
  return { success: true, hovered: { by, value, tag: coords.tag, x: coords.x, y: coords.y } };
}

export async function scroll({ direction, amount, _deps }) {
  const { evaluate, getClient } = _resolve(_deps);
  const c = await getClient();
  const px = amount || 300;
  const center = await evaluate(`
    (function() {
      var el = document.querySelector('[data-name="pane-canvas"]') || document.querySelector('[class*="chart-container"]') || document.querySelector('canvas');
      if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `);
  let deltaX = 0, deltaY = 0;
  if (direction === 'up') deltaY = -px; else if (direction === 'down') deltaY = px;
  else if (direction === 'left') deltaX = -px; else if (direction === 'right') deltaX = px;
  await c.Input.dispatchMouseEvent({ type: 'mouseWheel', x: center.x, y: center.y, deltaX, deltaY });
  return { success: true, direction, amount: px };
}

/**
 * Click at chart-window coordinates or on a DOM-selected element.
 *
 * Coordinate model: `Input.dispatchMouseEvent` expects DEVICE pixels on
 * Electron/TV Desktop, while `getBoundingClientRect()` returns CSS pixels.
 * On HiDPI displays and WSL2-driven Windows TV (typical devicePixelRatio
 * 1.25 or 1.5), a CSS-pixel click lands on the wrong element — e.g. the
 * Alert button when the caller meant Bar Replay (IDEAS line 199-207).
 *
 * Pass `selector` to side-step the coord-space problem entirely: the
 * element's center is computed in CSS pixels via getBoundingClientRect(),
 * then multiplied by devicePixelRatio before being sent to CDP. The raw
 * `x`/`y` path is unchanged for callers who already pre-scaled.
 */
export async function mouseClick({ x, y, selector, button, double_click, _deps }) {
  const { getClient, evaluate } = _resolve(_deps);
  const c = await getClient();
  const btn = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
  const btnNum = btn === 'right' ? 2 : btn === 'middle' ? 1 : 0;

  let clickX = x;
  let clickY = y;
  let resolved = null;
  if (selector) {
    resolved = await evaluate(`
      (function() {
        try {
          var el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { found: false };
          if (el.offsetParent === null) return { found: true, visible: false };
          var r = el.getBoundingClientRect();
          return {
            found: true,
            visible: true,
            dpr: window.devicePixelRatio || 1,
            cssX: r.x + r.width / 2,
            cssY: r.y + r.height / 2,
            cssW: r.width,
            cssH: r.height,
          };
        } catch(e) { return { found: false, err: e.message }; }
      })()
    `);
    if (!resolved || !resolved.found) {
      throw new Error(`selector "${selector}" did not match any element`);
    }
    if (!resolved.visible) {
      throw new Error(`selector "${selector}" matched a hidden element (offsetParent: null)`);
    }
    clickX = resolved.cssX * resolved.dpr;
    clickY = resolved.cssY * resolved.dpr;
  }

  if (clickX == null || clickY == null) {
    throw new Error('mouseClick requires either { x, y } or { selector }.');
  }

  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: clickX, y: clickY });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: clickX, y: clickY, button: btn, buttons: btnNum, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: clickX, y: clickY, button: btn });
  if (double_click) {
    await new Promise(r => setTimeout(r, 50));
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: clickX, y: clickY, button: btn, buttons: btnNum, clickCount: 2 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: clickX, y: clickY, button: btn });
  }
  return {
    success: true,
    x: clickX,
    y: clickY,
    button: btn,
    double_click: !!double_click,
    ...(selector ? { selector, resolved: { dpr: resolved.dpr, css_x: resolved.cssX, css_y: resolved.cssY } } : {}),
  };
}

export async function findElement({ query, strategy, _deps }) {
  const { evaluate } = _resolve(_deps);
  const strat = strategy || 'text';
  const probe = await evaluate(`
    (function() {
      var query = ${JSON.stringify(query)};
      var strategy = ${JSON.stringify(strat)};
      var dpr = window.devicePixelRatio || 1;
      var results = [];
      function record(el) {
        var rect = el.getBoundingClientRect();
        results.push({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().substring(0, 80),
          aria_label: el.getAttribute('aria-label') || null,
          data_name: el.getAttribute('data-name') || null,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          // device_x/y multiply by devicePixelRatio so callers can pass
          // them straight to Input.dispatchMouseEvent without scaling.
          // On WSL2 Windows TV (dpr 1.25) the CSS center vs device center
          // differ enough that clicks land on adjacent elements.
          device_x: (rect.x + rect.width / 2) * dpr,
          device_y: (rect.y + rect.height / 2) * dpr,
          visible: el.offsetParent !== null,
        });
      }
      if (strategy === 'css') {
        var els = document.querySelectorAll(query);
        for (var i = 0; i < Math.min(els.length, 20); i++) record(els[i]);
      } else if (strategy === 'aria-label') {
        var els = document.querySelectorAll('[aria-label*="' + query.replace(/"/g, '\\\\"') + '"]');
        for (var i = 0; i < Math.min(els.length, 20); i++) record(els[i]);
      } else {
        var all = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], input, select, label, span, div, h1, h2, h3, h4');
        for (var i = 0; i < all.length; i++) {
          var text = all[i].textContent.trim();
          if (text.toLowerCase().indexOf(query.toLowerCase()) !== -1 && text.length < 200) {
            var rect = all[i].getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              record(all[i]);
              if (results.length >= 20) break;
            }
          }
        }
      }
      return { dpr: dpr, elements: results };
    })()
  `);
  const results = probe?.elements || [];
  return {
    success: true,
    query,
    strategy: strat,
    device_pixel_ratio: probe?.dpr ?? 1,
    count: results.length,
    elements: results,
  };
}
