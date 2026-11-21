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

## Running the tests

```bash
npm run test:ivb          # the IVB unit suite + the Pine/JS consistency check
npm run check:syntax
npm run lint
npm run test:offline      # full offline regression suite
```

The Pine source cannot be executed locally; its correctness is established by
the shared JS reference plus the static consistency check. Live chart
reconciliation is a separate task.
