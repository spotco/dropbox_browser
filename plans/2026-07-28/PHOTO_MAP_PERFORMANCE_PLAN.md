# Photo Map performance plan

## Diagnosis

- [x] Avoid the duplicate folder listing request when Browse is already
  loading the current folder. The live Brave page transferred two listings of
  about 34 MB each.
- [x] Ensure the client-render Browse bootstrap runs before Photo Map when the
  latter is restored as the initial pane.
- [x] Replace the Photo Map cache merge's per-candidate linear scan with a
  keyed lookup. The current folder has 26,573 candidates and 26,573 cache
  entries; the existing shape is close to quadratic.
- [ ] Keep the full cache payload reduction as a follow-up if the keyed merge
  and shared listing are not sufficient. The current cache response is about
  12 MB.
- [x] Spread expensive pin/group layer work over animation frames while
  preserving grouping, marker identity, popup behavior, and final status.
- [x] Keep CPU usage bounded: retain conservative metadata/thumbnail
  concurrency and use frame-sized batches rather than increasing parallelism.

## Implementation

- [x] Add an in-flight current-listing promise to the Browse client and let
  Photo Map await it before falling back to its own endpoint.
- [x] Order the client-render script bootstrap so Browse installs its shared
  listing state before Photo Map can activate.
- [x] Add an O(n + m) cache merge implementation that preserves identity and
  QuickTime parser-version behavior.
- [x] Add progressive marker-layer synchronization with a small per-frame
  batch, keeping the existing synchronous API as the default for tests and
  non-progressive callers.
- [x] Add focused JavaScript tests for shared listing reuse, cache merge
  equivalence, and progressive marker-layer completion.
- [x] Run the Photo Map JavaScript and Python groups, then the full regression
  suite.

## Verification

- [x] Confirm no duplicate listing request in the focused browser/E2E flow.
- [x] Confirm all existing Photo Map behavior tests pass.
- [x] Record test results and any remaining follow-up work here.

## Results

- [x] `npm run test:js:photo-map`: 76/76 passed.
- [x] `python -m tests.run photo-map -v`: 10/10 passed.
- [x] `npx playwright test tests/e2e/client-render.photo-map.spec.js --project=client-render`: 1/1 passed.
- [x] `python -m unittest discover -s tests -v`: 502/502 passed.
- [x] `npm run test:js`: passed.
- [x] `python -m tests.run web -v`: 10/10 passed.
- [x] `git diff --check`: passed.
- [ ] Follow-up: consider reducing the cache response payload before changing
  the cache schema; the keyed merge and shared listing request are implemented
  first so behavior and CPU usage remain stable.
