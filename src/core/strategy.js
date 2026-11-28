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
  if (from > to) throw new Error('from must be on or before to.');
  const { evaluate, getClient } = _resolve(_deps);

  // ── Verified calendar-walk algorithm (live-verified against TV 3.5.1) ──
  // The shipped 2026 implementation was a no-op against TV 3.5.1 for three
  // confirmed reasons:
  //   1. stale container selector — the panel is now `[class*="reportShell-"]`
  //      inside `.bottom-widgetbar-content.backtesting`; the old
  //      `[class*="strategy-tester" i]` selectors match nothing.
  //   2. the missing "Custom date range" menu step — the range button opens a
  //      Testing-period menu; the calendar modal only mounts after that item
  //      is clicked.
  //   3. `Select` stays aria-disabled=true until a calendar DAY CELL is
  //      clicked — filling the two YYYY-MM-DD text fields alone is rejected.
  // Plus two walk-time hazards:
  //   - there is no month/year picker; reaching an arbitrary month means
  //     clicking the prev/next arrows N times, and the displayed month is
  //     readable only from the arrow's aria-label ("Next month, March 2010").
  //   - day cells must be matched on aria-label ("Sunday 1 January 2023");
  //     the `another-month-*` class flag is inverted/unreliable.
  //   - the calendar jumps to the END month after the start day is picked,
  //     so every month read must be re-taken after each click.


  // Page-side helpers for the calendar modal (verified live on TV 3.5.1).

  // Native-setter write + React-friendly events. One field per evaluate: a
  // combined write gets clobbered by TradingView's re-render.
  const setDateInput = (index, value) => evaluate(`
    (function() {
      var ins = [].slice.call(document.querySelectorAll('input[placeholder="YYYY-MM-DD"]'))
        .filter(function (i) { return i.offsetParent !== null; });
      var el = ins[${index}];
      if (!el) return { ok: false, error: 'visible date input #${index} not found' };
      el.focus();
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return { ok: true, value: el.value };
    })()
  `);

  // Click a calendar day cell by aria-label ("Wednesday 1 December 2024").
  // Matched on the full label because the `another-month-*` class is
  // inverted/unreliable and the visible text is just the day number.
  const clickDayCell = (ariaLabel) => evaluate(`
    (function() {
      var target = ${JSON.stringify(ariaLabel)};
      var els = [].slice.call(document.querySelectorAll('button, [role="button"]'));
      for (var i = 0; i < els.length; i++) {
        if (els[i].offsetParent === null) continue;
        var aria = els[i].getAttribute('aria-label') || '';
        if (aria !== target) continue;
        els[i].click();
        return { ok: true, aria: aria };
      }
      return { ok: false, error: 'day cell not found: ' + target };
    })()
  `);

  // Which field the calendar is currently editing (start=0 / end=1). The
  // visible day grid follows the field with focus, so this is what decides
  // which month is on screen.

  // The month shown by the calendar, read from the flip arrow's aria-label:
  // "Next month, March 2010" => February 2010; "Previous month, ..." => +1.
  const shownMonth = () => evaluate(`
    (function() {
      var arrows = [].slice.call(document.querySelectorAll('button, [role="button"]'));
      for (var i = 0; i < arrows.length; i++) {
        if (arrows[i].offsetParent === null) continue;
        var aria = arrows[i].getAttribute('aria-label') || '';
        var m = aria.match(/^(Next|Previous)\\s+month,\\s+(.+?)\\s+((?:19|20)\\d{2})$/i);
        if (!m) continue;
        var dir = m[1].toLowerCase() === 'next' ? -1 : 1;
        var mon = { january: 1, jan: 1, february: 2, feb: 2, march: 3, mars: 3,
          april: 4, avr: 4, avril: 4, may: 5, mai: 5, june: 6, juin: 6,
          july: 7, juil: 7, juillet: 7, august: 8, aout: 8, aoo\\u00fbt: 8,
          sep: 9, sept: 9, september: 9, septembre: 9, october: 10, oct: 10,
          octobre: 10, november: 11, nov: 11, novembre: 11, december: 12,
          dec: 12, decembre: 12 }[m[2].toLowerCase().normalize('NFD')
            .replace(/[\\u0300-\\u036f]/g, '').replace(/[.,]$/, '')];
        if (!mon) continue;
        var idx = Number(m[3]) * 12 + (mon - 1) + dir;
        return { year: Math.floor(idx / 12), month: (idx % 12) + 1, arrow: aria };
      }
      return null;
    })()
  `);

  // Walk the calendar to (y, m) using the flip arrows. Re-reads the month
  // after every click — a stale read walks the wrong way.
  const walkToMonth = async (y, m) => {
    for (let steps = 0; steps < 400; steps++) {
      const cur = await shownMonth();
      if (!cur) return { ok: false, error: 'calendar flip arrows not found — cannot walk to the target month' };
      const delta = (y - cur.year) * 12 + (m - cur.month);
      if (delta === 0) return { ok: true, steps };
      const ok = await evaluate(`
        (function() {
          var dir = ${delta > 0 ? '"next"' : '"previous"'};
          var els = [].slice.call(document.querySelectorAll('button, [role="button"]'));
          for (var i = 0; i < els.length; i++) {
            if (els[i].offsetParent === null) continue;
            var aria = els[i].getAttribute('aria-label') || '';
            if (aria.toLowerCase().indexOf(dir + ' month,') === 0) { els[i].click(); return true; }
          }
          return false;
        })()
      `);
      if (!ok) return { ok: false, error: 'calendar arrow click made no progress' };
      await new Promise(r => setTimeout(r, 120));
    }
    return { ok: false, error: 'calendar walk did not converge after 400 arrow clicks' };
  };

  // Full day-cell selection: focus the field, type the date (which drives the
  // calendar to that month), walk the arrows if the field does not own the
  // grid, then click the exact day cell. Verified live for both endpoints.
  const pickDay = async (fieldIndex, dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthsLong = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const wd = weekdays[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    const ariaLabel = wd + ' ' + d + ' ' + monthsLong[m - 1] + ' ' + y;

    const focused = await evaluate(String.raw`
      (function() {
        var ins = [].slice.call(document.querySelectorAll('input[placeholder="YYYY-MM-DD"]'))
          .filter(function (i) { return i.offsetParent !== null; });
        var el = ins[${fieldIndex}];
        if (!el) return false;
        el.click();
        el.focus();
        return document.activeElement === el;
      })()
    `);
    if (!focused) return { ok: false, error: 'could not focus date input #' + fieldIndex };

    const written = await setDateInput(fieldIndex, dateStr);
    if (!written.ok) return written;
    await new Promise(r => setTimeout(r, 500));

    // Typing drives the calendar to the typed month. If it did not (e.g. the
    // field is not the calendar's owner), walk the arrows as a fallback.
    const shown = await shownMonth();
    if (!shown || shown.year !== y || shown.month !== m) {
      const walk = await walkToMonth(y, m);
      if (!walk.ok) return walk;
    }
    const hit = await clickDayCell(ariaLabel);
    if (!hit.ok) return hit;
    return { ok: true, aria: ariaLabel, written: written.value };
  };


  // Step 1 — ensure the panel is open.
  const ensurePanel = await evaluate(`
    (function() {
      var shell = document.querySelector('[class*="reportShell-" i]');
      if (shell && shell.offsetParent !== null) return { open: true };
      var opener = document.querySelector('button[aria-label="Open strategy report"], [aria-label="Open strategy report"]');
      if (!opener) return { open: false, error: 'panel closed and no "Open strategy report" button found' };
      var r = opener.getBoundingClientRect();
      return { open: false, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dpr: window.devicePixelRatio || 1 };
    })()
  `);
  if (!ensurePanel.open) {
    if (ensurePanel.error) return { success: false, error: ensurePanel.error };
    const c = await getClient();
    const ex = Math.round(ensurePanel.x * ensurePanel.dpr);
    const ey = Math.round(ensurePanel.y * ensurePanel.dpr);
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: ex, y: ey, button: 'left', clickCount: 1 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: ex, y: ey, button: 'left' });
    await new Promise(r => setTimeout(r, 600));
  }

  // Step 2 — open the Testing-period menu (range button, real mouse event:
  // the button doubles as the panel-collapse control, .click() is unsafe).
  const rangeBtn = await evaluate(`
    (function() {
      var shell = document.querySelector('[class*="reportShell-" i]');
      if (!shell) return { ok: false, error: 'strategy-tester container not found — is the panel open?' };
      var btns = [].slice.call(shell.querySelectorAll('button, [role="button"]'));
      var rangeShape = /\\b(19|20)\\d{2}\\b[\\s\\S]{1,60}[—\\-–][\\s\\S]{1,60}\\b(19|20)\\d{2}\\b/;
      var presetShape = /(^|\\s)(last\\s+\\d+\\s+days|entire\\s+history)($|\\s)/i;
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].offsetParent === null) continue;
        var aria = btns[i].getAttribute('aria-label') || '';
        var txt = (btns[i].textContent || '').trim();
        if ((rangeShape.test(aria) || rangeShape.test(txt) || presetShape.test(' ' + txt + ' ') || /days|history/i.test(aria))) {
          var r = btns[i].getBoundingClientRect();
          return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dpr: window.devicePixelRatio || 1, text: txt };
        }
      }
      return { ok: false, error: 'date range button not found in strategy tester' };
    })()
  `);
  if (!rangeBtn.ok) return { success: false, error: rangeBtn.error };
  {
    const c = await getClient();
    const rx = Math.round(rangeBtn.x * rangeBtn.dpr);
    const ry = Math.round(rangeBtn.y * rangeBtn.dpr);
    await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: rx, y: ry });
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: rx, y: ry, button: 'left', clickCount: 1 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: rx, y: ry, button: 'left' });
    await new Promise(r => setTimeout(r, 700));
  }

  // Step 3 — click "Custom date range" so the calendar modal mounts.
  const customItem = await evaluate(`
    (function() {
      var shell = document.querySelector('[class*="reportShell-" i]');
      var titles = document.querySelectorAll('[class*="title-" i]');
      for (var i = 0; i < titles.length; i++) {
        var el = titles[i];
        if (el.offsetParent === null) continue;
        if (shell && shell.contains(el)) continue; // panel-internal labels
        var tx = (el.innerText || el.textContent || '').trim();
        // Structure-based match (i18n-safe): the "Custom date range" menu
        // row is a [class*="middle-"] button carrying a [class*="title-"]
        // label; the English text is only a secondary signal.
        var row = el.closest('[class*="middle-" i]');
        if (row && /custom/i.test(tx)) {
          var r = row.getBoundingClientRect();
          return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dpr: window.devicePixelRatio || 1 };
        }
      }
      return { ok: false, error: '"Custom date range" menu item not found — is the Testing-period menu open?' };
    })()
  `);
  if (!customItem.ok) return { success: false, error: customItem.error };
  {
    const c = await getClient();
    const cx = Math.round(customItem.x * customItem.dpr);
    const cy = Math.round(customItem.y * customItem.dpr);
    await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: cx, y: cy });
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left' });
  }

  // Step 4 — wait for the two YYYY-MM-DD inputs to mount.
  let inputsReady = false;
  for (let i = 0; i < 20; i++) {
    inputsReady = await evaluate(`
      (function() {
        var ins = document.querySelectorAll('input[placeholder="YYYY-MM-DD"]');
        var n = 0;
        for (var i = 0; i < ins.length; i++) if (ins[i].offsetParent !== null) n++;
        return n >= 2;
      })()
    `);
    if (inputsReady) break;
    await new Promise(r => setTimeout(r, 250));
  }
  if (!inputsReady) {
    return { success: false, error: 'calendar modal did not open (no YYYY-MM-DD inputs found after clicking "Custom date range")' };
  }

  // Step 5 — anchor the start at "Select first available date". Without this
  // the day cells stay disabled and Select never enables; with it the inputs
  // get seeded to the first available date and the day grid becomes clickable.
  const anchored = await evaluate(`
    (function() {
      var btns = [].slice.call(document.querySelectorAll('button, [role="button"]'));
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null) continue;
        if (/first available/i.test(b.textContent || '')) { b.click(); return { ok: true }; }
      }
      return { ok: false, error: '"Select first available date" button not found' };
    })()
  `);
  if (!anchored.ok) return { success: false, error: anchored.error };
  await new Promise(r => setTimeout(r, 400));

  // Step 6 — pick the start day cell. Typing into the focused start field
  // drives the calendar to that month, then the exact day cell is clicked.
  const startPick = await pickDay(0, from);
  if (!startPick.ok) return { success: false, error: startPick.error, stage: 'pick-start-day' };
  // After the start day is picked the calendar jumps to the END month, so the
  // end pick must re-focus and re-read rather than trust the previous state.
  await new Promise(r => setTimeout(r, 400));
  const endPick = await pickDay(1, to);
  if (!endPick.ok) return { success: false, error: endPick.error, stage: 'pick-end-day' };
  await new Promise(r => setTimeout(r, 300));

  // Step 7 — Select is only enabled once a day cell has been clicked. Read the
  // submitted field values back: TradingView silently clamps an end date that
  // falls outside the available chart range (e.g. 2026-12-31 → 2026-11-27),
  // so the committed range must be reported from the DOM, not the request.
  const submitted = await evaluate(`
    (function() {
      var ins = [].slice.call(document.querySelectorAll('input[placeholder="YYYY-MM-DD"]'))
        .filter(function (i) { return i.offsetParent !== null; });
      var btns = [].slice.call(document.querySelectorAll('button, [role="button"]'));
      var select = null;
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].offsetParent === null) continue;
        if (/^(Select|S\u00e9lectionner|Selectionner|Appliquer|Apply|OK)$/i.test((btns[i].textContent || '').trim())) {
          select = btns[i];
          break;
        }
      }
      return { from: ins[0] ? ins[0].value : null, to: ins[1] ? ins[1].value : null,
        hasSelect: !!select, selected: !!(select && !(select.disabled || select.getAttribute('aria-disabled') === 'true')),
        selectText: select ? (select.textContent || '').trim() : null };
    })()
  `);
  if (!submitted.hasSelect) return { success: false, error: 'submit button not found in the calendar modal' };
  if (!submitted.selected) {
    return {
      success: false,
      error: 'Select button still disabled after day-cell clicks — the requested dates are outside the available chart range',
      stage: 'select-disabled',
      set_inputs: { from: submitted.from, to: submitted.to },
    };
  }
  // Snapshot BEFORE the Select click so the before/after comparison is real.
  const beforeEvidence = await readDeepStats({ _deps });

  // Step 8 — commit. Re-query the button (not the earlier read) so a
  // re-render between the check and the click cannot hit a detached node.
  const committed = await evaluate(`
    (function() {
      var btns = [].slice.call(document.querySelectorAll('button, [role="button"]'));
      for (var b = 0; b < btns.length; b++) {
        if (btns[b].offsetParent === null) continue;
        if (!/^(Select|S\\u00e9lectionner|Selectionner|Appliquer|Apply|OK)$/i.test((btns[b].textContent || '').trim())) continue;
        btns[b].click();
        return true;
      }
      return false;
    })()
  `);
  if (!committed) return { success: false, error: 'calendar modal closed before the Select button could be clicked' };

  // Step 9 — verify the stats actually moved. A deep re-run is async (16
  // years took ~20 s live), so poll the panel for the new range and
  // non-recomputing stats. beforeEvidence was captured above, before Select
  // was clicked, so `stats_moved` is a real before/after rather than two
  // post-commit reads.
  // Exit only when the header range BOTH matches the request AND the stats
  // have stopped moving (two consecutive identical reads). TradingView
  // updates the header label first and re-renders the stat cards a moment
  // later, so a range-only match returns stale values.
  const deadline = Date.now() + 90000;
  const wantFrom = new Date(from + 'T00:00:00Z')
    .toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  const wantTo = new Date(to + 'T00:00:00Z')
    .toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  const fromDay = wantFrom.slice(0, wantFrom.lastIndexOf(', ')); // "Mar 1"
  let afterEvidence = null;
  let settledReads = 0;
  let prevKey = null;
  for (;;) {
    await new Promise(r => setTimeout(r, 2000));
    const snap = await readDeepStats({ wait: false, _deps });
    if (snap.success && !snap.recomputing) {
      afterEvidence = snap;
      const rangeText = String(snap.range || '').replace(/\s+/g, ' ');
      const key = JSON.stringify(snap.key_stats);
      if (key === prevKey) settledReads += 1; else settledReads = 0;
      prevKey = key;
      const rangeMatches = rangeText.includes(fromDay) || rangeText.includes(wantTo);
      // Settle only matters when the stats actually changed; if the request
      // reproduces the current range the values are already final.
      const differs = key !== JSON.stringify(beforeEvidence.key_stats || {});
      if (rangeMatches && (!differs || settledReads >= 1)) break;
    }
    if (Date.now() > deadline) break;
  }


  const statsMoved = beforeEvidence.success && afterEvidence.success &&
    JSON.stringify(beforeEvidence.key_stats) !== JSON.stringify(afterEvidence.key_stats);

  return {
    success: true,
    requested: { from, to },
    set_inputs: { from: submitted.from, to: submitted.to },
    submit_button: submitted.selectText,
    display_range: afterEvidence?.range || null,
    evidence: {
      before: beforeEvidence.success ? { total_pnl: beforeEvidence.key_stats?.['Total PnL'] ?? null, trade_count: beforeEvidence.trade_count, range: beforeEvidence.range } : null,
      after: afterEvidence?.success ? { total_pnl: afterEvidence.key_stats?.['Total PnL'] ?? null, trade_count: afterEvidence.trade_count, range: afterEvidence.range, mode: afterEvidence.mode } : null,
      stats_moved: statsMoved,
      note: statsMoved
        ? 'Stats demonstrably moved between the two reads — the range change took effect.'
        : 'Stats did not change between reads (the range may already have been set, or the re-run had not landed).',
    },
    note: afterEvidence?.success ? undefined : 'Range submitted but the panel was still recomputing at the poll deadline; re-run strategy_read_deep_stats to confirm.',
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

// ---------------------------------------------------------------------------
// R3 — strategy_get_deep_trades (virtualised per-trade table, scroll/collect)
// ---------------------------------------------------------------------------

/**
 * Read the per-trade table on the Strategy Tester's "List of trades" tab.
 *
 * The table is VIRTUALISED: only ~12 of N rows are in the DOM at a time, so
 * a single scrape misses the rest. This tool:
 *   1. clicks the trade-list header tab (real CDP mouse, not .click());
 *   2. reads the visible rows;
 *   3. scrolls the table's container down, re-reads, and de-dupes by
 *      trade number until scrolling stops producing new rows;
 *   4. returns the collected rows in the panel's own (newest-first) order.
 *
 * The `max_trades` cap limits how many rows are returned. When the panel
 * shows the STANDARD backtest the trade count is small and the loop
 * terminates after one or two scrolls — the same scrape works in both modes.
 * The empty-table case (a range with zero trades) returns trade_count: 0
 * with an explanatory note rather than an error.
 */
export async function getDeepTrades({ max_trades = 500, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const cap = Math.max(1, Math.min(Number(max_trades) || 500, 5000));

  // Step 1 — switch the panel to the trade-list tab. The two unlabeled icon
  // tabs in the header: index 0 = performance/summary, index 1 = trade list.
  // Use a real mouse event at the tab's centre so the panel's React handler
  // fires; a stray .click() on the range button would collapse the panel.
  const tabClicked = await evaluate(`
    (function() {
      try {
        var shell = document.querySelector('[class*="reportShell-" i]');
        if (!shell) return { ok: false, error: 'panel_not_open' };
        var tabs = [].slice.call(shell.querySelectorAll('[role="tab"]'));
        // The summary/trade-list tabs are the small icon tabs near the top
        // of the panel (height < 60, and not the analysis sub-tabs which are
        // lower on the page).
        var iconTabs = tabs.filter(function (b) {
          var r = b.getBoundingClientRect();
          return r.height > 0 && r.height < 60 && r.width < 60 && b.offsetParent !== null;
        });
        if (iconTabs.length < 2) return { ok: false, error: 'trade-list tab not found' };
        var target = iconTabs[1]; // index 1 = List of trades
        var r2 = target.getBoundingClientRect();
        // Report coordinates; the mouse event is dispatched by the caller
        // so a single evaluate doesn't mix a read and a side-effect. The
        // devicePixelRatio is included because CDP mouse events are
        // device-pixel but getBoundingClientRect is CSS-pixel.
        return { ok: true, x: Math.round(r2.x + r2.width / 2), y: Math.round(r2.y + r2.height / 2), dpr: window.devicePixelRatio || 1 };
      } catch (e) {
        return { ok: false, error: 'page-side: ' + String(e && e.message || e) };
      }
    })()
  `);
  if (!tabClicked || tabClicked.ok !== true) {
    const err = tabClicked?.error === 'panel_not_open'
      ? 'Strategy Tester panel not open — open it before reading the trade list.'
      : (tabClicked?.error || 'could not locate the trade-list tab');
    return { success: false, error: err, source: 'dom' };
  }

  // Click the tab with a real CDP mouse event, scaled CSS→device pixels
  // (dispatchMouseEvent expects device pixels; a CSS-pixel click misses on
  // HiDPI displays — see ui.js mouseClick).
  {
    const { x, y, dpr } = tabClicked;
    const { getClient } = _resolve(_deps);
    const client = await getClient();
    const dx = Math.round(x * (dpr || 1));
    const dy = Math.round(y * (dpr || 1));
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: dx, y: dy });
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: dx, y: dy, button: 'left', buttons: 1, clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: dx, y: dy, button: 'left' });
  }
  await new Promise(r => setTimeout(r, 800));

  const scrape = async () => evaluate(`
    (function() {
      try {
        ${CLEAN_SRC}
        var shell = document.querySelector('[class*="reportShell-" i]');
        if (!shell) return { ok: false, error: 'panel_not_open' };
        var text = (shell.innerText || '');
        var deep = /(^|\\s)DEEP(\\s|$)/.test(text);

        // Find the virtualised table: a <table> inside the panel whose header
        // row is the trade-list columns.
        var tables = shell.querySelectorAll('table');
        var table = null;
        for (var i = 0; i < tables.length; i++) {
          var head = (tables[i].querySelector('thead') || tables[i]).textContent;
          if (/Trade number/i.test(head)) { table = tables[i]; break; }
        }
        if (!table) return { ok: true, deep: deep, mode: deep ? 'deep' : 'standard', rows: [], empty: true, source: 'dom' };

        // Scroll container: the nearest scrollable ancestor of the table.
        var scroller = null;
        var sc = table;
        while (sc && sc !== shell) {
          if (sc.scrollHeight > sc.clientHeight + 4) { scroller = sc; break; }
          sc = sc.parentElement;
        }

        // Read the visible rows, splitting each cell on newline so the
        // exit/entry pair stays intact.
        var headerCells = [].slice.call(table.querySelectorAll('thead th')).map(function (c) { return (c.textContent || '').trim(); });
        var rows = [];
        [].slice.call(table.querySelectorAll('tbody tr')).forEach(function (tr) {
          var cells = [].slice.call(tr.querySelectorAll('td')).map(function (c) {
            return (c.innerText || '').split('\\n').map(function (x) { return x.trim(); }).filter(Boolean).join(' | ');
          });
          if (cells.length) rows.push(cells);
        });

        // Report the trade-count footer when present (the "List of trades"
        // header states the total), plus the scroll position for the caller.
        var total = null;
        var m = text.match(/List of trades\\s*([0-9][0-9,]*)/i);
        if (m) total = m[1];

        return {
          ok: true,
          deep: deep,
          mode: deep ? 'deep' : 'standard',
          headers: headerCells,
          rows: rows,
          total: total,
          scroll: scroller ? { top: scroller.scrollTop, height: scroller.clientHeight, scrollHeight: scroller.scrollHeight } : null,
          source: 'dom',
        };
      } catch (e) {
        return { ok: false, error: 'page-side: ' + String(e && e.message || e) };
      }
    })()
  `);

  const first = await scrape();
  if (!first || first.ok !== true) {
    return {
      success: false,
      error: first?.error === 'panel_not_open'
        ? 'Strategy Tester panel not open — open it before reading the trade list.'
        : (first?.error || 'trade-list scrape failed'),
      source: 'dom',
    };
  }
  if (first.empty) {
    return {
      success: true,
      mode: first.mode,
      deep: first.deep,
      trade_count: 0,
      collected: 0,
      headers: first.headers || [],
      trades: [],
      empty: true,
      note: 'The per-trade table has no rows for the current range (zero closed trades).',
      source: 'dom',
    };
  }

  // Scroll/collect loop. De-dupe by the trade-number column (index 0) which
  // is unique even though rows show an exit/entry pair.
  const collected = {};
  const order = [];
  const ingest = (rows) => {
    for (const row of rows) {
      const id = String(row[0] || '');
      if (!id || collected[id]) continue;
      collected[id] = row;
      order.push(id);
    }
  };
  ingest(first.rows);

  // Total trade count from the footer if available — lets us stop early
  // without scrolling the whole virtualised list when it is tiny.
  let knownTotal = null;
  if (first.total) knownTotal = Number(first.total.replace(/[^\d]/g, ''));

  let scroller = first.scroll;
  let guard = 0;
  const MAX_SCROLLS = 400; // hard cap so a mis-detected scroller can't hang.
  while (scroller && guard < MAX_SCROLLS) {
    const full = knownTotal && Object.keys(collected).length >= knownTotal;
    if (full || Object.keys(collected).length >= cap) break;
    // Scroll one viewport down and re-read.
    await evaluate(`
      (function() {
        var shell = document.querySelector('[class*="reportShell-" i]');
        if (!shell) return false;
        var table = null;
        var tables = shell.querySelectorAll('table');
        for (var i = 0; i < tables.length; i++) {
          if (/Trade number/i.test((tables[i].querySelector('thead') || tables[i]).textContent)) { table = tables[i]; break; }
        }
        var sc = table;
        while (sc && sc !== shell) {
          if (sc.scrollHeight > sc.clientHeight + 4) break;
          sc = sc.parentElement;
        }
        if (!sc) return false;
        // Kendo's virtual grid re-renders lazily: a small scroll step settles
        // back onto the same window of rows and the loop makes no progress.
        // Jump two viewports at a time and let it settle — the de-dupe in the
        // collector absorbs the overlap between windows.
        sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + sc.clientHeight * 2);
        sc.dispatchEvent(new Event('scroll', { bubbles: true }));
        return true;
      })()
    `);
    await new Promise(r => setTimeout(r, 450));
    const probe = await scrape();
    if (!probe || probe.ok !== true || probe.empty) break;
    const before = Object.keys(collected).length;
    ingest(probe.rows);
    // No progress AND we are not at the bottom → stop. No progress at the
    // bottom means the list is fully drained.
    const atBottom = scroller && scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 10;
    if (Object.keys(collected).length === before && atBottom) break;
    if (Object.keys(collected).length === before && !atBottom && guard > 2) break;
    scroller = probe.scroll;
    guard++;
  }

  const trades = order
    .map((id) => collected[id])
    .slice(0, cap)
    .map((row) => {
      const out = {};
      const headers = first.headers || [];
      headers.forEach((h, i) => { out[h] = row[i] ?? null; });
      out.Trade_number = row[0];
      return out;
    });

  return {
    success: true,
    deep: first.deep,
    mode: first.mode,
    source: 'dom',
    trade_count: knownTotal || trades.length,
    collected: trades.length,
    headers: first.headers || [],
    trades,
    note: knownTotal && knownTotal > trades.length
      ? `collected ${trades.length} of ${knownTotal} (cap ${cap}); scroll the panel to read the rest.`
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// R4 — strategy_set_broker_settings (Settings gear → 7 inputs → Ok → read-back)
// ---------------------------------------------------------------------------

/**
 * Broker-emulator settings fields, in the deterministic on-screen order the
 * Settings dialog exposes them (verified live against TV 3.5.1 — the labels
 * are NOT in each input's ancestor chain, so the mapping is positional):
 *
 *   0 initial_capital   (USD)
 *   1 order_size        (% of equity or contracts)
 *   2 pyramiding        (number)
 *   3 commission        (value; unit is a separate dropdown: Percent/Contract)
 *   4 long_leverage     ("1x" style)
 *   5 short_leverage    ("1x" style)
 *   6 slippage          (ticks)
 *
 * The tool opens the gear, writes the requested fields via the React-friendly
 * value setter (each in its own evaluate — a single multi-write is
 * clobbered by React's re-render), reads every field back, then commits
 * with Ok. Values that did not take are reported in `mismatches` and the
 * call returns success:false (the dialog is left open so it can be fixed).
 */
const BROKER_FIELDS = [
  'initial_capital',
  'order_size',
  'pyramiding',
  'commission',
  'long_leverage',
  'short_leverage',
  'slippage',
];

export async function setBrokerSettings({ initial_capital, order_size, pyramiding, commission, long_leverage, short_leverage, slippage, _deps } = {}) {
  const { evaluate } = _resolve(_deps);

  // Normalise the requested writes.
  const requested = {};
  for (const f of BROKER_FIELDS) {
    const v = { initial_capital, order_size, pyramiding, commission, long_leverage, short_leverage, slippage }[f];
    if (v !== undefined) requested[f] = String(v).trim();
  }
  const requestedKeys = Object.keys(requested);
  if (requestedKeys.length === 0) {
    throw new Error('setBrokerSettings: pass at least one of initial_capital, order_size, pyramiding, commission, long_leverage, short_leverage, slippage.');
  }

  const fieldIndex = {};
  BROKER_FIELDS.forEach((f, i) => { fieldIndex[f] = i; });
  const writes = requestedKeys.map((f) => ({ field: f, index: fieldIndex[f], value: requested[f] }));

  // Step 1 — open the Settings gear (a real mouse event; a stray .click()
  // in the panel can collapse the Strategy Tester).
  const gear = await evaluate(`
    (function() {
      try {
        var shell = document.querySelector('[class*="reportShell-" i]');
        if (!shell) return { ok: false, error: 'panel_not_open' };
        // If a settings dialog is already open (previous call left it there),
        // reuse it — no need to re-open.
        var dlg = document.querySelector('[role="dialog"], [data-dialog-name]');
        var inputs = dlg ? [].slice.call(dlg.querySelectorAll('input')) : [];
        if (inputs.some(function (i) { return i.offsetParent !== null && i.getBoundingClientRect().width > 0; })) {
          return { ok: true, already_open: true };
        }
        var btns = [].slice.call(shell.querySelectorAll('button, [role="button"]'));
        var gearBtn = btns.find(function (b) {
          return b.offsetParent !== null && (b.getAttribute('aria-label') || '') === 'Settings';
        });
        if (!gearBtn) return { ok: false, error: 'Settings button not found in the Strategy Tester header' };
        var r = gearBtn.getBoundingClientRect();
        return {
          ok: true,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          dpr: window.devicePixelRatio || 1,
        };
      } catch (e) {
        return { ok: false, error: 'page-side: ' + String(e && e.message || e) };
      }
    })()
  `);
  if (!gear || gear.ok !== true) {
    const err = gear?.error === 'panel_not_open'
      ? 'Strategy Tester panel not open — open it before changing broker settings.'
      : (gear?.error || 'could not open the Settings dialog');
    return { success: false, error: err, source: 'dom' };
  }
  if (!gear.already_open) {
    const { getClient } = _resolve(_deps);
    const client = await getClient();
    const dx = Math.round(gear.x * gear.dpr);
    const dy = Math.round(gear.y * gear.dpr);
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: dx, y: dy });
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: dx, y: dy, button: 'left', buttons: 1, clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: dx, y: dy, button: 'left' });
  }

  // Step 2 — wait for the dialog's inputs to mount.
  let dialogReady = false;
  for (let i = 0; i < 20; i++) {
    dialogReady = await evaluate(`
      (function() {
        var dlg = document.querySelector('[role="dialog"], [data-dialog-name]');
        if (!dlg) return 0;
        var n = 0;
        for (var i = 0; i < dlg.querySelectorAll('input').length; i++) {
          var el = dlg.querySelectorAll('input')[i];
          if (el.offsetParent !== null && el.getBoundingClientRect().width > 0) n++;
        }
        return n;
      })()
    `);
    if (Number(dialogReady) >= 7) { dialogReady = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!dialogReady) {
    return {
      success: false,
      error: 'Settings dialog did not expose its inputs (expected 7 visible fields)',
      source: 'dom',
    };
  }

  // Step 3 — write each requested field. One evaluate per field: React's
  // re-render clobbers a multi-field write that lands in the same tick.
  const before = {};
  const writeProbes = [];
  for (const w of writes) {
    const beforeVal = await evaluate(`
      (function() {
        var dlg = document.querySelector('[role="dialog"], [data-dialog-name]');
        if (!dlg) return null;
        var vis = [].slice.call(dlg.querySelectorAll('input')).filter(function (i) {
          return i.offsetParent !== null && i.getBoundingClientRect().width > 0;
        });
        return vis[${w.index}] ? vis[${w.index}].value : null;
      })()
    `);
    before[w.field] = beforeVal;

    const escVal = JSON.stringify(w.value);
    const wRes = await evaluate(`
      (function() {
        var dlg = document.querySelector('[role="dialog"], [data-dialog-name]');
        if (!dlg) return { ok: false, error: 'dialog closed mid-write' };
        var vis = [].slice.call(dlg.querySelectorAll('input')).filter(function (i) {
          return i.offsetParent !== null && i.getBoundingClientRect().width > 0;
        });
        var el = vis[${w.index}];
        if (!el) return { ok: false, error: 'input ' + ${w.index} + ' not visible' };
        // React-friendly value set: bypass the native setter so React's
        // onChange handler actually fires.
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${escVal});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: el.value };
      })()
    `);
    writeProbes.push({ field: w.field, result: wRes });
    await new Promise(r => setTimeout(r, 120));
  }

  // Step 4 — read every requested field back to confirm it took.
  const readbacks = {};
  for (const w of writes) {
    readbacks[w.field] = await evaluate(`
      (function() {
        var dlg = document.querySelector('[role="dialog"], [data-dialog-name]');
        if (!dlg) return null;
        var vis = [].slice.call(dlg.querySelectorAll('input')).filter(function (i) {
          return i.offsetParent !== null && i.getBoundingClientRect().width > 0;
        });
        return vis[${w.index}] ? vis[${w.index}].value : null;
      })()
    `);
  }

  const mismatches = writes
    .filter((w) => String(readbacks[w.field] ?? '').replace(/[^0-9A-Za-z.]/g, '').toLowerCase() !== String(w.value).replace(/[^0-9A-Za-z.]/g, '').toLowerCase())
    .map((w) => ({ field: w.field, requested: w.value, read_back: readbacks[w.field] }));

  // Step 5 — commit with Ok only when everything took.
  let committed = false;
  if (mismatches.length === 0) {
    const commitRes = await evaluate(`
      (function() {
        var dlg = document.querySelector('[role="dialog"], [data-dialog-name]');
        if (!dlg) return { ok: false, error: 'dialog closed before commit' };
        var btns = [].slice.call(dlg.querySelectorAll('button'));
        var submit = btns.find(function (b) {
          var t = (b.textContent || '').trim();
          return /^(Ok|OK|D\u2019accord|Accepter|Appliquer|Apply|Apply)$/i.test(t) && b.offsetParent !== null;
        });
        if (!submit) return { ok: false, error: 'commit button (Ok) not found in the dialog' };
        submit.click();
        return { ok: true };
      })()
    `);
    if (!commitRes || commitRes.ok !== true) {
      return {
        success: false,
        error: commitRes?.error || 'could not commit the Settings dialog',
        readbacks,
        mismatches: [],
        before,
        source: 'dom',
      };
    }
    await new Promise(r => setTimeout(r, 500));
    committed = true;
  }

  return {
    success: mismatches.length === 0,
    committed,
    applied: committed ? readbacks : null,
    readbacks,
    before,
    mismatches,
    note: mismatches.length
      ? 'some fields did not take (leverage fields may need a "1x"-shaped value; commission unit is a separate dropdown). The dialog was left open — fix the values and commit manually, or retry with corrected input.'
      : undefined,
    source: 'dom',
  };
}
