# AB complex scenario suite

This directory preserves distinct, real interaction shapes that exposed failures in Agent use. Each scenario owns its deterministic page, user path, assertions, and a README that records why the scenario exists.

## Admission rule

Add a scenario when a failure depends on a reusable combination of page shape, state transition, scale, browser lifecycle, or Agent-visible output. A small branch, constant, or isolated protocol mapping belongs in its existing focused check instead.

Every accepted scenario must record:

- the real incident shape without copying credentials or private page content;
- the pressure dimensions that made the failure observable;
- the complete user action and observation path;
- implementation-independent invariants that distinguish correct behavior;
- known boundaries that the scenario does not claim to prove.

The fixture may be a deterministic local reduction of a private or unstable page. It must preserve the relevant scale and interaction shape; it must not special-case a site URL, label, date, or benchmark answer in production code.

## Execution rule

Complex scenarios are named cases in `test/ab/live-suite.ts` and run in the default real-Chrome suite. A new scenario is additive: fixing it does not replace or disable earlier scenarios. Failures stay attributable to the individual scenario rather than being folded into a generic smoke result.

These scenarios are product regression evidence, not official benchmark scores. MiniWoB++, WebArena-Verified, and VisualWebArena remain separate under `test/benchmarks`.
