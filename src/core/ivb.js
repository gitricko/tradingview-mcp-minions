/**
 * IVB 5-minute Entry/Exit model — plain-JS reference implementation.
 *
 * This module is the single source of truth for the model's rules. It is
 * pure: no TradingView connection, no CDP, no network, no I/O. The Pine
 * indicator (`pine/ivb-5min-entry-exit.pine`) and the synthetic test suite
 * (`tests/ivb.test.js`) are both derived from the rules encoded here, so the
 * chart and the numbers cannot drift apart.
 *
 * Spec: data/ivb-5min-entry-model/rules.md (IVB 5-minute Entry/Exit Model).
 *
 * Model summary (long only, per symbol; TQQQ and SQQQ are traded independently):
 *   • OR          = high/low of the first six regular-session 5-minute bars,
 *                   i.e. the 09:30-10:00 window in the symbol's exchange
 *                   timezone (America/New_York for TQQQ / SQQQ).
 *   • Break  B    = regular bar at/after 10:00 exchange-local with
 *                   close(B) > OR_high AND close(B-1) <= OR_high
 *                   (close-confirmed fresh cross — an intrabar wick poke does
 *                   not count).
 *   • Confirm C   = the bar immediately after B; valid only when
 *                   close(C) > high(B) (the whole break bar, wick included).
 *   • Entry       = close(C).
 *   • R           = high(C) - low(C) (the full range of the entry bar).
 *   • Stop        = entry - R, Target = entry + R (1:1).
 *   • Re-arm      = a failed confirmation leaves the symbol eligible; a later
 *                   fresh break of the same day's OR_high starts a new setup.
 *   • Daily limit = once an entered trade has exited (target, stop or the
 *                   end-of-session time stop) the symbol takes no further
 *                   trades that day.
 *
 * Bar shape: { time, open, high, low, close, volume }
 *   `time` is unix seconds; unix milliseconds are accepted and normalised.
 */

export const DEFAULT_EXCHANGE_TIMEZONE = 'America/New_York';
/** 09:30 exchange-local — first regular-session bar / first OR bar. */
export const OR_START_MINUTE = 9 * 60 + 30;
/** 10:00 exchange-local — the OR is complete; break bars start here. */
export const OR_END_MINUTE = 10 * 60;
/** 16:00 exchange-local — regular session close (time stop). */
export const SESSION_END_MINUTE = 16 * 60;
/** Number of 5-minute bars in the 30-minute opening range. */
export const OR_BAR_COUNT = 6;

const _tzFormatters = new Map();

function _tzFormatter(timezone) {
  let fmt = _tzFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    _tzFormatters.set(timezone, fmt);
  }
  return fmt;
}

function _pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Resolve the exchange timezone to use for session windows.
 * Mirrors src/core/chart.js `frameChart`: the IANA name comes from the
 * symbol's exchange (never from naive bar-time string prefixes).
 *
 * @param {string|null|undefined} timezone IANA name, e.g. "America/New_York".
 * @returns {{timezone: string, source: 'exchange_symbol'|'default'|'default_invalid'}}
 */
export function resolveExchangeTimezone(timezone) {
  if (timezone == null || timezone === '') {
    return { timezone: DEFAULT_EXCHANGE_TIMEZONE, source: 'default' };
  }
  const name = String(timezone);
  try {
    _tzFormatter(name).formatToParts(new Date(0));
    return { timezone: name, source: 'exchange_symbol' };
  } catch {
    return { timezone: DEFAULT_EXCHANGE_TIMEZONE, source: 'default_invalid' };
  }
}

/**
 * Wall-clock parts of a unix timestamp in the given IANA timezone.
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number,minuteOfDay:number}}
 */
export function exchangeLocalParts(unixSeconds, timezone) {
  const parts = _tzFormatter(timezone).formatToParts(new Date(unixSeconds * 1000));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
    minuteOfDay: hour * 60 + get('minute'),
  };
}

/**
 * UTC offset (seconds east of UTC) of an IANA timezone at an instant.
 * @returns {number|null} null when the zone is unknown.
 */
export function tzOffsetSecondsAt(timezone, unixSeconds) {
  try {
    const parts = _tzFormatter(timezone).formatToParts(new Date(unixSeconds * 1000));
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return Math.round((asUTC - unixSeconds * 1000) / 1000);
  } catch {
    return null;
  }
}

/**
 * Convert an exchange-local wall-clock date + minute-of-day to unix seconds.
 * DST-safe: the UTC offset is resolved iteratively at the target instant.
 *
 * @param {string} dateStr "YYYY-MM-DD" in the exchange timezone.
 * @param {number} minuteOfDay minutes since local midnight.
 * @param {string} timezone IANA name.
 * @returns {number} unix seconds.
 */
export function exchangeLocalToUnixSeconds(dateStr, minuteOfDay, timezone = DEFAULT_EXCHANGE_TIMEZONE) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) throw new Error(`Bad date string: ${dateStr}`);
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0) / 1000;
  let offset = tzOffsetSecondsAt(timezone, naive + 12 * 3600) ?? 0;
  for (let i = 0; i < 3; i += 1) {
    const guess = naive + minuteOfDay * 60 - offset;
    const next = tzOffsetSecondsAt(timezone, guess);
    if (next == null || next === offset) break;
    offset = next;
  }
  return naive + minuteOfDay * 60 - offset;
}

/**
 * Absolute UTC window of an exchange-local wall-clock range on a given date.
 * (Same shape as `frameChart`'s session window: local wall time resolved to
 * absolute unix seconds through the exchange's UTC offset.)
 *
 * @returns {{start:number, end:number}} unix seconds, [start, end).
 */
export function localSessionWindowUtc(dateStr, timezone, startMinute, endMinute) {
  const start = exchangeLocalToUnixSeconds(dateStr, startMinute, timezone);
  const end = exchangeLocalToUnixSeconds(dateStr, endMinute, timezone);
  return { start, end };
}

function _normalizeTime(time) {
  if (time instanceof Date) return Math.floor(time.getTime() / 1000);
  const n = Number(time);
  if (!Number.isFinite(n)) return null;
  // Heuristic: values above ~1e11 are milliseconds (year 5138 in seconds).
  return Math.floor(n > 1e11 ? n / 1000 : n);
}

function _barSnapshot(w) {
  const b = w.bar;
  return {
    barIndex: b.srcIndex,
    time: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    minuteOfDay: w.local.minuteOfDay,
  };
}

/**
 * Run the IVB daily state machine over one symbol's 5-minute bars for a
 * single trading day.
 *
 * @param {Array<{time:number,open:number,high:number,low:number,close:number,volume?:number}>} bars
 *        5-minute OHLCV bars. Pre-market / after-hours bars are ignored (they
 *        never contribute to the OR); only regular-session bars drive the
 *        state machine.
 * @param {object} [options]
 * @param {string} [options.exchangeTimezone] IANA name of the symbol's
 *        exchange timezone (defaults to America/New_York).
 * @param {number} [options.orStartMinute] OR window start, minutes local.
 * @param {number} [options.orEndMinute] OR window end, minutes local.
 * @param {number} [options.sessionEndMinute] regular session close, minutes local.
 * @returns {object} the setup sequence for the day.
 */
export function computeIvbSetupSequence(bars, options = {}) {
  if (!Array.isArray(bars)) throw new TypeError('bars must be an array of OHLCV bars');

  const { timezone, source: timezoneSource } = resolveExchangeTimezone(options.exchangeTimezone);
  const orStartMin = options.orStartMinute ?? OR_START_MINUTE;
  const orEndMin = options.orEndMinute ?? OR_END_MINUTE;
  const sessionEndMin = options.sessionEndMinute ?? SESSION_END_MINUTE;

  const normalized = [];
  for (let i = 0; i < bars.length; i += 1) {
    const raw = bars[i];
    if (!raw || typeof raw !== 'object') continue;
    const time = _normalizeTime(raw.time);
    const open = Number(raw.open);
    const high = Number(raw.high);
    const low = Number(raw.low);
    const close = Number(raw.close);
    if (time == null || ![open, high, low, close].every(Number.isFinite)) continue;
    normalized.push({
      srcIndex: i, time, open, high, low, close,
      volume: Number(raw.volume) || 0,
    });
  }
  normalized.sort((a, b) => (a.time - b.time) || (a.srcIndex - b.srcIndex));

  const withLocal = normalized.map((bar) => ({ bar, local: exchangeLocalParts(bar.time, timezone) }));
  const regular = withLocal.filter((w) => w.local.minuteOfDay >= orStartMin && w.local.minuteOfDay < sessionEndMin);

  const dayKeys = new Set(regular.map((w) => `${w.local.year}-${_pad2(w.local.month)}-${_pad2(w.local.day)}`));
  if (dayKeys.size > 1) {
    throw new Error(
      `computeIvbSetupSequence expects one trading day; got ${dayKeys.size} (${[...dayKeys].join(', ')})`,
    );
  }
  const tradingDay = dayKeys.size === 1 ? [...dayKeys][0] : null;

  const orWindowBars = regular.filter((w) => w.local.minuteOfDay < orEndMin);
  const postOrBars = regular.filter((w) => w.local.minuteOfDay >= orEndMin);
  const orHigh = orWindowBars.length ? Math.max(...orWindowBars.map((w) => w.bar.high)) : null;
  const orLow = orWindowBars.length ? Math.min(...orWindowBars.map((w) => w.bar.low)) : null;
  const orComplete = orWindowBars.length >= OR_BAR_COUNT && postOrBars.length > 0;

  const setups = [];
  const timeline = [];
  const marks = [];

  let prevClosedAboveOr = false;
  let eligible = true;
  let pending = null; // { breakHigh, breakBar }
  let trade = null; // { entry, R, stop, target, entryBar }
  let activeSetup = null; // setup record that owns `trade`
  let completedTrade = false;
  let ambiguityCount = 0;

  for (let i = 0; i < regular.length; i += 1) {
    const w = regular[i];
    const b = w.bar;
    const mark = {
      barIndex: b.srcIndex,
      time: b.time,
      minuteOfDay: w.local.minuteOfDay,
      close: b.close,
      break: false,
      confirmValid: false,
      confirmInvalid: false,
      entry: false,
      exit: false,
      exitReason: null,
      inTrade: false,
      done: false,
    };

    // ── 1. Resolve an open position first (stop/target before new setups) ──
    if (trade) {
      const stopHit = b.low <= trade.stop;
      const targetHit = b.high >= trade.target;
      let exitPrice = null;
      let exitReason = null;
      let ambiguous = false;
      if (stopHit && targetHit) {
        exitPrice = trade.stop;      // pessimistic fill (§10.4)
        exitReason = 'stop';
        ambiguous = true;
      } else if (stopHit) {
        exitPrice = trade.stop;
        exitReason = 'stop';
      } else if (targetHit) {
        exitPrice = trade.target;
        exitReason = 'target';
      }
      if (exitPrice != null) {
        trade.exit = {
          barIndex: b.srcIndex, time: b.time, price: exitPrice,
          reason: exitReason, ambiguous,
        };
        trade.ambiguous = ambiguous;
        if (ambiguous) ambiguityCount += 1;
        completedTrade = true;
        eligible = false;
        if (activeSetup) {
          activeSetup.exit = trade.exit;
          activeSetup.ambiguous = ambiguous;
          activeSetup.eligibleAfter = false;
        }
        mark.exit = true;
        mark.exitReason = exitReason;
        mark.done = true;
        timeline.push({ type: 'exit', reason: exitReason, price: exitPrice, barIndex: b.srcIndex, time: b.time, ambiguous });
        trade = null;
      }
    }

    // ── 2. Confirmation bar C = B + 1 ──────────────────────────────────────
    if (pending) {
      const confirmation = _barSnapshot(w);
      const valid = b.close > pending.breakHigh;
      confirmation.valid = valid;
      const setup = {
        id: setups.length + 1,
        breakBar: pending.breakBar,
        breakHigh: pending.breakHigh,
        confirmation,
        outcome: null,
        entry: null,
        R: null,
        stop: null,
        target: null,
        exit: null,
        ambiguous: false,
        eligibleAfter: true,
      };
      if (valid) {
        const R = b.high - b.low;
        if (R > 0) {
          const entry = b.close;
          trade = {
            entry, R,
            stop: entry - R,
            target: entry + R,
            entryBar: _barSnapshot(w),
          };
          setup.outcome = 'entered';
          activeSetup = setup;
          setup.entry = { barIndex: b.srcIndex, time: b.time, price: entry };
          setup.R = R;
          setup.stop = trade.stop;
          setup.target = trade.target;
          mark.confirmValid = true;
          mark.entry = true;
          timeline.push({ type: 'confirm_valid', barIndex: b.srcIndex, time: b.time });
          timeline.push({ type: 'entry', price: entry, R, stop: trade.stop, target: trade.target, barIndex: b.srcIndex, time: b.time });
        } else {
          // Degenerate zero-range entry bar: no trade, stay eligible.
          setup.outcome = 'degenerate-risk';
          mark.confirmValid = true;
          timeline.push({ type: 'confirm_valid', barIndex: b.srcIndex, time: b.time });
          timeline.push({ type: 'no_trade', reason: 'degenerate-risk', barIndex: b.srcIndex, time: b.time });
        }
      } else {
        setup.outcome = 'invalidated';
        mark.confirmInvalid = true;
        timeline.push({ type: 'confirm_invalid', barIndex: b.srcIndex, time: b.time });
      }
      setups.push(setup);
      pending = null;
    }

    // ── 3. Break bar B: close-confirmed fresh cross of OR_high ────────────
    if (eligible && !trade && !pending && orComplete && w.local.minuteOfDay >= orEndMin) {
      if (b.close > orHigh && !prevClosedAboveOr) {
        pending = { breakHigh: b.high, breakBar: _barSnapshot(w) };
        mark.break = true;
        timeline.push({ type: 'break', barIndex: b.srcIndex, time: b.time, breakHigh: b.high });
      }
    }

    // ── 4. Remember whether the previous bar closed above OR_high ─────────
    if (orComplete) prevClosedAboveOr = b.close > orHigh;

    mark.inTrade = !!trade;
    mark.done = completedTrade;
    marks.push(mark);
  }

  // ── 5. Time stop: flat by the end of the regular session ────────────────
  // Mirrors the Pine guard `state == 2 and barMinute + 5 >= sessionEnd`: the
  // position is closed on the last bar of the regular session. When the data
  // is truncated mid-session there is no session-end event, and the trade is
  // reported as still open.
  if (trade && regular.length) {
    const lastW = regular[regular.length - 1];
    const last = lastW.bar;
    if (lastW.local.minuteOfDay + 5 >= sessionEndMin) {
      trade.exit = {
        barIndex: last.srcIndex, time: last.time, price: last.close,
        reason: 'session-end', ambiguous: false,
      };
      completedTrade = true;
      eligible = false;
      if (activeSetup) {
        activeSetup.exit = trade.exit;
        activeSetup.ambiguous = false;
        activeSetup.eligibleAfter = false;
      }
      const lastMark = marks[marks.length - 1];
      if (lastMark) {
        lastMark.exit = true;
        lastMark.exitReason = 'session-end';
        lastMark.done = true;
      }
      timeline.push({ type: 'exit', reason: 'session-end', price: last.close, barIndex: last.srcIndex, time: last.time, ambiguous: false });
    }
  }

  // A break bar whose confirmation bar never arrived (session ended) — no
  // trade was taken, the symbol stays eligible.
  if (pending) {
    setups.push({
      id: setups.length + 1,
      breakBar: pending.breakBar,
      breakHigh: pending.breakHigh,
      confirmation: null,
      outcome: 'no-confirmation',
      entry: null,
      R: null,
      stop: null,
      target: null,
      exit: null,
      ambiguous: false,
      eligibleAfter: true,
    });
    timeline.push({ type: 'no_confirmation', barIndex: pending.breakBar.barIndex, time: pending.breakBar.time });
  }

  return {
    exchangeTimezone: timezone,
    timezoneSource,
    tradingDay,
    session: {
      openMinute: orStartMin,
      orEndMinute: orEndMin,
      closeMinute: sessionEndMin,
    },
    or: {
      high: orHigh,
      low: orLow,
      barCount: orWindowBars.length,
      complete: orComplete,
      startTime: orWindowBars.length ? orWindowBars[0].bar.time : null,
      endTime: orWindowBars.length ? orWindowBars[orWindowBars.length - 1].bar.time : null,
    },
    setups,
    timeline,
    marks,
    regularBarCount: regular.length,
    completedTrade,
    inTradeAtEnd: !!trade,
    stillEligible: eligible && !trade,
    ambiguityCount,
  };
}

export default computeIvbSetupSequence;
