/**
 * Core chart control logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite, getClient as _getClient, disconnect as _disconnect } from '../connection.js';
import { waitForChartReady as _waitForChartReady, waitForStudiesReady as _waitForStudiesReady } from '../wait.js';
import { dismissBlockingDialogs as _dismissBlockingDialogs } from './dialog.js';
import { openScript as _openScript, smartCompile as _smartCompile } from './pine.js';
import { captureScreenshot as _captureScreenshot, dismissBlockingOverlays as _dismissBlockingOverlays } from './capture.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
    waitForStudiesReady: deps?.waitForStudiesReady || _waitForStudiesReady,
    dismissBlockingDialogs: deps?.dismissBlockingDialogs || _dismissBlockingDialogs,
    getClient: deps?.getClient || _getClient,
    disconnect: deps?.disconnect || _disconnect,
    captureScreenshot: deps?.captureScreenshot || _captureScreenshot,
    dismissBlockingOverlays: deps?.dismissBlockingOverlays || _dismissBlockingOverlays,
  };
}

// Add a user-saved Pine script to the chart by routing through the Pine
// editor. chart.createStudy() only accepts built-in study names; user
// Pine scripts must be loaded via Monaco + "Add to chart" click.
//
// Sequence: open Pine editor → fetch source from pine-facade by ID →
// inject into Monaco → click "Add to chart" via smartCompile → diff
// studies to surface the new entity_id.
async function _addUserScript({ id, _deps }) {
  const { evaluate } = _resolve(_deps);
  const beforeIds = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);

  // openScript handles "USER;<hash>" or bare hash — normalizes internally.
  const opened = await _openScript({ id, _deps });
  const compile = await _smartCompile({ _deps });

  // Studies diff to find the entity_id of the just-added script. smartCompile
  // already does this internally for honest_success purposes; trust its
  // matched_study when available, fall back to a manual diff.
  let entityId = null;
  if (compile.matched_study && compile.matched_study.id) {
    entityId = compile.matched_study.id;
  } else {
    const afterIds = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const beforeSet = new Set(beforeIds || []);
    const fresh = (afterIds || []).filter(i => !beforeSet.has(i));
    entityId = fresh[0] || null;
  }

  return {
    success: !!entityId,
    action: 'add',
    indicator: id,
    script_name: opened.name,
    entity_id: entityId,
    button_clicked: compile.button_clicked,
    pine_compile_errors: compile.errors || [],
    new_study_count: entityId ? 1 : 0,
    slot_rebound: opened.slot_rebound,
    // Surface openScript's unsafe-fallback warning rather than swallowing it:
    // the open→compile sequence here is exactly what it cautions against.
    ...(opened.warning && { pine_open_warning: opened.warning }),
    source: 'pine_facade_via_editor',
  };
}

// Hard reload the TradingView tab. Last-resort recovery when setSymbol is
// stuck in a state that dialog dismissal can't break (cumulative replay
// side effects, half-applied symbol switches). Wipes all studies, drawings,
// and replay state — caller must re-add studies after this returns.
// Mirrors the pattern in core/health.js reconnect().
async function _hardReload({ getClient, disconnect, waitForChartReady }) {
  const c = await getClient();
  try { await c.Page.reload({ ignoreCache: false }); }
  catch { /* reload can drop the CDP WS — expected */ }
  await disconnect();
  // TV needs ~3s after reload before its CDP target re-accepts attaches;
  // a tighter wait races the renderer and surfaces as a connect retry storm.
  await new Promise(r => setTimeout(r, 3000));
  await getClient();
  // 20s ceiling — TV with many studies + a slow data feed can take >10s
  // to repaint after reload. waitForChartReady polls until the loading
  // spinner clears and bar count stabilizes.
  return await waitForChartReady(null, 20000);
}

/**
 * Compare a requested symbol against the actual chart symbol. TV resolves
 * 'AAPL' to 'NASDAQ:AAPL' or 'BATS:AAPL' depending on availability, so we
 * accept any actual that matches case-insensitively after stripping the
 * exchange prefix on either side.
 */
function _symbolMatches(requested, actual) {
  if (!actual) return false;
  const norm = (s) => String(s).split(':').pop().toUpperCase();
  return norm(actual) === norm(requested);
}

export async function getState({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies,
      };
    })()
  `);
  return { success: true, ...state };
}

export async function setSymbol({ symbol, discard_unsaved = false, _deps }) {
  const { evaluate, evaluateAsync, waitForChartReady, waitForStudiesReady, dismissBlockingDialogs, getClient, disconnect } = _resolve(_deps);

  // Trigger the symbol switch; don't gate on DOM readiness here.
  // `waitForChartReady` does a DOM-legend substring match that fails when
  // the caller passes a prefixed symbol ("CME_MINI:NQU2026") while the
  // legend shows the bare form ("NQU2026") — surfaced as a false stuck
  // state on the first attempt. Authoritative check is the JS API
  // chart.symbol() poll below.
  async function _doSetSymbol() {
    await evaluateAsync(`
      (function() {
        var chart = ${CHART_API};
        return new Promise(function(resolve) {
          chart.setSymbol(${safeString(symbol)}, {});
          setTimeout(resolve, 500);
        });
      })()
    `);
  }

  // Poll chart.symbol() until it matches the requested symbol (with the
  // exchange-prefix normalization rules from _symbolMatches) or the
  // timeout elapses. Returns the final actual value either way.
  async function _waitForSymbolMatch(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let actual = await evaluate(`${CHART_API}.symbol()`);
    while (!_symbolMatches(symbol, actual) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250));
      actual = await evaluate(`${CHART_API}.symbol()`);
    }
    return actual;
  }

  // Detect the "This symbol doesn't exist" / "No data here" overlay that
  // TV draws when the chart's data fetch failed but the JS API still
  // reports the requested symbol — chart.symbol() matches, yet the user
  // sees a broken chart. Bounded text scan (length-capped, narrow
  // selectors first) keeps it cheap. Returns the matched message or null.
  async function _detectSymbolErrorOverlay() {
    try {
      return await evaluate(`
        (function() {
          var patterns = [
            /This symbol doesn'?t exist/i,
            /Symbol not found/i,
            /No data (here|available for this symbol)/i,
            /Invalid symbol/i,
          ];
          // Narrow: TV's no-data overlay sits in the chart canvas area
          // under classes like "errorCard"/"noDataHere"/"emptyState". A
          // wider scan would flood with editor and tooltip text.
          var candidates = document.querySelectorAll(
            '[class*="errorCard"], [class*="noDataHere"], [class*="emptyState"], ' +
            '[class*="error-message"], [class*="errorMessage"], [class*="noData"]'
          );
          for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            if (el.offsetParent === null) continue;
            var text = el.textContent || '';
            if (text.length > 400) continue;
            for (var p = 0; p < patterns.length; p++) {
              if (patterns[p].test(text)) return text.trim().slice(0, 200);
            }
          }
          return null;
        })()
      `);
    } catch { return null; }
  }

  // Capture pre-switch state — if we end up hard-reloading, the caller
  // needs to know what was wiped to restore studies.
  let priorStudies = [];
  try {
    priorStudies = await evaluate(`
      (function() {
        try {
          var chart = ${CHART_API};
          return (chart.getAllStudies() || []).map(function(s) {
            return { id: s.id, name: s.name || s.title || 'unknown' };
          });
        } catch(e) { return []; }
      })()
    `) || [];
  } catch { /* best effort */ }

  // "Healthy load" = JS API matches AND no error overlay is visible. The
  // overlay case is the stuck state where chart.symbol() returns the
  // requested value but TV's data fetch failed — IDEAS line 92-101.
  async function _checkHealthy(timeoutMs) {
    const actualNow = await _waitForSymbolMatch(timeoutMs);
    const overlay = _symbolMatches(symbol, actualNow) ? await _detectSymbolErrorOverlay() : null;
    return { actual: actualNow, overlay };
  }

  // First attempt — 8s window covers a typical cold contract-data fetch.
  await _doSetSymbol();
  let { actual, overlay: errorOverlay } = await _checkHealthy(8000);
  let dismissedDialogs = [];
  let hardReloaded = false;

  // If the JS API didn't reflect the change, TV likely popped a blocking
  // modal (Leave current replay / Continue your last replay / Save script
  // / unsaved changes) that absorbed the change request. Dismiss whatever's
  // open and retry once. (An error overlay alone — JS API already matches —
  // skips this step because dismissing a dialog won't refetch the chart
  // data; hard reload is the only recovery for that case.)
  if (!_symbolMatches(symbol, actual)) {
    try { dismissedDialogs = await dismissBlockingDialogs({ evaluate, discardUnsaved: !!discard_unsaved }); } catch {}
    // Refuse rather than silently discard unsaved Pine/drawing changes. The
    // dialog was detected but not clicked (blocked) because discard_unsaved
    // wasn't set — mirror layout_switch's opt-in-to-lose-work contract.
    const blocked = dismissedDialogs.find(d => d.blocked);
    if (blocked) {
      const err = new Error(
        `Switching to "${symbol}" is blocked by an unsaved-changes dialog (${blocked.note}). ` +
        `Save your work first, or pass discard_unsaved:true to switch and lose it.`
      );
      err.code = 'UNSAVED_CHANGES';
      err.requested = symbol;
      err.unsaved_changes = true;
      throw err;
    }
    await _doSetSymbol();
    ({ actual, overlay: errorOverlay } = await _checkHealthy(8000));
  }

  // Last-resort: hard reload. Triggers on either (a) JS API still wrong,
  // or (b) JS API matches but chart shows the error overlay. Page.reload
  // is the only path that consistently breaks both stuck states. Wipes
  // studies and replay state — caller is told via hard_reloaded:true.
  if (!_symbolMatches(symbol, actual) || errorOverlay) {
    try {
      await _hardReload({ getClient, disconnect, waitForChartReady });
      hardReloaded = true;
      await _doSetSymbol();
      ({ actual, overlay: errorOverlay } = await _checkHealthy(12000)); // post-reload TV is slower
    } catch (reloadErr) {
      const err = new Error(
        `setSymbol failed: requested "${symbol}" but chart symbol is "${actual}"` +
        (errorOverlay ? ` (chart shows error: "${errorOverlay}")` : '') +
        `. Hard reload also failed: ${reloadErr.message}.`
      );
      err.code = 'SYMBOL_DID_NOT_CHANGE';
      err.requested = symbol;
      err.actual = actual;
      err.dismissed_dialogs = dismissedDialogs;
      err.error_overlay = errorOverlay;
      err.hard_reload_attempted = true;
      throw err;
    }
  }

  if (!_symbolMatches(symbol, actual) || errorOverlay) {
    const err = new Error(
      `setSymbol failed: requested "${symbol}" but chart symbol is "${actual}"` +
      (errorOverlay ? ` (chart shows error: "${errorOverlay}")` : '') +
      ` even after dialog dismissal${hardReloaded ? ' and hard reload' : ''}. ` +
      `TV may be unresponsive — try tv_health_check.`
    );
    err.code = errorOverlay ? 'SYMBOL_LOAD_ERROR' : 'SYMBOL_DID_NOT_CHANGE';
    err.requested = symbol;
    err.actual = actual;
    err.dismissed_dialogs = dismissedDialogs;
    err.error_overlay = errorOverlay;
    err.hard_reloaded = hardReloaded;
    throw err;
  }

  // Best-effort DOM settle for callers about to scrape the legend/studies.
  // Not gating — chart.symbol() already confirmed the switch landed.
  const ready = await waitForChartReady(symbol);
  const studies_ready = await waitForStudiesReady();

  // After a hard reload, user-saved Pine studies often stay "inert" — TV
  // restores their layout reference (id, inputs, scriptIdPart `USER;<hash>`)
  // but never re-fetches the source from pine-facade, so the study runs
  // forever with `isRestarting:true` and produces zero output. Callers
  // about to read drawing data (data_get_pine_lines etc.) will see empty
  // results; surface the inert studies so they know to re-add via Pine
  // editor instead of debugging the read path.
  let inertStudies;
  if (hardReloaded) {
    try {
      const probe = await evaluate(`
        (function() {
          try {
            var chart = ${CHART_API}._chartWidget;
            var sources = chart.model().model().dataSources();
            var inert = [];
            for (var i = 0; i < sources.length; i++) {
              var s = sources[i];
              if (!s.metaInfo) continue;
              var meta;
              try { meta = s.metaInfo(); } catch(e) { continue; }
              if (!meta || !meta.isTVScript) continue;
              // No bar-index entries = study never executed against the
              // main series. This is the only reliable inertness signal —
              // meta.pine.source is null even for working Pine studies
              // on TV 3.1 (verified empirically; TV doesn't expose the
              // compiled source client-side), so checking !sourcePresent
              // produces false positives on healthy studies.
              var idxCount = (s._graphics && s._graphics._indexes) ? s._graphics._indexes.length : 0;
              if (idxCount === 0) {
                inert.push({
                  id: typeof s.id === 'function' ? s.id() : (s.id || null),
                  name: meta.description || meta.shortDescription || 'unknown',
                  scriptIdPart: meta.scriptIdPart || null,
                  indexes_count: idxCount,
                });
              }
            }
            return inert;
          } catch(e) { return null; }
        })()
      `);
      if (Array.isArray(probe) && probe.length > 0) inertStudies = probe;
    } catch { /* best effort */ }
  }

  return {
    success: true,
    symbol: actual,
    requested: symbol,
    chart_ready: ready,
    studies_ready,
    dismissed_dialogs: dismissedDialogs.length ? dismissedDialogs : undefined,
    hard_reloaded: hardReloaded || undefined,
    prior_studies: hardReloaded ? priorStudies : undefined,
    inert_studies: inertStudies,
    inert_studies_hint: inertStudies
      ? 'TV restored these user-saved Pine studies from layout but did not refetch their source. Re-add them via the Pine editor (open the script, click "Add to chart") to make them compute again.'
      : undefined,
  };
}

// TV's resolution() canonicalizes day/week/month as 1D/1W/1M; callers may
// pass D/W/M. Normalize both sides so a successful change isn't misread as a
// mismatch (and vice-versa). Intraday spellings collapse to TV canonical
// too: 4H/12H -> minutes (240/720), 15m/15MIN -> bare minutes (15), seconds
// words -> "<N>S". Month stays TV-canonical "<N>M" (never NMO). A bare
// uppercase "<N>M" is month-form; minutes need lowercase "m" ("15m") or an
// explicit minute word.
function _normalizeResolution(r) {
  const raw = String(r == null ? '' : r).trim();
  const s = raw.toUpperCase();
  if (s === 'D') return '1D';
  if (s === 'W') return '1W';
  if (s === 'M' || s === 'MO') return '1M';
  let m;
  if ((m = /^(\d+)\s*S(?:EC(?:OND)?S?)?$/.exec(s))) return `${Number(m[1])}S`;
  if ((m = /^(\d+)\s*H(?:R|OURS?)?$/.exec(s))) return String(Number(m[1]) * 60);
  if ((m = /^(\d+)\s*MIN(?:UTE)?S?$/.exec(s))) return String(Number(m[1]));
  if (/^\d+$/.test(s)) return String(Number(s));
  if ((m = /^(\d+)\s*D(?:AY|AYS)?$/.exec(s))) return `${Number(m[1])}D`;
  if ((m = /^(\d+)\s*W(?:EEK|EEKS)?$/.exec(s))) return `${Number(m[1])}W`;
  if ((m = /^(\d+)\s*MO(?:NTHS?)?$/.exec(s))) return `${Number(m[1])}M`;
  if ((m = /^(\d+)\s*m$/.exec(raw))) return String(Number(m[1]));
  if ((m = /^(\d+)\s*M$/.exec(s))) return `${Number(m[1])}M`;
  return s;
}

export async function setTimeframe({ timeframe, _deps }) {
  const { evaluate, waitForChartReady, waitForStudiesReady, dismissBlockingDialogs } = _resolve(_deps);
  const setResJs = `(function() { var chart = ${CHART_API}; chart.setResolution(${safeString(timeframe)}, {}); })()`;

  const before = await evaluate(`${CHART_API}.resolution()`);
  await evaluate(setResJs);
  let actual = await evaluate(`${CHART_API}.resolution()`);

  // If the resolution didn't move AND we asked for a different one, a modal
  // (Leave replay / unsaved changes) likely absorbed the change — dismiss and
  // retry once, mirroring setSymbol.
  let dismissedDialogs = [];
  let blockedUnsaved = false;
  if (actual === before && _normalizeResolution(timeframe) !== _normalizeResolution(before)) {
    // discardUnsaved:false — a timeframe change must never silently discard
    // unsaved Pine/drawing edits (this tool has no discard opt-in). The
    // "Leave replay" dialog is still dismissed; an unsaved-changes dialog is
    // left in place and reported as blocked.
    try { dismissedDialogs = await dismissBlockingDialogs({ evaluate, discardUnsaved: false }); } catch {}
    blockedUnsaved = dismissedDialogs.some(d => d.blocked);
    if (!blockedUnsaved) {
      await evaluate(setResJs);
      actual = await evaluate(`${CHART_API}.resolution()`);
    }
  }

  const ready = await waitForChartReady(null);
  const studies_ready = await waitForStudiesReady();
  const matched = _normalizeResolution(timeframe) === _normalizeResolution(actual);
  return {
    success: true,
    timeframe: actual,          // the ACTUAL resolution, not the requested string
    requested: timeframe,
    changed: actual !== before,
    chart_ready: ready,
    studies_ready,
    dismissed_dialogs: dismissedDialogs.length ? dismissedDialogs : undefined,
    unsaved_changes: blockedUnsaved || undefined,
    warning: matched ? undefined
      : blockedUnsaved
        ? `Timeframe change blocked by an unsaved-changes dialog — left it in place rather than discarding your work. Save first, then retry. Chart resolution is still "${actual}".`
        : `Requested timeframe "${timeframe}" but chart resolution is "${actual}" — TV may have rejected it (invalid timeframe or a blocking dialog).`,
  };
}

export async function setType({ chart_type, _deps }) {
  const { evaluate } = _resolve(_deps);
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  // Only fall back to a numeric type for a clean integer string. Number("")
  // is 0 and Number(" 3 ")/"0x5" coerce too — those should be rejected, not
  // silently turned into a chart type.
  let typeNum = typeMap[chart_type];
  if (typeNum === undefined) {
    const t = String(chart_type).trim();
    typeNum = /^\d+$/.test(t) ? Number(t) : NaN;
  }
  if (isNaN(typeNum) || typeNum < 0 || typeNum > 9 || !Number.isInteger(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw, _deps }) {
  const { evaluate } = _resolve(_deps);
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  if (action === 'add') {
    // USER;<scriptIdPart> routes through the Pine editor (open script +
    // smart compile) because chart.createStudy() only accepts built-in
    // study names. The script source is fetched from pine-facade, loaded
    // into Monaco, then "Add to chart" is clicked. Same final result as
    // built-in createStudy but with a different mechanism.
    if (typeof indicator === 'string' && /^USER;/i.test(indicator)) {
      return await _addUserScript({ id: indicator, _deps });
    }

    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy(${safeString(indicator)}, false, false, []);
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const newIds = (after || []).filter(id => !(before || []).includes(id));
    const entityId = newIds[0] || null;

    // createStudy's 4th arg (input values) is unreliable across TradingView
    // builds (#249): the study is created with defaults regardless. Apply
    // overrides afterward via the study's own getInputValues/setInputValues
    // (the same API indicator_set_inputs uses), then read back to report what
    // actually took. Unknown keys are surfaced instead of silently dropped.
    let appliedInputs;
    if (entityId && inputs && Object.keys(inputs).length) {
      const result = await evaluate(`
        (function() {
          var chart = ${CHART_API};
          var study = chart.getStudyById(${safeString(entityId)});
          if (!study || typeof study.getInputValues !== 'function') return { error: 'inputs unsupported for this study' };
          var current = study.getInputValues();
          var overrides = ${JSON.stringify(inputs)};
          var applied = {}, unknown = [];
          var byId = {};
          for (var i = 0; i < current.length; i++) byId[current[i].id] = true;
          for (var k in overrides) {
            if (byId[k]) { for (var j = 0; j < current.length; j++) { if (current[j].id === k) current[j].value = overrides[k]; } applied[k] = overrides[k]; }
            else unknown.push(k);
          }
          study.setInputValues(current);
          var after = study.getInputValues();
          var confirmed = {};
          for (var m = 0; m < after.length; m++) { if (applied.hasOwnProperty(after[m].id)) confirmed[after[m].id] = after[m].value; }
          return { confirmed: confirmed, unknown: unknown };
        })()
      `);
      if (result?.error) appliedInputs = { error: result.error };
      else appliedInputs = { applied: result?.confirmed || {}, ...(result?.unknown?.length && { unknown_inputs: result.unknown }) };
    }

    return {
      success: newIds.length > 0,
      action: 'add',
      indicator,
      entity_id: entityId,
      new_study_count: newIds.length,
      ...(appliedInputs && { inputs: appliedInputs }),
    };
  } else if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.removeEntity(${safeString(entity_id)});
      })()
    `);
    return { success: true, action: 'remove', entity_id };
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

export async function removeStudiesByTitle({ title_match, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  if (!title_match || typeof title_match !== 'string') {
    throw new Error('title_match required (case-insensitive substring of study name)');
  }
  const result = await evaluate(`
    (function() {
      var target = ${safeString(title_match.toLowerCase())};
      var chart = ${CHART_API};
      var studies = (typeof chart.getAllStudies === 'function') ? (chart.getAllStudies() || []) : [];
      var matched = [];
      var removed = [];
      for (var i = 0; i < studies.length; i++) {
        var s = studies[i];
        var name = (s && s.name) ? String(s.name) : '';
        if (name.toLowerCase().indexOf(target) !== -1) {
          matched.push({ id: s.id, name: name });
          try {
            chart.removeEntity(s.id);
            removed.push({ id: s.id, name: name });
          } catch (e) { /* keep in matched but not removed */ }
        }
      }
      return { matched: matched, removed: removed };
    })()
  `);
  return {
    success: result.removed.length === result.matched.length,
    title_match,
    matched: result.matched,
    removed: result.removed,
  };
}

export async function getVisibleRange({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

// Internal: read the chart's currently displayed visible range as
// { from, to } in unix seconds. Returns { from: 0, to: 0, error? } on
// failure rather than throwing — callers compare against the request to
// detect cache-clamp.
async function _readVisibleRange(evaluate) {
  return await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
}

// Internal: zoom the main-series time scale to the bars covering
// [from, to] in unix seconds. Walks the loaded bar buffer and calls
// zoomToBarsRange(firstIdx, lastIdx); when the requested window predates
// the buffer, both indices clamp to the buffer's start — that's the
// silent-clamp condition setVisibleRange's auto_extend_cache fixes.
async function _zoomTimeRange(evaluate, from, to) {
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
}

// Internal: ask TV's data layer to preload history ahead of the requested
// `fromUnixSec`. `mainSeries().requestMoreData(n)` drives the same gateway
// requestMoreData path the time scale's scroll handler uses (verified live:
// TV Desktop 3.4.1 exposes _replayApi as undefined, so the previous replay-mode
// preload was dead on arrival). This fills the bar cache backward without
// touching replay UI state.
//
// Returns { extended: boolean, rounds: number, error?: string, note?: string }.
async function _extendCacheBackward(evaluate, fromUnixSec, maxRounds = 8) {
  const firstBefore = await evaluate(`
    (function() {
      var b = ${CHART_API}._chartWidget.model().mainSeries().bars();
      var v = b.valueAt(b.firstIndex());
      return { firstIndex: b.firstIndex(), firstTs: v ? v[0] : null };
    })()
  `);
  if (!firstBefore || !firstBefore.firstTs) {
    return { extended: false, rounds: 0, error: 'could not read bar buffer start' };
  }
  // Already covers `from` — nothing to load. A small grace lets an async
  // fetch triggered by an earlier zoom settle before we conclude "done".
  if (firstBefore.firstTs <= fromUnixSec + 60) {
    return { extended: true, rounds: 0, note: 'already_covered', first_index: firstBefore.firstIndex, first_ts: firstBefore.firstTs };
  }
  let first = firstBefore;
  let rounds = 0;
  let lastErr = null;
  while (rounds < maxRounds && first.firstTs > fromUnixSec) {
    try {
      // requestMoreData asks the series source for ~n more bars backward;
      // the gateway responds asynchronously and extends the cache.
      await evaluate(`
        (function() {
          var m = ${CHART_API}._chartWidget.model();
          try { m.mainSeries().requestMoreData(${PRELOAD_BARS_PER_ROUND}); } catch (e) {}
          return 1;
        })()
      `);
    } catch (e) { lastErr = e.message; }
    rounds++;
    // Give the gateway round-trip room to land before re-reading the buffer.
    await new Promise(r => setTimeout(r, 600));
    first = await evaluate(`
      (function() {
        var b = ${CHART_API}._chartWidget.model().mainSeries().bars();
        var v = b.valueAt(b.firstIndex());
        return { firstIndex: b.firstIndex(), firstTs: v ? v[0] : null };
      })()
    `) || { firstIndex: null, firstTs: null };
    if (!first.firstTs || first.firstTs <= fromUnixSec) break;
  }
  return {
    extended: !!(first.firstTs && first.firstTs <= fromUnixSec),
    rounds,
    ...(lastErr && !first.firstTs ? { error: lastErr } : {}),
    first_index: first.firstIndex ?? null,
    first_ts: first.firstTs ?? null,
  };
}

// Bars asked per preload round. Small enough to avoid flooding the gateway
// when the caller requests a far-past day; large enough that a full US session
// (78 five-minute bars) lands in one round.
const PRELOAD_BARS_PER_ROUND = 100;

/**
 * Set the chart's visible time range to [from, to] (unix seconds).
 *
 * When the requested `from` predates the loaded bar buffer, TV silently
 * clamps the zoom to the buffer's start. `auto_extend_cache=true` (the
 * default) detects this (actual.from > requested.from + 60s tolerance)
 * and triggers `_extendCacheBackward` — a `mainSeries().requestMoreData()`
 * preload that asks the gateway for history ahead of `from`, after which the
 * zoom is retried. Response carries `cache_extended` + final `clamped` so the
 * caller can tell when the data layer ran out of history.
 */
export async function setVisibleRange({ from, to, auto_extend_cache = true, _deps }) {
  const { evaluate } = _resolve(_deps);
  const f = requireFinite(from, 'from');
  const t = requireFinite(to, 'to');

  await _zoomTimeRange(evaluate, f, t);
  await new Promise(r => setTimeout(r, 500));
  const actual = (await _readVisibleRange(evaluate)) || { from: 0, to: 0 };

  // Treat a probe failure (from/to both 0, or explicit error field) as
  // "couldn't tell" instead of "not clamped" — the previous code
  // computed `0 > f+60`, which is always false for post-epoch
  // timestamps, so auto_extend_cache silently skipped and the response
  // claimed success with no diagnostic.
  const probeFailed = !!actual.error || (!actual.from && !actual.to);
  // 60s tolerance: bar-snap quantization on intraday TFs lands the
  // cursor on the bar containing `from`, which can be up to one bar
  // earlier (we err on the side of "still inside the requested window").
  const clamped = !probeFailed && (actual.from || 0) > f + 60;
  let cacheExtended = false;
  let cacheNote = null;
  let cacheReplayLeftRunning = false;

  if ((clamped || probeFailed) && auto_extend_cache) {
    const ext = await _extendCacheBackward(evaluate, f);
    cacheExtended = !!ext.extended;
    cacheNote = ext.error || null;
    if (ext.replay_left_running) cacheReplayLeftRunning = true;
    // A probe failure that the preload *did* fix should not still report
    // cache_extended:false — read `ext.extended` (the authoritative signal)
    // rather than trusting the pre-preload clamp flag alone.
    if (cacheExtended) {
      await _zoomTimeRange(evaluate, f, t);
      await new Promise(r => setTimeout(r, 500));
      const retry = (await _readVisibleRange(evaluate)) || { from: 0, to: 0 };
      const retryProbeFailed = !!retry.error || (!retry.from && !retry.to);
      return {
        success: true,
        requested: { from, to },
        actual: retry,
        cache_extended: true,
        clamped: !retryProbeFailed && (retry.from || 0) > f + 60,
        actual_read_failed: retryProbeFailed || undefined,
        actual_read_error: retry.error || undefined,
        replay_left_running: cacheReplayLeftRunning || undefined,
      };
    }
  }

  return {
    success: true,
    requested: { from, to },
    actual,
    cache_extended: cacheExtended,
    clamped,
    cache_note: cacheNote,
    actual_read_failed: probeFailed || undefined,
    actual_read_error: actual.error || undefined,
    replay_left_running: cacheReplayLeftRunning || undefined,
  };
}

export async function scrollToDate({ date, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  let timestamp;
  if (/^\d+$/.test(date)) {
    timestamp = Number(date);
    // A 13-digit value is a millisecond epoch (TV expects seconds); a bare
    // seconds value above ~1e11 is already past year 5138, so treat anything
    // that large as milliseconds rather than scrolling ~50,000 years out.
    if (timestamp > 1e11) timestamp = Math.floor(timestamp / 1000);
  } else {
    timestamp = Math.floor(new Date(date).getTime() / 1000);
  }
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);
  const normRes = _normalizeResolution(resolution);
  let secsPerBar = 60;
  let m;
  if ((m = /^(\d+)S$/.exec(normRes))) secsPerBar = Number(m[1]);
  else if (/^\d+$/.test(normRes)) secsPerBar = parseInt(normRes, 10) * 60;
  else if ((m = /^(\d+)D$/.exec(normRes))) secsPerBar = Number(m[1]) * 86400;
  else if ((m = /^(\d+)W$/.exec(normRes))) secsPerBar = Number(m[1]) * 604800;
  else if ((m = /^(\d+)M$/.exec(normRes))) secsPerBar = Number(m[1]) * 2592000;

  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  await _zoomTimeRange(evaluate, from, to);
  await new Promise(r => setTimeout(r, 500));
  // Postcondition read-back: TV silently clamps the zoom to the loaded bar
  // buffer, so a far-past date can snap back toward live. Report whether the
  // target landed inside the visible range, but keep success:true — a miss
  // is diagnostic (setVisibleRange clamped/cache_extended precedent), not a
  // throw.
  const actual = (await _readVisibleRange(evaluate)) || { from: 0, to: 0 };
  const probeFailed = !!actual.error || (!actual.from && !actual.to);
  return {
    success: true,
    date,
    centered_on: timestamp,
    resolution,
    window: { from, to },
    actual,
    target_in_visible_range: !probeFailed && (actual.from || 0) <= timestamp && timestamp <= (actual.to || 0),
    actual_read_failed: probeFailed || undefined,
    actual_read_error: actual.error || undefined,
  };
}

// Internal: reset a price scale to auto-scale and re-derive its range from
// the time scale's *visible* bar/logical range. This is the CDP-reachable
// equivalent of double-clicking the price axis in the TV widget: it re-enables
// autoScale (undoing any manual lock), calls resetScale(), then recalculates
// the range for exactly the visible bars so nothing clips at the pane edge.
//
// Returns { success, is_auto, min, max, error? }.
async function _resetPriceScaleToVisible(evaluate) {
  try {
    const result = await evaluate(`
      (function() {
        var m = ${CHART_API}._chartWidget.model();
        var ms = m.mainSeries();
        var ps = ms.priceScale.call(ms);
        // pane.setPriceAutoScale(ps, true) -> ps.setMode({autoScale:true}); the
        // canonical "price-axis double-click" toggle. A no-op when already on.
        var pane = null;
        try { pane = m.panes()[0]; } catch (e) {}
        if (pane && typeof pane.setPriceAutoScale === 'function') {
          pane.setPriceAutoScale(ps, true);
        } else {
          // Older/alternate build path: drive the scale directly.
          ps.setMode({ autoScale: true });
        }
        // pane.resetPriceScale(ps): resetScale() + recalculatePriceRange over
        // visibleBarsStrictRange()/logicalRange(). This frames the price axis
        // to what's actually on screen — not the full loaded buffer.
        if (pane && typeof pane.resetPriceScale === 'function') {
          pane.resetPriceScale(ps);
        } else {
          try { ps.resetScale(); } catch (e) {}
        }
        return {
          success: true,
          is_auto: ps.isAutoScale(),
          min: ps.priceRange ? ps.priceRange()._minValue : null,
          max: ps.priceRange ? ps.priceRange()._maxValue : null,
        };
      })()
    `);
    return { success: !!result?.success, ...result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Frame the chart to show a specific time window with full candle
 * visibility: every bar of [from, to] on the time axis, and a price axis
 * that covers those bars' low-to-high with headroom — nothing clipped at the
 * top or bottom of the pane.
 *
 * Reproduces the human gesture (double-click price axis + double-click time
 * axis) via the model API instead of synthesized mouse events:
 *   - time axis: timeScale().zoomToBarsRange(fromIdx, toIdx)
 *   - price axis: pane.setPriceAutoScale(scale, true) + pane.resetPriceScale(scale)
 *     (a requestMoreData preload replaces the dead replay-mode cache extension
 *     when `from` predates the loaded bar buffer)
 *
 * When `symbol` / `timeframe` are provided they're applied first (setSymbol /
 * setTimeframe), because framing depends on the bar grid actually loaded.
 * Optionally captures a screenshot of the framed view.
 */
export async function frameChart({
  symbol, timeframe, from, to, date, session, time_zone,
  screenshot, screenshot_region, screenshot_output_dir,
  auto_extend_cache = true,
  _deps,
}) {
  const { evaluate, waitForChartReady, captureScreenshot, dismissBlockingOverlays } = _resolve(_deps);

  // ── Overlay preflight ─────────────────────────────────────────────────
  // A subscription-upsell / get-realtime / new-feature-tour overlay hides the
  // pane being framed, so the zoom and the postcondition read-back describe
  // a chart the caller can't see. Dismiss it through its own control once
  // here, then frame and (optionally) screenshot on the cleared chart — the
  // nested screenshot gets dismiss_overlays:false so it doesn't re-probe.
  let overlayResult = null;
  try { overlayResult = await dismissBlockingOverlays({ _deps }); }
  catch { overlayResult = null; }

  // ── Resolve the target window ─────────────────────────────────────────
  let f = null;
  let t = null;
  let sourceDesc = null;

  if ((from !== undefined && from !== null) || (to !== undefined && to !== null)) {
    if (from === undefined || from === null || to === undefined || to === null) {
      throw new Error('Both `from` and `to` are required together (unix seconds, or ISO strings).');
    }
    f = requireFinite(from, 'from');
    t = requireFinite(to, 'to');
    sourceDesc = 'explicit_range';
  } else if (date) {
    // `date` is a calendar day; `session` picks which market session's hours.
    const dayStart = Math.floor(new Date(`${String(date)}T00:00:00Z`).getTime() / 1000);
    if (isNaN(dayStart)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15).`);
    let sessStart = null;
    let sessEnd = null;
    const s = String(session || 'us_regular').toLowerCase();
    if (s === 'us_regular' || s === 'us' || s === 'regular') {
      // US regular session in exchange-local terms is 09:30–16:00. TV charts
      // display exchange-local time, so caller passes time_zone only for
      // ISO conversion; here we default to UTC interpretation unless told
      // otherwise. Explicit `from`/`to` is the precise form.
      sessStart = 9 * 3600 + 30 * 60;
      sessEnd = 16 * 3600;
    } else if (s === 'full_day' || s === 'day' || s === '24h') {
      sessStart = 0;
      sessEnd = 86400;
    } else {
      throw new Error(`Unknown session: ${session}. Use us_regular (09:30-16:00), full_day, or pass explicit from/to.`);
    }
    const offsetSec = time_zone != null ? Number(time_zone) * 3600 : 0;
    f = dayStart + sessStart - offsetSec;
    t = dayStart + sessEnd - offsetSec;
    sourceDesc = `date_session:${session || 'us_regular'}`;
  } else {
    throw new Error('Provide `from`+`to`, or `date` (+ optional `session`).');
  }
  if (!(t > f)) throw new Error('`to` must be greater than `from`.');

  // ── Apply symbol / timeframe first (framing reads the bar grid) ───────
  let symbolApplied = null;
  let timeframeApplied = null;
  if (symbol) {
    const sym = await setSymbol({ symbol, discard_unsaved: false, _deps });
    symbolApplied = sym;
  }
  if (timeframe) {
    const tf = await setTimeframe({ timeframe, _deps });
    timeframeApplied = tf;
  }
  if (symbol || timeframe) {
    await waitForChartReady(null);
  }

  // ── Extend the bar buffer if `from` predates it ────────────────────────
  const beforeExtend = await evaluate(`
    (function() {
      var b = ${CHART_API}._chartWidget.model().mainSeries().bars();
      var v = b.valueAt(b.firstIndex());
      return { firstIndex: b.firstIndex(), firstTs: v ? v[0] : null, lastIndex: b.lastIndex(), lastTs: null };
    })()
  `);
  let cacheExtended = false;
  let cacheNote = null;
  if (beforeExtend && beforeExtend.firstTs && beforeExtend.firstTs > f) {
    if (!auto_extend_cache) {
      cacheNote = 'requested range predates loaded buffer and auto_extend_cache=false';
    } else {
      const ext = await _extendCacheBackward(evaluate, f);
      cacheExtended = !!ext.extended;
      cacheNote = ext.error || (cacheExtended ? null : 'preload rounds exhausted before covering `from`');
      if (cacheExtended) {
        // Give TV a beat to reflow the freshly loaded history into the scale.
        await new Promise(r => setTimeout(r, 400));
      }
    }
  } else {
    cacheExtended = true; // already covered; nothing needed
    cacheNote = 'already_covered';
  }

  // ── Time axis: zoom to the exact bar range ────────────────────────────
  // _zoomTimeRange (proven in setVisibleRange) resolves from/to to bar
  // indices and calls timeScale().zoomToBarsRange, clamping to the loaded
  // buffer. The preload above already widened that buffer when needed.
  await _zoomTimeRange(evaluate, f, t);

  // Let the zoom land before reading back / framing the price axis.
  await new Promise(r => setTimeout(r, 500));

  // ── Price axis: reset to visible-range autoscale ──────────────────────
  const price = await _resetPriceScaleToVisible(evaluate);
  await new Promise(r => setTimeout(r, 300));

  // ── Postcondition read-back ───────────────────────────────────────────
  const actual = (await _readVisibleRange(evaluate)) || { from: 0, to: 0 };
  const probeFailed = !!actual.error || (!actual.from && !actual.to);
  const windowOk = !probeFailed && (actual.from || 0) <= f + 60 && (actual.to || 0) >= t - 60;

  const out = {
    success: true,
    requested: { from: f, to: t },
    range_source: sourceDesc,
    actual,
    time_axis_ok: windowOk,
    price_scale: price,
    cache_extended: cacheExtended,
    actual_read_failed: probeFailed || undefined,
    actual_read_error: actual.error || undefined,
    ...(cacheNote ? { cache_note: cacheNote } : {}),
    ...(symbol ? { symbol_applied: symbolApplied?.symbol ?? symbolApplied ?? symbol } : {}),
    ...(timeframe ? { timeframe_applied: timeframeApplied?.timeframe ?? timeframeApplied ?? timeframe } : {}),
    // What the overlay preflight did (null fields when nothing was up).
    ...(overlayResult ? { overlays_dismissed: overlayResult.dismissed, overlays_remaining: overlayResult.remaining } : {}),
    ...(overlayResult?.error ? { overlay_error: overlayResult.error } : {}),
  };

  // ── Optional screenshot proof ─────────────────────────────────────────
  if (screenshot) {
    try {
      const shot = await captureScreenshot({
        region: screenshot_region || 'chart',
        output_dir: screenshot_output_dir,
        // The overlay preflight already ran above; don't spend a second
        // detection round-trip on the nested screenshot.
        dismiss_overlays: false,
        _deps,
      });
      out.screenshot = shot;
    } catch (e) {
      out.screenshot = { success: false, error: e.message };
    }
  }

  return out;
}

export async function symbolInfo({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      // TV Desktop 3.1.0 removed chart.symbolExt(); fall back to symbolInfo()
      // (returns full info object), then symbol() as a last resort.
      var info = null;
      try { if (typeof chart.symbolExt === 'function') info = chart.symbolExt(); } catch(e) {}
      if (!info) {
        try { if (typeof chart.symbolInfo === 'function') info = chart.symbolInfo(); } catch(e) {}
      }
      var symbol = '';
      try { symbol = chart.symbol(); } catch(e) {}
      var resolution = '';
      try { resolution = chart.resolution(); } catch(e) {}
      var chart_type = null;
      try { chart_type = chart.chartType(); } catch(e) {}
      if (info) {
        return {
          symbol: info.symbol || symbol,
          full_name: info.full_name || info.fullName,
          exchange: info.exchange,
          description: info.description,
          type: info.type,
          pro_name: info.pro_name || info.proName,
          typespecs: info.typespecs,
          resolution: resolution,
          chart_type: chart_type,
          source: 'symbolExt_or_symbolInfo'
        };
      }
      // Minimal fallback — only the symbol string is reliably available on
      // TV 3.1.0 without the symbolExt API.
      return { symbol: symbol, resolution: resolution, chart_type: chart_type, source: 'symbol_only' };
    })()
  `);
  return { success: true, ...result };
}

export async function symbolSearch({ query, type }) {
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
