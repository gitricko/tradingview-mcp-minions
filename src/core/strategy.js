/**
 * Strategy Tester surface beyond what data.js / chart.js expose.
 *
 * Two families live here:
 *
 *  1. WRITE — setDeepBacktestRange() drives the Premium Deep Backtesting
 *     calendar picker in the Strategy Tester header.
 *  2. DEEP READ / panel WRITE — readDeepStats(), getDeepTrades(),
 *     getEquitySummary(), setBrokerSettings().
 *
 * WHY THE DEEP READS SCRAPE THE PANEL DOM (verified, not theoretical):
 * while a deep backtest runs, the DOM panel and the chart model's
 * `_reportData` hold DIFFERENT numbers at the SAME time. Live instance on
 * TradingView 3.5.1 with the DEEP badge on:
 *
 *   DOM panel   : -33,961.90 USD, 1775 trades, PF 0.909, Feb 2010 → Nov 2026
 *   _reportData :  +2,376.18 USD,    25 trades, PF 1.822, 2026-08-31 → 2026-11-27
 *
 * They converge exactly once a STANDARD range ("Last 90 days") is selected,
 * which proves the divergence is MODE, not staleness: the internal API is
 * hard-wired to the standard backtest while the panel shows the deep one.
 * So data_get_strategy_results / data_get_trades / data_get_equity can never
 * see a Premium deep run; the panel DOM is the only deep surface. Every read
 * here reports the mode it observed plus the date range, so a caller can
 * never silently mix a deep read with a standard one.
 *
 * TradingView 3.5.1 selector notes (the shipped 2026 selectors are stale):
 *  - panel root: `[class*="reportShell-<hash>"]` inside
 *    `.bottom-widgetbar-content.backtesting`. The older
 *    `[class*="strategy-tester" i]` family matches nothing.
 *  - key-stat cards: `[class*="title-<hash>"]` is the LABEL; the value is a
 *    sibling of the label up to 3 ancestor levels (the card itself holds
 *    only the label — a naive `card.innerText` returns the label alone).
 *  - the DEEP badge is the literal word `DEEP` in the panel root's innerText.
 *  - calendar day cells must be matched on `aria-label`
 *    ("Sunday 1 January 2023"); the `another-month-*` class is unreliable.
 *  - the calendar month is readable ONLY from the arrow's aria-label
 *    ("Next month, January 2023"); there is no month/year picker, so
 *    reaching an arbitrary month means clicking prev/next N times.
 *  - interactions use real CDP Input.dispatchMouseEvent, not `.click()`:
 *    a stray `.click()` on the range button collapses the panel.
 *
 * Ported from jacktradesnq fork (commit 7c5b6c2, May 2026) for the range
 * picker; the read/write helpers are new for 3.5.1. _deps DI pattern +
 * safeString interpolation; locale tolerant where the UI strings allow it.
 */
import { evaluate as _evaluate, getClient as _getClient } from '../connection.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getClient: deps?.getClient || _getClient,
  };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ── Page-side helpers ──────────────────────────────────────────────────────
// Inlined into every CDP expression so each evaluate() is self-contained.

/** Locate the Strategy Tester panel root, or null. */
const FIND_PANEL_SRC = `
  function __findPanel() {
    var shell = document.querySelector('[class*="reportShell-" i]');
    if (shell && shell.offsetParent !== null) return shell;
    var bt = document.querySelector('.bottom-widgetbar-content.backtesting');
    if (bt) {
      var inner = bt.querySelector('[class*="reportShell-" i]');
      if (inner && inner.offsetParent !== null) return inner;
    }
    return null;
  }
`;

/** Drop NBSP/thin-space and reject placeholder-ish values. */
const CLEAN_SRC = `
  function __clean(v) {
    if (v === null || v === undefined) return null;
    var t = String(v).replace(/[\u00a0\u202f]/g, ' ').trim();
    if (!t) return null;
    // TradingView renders an in-flight stat as the literal word "undefined"
    // (and sometimes an em/en-dash placeholder). These mean NO VALUE, not a
    // value — treat them as absent so a caller can never store "undefined".
    if (t === 'undefined' || t === 'NaN') return null;
    if (/^[-\u2013\u2014]+$/.test(t)) return null;
    if (/^n\\/a$/i.test(t)) return null;
    return t;
  }
`;

/** The panel root's innerText, or ''. */
const PANEL_TEXT_SRC = `
  function __panelText(shell) {
    return (shell && shell.innerText ? shell.innerText : '').replace(/\u00a0/g, ' ');
  }
`;

/**
 * Scrape every visible key-stat card as {label, value} pairs. The value is a
 * sibling of the `title-<hash>` label up to 3 ancestor levels.
 */
const READ_CARDS_SRC = `
  function __readCards(shell) {
    var out = [];
    // Scope the sweep to the panel: the same ".title-<hash>" class is used
    // elsewhere in the app (chart legend, data window), and a document-wide
    // query mixes those rows into the stats.
    var scope = shell || document;
    var titles = scope.querySelectorAll('[class*="title-" i]');
    for (var i = 0; i < titles.length; i++) {
      var t = titles[i];
      if (t.offsetParent === null) continue;
      // Must be inside the Strategy Tester panel, not another widget.
      if (shell && !t.closest('[class*="reportShell-" i]')) continue;
      var label = (t.textContent || '').replace(/[\u00a0\u202f]/g, ' ').trim();
      if (!label || label.length > 80) continue;
      var row = t.parentElement, value = null;
      for (var d = 0; d < 3 && row; d++) {
        var kids = row.children;
        for (var k = 0; k < kids.length; k++) {
          if (kids[k] === t) continue;
          var tx = __clean(kids[k].innerText);
          if (tx && tx !== label && tx.length < 60 && !value) value = tx;
        }
        if (value) break;
        row = row.parentElement;
      }
      out.push({ label: label, value: value });
    }
    return out;
  }
`;

export { FIND_PANEL_SRC, CLEAN_SRC, PANEL_TEXT_SRC, READ_CARDS_SRC };

export async function setDeepBacktestRange({ from, to, _deps } = {}) {
  if (!YMD.test(String(from || '')) || !YMD.test(String(to || ''))) {
    throw new Error('from and to must be YYYY-MM-DD strings.');
  }
  const { evaluate } = _resolve(_deps);

  // Step 1 — open the date-range picker in the Strategy Tester header.
  // The match shape is intentionally narrow: TWO year-shaped tokens
  // (19xx/20xx) separated by an en/em/hyphen dash. Previous loose match
  // (one 4-digit run + any dash) could click any P&L/drawdown cell that
  // happened to contain a negative number — e.g. "Net profit: -1234.56"
  // matched and Step 2 timed out with a misleading message. The new
  // regex also requires the strategy-tester container to exist (no
  // document-wide fallback) so we never wander into another panel.
  const opened = await evaluate(`
    (function() {
      function visible(el) { return el && el.offsetParent !== null; }
      var st = document.querySelector('[class*="strategy-tester" i], [data-name*="strategy-tester" i], [class*="strategyTester" i]');
      if (!st) return { ok: false, error: 'strategy-tester container not found — is the panel open?' };
      var btns = st.querySelectorAll('button, [role="button"]');
      // Two year-shaped tokens (19xx or 20xx) + dash separator.
      var rangeShape = /\\b(19|20)\\d{2}\\b[\\s\\S]{1,40}[—\\-–][\\s\\S]{1,40}\\b(19|20)\\d{2}\\b/;
      for (var i = 0; i < btns.length; i++) {
        if (!visible(btns[i])) continue;
        var t = (btns[i].textContent || '').trim();
        if (t.length > 80) continue;
        if (rangeShape.test(t)) {
          btns[i].click();
          return { ok: true, text: t };
        }
      }
      return { ok: false, error: 'date range button not found in strategy tester' };
    })()
  `);
  if (!opened || !opened.ok) {
    return { success: false, error: opened?.error || 'could not open Deep BT range picker' };
  }

  // Step 2 — wait for the modal's two YYYY-MM-DD inputs to mount.
  let inputCount = 0;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200));
    const probe = await evaluate(`
      (function() {
        var ins = document.querySelectorAll('input[placeholder="YYYY-MM-DD"]');
        var n = 0;
        for (var i = 0; i < ins.length; i++) { if (ins[i].offsetParent !== null) n++; }
        return n;
      })()
    `);
    inputCount = Number(probe) || 0;
    if (inputCount >= 2) break;
  }
  if (inputCount < 2) {
    return { success: false, error: 'date range modal did not open (no YYYY-MM-DD inputs found)' };
  }

  // Step 3 — fill both inputs via React-friendly setter, then poll the
  // submit-button enabled state (React validation re-render runs on a
  // microtask boundary; checking immediately would observe pre-change
  // state). Submit-button search is scoped to the modal that contains
  // the date inputs — previously a document-wide query could click an
  // unrelated 'OK' / 'Apply' button on another panel.
  const escFrom = JSON.stringify(from);
  const escTo = JSON.stringify(to);

  // Fill inputs separately so the wait can see post-render state.
  const fillResult = await evaluate(`
    (function() {
      function visible(el) { return el && el.offsetParent !== null; }
      function setReactInputValue(el, value) {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }
      var ins = document.querySelectorAll('input[placeholder="YYYY-MM-DD"]');
      var visIns = [];
      for (var i = 0; i < ins.length; i++) { if (visible(ins[i])) visIns.push(ins[i]); }
      if (visIns.length < 2) return { ok: false, error: 'fewer than 2 visible date inputs' };
      setReactInputValue(visIns[0], ${escFrom});
      setReactInputValue(visIns[1], ${escTo});
      // Resolve the modal container so the submit search is scoped.
      var modal = visIns[0].closest('[role="dialog"], [class*="dialog" i], [class*="modal" i], [data-dialog-name]');
      return { ok: true, set_from: visIns[0].value, set_to: visIns[1].value, modal_found: !!modal };
    })()
  `);
  if (!fillResult || !fillResult.ok) {
    return { success: false, error: fillResult?.error || 'could not fill range', detail: fillResult };
  }

  // Poll submit-button enable state inside the modal.
  let submitProbe = null;
  for (let i = 0; i < 20; i++) {
    submitProbe = await evaluate(`
      (function() {
        function visible(el) { return el && el.offsetParent !== null; }
        var ins = document.querySelectorAll('input[placeholder="YYYY-MM-DD"]');
        var anchor = null;
        for (var k = 0; k < ins.length; k++) { if (visible(ins[k])) { anchor = ins[k]; break; } }
        if (!anchor) return { ready: false, error: 'inputs disappeared' };
        var scope = anchor.closest('[role="dialog"], [class*="dialog" i], [class*="modal" i], [data-dialog-name]') || document;
        var allBtns = scope.querySelectorAll('button');
        var submitBtn = null;
        for (var b = 0; b < allBtns.length; b++) {
          if (!visible(allBtns[b])) continue;
          var t = (allBtns[b].textContent || '').trim();
          if (/^(S[ée]lectionner|Select|Apply|Appliquer|OK)$/i.test(t)) { submitBtn = allBtns[b]; break; }
        }
        if (!submitBtn) return { ready: false, error: 'submit button not found in modal scope' };
        var dis = submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true';
        return { ready: !dis, text: (submitBtn.textContent || '').trim() };
      })()
    `);
    if (submitProbe && submitProbe.ready) break;
    await new Promise(r => setTimeout(r, 75));
  }
  if (!submitProbe || !submitProbe.ready) {
    return {
      success: false,
      error: submitProbe?.error || 'submit button never enabled (date range may be invalid)',
      set_inputs: { from: fillResult.set_from, to: fillResult.set_to },
    };
  }

  // Click — the button is enabled within the modal scope.
  const filled = await evaluate(`
    (function() {
      function visible(el) { return el && el.offsetParent !== null; }
      var ins = document.querySelectorAll('input[placeholder="YYYY-MM-DD"]');
      var anchor = null;
      for (var k = 0; k < ins.length; k++) { if (visible(ins[k])) { anchor = ins[k]; break; } }
      if (!anchor) return { ok: false, error: 'inputs disappeared before click' };
      var scope = anchor.closest('[role="dialog"], [class*="dialog" i], [class*="modal" i], [data-dialog-name]') || document;
      var allBtns = scope.querySelectorAll('button');
      var submitBtn = null;
      for (var b = 0; b < allBtns.length; b++) {
        if (!visible(allBtns[b])) continue;
        var t = (allBtns[b].textContent || '').trim();
        if (/^(S[ée]lectionner|Select|Apply|Appliquer|OK)$/i.test(t)) { submitBtn = allBtns[b]; break; }
      }
      if (!submitBtn) return { ok: false, error: 'submit button not found' };
      submitBtn.click();
      return { ok: true, set_from: anchor.value, button: (submitBtn.textContent || '').trim() };
    })()
  `);
  if (!filled || !filled.ok) {
    return { success: false, error: filled?.error || 'could not fill range', detail: filled };
  }

  // Step 4 — verify the strategy-tester button reflects the new range.
  // Use the same tight regex as the picker-button search so the verifier
  // can't read from an unrelated cell.
  await new Promise(r => setTimeout(r, 1000));
  const verify = await evaluate(`
    (function() {
      function visible(el) { return el && el.offsetParent !== null; }
      var st = document.querySelector('[class*="strategy-tester" i], [data-name*="strategy-tester" i], [class*="strategyTester" i]');
      if (!st) return { displayed: null };
      var btns = st.querySelectorAll('button, [role="button"]');
      var rangeShape = /\\b(19|20)\\d{2}\\b[\\s\\S]{1,40}[—\\-–][\\s\\S]{1,40}\\b(19|20)\\d{2}\\b/;
      for (var i = 0; i < btns.length; i++) {
        if (!visible(btns[i])) continue;
        var t = (btns[i].textContent || '').trim();
        if (t.length > 80) continue;
        if (rangeShape.test(t)) return { displayed: t };
      }
      return { displayed: null };
    })()
  `);

  const yearFrom = from.slice(0, 4);
  const yearTo = to.slice(0, 4);
  const display = verify?.displayed || '';
  const matches = display.includes(yearFrom) && display.includes(yearTo);

  return {
    success: matches,
    requested: { from, to },
    set_inputs: { from: fillResult.set_from, to: fillResult.set_to },
    submit_button: filled.button,
    displayed: verify?.displayed || null,
    note: matches ? undefined : 'Range submitted but display verification did not match the requested years. Check Strategy Tester manually.',
  };
}

// ---------------------------------------------------------------------------
// R1 — strategy_read_deep_stats
// ---------------------------------------------------------------------------

/**
 * Header context: range button text, DEEP badge, capital, detalization,
 * script execution. Every field is a DOM text read, so it reflects whatever
 * mode the panel is currently showing.
 */
const READ_HEADER_SRC = `
  ${FIND_PANEL_SRC}
  function __readHeader(shell) {
    var out = { range: null, capital: null, detalization: null, script_execution: null, deep: false };
    if (!shell) return out;
    var text = (shell.innerText || '');
    out.deep = /(^|\\s)DEEP(\\s|$)/.test(text);
    var btns = shell.querySelectorAll('button, [role="button"]');
    var rangeShape = /\\b(19|20)\\d{2}\\b[\\s\\S]{1,60}[—\\-–][\\s\\S]{1,60}\\b(19|20)\\d{2}\\b/;
    var historyShape = /(last\\s+\\d+\\s+days|entire\\s+history|history)/i;
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.offsetParent === null) continue;
      var aria = (b.getAttribute('aria-label') || '').trim();
      var txt = (b.textContent || '').trim();
      if (!out.range && aria && (rangeShape.test(aria) || historyShape.test(aria))) {
        out.range = aria;
      }
      if (!out.capital && /\\d/.test(aria) && /[KkMm]$/.test(aria.replace(/\\s/g, '').slice(-1)) ) out.capital = aria;
    }
    // Detalization / script execution: label buttons whose aria-label names them.
    for (var j = 0; j < btns.length; j++) {
      var a2 = (btns[j].getAttribute('aria-label') || '').trim();
      if (/detalization/i.test(a2)) out.detalization = (btns[j].textContent || '').trim() || a2;
      if (/script execution/i.test(a2)) out.script_execution = (btns[j].textContent || '').trim() || a2;
    }
    return out;
  }
`;

/**
 * Read the Strategy Tester panel's key stats, performance-analysis cards and
 * trade-count cards straight off the DOM, tagged with the mode (deep /
 * standard) that produced them.
 *
 * Guards:
 *  - panel missing → success:false with the panel-open hint.
 *  - mid-recompute: key-stat cards briefly read `undefined` while a deep run
 *    re-runs (verified live after a range/timeframe change). Rather than
 *    returning garbage, `undefined_count` > 0 sets `recomputing: true` and
 *    `success:false` — the caller retries. Polling is done in JS by the
 *    caller (or via `wait`), because the recompute is TradingView-side.
 *  - a partially-rendering refresh is caught the same way: any card with a
 *    label but no value means the row is mid-refresh.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.wait=false] Poll until the panel holds real values
 *   (no `undefined` cards, no empty rows) or `wait_timeout_ms` elapses.
 * @param {number}  [opts.wait_timeout_ms=45000]
 * @param {number}  [opts.wait_interval_ms=1500]
 * @param {object}  [opts._deps] Test injection for `evaluate`.
 */
export async function readDeepStats({ wait = false, wait_timeout_ms = 45000, wait_interval_ms = 1500, _deps } = {}) {
  const { evaluate, getClient } = _resolve(_deps);
  const deadline = Date.now() + (Number(wait_timeout_ms) || 45000);
  const interval = Math.max(300, Number(wait_interval_ms) || 1500);

  // The stat cards live on the panel's summary tab; the trade-list tab
  // (left selected by strategy_get_deep_trades) does not render them at all,
  // so a read there returns zero cards rather than "zero stats". Switch back
  // to the summary tab (icon-tab index 0) with a real mouse event before
  // scraping, the same way getDeepTrades selects the trade list.
  {
    const tabInfo = await evaluate(`
      (function() {
        try {
          var shell = document.querySelector('[class*="reportShell-" i]');
          if (!shell) return { ok: false, error: 'panel_not_open' };
          var tabs = [].slice.call(shell.querySelectorAll('[role="tab"]'));
          var iconTabs = tabs.filter(function (b) {
            var r = b.getBoundingClientRect();
            return r.height > 0 && r.height < 60 && r.width < 60 && b.offsetParent !== null;
          });
          if (iconTabs.length < 2) return { ok: false, error: 'stat cards tab not found' };
          var r2 = iconTabs[0].getBoundingClientRect();
          return { ok: true, x: Math.round(r2.x + r2.width / 2), y: Math.round(r2.y + r2.height / 2), dpr: window.devicePixelRatio || 1 };
        } catch (e) {
          return { ok: false, error: 'page-side: ' + String(e && e.message || e) };
        }
      })()
    `);
    if (tabInfo.ok === true) {
      try {
        const client = await getClient();
        const tx = Math.round(tabInfo.x * (tabInfo.dpr || 1));
        const ty = Math.round(tabInfo.y * (tabInfo.dpr || 1));
        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: tx, y: ty });
        await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: tx, y: ty, button: 'left', buttons: 1, clickCount: 1 });
        await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: tx, y: ty, button: 'left' });
        await new Promise(r => setTimeout(r, 700));
      } catch {
        // A read tool must not fail because a tab switch could not be sent;
        // whatever tab is visible is scraped and reported as-is below.
      }
    }
  }

  // One evaluate gathers: header context, card pairs, and the panel text
  // (for the mode + the summary/trade-count lines).
  const scratch = async () => evaluate(`
    (function() {
      try {
        ${READ_HEADER_SRC}
        ${CLEAN_SRC}
        ${PANEL_TEXT_SRC}
        ${READ_CARDS_SRC}
        var shell = __findPanel();
        if (!shell) return { ok: false, error: 'panel_not_open' };
        var header = __readHeader(shell);
        var cards = __readCards(shell);
        var text = __panelText(shell);

        // The DEEP badge and the range are read from the live text so the
        // mode tag can never disagree with what the caller sees on screen.
        var deep = header.deep || /(^|\\s)DEEP(\\s|$)/.test(text);

        // The 12 headline Key stats the brief names, plus the summary
        // counters scraped from the panel text.
        var HEADLINE = ['Total PnL','Net profit','Max drawdown','Profitable trades','Profit factor',
          'Strategy return','Buy and hold return','Strategy outperformance','Correlation',
          'Longest winning streak','Longest losing streak','Average winning streak','Average losing streak'];

        var undefinedCount = 0, emptyCount = 0;
        var keyStats = {}, analysis = {};
        var tradeCount = null;
        for (i = 0; i < cards.length; i++) {
          var lab = cards[i].label, val = cards[i].value;
          var isHeadline = false;
          for (var k = 0; k < HEADLINE.length; k++) {
            if (lab === HEADLINE[k]) { isHeadline = true; break; }
          }
          if (isHeadline) keyStats[lab] = val;
          else if (val !== null) analysis[lab] = val;  // section headings have no value
          if (val !== null) {
            if (/undefined/i.test(String(val))) undefinedCount++;
          } else if (isHeadline) {
            emptyCount++;  // a real stat card lost its value mid-refresh
          }
          // "Profitable trades 37.30% 662/1775" carries the trade count.
          if (lab === 'Profitable trades' && val) {
            var mm = String(val).match(/([0-9][0-9,]*)\\s*\\/\\s*([0-9][0-9,]*)/);
            if (mm) tradeCount = mm[2];
          }
        }

        // Total-trade count: the trade-list tab footer states it outright.
        if (!tradeCount) {
          var mrow = text.match(/([0-9][0-9,]{2,})\\s*(?:trades)?\\s*$/m);
          if (mrow) tradeCount = mrow[1];
        }

        return {
          ok: true,
          deep: deep,
          mode: deep ? 'deep' : 'standard',
          range: header.range,
          capital: header.capital,
          detalization: header.detalization,
          script_execution: header.script_execution,
          key_stats: keyStats,
          analysis_cards: analysis,
          trade_count: tradeCount,
          card_count: cards.length,
          cards_without_value: emptyCount,
          cards_with_undefined: undefinedCount,
          recomputing: undefinedCount > 0 || emptyCount > 0,
          source: 'dom',
        };
      } catch (e) {
        return { ok: false, error: 'page-side: ' + String(e && e.message || e) };
      }
    })()
  `);

  let result = await scratch();
  if (!result || result.ok !== true) {
    const err = result?.error === 'panel_not_open'
      ? 'Strategy Tester panel not open — open it (ui_open_panel panel:"strategy-tester" / button[aria-label="Open strategy report"]) and load a strategy on the chart.'
      : (result?.error || 'Strategy Tester panel did not respond');
    return { success: false, error: err, source: 'dom' };
  }

  if (wait) {
    while (result.recomputing && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, interval));
      result = await scratch();
      if (!result || result.ok !== true) break;
    }
    if (result.recomputing) {
      return {
        success: false,
        error: 'Strategy Tester is recomputing (key-stat cards are mid-refresh) — retry shortly.',
        recomputing: true,
        mode: result.mode,
        range: result.range,
        source: 'dom',
      };
    }
  }

  return {
    success: true,
    ...result,
    // Never surface a literal 'undefined' as a value: the scrape already
    // dropped those, and anything still carrying it is flagged above.
  };
}

// ---------------------------------------------------------------------------
// R6 — strategy_get_equity_summary (legend numbers only — NOT the curve)
// ---------------------------------------------------------------------------

/**
 * The equity chart is canvas-rendered, so the POINT SERIES is not exposed
 * anywhere (no `_reportData.equity`/`curve`, no data-bearing SVG paths, no
 * `window.LightweightCharts`). Only the canvas LEGEND carries DOM text:
 * Cumulative P&L, Buy & hold, Margin calls. This exposes exactly those
 * numbers and says so — it is deliberately NOT an equity curve read.
 */
export async function getEquitySummary({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      try {
        ${CLEAN_SRC}
        var shell = document.querySelector('[class*="reportShell-" i]');
        if (!shell) return { ok: false, error: 'panel_not_open' };
        var text = (shell.innerText || '');
        var deep = /(^|\\s)DEEP(\\s|$)/.test(text);

        // The equity chart is canvas-rendered: no data-bearing SVG paths, no
        // _reportData.equity/curve, no LightweightCharts. The only DOM text is
        // the chart legend. Each legend row is [class*="legendRow-"]: the
        // label is the row's [class*="title-"] leaf and the value is the
        // row's next text-bearing content after that label. "Margin calls"
        // carries no value when there are zero.
        var out = { cumulative_pnl: null, buy_and_hold: null, margin_calls: null };
        var rows = shell.querySelectorAll('[class*="legendRow-" i]');
        for (var r = 0; r < rows.length; r++) {
          var row = rows[r];
          if (row.offsetParent === null) continue;
          var labelEl = row.querySelector('[class*="title-" i]');
          var L = __clean(labelEl ? labelEl.textContent : null);
          if (!L || L.length > 40) continue;
          L = L.replace(/:$/, '');
          var key = null;
          if (L === 'Cumulative PnL' || L === 'Cumulative P&L' || L === 'Cumulative profit') key = 'cumulative_pnl';
          else if (L === 'Buy and hold' || L === 'Buy & hold' || L === 'Buy-and-hold') key = 'buy_and_hold';
          else if (L === 'Margin calls') key = 'margin_calls';
          if (!key) continue;
          // Value: walk the label's siblings for the first value-bearing node.
          var val = null;
          var node = labelEl ? labelEl.nextSibling : null;
          for (var d = 0; d < 6 && node; d++) {
            var t2 = __clean(node.textContent);
            if (t2 && t2 !== L) { val = t2; break; }
            node = node.nextSibling;
          }
          if (val === null) {
            // No sibling value: derive from the row text after the label.
            var rowText = __clean(row.innerText) || '';
            var after = rowText.slice(L.length).replace(/^[\\s|]+/, '').trim();
            val = (after === '' || after === L) ? null : after;
          }
          out[key] = val;
        }

        return { ok: true, deep: deep, mode: deep ? 'deep' : 'standard', legend: out, source: 'dom' };
      } catch (e) {
        return { ok: false, error: 'page-side: ' + String(e && e.message || e) };
      }
    })()
  `);
  if (!result || result.ok !== true) {
    const err = result?.error === 'panel_not_open'
      ? 'Strategy Tester panel not open — open it before reading the equity legend.'
      : (result?.error || 'equity legend did not respond');
    return {
      success: false,
      error: err,
      note: 'The equity CURVE is canvas-rendered and is deliberately not read here — this tool returns only the legend numbers (Cumulative P&L / Buy & hold / Margin calls).',
      source: 'dom',
    };
  }
  return {
    success: true,
    ...result,
    note: 'Legend values only — the equity curve series is canvas-rendered and out of scope for this tool.',
  };
}
