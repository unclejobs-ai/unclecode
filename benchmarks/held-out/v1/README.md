# UncleCode held-out benchmark v1

This directory is the immutable evaluator side of the Task 11 offline benchmark. It contains 40 cases: 10 each for code, content, analysis, and workflow.

`manifest.json` pins the exact bytes of the case corpus, evaluator, thresholds, and recorded baseline fixture. The trusted runner pins the manifest hash in turn and exports `HELD_OUT_V1_EVALUATOR_ASSETS`, `HELD_OUT_V1_SUITE_ASSETS`, and their combined `HELD_OUT_V1_PROTECTED_ASSETS` for creator-lifecycle wiring. The runner reads these assets from its own trusted checkout and rejects a missing, extra, duplicated, escaping, symlinked, or hash-mismatched protected asset. Candidate result files are inputs and are deliberately not listed as protected suite assets.

The checked-in baseline and candidate are deterministic offline fixtures. They exercise the scoring and evidence gates without a provider credential, but they are not live quality evidence. A fixture comparison can pass its numerical and critic-shape gates while the integrated proof remains `unproven`. Candidate JSON cannot self-assert integrated proof: trusted live-run, complete verification-matrix, and independent-final-review evidence must be supplied separately by the host API.

Run the fixture harness from the repository root:

```sh
node scripts/held-out-benchmark.mjs --json
```

Use `--candidate <path>` for a separately recorded candidate result and `--require-proven` when generating an integration acceptance result.
