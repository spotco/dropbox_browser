# Photo Map State and Thumbnail Simplification Plan

## Purpose

The current grouped-pin preview code works by synchronizing several overlapping
representations of the same thing: the map marker's group member objects, the
host's `activeGroupedPopup`, the thumbnail scheduler cache, `thumbnailResults`,
and the live Leaflet popup DOM. That made recent fixes fragile: closing a full
screen preview can cause a map move, a visibility refresh, scheduler
reprioritisation, popup listener rebinding, and popup layout fitting. A thumbnail
can therefore be shown as loading in the group grid while the same source path
is already loaded in the detail pane.

This is the implementation plan for making the feature have one state model and
few, explicit side effects. It is intentionally paired with
`PHOTO_MAP_COVERAGE_FOLLOWUPS.md`: the future E2Es there are acceptance tests
for this design, not just regression tests for the symptoms seen so far.

## Findings that motivate the work

### Same media has multiple mutable states

`photo-map.js` owns `thumbnailResults`, `activeGroupedPopup`, selected paths,
and the combined pin/group thumbnail demand. `map.js` also stores a copy of each
member on `markerEntries`; `updateGroupedMember` replaces that copy when a
thumbnail state changes and then updates/rebinds the popup. The scheduler in
`thumbnails.js` separately keeps `cache`, `pending`, `active`, `desired`, and
`failed`.

Those copies do not have a single update order. In particular, the host can
hold the group captured at popup-open time while the map replaces its own group
member object. The popup grid, selected detail pane, and map pin can consequently
render different states for the same source path.

### Preview close currently performs too much work

`restorePreviewContext` restores more than the user-visible context. It can set
the map view, reopen/refresh the popup, rebind handlers, select a member, restore
scroll, and fit the popup. Those operations emit `moveend`/popup lifecycle work;
the host then recomputes thumbnail demand. The scheduler treats that recomputation
as an opportunity to preempt active work. Browser diagnostics showed aborted
thumbnail requests after preview close, without corresponding server thumbnail
errors.

The grid's loading markup also treats non-error, non-ready state as loading. An
intentional scheduler `idle` transition therefore looks like a broken thumbnail,
even when another renderer can display the same asset.

### Leaflet integration is too intrusive

`map.js` currently uses Leaflet 1.9.4 private popup methods (`_updateLayout` and
`_updatePosition`) plus manual panning to fit expanded group popups. Private
methods make the behavior tied to the current vendor implementation and help
create the map-move/layout feedback loop. Leaflet's public popup contract accepts
content and offers `setContent`/`update`; validate the exact behavior against the
vendored 1.9.4 build with a characterization test before refactoring, especially
whether a stable HTMLElement content root remains mounted through `update`.

The goal is not to eliminate fitting: it is to make fitting a bounded,
measurement-driven map-adapter operation rather than a source of application
state transitions.

## Target architecture

### 1. Immutable media catalogue and one thumbnail store

Keep source metadata immutable after grouping. Use a `ThumbnailStore`, keyed by
canonical source path (and media rendition/kind if a future rendition differs),
as the only logical thumbnail state:

```text
path -> { state: idle | loading | ready | error,
          url, errorCode, requestGeneration, updatedAt }
```

The group grid, selected detail preview, and map-pin renderer read this store;
they do not copy `photoMapThumbnailState` or thumbnail URLs into their own media
objects. A successful thumbnail is never demoted to `loading` or `idle` for that
path. A temporary browser image failure is represented explicitly and only
changes the store when it belongs to the current request generation.

Use subscription/batched notifications so a scheduler completion can update all
renderers from one source of truth. The selected detail image may still use a
normal browser `<img>` for presentation, but its ready/loading/error affordance
must derive from the same store entry as its grid tile.

### 2. Explicit group-popup state, identified by paths

Replace `activeGroupedPopup.group` (a mutable object snapshot) with a compact
state record containing identifiers and UI-only state:

```text
{ groupPath, memberPaths, visibleMemberPaths, selectedMemberPath,
  scrollTop, popupLayoutVersion }
```

There must be one owner for this record, ideally a small Photo Map state
controller in `photo-map.js`. `map.js` becomes an imperative Leaflet adapter:
it reports popup/selection/visibility events using paths and renders the latest
state supplied by the controller. It must not retain a competing cloned member
state in `markerEntries`.

The controller should resolve paths against the immutable catalogue at render
time. This removes stale group snapshots and makes selection restoration simply
`selectedMemberPath = path` when that member still exists.

### 3. Scheduler accepts demand deltas, not incidental map churn

The thumbnail scheduler should receive a normalized demand set with a reason and
priority, then compare it to its previous desired set. A semantically identical
refresh starts no work, aborts no work, and emits no state transition.

Define demand lanes:

- `selected-group-member`: highest priority, pinned while the grouped popup is open.
- `visible-group-member`: retained while the popup remains open; reserve a small
  amount of concurrency so normal map-pin work cannot starve it.
- `selected-map-pin` and `visible-map-pin`: normal viewport work, which may be
  deprioritized on a genuine viewport change.

Do not cancel a still-desired group request merely because `moveend`, a popup
layout pass, or a no-op restore recomputed visibility. Cancellation must carry a
reason (`popup-closed`, `data-generation-changed`, `genuine-viewport-eviction`)
and must not clear a ready URL. Keeping browser-network cancellation is fine for
off-screen ordinary pins; the requirement is that selected/open-popup members
are protected from incidental preemption.

### 4. Stable, delegated popup rendering

Mount one app-owned popup root and attach one delegated click/keyboard listener
for its lifetime. Patch individual tile/detail subtrees from store state, keyed
by member path, rather than replacing the entire popup HTML or rebinding listeners
after every thumbnail completion. Preserve scroll by not recreating the scrolling
grid; save it only for deliberate unmount/remount.

First add a Leaflet 1.9.4 characterization test for public `setContent`/`update`
with an HTMLElement. If it preserves a supplied root, use that root as the stable
mount point. If the public API legitimately replaces it, centralize the remount
in one adapter function, restore scroll there, and attach the single delegated
listener exactly once per mounted root. Do not retain application dependence on
private Leaflet layout methods.

### 5. Preview close is an idempotent restore, not a reinitialization

Capture only the context required to return to the group: popup path, selected
member path, scroll position, and an optional map-view snapshot. On close:

1. Restore the existing popup state record if that popup is still active.
2. Restore the selected path and scroll position without reopening a mounted
   popup or refreshing thumbnail demand.
3. Measure the already-rendered popup and fit it only if it is actually outside
   the usable map viewport.
4. If a pan is needed, tag it as `popup-fit` so the resulting `moveend` does not
   invalidate unchanged thumbnail demand; make at most one corrective pass for a
   layout version.

If a user chose another group/member while the overlay was open, newer state wins.
History/backdrop/Escape/close button should use the same close operation. Direct
preview navigation is a separate entry path and must not fabricate or overwrite a
group-popup context.

### 6. Bounded viewport fitting through public map behavior

Introduce a single `requestPopupFit(layoutVersion)` adapter method. Coalesce
requests in `requestAnimationFrame`, measure map and popup rectangles after the
current render, and calculate the smallest needed pan within the usable viewport
(including side panels). If no overflow exists, do nothing. If a pan occurs,
perform at most one measured correction after Leaflet's public update/reposition
path completes, then stop.

Do not call `_updateLayout` or `_updatePosition` directly in application code.
The characterization test should establish the public sequence appropriate for
the vendored Leaflet version; a vendor upgrade must rerun that test.

## Suggested delivery sequence

### Phase 0 — Characterize the current contracts

Before changing behavior, add focused JS tests for scheduler demand deltas,
popup DOM mount behavior under Leaflet 1.9.4, and preview-context restoration.
Add E2E diagnostic helpers that expose store entries, demand updates (with
reasons), active/pending paths, popup-root identity, selected path, scrollTop,
and fit-pass count. Keep transport logs summary-only and feature-gated.

### Phase 1 — Extract store and make scheduler monotonic

Introduce `ThumbnailStore` behind the current API, migrate map pin and group
updates to read it, and add demand-delta comparison/cancellation reasons. This
phase should not redesign popup HTML. It provides the invariant that a ready
group tile cannot regress to loading during a preview close.

### Phase 2 — Make grouped popup state path-based and rendering stable

Replace cloned member thumbnail state and `activeGroupedPopup.group` snapshots
with the path-based popup record. Consolidate listener setup and tile patching.
Remove `updateGroupedMember`'s responsibility for replacing member objects and
rebinding popup listeners once the new renderer owns it.

### Phase 3 — Make preview restore and popup fitting idempotent

Route every overlay exit through one restore operation. Remove unconditional
`setView`, popup reopening, and demand refreshes. Introduce coalesced,
measurement-based fitting and programmatic-fit suppression.

### Phase 4 — Remove compatibility paths and prove boundaries

Delete obsolete duplicate thumbnail fields, stale-popup fallbacks, and private
Leaflet method calls. Keep only concise diagnostic counters and the documented
test hooks. Run the focused suites followed by the Photo Map E2Es and the full
JS test suite before merging the refactor.

## E2E and unit-test contract

The follow-up coverage plan should be implemented against these observable
properties. Use a deterministic 10–16 item synthetic group containing both
photos and videos, delayed thumbnail responses where needed, and a constrained
viewport so timing and fitting are exercised deliberately.

Implement this primarily by extending the existing Photo Map Playwright suite,
`tests/e2e/client-render.photo-map-preview.spec.js`, and its existing synthetic
fixtures/helpers. The scenarios in `PHOTO_MAP_COVERAGE_FOLLOWUPS.md` are not a
separate aspirational test list: fold each one into that suite or an adjacent
focused Photo Map spec when a separate fixture is needed for reliable isolation.
Keep common photo-map setup, debug-state capture, thumbnail delay controls, and
assertion helpers shared so every regression scenario observes the same real
client flow. Add a new spec file only for an independently runnable concern
(for example, viewport-fitting geometry) that would otherwise make the preview
suite unreasonably slow or obscure its purpose.

Before each refactor phase, first edit or add the relevant existing E2E so it
fails against the current regression. Then make the phase pass without weakening
the assertion. Do not replace interaction assertions with debug-only checks:
use debug state to diagnose and bound internal work, while the test continues to
assert actual tile images/posters, selection, scroll, popup position, and
clickability.

| Area | Required checks |
| --- | --- |
| Shared thumbnail state | After every group tile is ready, select one, open full screen, then close by button, backdrop, Escape, and history. The selected tile remains ready, the detail pane matches the same path, and no already-ready group tile becomes loading or error. |
| No unnecessary reload | During preview close, assert no new scheduler start or cancellation for an already-ready/open-group member. Network assertions should be scoped to group thumbnail paths, not all map pins, because ordinary viewport work may remain cancellable. |
| Mixed media | Exercise image and video members. Both retain their proper poster/thumbnail and selected state through preview open/close; video does not inherit an image-only state transition. |
| Scroll and DOM lifetime | Scroll a long group grid, open/close a preview, and assert the grid scroll position and (where the public Leaflet contract permits) popup root identity are unchanged. Complete thumbnail requests while the popup is open, then click another tile to prove delegation survived. |
| Map lifecycle | While requests complete, zoom/pan/spiderfy/regroup according to the existing coverage plan. Assert the active popup either has coherent state or closes intentionally—never a stale group that can request or render old member objects. |
| Viewport fit | Test corner/edge pins and expanded selected detail. Assert the final popup is inside usable map bounds, fit passes are bounded (zero if already visible; at most two otherwise), and the fit-generated map event produces no no-op demand refresh. |
| Navigation | Test close button, backdrop, Escape, browser Back/Forward, and direct preview navigation. Only a real captured group context restores a group; newer selections win. |
| Diagnostics | Assert a bounded snapshot exposes store state, demand delta/no-op count, starts/completions/cancellations with reason, popup-root mount count, and fit-pass count. Client logs must remain summarized and capped. |

Add narrow unit/JS tests alongside those E2Es:

- Repeating an identical demand set produces zero starts, aborts, or state changes.
- Promoting a selected member keeps its in-flight request alive and preserves a
  completed entry.
- A `ready` store entry never transitions to `idle`/`loading` because of a later
  scheduler refresh.
- A group state made of paths resolves current catalogue items and cannot retain a
  stale copied thumbnail state.
- Popup listener count and root mount count remain bounded across store updates.
- Preview restore is a no-op for already-correct map/popup state; a needed fit is
  measured and bounded.

## Acceptance invariants

- A media path has exactly one logical thumbnail state.
- All renderers for that path agree on its thumbnail readiness and URL.
- Preview close preserves selected member and grid scroll without restarting or
  cancelling open-popup thumbnail work.
- Popup thumbnail completion does not replace the grid, lose event handlers, or
  silently reset selection.
- Popup fitting is measured, coalesced, bounded, and does not create a scheduler
  feedback loop.
- Leaflet-private popup APIs are absent from Photo Map application logic after
  the refactor; public behavior is protected by a vendored-version
  characterization test.
- Debugging a recurrence requires one compact state snapshot, not inference from
  thousands of request logs.

## Scope and rollout guardrails

Keep this refactor inside Photo Map client modules and their synthetic tests. It
must preserve the current server thumbnail/file endpoint contracts, normal map
pin demand behavior, and existing preview routing. Land it in small phases with
the relevant characterization tests first; do not combine it with unrelated
Browse, metadata, or server cache changes. If public Leaflet behavior cannot
support a stable element root cleanly, document the constrained adapter fallback
and test it rather than reintroducing private-method coupling.
