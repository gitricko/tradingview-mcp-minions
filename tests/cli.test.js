/**
 * CLI unit tests — no TradingView connection needed.
 * Tests: help output, pine analyze, pine check, error handling, exit codes.
 *
 * Run: node --test tests/cli.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, unlinkSync } from 'fs';

function require_fs() { return { writeFileSync, unlinkSync }; }

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'src', 'cli', 'index.js');

function run(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 15000,
      ...opts,
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  }
}

describe('CLI — overlay dismissal', () => {
  // Point at a dead CDP endpoint so the probe fails fast and deterministically
  // (no live TradingView, no retry-against-a-real-server latency).
  const DEAD = { env: { ...process.env, TV_CDP_HOST: '127.0.0.1', TV_CDP_PORT: '9999' } };

  it('lists `ui dismiss` in the ui help', () => {
    const { stdout, exitCode } = run(['ui', '--help'], DEAD);
    assert.equal(exitCode, 0);
    assert.match(stdout, /dismiss/i);
  });

  it('exits 2 (connection failure) when CDP is unreachable', () => {
    const { stdout, stderr, exitCode } = run(['ui', 'dismiss'], { ...DEAD, timeout: 30000 });
    assert.equal(exitCode, 2, 'unreachable CDP must be exit 2, not a silent success');
    // Router writes the failure envelope to stderr (stdout stays for results).
    const body = JSON.parse(stderr);
    assert.equal(body.success, false);
    assert.match(body.error, /CDP connection failed/);
    assert.ok(!('dismissed' in body), 'the failure envelope is minimal — no false dismissal claims');
    assert.equal(stdout, '');
  });

  // The clean/dismissal result shape is covered in tests/popup_dismiss.test.js
  // (both the tool and overlayState levels, via _deps injection).
});

describe('CLI — help and routing', () => {
  it('--help shows command list', () => {
    const { stdout, exitCode } = run(['--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
    assert.ok(stdout.includes('status'));
    assert.ok(stdout.includes('pine'));
    assert.ok(stdout.includes('quote'));
  });

  it('-h is same as --help', () => {
    const { stdout, exitCode } = run(['-h']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
  });

  it('no args shows help', () => {
    const { stdout, exitCode } = run([]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('Usage: tv'));
  });

  it('unknown command exits 1', () => {
    const { exitCode, stderr } = run(['nonexistent']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Unknown command'));
  });

  it('pine --help shows subcommands', () => {
    const { stdout, exitCode } = run(['pine', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('get'));
    assert.ok(stdout.includes('set'));
    assert.ok(stdout.includes('compile'));
    assert.ok(stdout.includes('analyze'));
    assert.ok(stdout.includes('check'));
  });

  it('ohlcv --help shows options', () => {
    const { stdout, exitCode } = run(['ohlcv', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('--count'));
    assert.ok(stdout.includes('--summary'));
  });

  it('pane --help shows subcommands', () => {
    const { stdout, exitCode } = run(['pane', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('list'));
    assert.ok(stdout.includes('layout'));
    assert.ok(stdout.includes('focus'));
    assert.ok(stdout.includes('symbol'));
  });

  it('tab --help shows subcommands', () => {
    const { stdout, exitCode } = run(['tab', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('list'));
    assert.ok(stdout.includes('new'));
    assert.ok(stdout.includes('close'));
    assert.ok(stdout.includes('switch'));
  });

  it('pane layout missing arg exits 1', () => {
    const { exitCode, stderr } = run(['pane', 'layout']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Layout required'));
  });

  it('tab switch missing arg exits 1', () => {
    const { exitCode, stderr } = run(['tab', 'switch']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Index required'));
  });

  // Regression: leading-hyphen indicator names like "-4 CB Model" used to
  // error with "Indicator name required" because parseArgs ate the -4 as
  // a flag. The router now auto-shields ^-\d args with `--`. We can't run
  // a real add (no TV), but the error we expect is from a deeper layer —
  // either "CDP connection failed" (no TV running in CI) or a JS evaluation
  // error — proving the name made it through parseArgs.
  it('indicator add with leading-hyphen name passes through parser', () => {
    const { stderr, exitCode } = run(['indicator', 'add', '-4 CB Model Indicator']);
    // exitCode 2 = CDP connection failure (no TV in CI); exitCode 1 with
    // JS-evaluation error also acceptable. Critically, it MUST NOT be
    // the "Indicator name required" CLI parser error.
    assert.notEqual(exitCode, 0);
    assert.ok(
      !stderr.includes('Indicator name required'),
      `Expected indicator name to pass through; got: ${stderr.slice(0, 200)}`,
    );
  });

  // Regression: `frame --date D --session us_regular --time_zone -5` used to
  // fail with the confusing "`to` must be greater than `from`" because the
  // router's negative-positional shield turned the flag value into `--` (so
  // time_zone parsed as the string '--' → NaN). Known string-typed long
  // options are no longer shielded, so the value flows through as a number.
  // We can't run a real frame (no TV), but the errors we may legitimately
  // see are CDP/evaluation ones — never the NaN range error.
  it('frame --time_zone -5 space form parses (no NaN range error)', () => {
    const { stderr, exitCode } = run([
      'frame', '--date', '2026-11-18', '--session', 'us_regular', '--time_zone', '-5',
    ]);
    assert.notEqual(exitCode, 0);
    assert.ok(
      !/must be greater than/.test(stderr),
      `time_zone value was lost (NaN). stderr: ${stderr.slice(0, 300)}`,
    );
  });

  // The = form must keep working (it was never broken — this pins it).
  it('frame --time_zone=-5 equals form still parses', () => {
    const { stderr, exitCode } = run([
      'frame', '--date', '2026-11-18', '--session', 'us_regular', '--time_zone=-5',
    ]);
    assert.notEqual(exitCode, 0);
    assert.ok(
      !/must be greater than/.test(stderr),
      `time_zone value was lost (NaN). stderr: ${stderr.slice(0, 300)}`,
    );
  });

  // The shield must still protect genuine leading-hyphen positionals.
  it('frame --date with a leading-hyphen indicator name still shields', () => {
    const { stderr, exitCode } = run(['frame', '-4 CB Model']);
    assert.notEqual(exitCode, 0);
    // It should not be a parser crash from a dangling option value.
    assert.ok(
      !/Unknown option.*-4/.test(stderr),
      `positional -4 was not shielded. stderr: ${stderr.slice(0, 300)}`,
    );
  });
});

describe('CLI — pine analyze (offline)', () => {
  it('analyzes clean v6 script', () => {
    const source = '//@version=6\nindicator("test")\nplot(close)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.success, true);
    assert.equal(result.issue_count, 0);
  });

  it('detects array out of bounds', () => {
    const source = '//@version=6\nindicator("test")\narr = array.from(1, 2, 3)\nval = array.get(arr, 5)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.issue_count, 1);
    assert.ok(result.diagnostics[0].message.includes('out of bounds'));
  });

  it('detects strategy.entry without strategy()', () => {
    const source = '//@version=6\nindicator("test")\nstrategy.entry("long", strategy.long)';
    const { stdout, exitCode } = run(['pine', 'analyze'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.ok(result.diagnostics.some(d => d.message.includes('strategy()')));
  });

  it('errors without input', () => {
    // When stdin is a TTY (no pipe), analyze should error
    const { exitCode, stderr } = run(['pine', 'analyze']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('No source provided'));
  });

  it('reads --file flag', () => {
    const { writeFileSync, unlinkSync } = require_fs();
    const tmpFile = join(__dirname, '_test_script.pine');
    writeFileSync(tmpFile, '//@version=6\nindicator("test")\nplot(close)');
    try {
      const { stdout, exitCode } = run(['pine', 'analyze', '--file', tmpFile]);
      assert.equal(exitCode, 0);
      const result = JSON.parse(stdout);
      assert.equal(result.success, true);
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

describe('CLI — pine check (server compile)', () => {
  it('compiles valid Pine Script', () => {
    const source = '//@version=6\nindicator("test")\nplot(close)';
    const { stdout, exitCode } = run(['pine', 'check'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.success, true);
    assert.equal(result.compiled, true);
  });

  it('returns errors for invalid Pine Script', () => {
    const source = '//@version=6\nindicator("test")\nplot(nonexistent_var)';
    const { stdout, exitCode } = run(['pine', 'check'], { input: source });
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.compiled, false);
    assert.ok(result.error_count > 0);
  });
});

describe('CLI — morning brief (integration)', () => {
  it('brief --help shows options', () => {
    const { stdout, exitCode } = run(['brief', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('rules'));
  });

  it('brief -h shows options (short flag)', () => {
    const { stdout, exitCode } = run(['brief', '-h']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('rules'));
  });

  it('session --help shows get and save subcommands', () => {
    const { stdout, exitCode } = run(['session', '--help']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('get'));
    assert.ok(stdout.includes('save'));
  });

  it('session -h shows subcommands (short flag)', () => {
    const { stdout, exitCode } = run(['session', '-h']);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('get'));
    assert.ok(stdout.includes('save'));
  });
});

describe('CLI — strategy subcommands', () => {
  // Every strategy deep-surface subcommand must be routable, and each must
  // fail with the standard connection envelope (exit 2) against a dead CDP
  // endpoint rather than a routing error — a botched registration surfaces
  // as `Unknown subcommand` before any probe is attempted.
  const DEAD = { env: { ...process.env, TV_CDP_HOST: '127.0.0.1', TV_CDP_PORT: '9999' } };

  it('strategy --help lists every deep-surface subcommand', () => {
    const { stdout, exitCode } = run(['strategy', '--help']);
    assert.equal(exitCode, 0);
    for (const sub of ['deep-stats', 'deep-trades', 'equity-summary', 'broker-settings', 'set-deep-bt-range']) {
      assert.ok(stdout.includes(sub), `expected ${sub} in the strategy help`);
    }
  });

  it('strategy deep-stats reaches the CDP probe (routing, not a bad subcommand)', () => {
    const { stderr, exitCode } = run(['strategy', 'deep-stats'], { ...DEAD, timeout: 30000 });
    assert.equal(exitCode, 2, 'an unreachable CDP endpoint must exit 2');
    assert.match(stderr, /CDP connection failed/);
  });

  it('strategy deep-trades reaches the CDP probe', () => {
    const { stderr, exitCode } = run(['strategy', 'deep-trades'], { ...DEAD, timeout: 30000 });
    assert.equal(exitCode, 2);
    assert.match(stderr, /CDP connection failed/);
  });

  it('strategy set-deep-bt-range still validates its positional args offline', () => {
    // Argument-shape validation happens before the probe, so it fails fast
    // with the usage message and no connection attempt.
    const { stderr, exitCode } = run(['strategy', 'set-deep-bt-range', '2024-01-01'], DEAD);
    assert.equal(exitCode, 1);
    assert.match(stderr, /Usage: tv strategy set-deep-bt-range/);
  });

  it('strategy broker-settings requires at least one field', () => {
    const { stderr, exitCode } = run(['strategy', 'broker-settings'], DEAD);
    assert.equal(exitCode, 1);
    assert.match(stderr, /pass at least one of/);
  });

  it('strategy broker-settings --help maps kebab flags to core field names', () => {
    const { stdout, exitCode } = run(['strategy', 'broker-settings', '--help']);
    assert.equal(exitCode, 0);
    assert.match(stdout, /--initial-capital/);
    assert.match(stdout, /--long-leverage/);
    assert.match(stdout, /--slippage/);
  });
});
