/**
 * Synthetic-OHLCV unit tests for src/core/ivb.js — the plain-JS reference
 * implementation of the IVB 5-minute Entry/Exit model.
 *
 * No CDP, no network, no TradingView. Every case in the acceptance spec
 * (data/ivb-5min-entry-model/rules.md) is reproduced here with hand-built
 * bars, including both negative examples on the invalidation chart, the
 * re-arm-after-failed-confirmation case and the end-trading-for-the-day case.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeIvbSetupSequence,
  exchangeLocalToUnixSeconds,
  exchangeLocalParts,
  resolveExchangeTimezone,
  localSessionWindowUtc,
} from '../src/core/ivb.js';

const TZ = 'America/New_York';

/** Unix seconds for an exchange-local wall clock time. */
function et(dateStr, hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return exchangeLocalToUnixSeconds(dateStr, h * 60 + m, TZ) + s;
}

/** Build one 5-minute bar at an exchange-local time. */
function bar(dateStr, hhmmss, open, high, low, close, volume = 1000) {
  return { time: et(dateStr, hhmmss), open, high, low, close, volume };
}

/**
 * The six opening-range bars 09:30..09:55 for the given date.
 * OR high = 100, OR low = 98 by default.
 */
function orBars(dateStr, { orHigh = 100, orLow = 98 } = {}) {
  const steps = [
    [99.0, 99.4, 98.8, 99.2],
    [99.2, 99.7, 98.9, 99.5],
    [99.5, 99.8, 99.0, 99.4],
    [99.4, 99.9, 98.7, 99.6],
    [99.6, 100.0, 99.2, 99.8],
    [99.8, 99.9, 98.0, 98.5],
  ];
  return steps.map(([o, h, l, c], i) => {
    const minute = 9 * 60 + 30 + i * 5;
    const hh = String(Math.floor(minute / 60)).padStart(2, '0');
    const mm = String(minute % 60).padStart(2, '0');
    return bar(dateStr, `${hh}:${mm}:00`, o, h, l, c);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Positive example (spec §3-§8): SQQQ long.
//
// 09:30-09:55 OR: high 100, low 98.
// 10:00 break bar B: open 98.6, high 100.6, low 98.5, close 100.4 (> 100).
// 10:05 confirmation C: open 100.5, high 101.2, low 100.0, close 101.0
//   (> high(B) = 100.6) -> valid.
//   R = high(C) - low(C) = 101.2 - 100.0 = 1.2
//   entry = 101.0, stop = 99.8, target = 102.2
// 10:10 hits the target (high 102.5) -> exit, done for the day.
// ───────────────────────────────────────────────────────────────────────────
function positiveDayBars(dateStr = '2026-11-20') {
  return [
    ...orBars(dateStr),
    bar(dateStr, '10:00:00', 98.6, 100.6, 98.5, 100.4),
    bar(dateStr, '10:05:00', 100.5, 101.2, 100.0, 101.0),
    bar(dateStr, '10:10:00', 101.1, 102.5, 100.9, 102.3),
    bar(dateStr, '10:15:00', 102.3, 102.4, 101.5, 101.8),
  ];
}

describe('ivb — exchange timezone helpers', () => {
  it('resolves the exchange timezone from an IANA name and falls back safely', () => {
    assert.deepEqual(resolveExchangeTimezone('America/New_York'), {
      timezone: 'America/New_York', source: 'exchange_symbol',
    });
    assert.deepEqual(resolveExchangeTimezone(null), {
      timezone: 'America/New_York', source: 'default',
    });
    assert.equal(resolveExchangeTimezone('Not/AZone').timezone, 'America/New_York');
    assert.equal(resolveExchangeTimezone('Not/AZone').source, 'default_invalid');
  });

  it('maps 09:30 ET to the correct UTC instant in summer (EDT) and winter (EST)', () => {
    const summer = exchangeLocalToUnixSeconds('2026-07-15', 9 * 60 + 30, TZ);
    const winter = exchangeLocalToUnixSeconds('2026-01-15', 9 * 60 + 30, TZ);
    const su = new Date(summer * 1000);
    const wi = new Date(winter * 1000);
    assert.equal(su.toISOString(), '2026-07-15T13:30:00.000Z');
    assert.equal(wi.toISOString(), '2026-01-15T14:30:00.000Z');
  });

  it('reports exchange-local wall clock parts, not naive UTC parts', () => {
    const t = et('2026-11-20', '09:30:00');
    const p = exchangeLocalParts(t, TZ);
    assert.equal(p.hour, 9);
    assert.equal(p.minute, 30);
    assert.equal(p.minuteOfDay, 570);
  });

  it('exposes the local session window as absolute UTC unix seconds', () => {
    const win = localSessionWindowUtc('2026-11-20', TZ, 570, 600);
    assert.equal(new Date(win.start * 1000).toISOString(), '2026-11-20T14:30:00.000Z');
    assert.equal(new Date(win.end * 1000).toISOString(), '2026-11-20T15:00:00.000Z');
  });
});

describe('ivb — positive example (spec §3-§8)', () => {
  const res = computeIvbSetupSequence(positiveDayBars());

  it('computes the OR high/low from the six 09:30-09:55 bars', () => {
    assert.equal(res.or.high, 100);
    assert.equal(res.or.low, 98);
    assert.equal(res.or.barCount, 6);
    assert.equal(res.or.complete, true);
  });

  it('marks the 10:00 bar as the break bar', () => {
    const breakMarks = res.marks.filter((m) => m.break);
    assert.equal(breakMarks.length, 1);
    assert.equal(breakMarks[0].minuteOfDay, 600);
  });

  it('validates the confirmation bar and derives entry/R/stop/target', () => {
    assert.equal(res.setups.length, 1);
    const s = res.setups[0];
    assert.equal(s.outcome, 'entered');
    assert.equal(s.breakBar.minuteOfDay, 600);
    assert.equal(s.confirmation.minuteOfDay, 605);
    assert.equal(s.entry.price, 101.0);
    assert.ok(Math.abs(s.R - 1.2) < 1e-9); // high(C) 101.2 - low(C) 100.0
    assert.ok(Math.abs(s.stop - 99.8) < 1e-9); // entry - R
    assert.ok(Math.abs(s.target - 102.2) < 1e-9); // entry + R
  });

  it('exits at the 1R target and marks the symbol done for the day', () => {
    const s = res.setups[0];
    assert.equal(s.exit.reason, 'target');
    assert.equal(s.exit.price, 102.2);
    assert.equal(res.completedTrade, true);
    assert.equal(res.stillEligible, false);
  });
});

describe('ivb — negative example (a): wick poke, close back below OR high (spec §3)', () => {
  // 10:00 bar trades above 100.0 (high 100.8) but closes at 99.8 -> no signal.
  const bars = [
    ...orBars('2026-11-20'),
    bar('2026-11-20', '10:00:00', 99.0, 100.8, 98.9, 99.8),
    bar('2026-11-20', '10:05:00', 99.9, 100.2, 99.7, 100.0),
    bar('2026-11-20', '10:10:00', 100.0, 100.3, 99.6, 99.9),
  ];
  const res = computeIvbSetupSequence(bars);

  it('produces no break bar and no setup', () => {
    assert.equal(res.marks.filter((m) => m.break).length, 0);
    assert.equal(res.setups.length, 0);
    assert.equal(res.completedTrade, false);
  });

  it('leaves the symbol eligible', () => {
    assert.equal(res.stillEligible, true);
  });

  it('does not treat the wick poke as a signal even though later bars close at/above OR_high', () => {
    // The 10:05 close (100.0) is not > OR_high (100.0) and the 10:10 bar
    // closes back below it, so no fresh cross exists anywhere in the day.
    assert.equal(res.setups.length, 0);
    assert.equal(res.marks.filter((m) => m.break).length, 0);
  });
});

describe('ivb — negative example (b): confirmation fails to close above break high (spec §4)', () => {
  // B = 10:00, high 100.6, close 100.4. C = 10:05 closes 100.5 <= high(B).
  const bars = [
    ...orBars('2026-11-20'),
    bar('2026-11-20', '10:00:00', 98.6, 100.6, 98.5, 100.4),
    bar('2026-11-20', '10:05:00', 100.3, 100.5, 99.9, 100.5),
    bar('2026-11-20', '10:10:00', 100.5, 100.6, 100.0, 100.2),
  ];
  const res = computeIvbSetupSequence(bars);

  it('marks the confirmation as invalidated and takes no trade', () => {
    assert.equal(res.setups.length, 1);
    const s = res.setups[0];
    assert.equal(s.outcome, 'invalidated');
    assert.equal(s.entry, null);
    assert.equal(s.R, null);
    assert.equal(res.marks.filter((m) => m.confirmInvalid).length, 1);
    assert.equal(res.marks.filter((m) => m.confirmValid).length, 0);
  });

  it('leaves the symbol eligible (no trade was taken)', () => {
    assert.equal(res.completedTrade, false);
    assert.equal(res.stillEligible, true);
  });
});

describe('ivb — re-arm after a failed confirmation (spec §7)', () => {
  // B1 = 10:00 (high 100.6) fails at 10:05. The 10:05 bar closes back below
  // OR_high (99.5), so the 10:10 bar is a FRESH break -> new setup.
  const bars = [
    ...orBars('2026-11-20'),
    bar('2026-11-20', '10:00:00', 98.6, 100.6, 98.5, 100.4),
    bar('2026-11-20', '10:05:00', 100.3, 100.4, 99.2, 99.5),
    bar('2026-11-20', '10:10:00', 99.6, 101.0, 99.5, 100.8),
    bar('2026-11-20', '10:15:00', 100.9, 101.4, 100.6, 101.2),
    bar('2026-11-20', '10:20:00', 101.3, 101.5, 100.9, 101.0),
  ];
  const res = computeIvbSetupSequence(bars);

  it('records two setups: the invalidated one and the re-armed one', () => {
    assert.equal(res.setups.length, 2);
    assert.equal(res.setups[0].outcome, 'invalidated');
    assert.equal(res.setups[1].outcome, 'entered');
  });

  it('enters the re-armed setup at the second confirmation close', () => {
    const s = res.setups[1];
    assert.equal(s.breakBar.minuteOfDay, 610);
    assert.equal(s.confirmation.minuteOfDay, 615);
    assert.equal(s.entry.price, 101.2);
    assert.equal(s.R, 101.4 - 100.6);
    assert.equal(s.stop, s.entry.price - s.R);
    assert.equal(s.target, s.entry.price + s.R);
  });

  it('does not re-use the first break bar as a new break (no continuation signals)', () => {
    const breaks = res.marks.filter((m) => m.break);
    assert.deepEqual(breaks.map((m) => m.minuteOfDay), [600, 610]);
  });
});

describe('ivb — completed trade ends trading for the day (spec §7)', () => {
  // The positive trade exits at 10:10 (target). A later fresh break at
  // 11:00 must NOT produce a second trade.
  const bars = [
    ...orBars('2026-11-20'),
    bar('2026-11-20', '10:00:00', 98.6, 100.6, 98.5, 100.4),
    bar('2026-11-20', '10:05:00', 100.5, 101.2, 100.0, 101.0),
    bar('2026-11-20', '10:10:00', 101.1, 102.5, 100.9, 102.3),
    // Push back below OR_high so a later bar could look like a fresh cross.
    bar('2026-11-20', '10:15:00', 102.3, 102.4, 97.0, 97.2),
    bar('2026-11-20', '10:20:00', 97.3, 101.5, 97.2, 101.4),
    bar('2026-11-20', '10:25:00', 101.5, 102.0, 101.0, 101.8),
  ];
  const res = computeIvbSetupSequence(bars);

  it('takes only the first trade', () => {
    const entered = res.setups.filter((s) => s.outcome === 'entered');
    assert.equal(entered.length, 1);
    assert.equal(res.setups.length, 1);
  });

  it('reports the symbol as no longer eligible', () => {
    assert.equal(res.completedTrade, true);
    assert.equal(res.stillEligible, false);
  });

  it('marks the bars after the exit as done', () => {
    const doneMarks = res.marks.filter((m) => m.done);
    assert.ok(doneMarks.length >= 1);
    assert.equal(doneMarks[0].exitReason, 'target');
  });
});

describe('ivb — exit rules (spec §8, §10)', () => {
  it('exits at the stop loss when the bar trades below entry - R', () => {
    const bars = [
      ...orBars('2026-11-20'),
      bar('2026-11-20', '10:00:00', 98.6, 100.6, 98.5, 100.4),
      bar('2026-11-20', '10:05:00', 100.5, 101.2, 100.0, 101.0),
      bar('2026-11-20', '10:10:00', 100.8, 100.9, 99.5, 99.7),
    ];
    const res = computeIvbSetupSequence(bars);
    const s = res.setups[0];
    assert.equal(s.exit.reason, 'stop');
    assert.equal(s.exit.price, 99.8);
  });

  it('uses the pessimistic (stop-first) fill when stop and target are both inside one bar', () => {
    const bars = [
      ...orBars('2026-11-20'),
      bar('2026-11-20', '10:00:00', 98.6, 100.6, 98.5, 100.4),
      bar('2026-11-20', '10:05:00', 100.5, 101.2, 100.0, 101.0),
      bar('2026-11-20', '10:10:00', 100.8, 102.5, 99.5, 101.5),
    ];
    const res = computeIvbSetupSequence(bars);
    const s = res.setups[0];
    assert.equal(s.exit.reason, 'stop');
    assert.equal(s.exit.price, 99.8);
    assert.equal(s.ambiguous, true);
    assert.equal(res.ambiguityCount, 1);
  });

  it('closes the position at the end of the regular session (time stop)', () => {
    // Entry at 15:55, no target/stop hit before the session ends at 16:00.
    const bars = [
      ...orBars('2026-11-20'),
      bar('2026-11-20', '10:00:00', 98.6, 100.6, 98.5, 100.4),
      bar('2026-11-20', '10:05:00', 100.5, 101.2, 100.0, 101.0),
      bar('2026-11-20', '15:55:00', 100.5, 100.8, 100.2, 100.4),
    ];
    const res = computeIvbSetupSequence(bars);
    const s = res.setups[0];
    assert.equal(s.exit.reason, 'session-end');
    assert.equal(res.completedTrade, true);
    assert.equal(res.stillEligible, false);
  });

  it('leaves a trade open when the supplied data stops mid-session', () => {
    const bars = positiveDayBars().slice(0, 8); // ends at 10:10 with no exit
    const res = computeIvbSetupSequence(bars);
    assert.equal(res.setups[0].exit, null);
    assert.equal(res.inTradeAtEnd, true);
    assert.equal(res.completedTrade, false);
  });
});

describe('ivb — session handling (spec §2, §8.3)', () => {
  it('ignores pre-market bars when computing the OR', () => {
    const bars = [
      // Pre-market 04:00-09:25 ET with a much higher high: must not count.
      bar('2026-11-20', '04:00:00', 90, 120, 89, 119),
      bar('2026-11-20', '09:00:00', 100, 130, 99, 129),
      ...orBars('2026-11-20'),
      bar('2026-11-20', '10:00:00', 98.6, 100.6, 98.5, 100.4),
      bar('2026-11-20', '10:05:00', 100.5, 101.2, 100.0, 101.0),
    ];
    const res = computeIvbSetupSequence(bars);
    assert.equal(res.or.high, 100);
    assert.equal(res.or.low, 98);
    assert.equal(res.or.barCount, 6);
  });

  it('ignores after-hours bars for the state machine', () => {
    const bars = [
      ...orBars('2026-11-20'),
      bar('2026-11-20', '10:00:00', 98.6, 100.6, 98.5, 100.4),
      bar('2026-11-20', '10:05:00', 100.5, 101.2, 100.0, 101.0),
      bar('2026-11-20', '17:00:00', 101.0, 101.5, 100.5, 101.2),
    ];
    const res = computeIvbSetupSequence(bars);
    assert.equal(res.regularBarCount, 8);
    assert.equal(res.setups.length, 1);
  });

  it('resolves the OR window by exchange timezone, not by naive bar timestamps', () => {
    // Same instants, different exchange timezone: the 09:30-10:00 ET window
    // maps to different bars. Under UTC the OR bars are a different set.
    const bars = [
      bar('2026-11-20', '09:30:00', 99.0, 99.4, 98.8, 99.2),
      bar('2026-11-20', '09:35:00', 99.2, 99.7, 98.9, 99.5),
      bar('2026-11-20', '09:40:00', 99.5, 99.8, 99.0, 99.4),
      bar('2026-11-20', '09:45:00', 99.4, 99.9, 98.7, 99.6),
      bar('2026-11-20', '09:50:00', 99.6, 100.0, 99.2, 99.8),
      bar('2026-11-20', '09:55:00', 99.8, 99.9, 98.0, 98.5),
    ];
    const ny = computeIvbSetupSequence(bars, { exchangeTimezone: TZ });
    assert.equal(ny.or.barCount, 6);
    assert.equal(ny.or.high, 100);

    // Under UTC those timestamps are 14:30-14:55 UTC -> outside 09:30-10:00.
    const utc = computeIvbSetupSequence(bars, { exchangeTimezone: 'UTC' });
    assert.equal(utc.or.barCount, 0);
    assert.equal(utc.or.complete, false);
  });

  it('rejects input spanning more than one trading day', () => {
    const bars = [
      ...orBars('2026-11-20'),
      ...orBars('2026-11-23'),
    ];
    assert.throws(() => computeIvbSetupSequence(bars), /one trading day/);
  });

  it('reports the OR as incomplete when fewer than six opening bars exist', () => {
    const res = computeIvbSetupSequence(orBars('2026-11-20').slice(0, 3));
    assert.equal(res.or.complete, false);
    assert.equal(res.setups.length, 0);
  });
});

describe('ivb — break freshness (spec §3)', () => {
  it('does not signal a continuation bar that closes above OR_high again', () => {
    const bars = [
      ...orBars('2026-11-20'),
      bar('2026-11-20', '10:00:00', 98.6, 100.6, 98.5, 100.4),
      bar('2026-11-20', '10:05:00', 100.5, 101.2, 100.0, 101.0),
    ];
    const res = computeIvbSetupSequence(bars);
    assert.equal(res.marks.filter((m) => m.break).length, 1);
  });

  it('requires the previous bar to close at or below OR_high (fresh cross only)', () => {
    // The 09:55 bar closes exactly at OR_high; the 10:00 bar closes above it
    // -> that is a fresh cross (close(B-1) <= OR_high).
    const bars = orBars('2026-11-20').map((b) => ({ ...b }));
    bars[5] = bar('2026-11-20', '09:55:00', 99.8, 100.0, 98.0, 100.0);
    bars.push(bar('2026-11-20', '10:00:00', 100.1, 100.8, 100.0, 100.7));
    bars.push(bar('2026-11-20', '10:05:00', 100.8, 101.5, 100.5, 101.2));
    const res = computeIvbSetupSequence(bars);
    assert.equal(res.marks.filter((m) => m.break).length, 1);
    assert.equal(res.setups.length, 1);
    assert.equal(res.setups[0].outcome, 'entered');
  });
});
