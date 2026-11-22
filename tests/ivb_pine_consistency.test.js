/**
 * Static consistency check between the Pine indicator
 * (`pine/ivb-5min-entry-exit.pine`) and the shared plain-JS reference
 * implementation (`src/core/ivb.js`).
 *
 * The Pine source cannot be executed locally (no compile in this offline
 * pass), so this test establishes that the two artefacts encode the SAME
 * rules: the numeric constants, the break/confirmation predicates, the
 * risk/stop/target derivation and the evaluation order are compared
 * mechanically instead of being trusted by inspection.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyze } from '../src/core/pine.js';
import {
  OR_START_MINUTE,
  OR_END_MINUTE,
  SESSION_END_MINUTE,
  OR_BAR_COUNT,
} from '../src/core/ivb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const pinePath = path.join(repoRoot, 'pine', 'ivb-5min-entry-exit.pine');
const pineSource = readFileSync(pinePath, 'utf8');
const jsSource = readFileSync(path.join(repoRoot, 'src', 'core', 'ivb.js'), 'utf8');

/** Find the numeric literal passed to a Pine `input.int(<name>, ...)` call. */
function pineInputInt(name) {
  const m = pineSource.match(new RegExp(`\\b${name}\\s*=\\s*input\\.int\\(\\s*(\\d+)`));
  assert.ok(m, `Pine input '${name}' not found`);
  return Number(m[1]);
}

/**
 * Find every `plot*` call that TradingView would reject as being in local
 * scope.
 *
 * Pine blocks are indentation-based: a block is the run of lines indented
 * deeper than its header. A plot* call is therefore in local scope when it
 * sits at an indentation level deeper than the file's top level.
 *
 * TradingView's compiler fails such a call with
 *   Cannot use "{functionName}" in local scope
 * The repository's offline Pine analyzer (src/core/pine.js) does NOT catch
 * this class of build-time error, which is why the check lives here.
 *
 * @param {string} source - Pine source to scan.
 * @returns {Array<{line:number, call:string, indent:number, text:string}>}
 */
function findLocalScopePlotCalls(source) {
  const PLOT_CALL = /\b(plot|plotshape|plotchar|plotarrow|plotcandle|plotbar|plotarea|plotkline)\s*\(/;
  const offenders = [];
  let baseIndent = null;

  for (const [i, raw] of source.split('\n').entries()) {
    const line = raw.replace(/\/\/.*$/, '');
    if (!line.trim()) continue;

    const indent = line.length - line.trimStart().length;
    if (baseIndent === null) {
      // The first code line establishes the file's top-level indentation.
      baseIndent = indent;
    }
    if (indent < baseIndent) {
      // De-dented back to (or past) the top level — e.g. a `for` header.
      baseIndent = indent;
    }

    const plotCall = line.match(PLOT_CALL);
    if (plotCall && indent > baseIndent) {
      offenders.push({
        line: i + 1,
        call: plotCall[1],
        indent,
        text: line.trim(),
      });
    }
  }

  return offenders;
}

describe('ivb Pine/JS static consistency', () => {
  it('is a Pine v6 overlay indicator', () => {
    assert.match(pineSource, /^\/\/@version=6\b/m);
    assert.match(pineSource, /indicator\("IVB 5-min Entry\/Exit Model"[^\n]*overlay=true/);
  });

  it('uses the symbol exchange timezone (syminfo.timezone), not a naive time prefix', () => {
    assert.match(pineSource, /i_tz\s*=\s*syminfo\.timezone/);
    assert.match(pineSource, /hour\(time,\s*i_tz\)/);
    assert.match(pineSource, /minute\(time,\s*i_tz\)/);
    assert.match(pineSource, /year\(time,\s*i_tz\)/);
    // The Pine file must not hard-code America/New_York in code.
    const code = pineSource.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!code.includes('America/New_York'));
  });

  it('derives the regular-session window from exchange-local minutes', () => {
    assert.match(pineSource, /i_inRegular = i_barMinute >= i_orStartMin and i_barMinute < i_sessionEnd/);
  });

  it('uses the same session constants as the JS reference', () => {
    assert.equal(pineInputInt('i_orStartMin'), OR_START_MINUTE);
    assert.equal(pineInputInt('i_orEndMin'), OR_END_MINUTE);
    assert.equal(pineInputInt('i_sessionEnd'), SESSION_END_MINUTE);
    assert.equal(pineInputInt('i_orBarCount'), OR_BAR_COUNT);
    assert.equal(OR_START_MINUTE, 570);
    assert.equal(OR_END_MINUTE, 600);
    assert.equal(SESSION_END_MINUTE, 960);
    assert.equal(OR_BAR_COUNT, 6);
  });

  it('encodes the break predicate identically (close-confirmed fresh cross)', () => {
    assert.match(pineSource, /close\s*>\s*orHigh\s+and\s+close\[1\]\s*<=\s*orHigh/);
    assert.match(jsSource, /b\.close\s*>\s*orHigh\s*&&\s*!prevClosedAboveOr/);
    assert.match(jsSource, /close\(B-1\)\s*<=\s*OR_high/);
  });

  it('encodes the confirmation predicate identically (close above the break bar high)', () => {
    assert.match(pineSource, /close\s*>\s*pendingBreakHigh/);
    assert.match(jsSource, /b\.close\s*>\s*pending\.breakHigh/);
  });

  it('encodes the risk unit, stop and target identically', () => {
    assert.match(pineSource, /riskR\s*:=\s*high\s*-\s*low/);
    assert.match(pineSource, /stopPrice\s*:=\s*entryPrice\s*-\s*riskR/);
    assert.match(pineSource, /targetPrice\s*:=\s*entryPrice\s*\+\s*riskR/);
    assert.match(jsSource, /const R = b\.high - b\.low/);
    assert.match(jsSource, /stop: entry - R/);
    assert.match(jsSource, /target: entry \+ R/);
  });

  it('resolves the open position before evaluating a new setup (spec §10.2)', () => {
    const pineExit = pineSource.indexOf('if state == 2');
    const pineConfirm = pineSource.indexOf('if state == 1');
    const pineBreak = pineSource.indexOf('if state == 0 and i_inRegular');
    assert.ok(pineExit >= 0 && pineConfirm > pineExit && pineBreak > pineConfirm);
    const jsExit = jsSource.indexOf('Resolve an open position first');
    const jsConfirm = jsSource.indexOf('Confirmation bar C = B + 1');
    const jsBreak = jsSource.indexOf('Break bar B: close-confirmed fresh cross');
    assert.ok(jsExit >= 0 && jsConfirm > jsExit && jsBreak > jsConfirm);
  });

  it('uses the pessimistic (stop-first) fill when stop and target are both hit', () => {
    assert.match(pineSource, /exitPrice = stopHit \? stopPrice : targetPrice/);
    assert.match(jsSource, /exitPrice = trade\.stop; {6}\/\/ pessimistic fill/);
  });

  it('re-arms after an invalidated confirmation (state returns to scanning)', () => {
    // The invalidation is recorded on a marking series; the plotshape() call
    // itself lives at global scope (see the local-scope plot guard below).
    assert.match(pineSource, /state := 0\n {8}markInvalid := close/);
    assert.match(jsSource, /setup\.outcome = 'invalidated'/);
  });

  it('marks the symbol done after a completed trade and stops taking new setups', () => {
    assert.match(pineSource, /state := 3/);
    assert.match(pineSource, /i_done = state == 3/);
    assert.match(jsSource, /completedTrade = true/);
    assert.match(jsSource, /eligible = false/);
  });

  it('plots the OR high/low, shades the OR band and draws the entry/stop/target box', () => {
    assert.match(pineSource, /plot\(i_showOr \? orHigh : na, title="OR high"/);
    assert.match(pineSource, /plot\(i_showOr \? orLow : na, title="OR low"/);
    assert.match(pineSource, /fill\(p_orHigh, p_orLow/);
    assert.match(pineSource, /box\.new\(entryBarIdx, entryPrice, bar_index \+ 1, stopPrice/);
    assert.match(pineSource, /box\.new\(entryBarIdx, targetPrice, bar_index \+ 1, entryPrice/);
  });

  it('marks break, valid confirmation and invalidated confirmation distinctly', () => {
    assert.match(pineSource, /title="Break bar"/);
    assert.match(pineSource, /title="Valid confirmation"/);
    assert.match(pineSource, /title="Invalidated confirmation"/);
    assert.match(pineSource, /title="Done for the day"/);
  });

  it('records each marking on its own series so the plots stay at global scope', () => {
    // The three event markings are recorded into dedicated series inside the
    // state blocks and plotted once at global scope. Keeping the series names
    // in sync with the plots is what stops a future edit from re-introducing
    // an inline plotshape() (which TradingView rejects — see the local-scope
    // plot guard below).
    assert.match(pineSource, /markBreak := high/);
    assert.match(pineSource, /markConf := close/);
    assert.match(pineSource, /markInvalid := close/);
    assert.match(pineSource, /plotshape\(markBreak, title="Break bar"/);
    assert.match(pineSource, /plotshape\(markConf, title="Valid confirmation"/);
    assert.match(pineSource, /plotshape\(markInvalid, title="Invalidated confirmation"/);
  });

  it('issues every plot* call at global scope (TradingView rejects local-scope plots)', () => {
    // Regression guard for the bug this file shipped with: TradingView's own
    // compiler fails a plotshape() placed inside an `if` block with
    //   Cannot use "{functionName}" in local scope
    // (line 122 / 130 / 138 of the original file), while the offline Pine
    // analyzer in src/core/pine.js accepts it. The offline analyzer cannot
    // catch this class of build-time error, so this check guards it here.
    const offenders = findLocalScopePlotCalls(pineSource);
    assert.deepEqual(
      offenders,
      [],
      `plot* calls must be at global scope; TradingView rejects local-scope plots: ${JSON.stringify(offenders)}`
    );
  });

  it('the local-scope plot guard detects the original (pre-fix) compile error', () => {
    // Negative test: the guard above must actually catch the bug it guards
    // against. This reconstructs the three offending calls exactly as the
    // original file had them — `plotshape(...)` nested inside the state
    // blocks — and asserts the guard flags all three.
    const brokenSnippet = [
      '//@version=6',
      'indicator("broken", overlay=true)',
      'var int state = 0',
      'if state == 1',
      '    if close > pendingBreakHigh',
      '        state := 2',
      '        plotshape(close, title="Valid confirmation")',
      '    else',
      '        state := 0',
      '        plotshape(close, title="Invalidated confirmation")',
      'if state == 0',
      '    if close > orHigh',
      '        state := 1',
      '        plotshape(high, title="Break bar")',
    ].join('\n');

    const offenders = findLocalScopePlotCalls(brokenSnippet);
    assert.equal(offenders.length, 3, `expected 3 local-scope plot calls, got ${JSON.stringify(offenders)}`);
    assert.deepEqual(
      offenders.map((o) => o.call),
      ['plotshape', 'plotshape', 'plotshape']
    );
    assert.deepEqual(
      offenders.map((o) => o.line),
      [7, 10, 14]
    );
  });

  it('passes the repository offline Pine static analyzer without errors', () => {
    const result = analyze({ source: pineSource });
    const errors = (result.diagnostics || []).filter((d) => d.severity === 'error');
    assert.deepEqual(errors, [], `Pine analyzer reported errors: ${JSON.stringify(errors)}`);
  });
});
