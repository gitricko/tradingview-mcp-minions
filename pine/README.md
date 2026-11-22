# IVB 5-minute Entry/Exit model — indicator

Pine v6 overlay indicator that marks the IVB 5-minute Entry/Exit model on a
5-minute chart, so the model's markings can be eyeballed against annotated
reference days before any performance number is trusted.

| File | Role |
| --- | --- |
| `pine/ivb-5min-entry-exit.pine` | The indicator (this directory's tracked Pine source). |
| `src/core/ivb.js` | The plain-JS reference implementation of the same rules — single source of truth. |
| `tests/ivb.test.js` | Synthetic-OHLCV case suite for the reference implementation. |
| `tests/ivb_pine_consistency.test.js` | Static consistency check between the Pine and the JS. |

Rules and scope: `data/ivb-5min-entry-model/rules.md` in the Firstmate task
material (not vendored here). Long-only, per symbol; TQQQ and SQQQ are traded
independently.

## What the indicator plots

- the 30-minute opening range (09:30–10:00 **exchange-local**) as a high/low
  pair with the band shaded for the day;
- the **break bar** (`B`) — only when a bar closes above the OR high after a
  bar that did not;
- the **confirmation bar** (`C`, the bar right after `B`) marked distinctly
  when it is valid (`close(C) > high(B)`) and when it is invalidated;
- the **entry / stop / 1R-target box**, with `R = high(C) - low(C)`,
  `stop = entry - R`, `target = entry + R`;
- the symbol greyed out once a trade has completed (done for the day).

The exchange timezone comes from `syminfo.timezone`, so the opening range is
resolved from the symbol's exchange, not from a naive bar-time prefix.

## Compiling on TradingView

TradingView's own compiler rejects a `plot*` call issued in **local scope**
(i.e. inside an `if` / `for` / `while` block) with:

```
Cannot use "{functionName}" in local scope
```

The repository's offline Pine analyzer (`src/core/pine.js`) does **not** catch
this class of build-time error, so the file was shipped once with three
`plotshape()` calls nested in the state blocks and failed to compile on
TradingView (lines 122 / 130 / 138 of the original file).

The indicator therefore records each event marking into its own series
(`markBreak` / `markConf` / `markInvalid`) inside the state blocks, and issues
the `plotshape()` calls **once, at global scope**. The per-bar reset
(`markBreak := na` and friends, before the state blocks) is what keeps each
marking firing on the bar that produced it and nowhere else.

`tests/ivb_pine_consistency.test.js` guards this: it fails if any `plot*`
call is nested in a block, and carries a negative test proving the guard
detects the original three offending calls.

To compile against the real compiler:

```bash
# Server-side TradingView compiler (pine-facade) — no chart needed.
TV_CDP_HOST=<host> TV_CDP_PORT=9222 node src/cli/index.js pine check \
  --file pine/ivb-5min-entry-exit.pine
# -> { "compiled": true, "error_count": 0, "warning_count": 0 }

# Or push it to the live editor and compile there.
TV_CDP_HOST=<host> TV_CDP_PORT=9222 node src/cli/index.js pine set \
  --file pine/ivb-5min-entry-exit.pine
TV_CDP_HOST=<host> TV_CDP_PORT=9222 node src/cli/index.js pine compile
```

## Running the tests

```bash
npm run test:ivb          # the IVB unit suite + the Pine/JS consistency check
npm run check:syntax
npm run lint
npm run test:offline      # full offline regression suite
```

The Pine source cannot be executed locally; its correctness is established by
the shared JS reference plus the static consistency check, and by compiling it
against TradingView's own compiler (see **Compiling on TradingView** above).
Live chart reconciliation is a separate task.
