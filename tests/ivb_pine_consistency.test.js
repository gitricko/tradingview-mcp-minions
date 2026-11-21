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
    assert.match(pineSource, /state := 0\n {8}plotshape\(close, title="Invalidated confirmation"/);
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

  it('passes the repository offline Pine static analyzer without errors', () => {
    const result = analyze({ source: pineSource });
    const errors = (result.diagnostics || []).filter((d) => d.severity === 'error');
    assert.deepEqual(errors, [], `Pine analyzer reported errors: ${JSON.stringify(errors)}`);
  });
});
