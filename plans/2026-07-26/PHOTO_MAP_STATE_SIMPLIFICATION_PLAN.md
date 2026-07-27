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

Phase 0 finding from the current synthetic preview-close flow: the mounted group
grid, selected member, and scroll position can survive while the scheduler's
`desiredPaths` becomes empty. This is evidence of the state split, not an
acceptable steady state. Phase 1 must make an active grouped popup an explicit
demand source and keep its selected/visible members represented until the popup
actually closes; the E2E should then strengthen from checking diagnostic shape
to requiring the selected/open-group paths to remain desired.

### Phase 1 — Extract store and make scheduler monotonic

Introduce `ThumbnailStore` behind the current API, migrate map pin and group
updates to read it, and add demand-delta comparison/cancellation reasons. This
phase should not redesign popup HTML. It provides the invariant that a ready
group tile cannot regress to loading during a preview close.

Phase 1 implementation finding: map-bounds visibility is not authoritative while
a grouped Leaflet popup is mounted. During preview restoration, marker/cluster
bounds can lag behind the popup DOM for a frame, so the active popup must remain
an explicit demand source until the popup-close lifecycle event. The follow-up
E2E now asserts both the active group identity and the selected member's demand;
future refactors must preserve that distinction between a transient viewport
refresh and a real popup close. The store also deliberately retains only
path/status/URL data, never the loader's DOM `Image` object.

### Phase 2 — Make grouped popup state path-based and rendering stable

Replace cloned member thumbnail state and `activeGroupedPopup.group` snapshots
with the path-based popup record. Consolidate listener setup and tile patching.
Remove `updateGroupedMember`'s responsibility for replacing member objects and
rebinding popup listeners once the new renderer owns it.

Phase 2 implementation finding: the map adapter can resolve the current group
and member catalogue from paths while reading thumbnail presentation through a
host-owned `getThumbnailForPath` callback. This keeps scheduler state out of
`markerEntries`; the adapter only retains a small fallback presentation map for
standalone map test doubles that do not provide the shared store. Thumbnail
completion must still explicitly patch the live cell even when the store is
already ready, because the store update happens before the adapter callback and
the mounted DOM may still contain the loading markup. Repeated state-only
updates remain no-ops. The stable-root test now verifies one listener attach and
zero detachments across popup reconciliation and thumbnail completion.

The remaining compatibility boundary is popup content replacement when the
current catalogue itself changes, plus the private Leaflet layout calls used by
viewport fitting. Phase 3 should remove unconditional popup reinitialization
from preview restore and characterize/coalesce the public popup update path
before removing those private calls.

### Phase 3 — Make preview restore and popup fitting idempotent

Route every overlay exit through one restore operation. Remove unconditional
`setView`, popup reopening, and demand refreshes. Introduce coalesced,
measurement-based fitting and programmatic-fit suppression.

Phase 3 implementation finding: the vendored Leaflet 1.9.4 public popup path
preserves an application-owned HTMLElement root, but `setContent`/`update`
also run Leaflet's automatic pan logic. The Photo Map adapter now keeps the
grouped preview root mounted, synchronizes Leaflet to a root if an external
reconciliation replaced the content child, and snapshots/restores the grid
scroll position around public updates. It temporarily disables popup
`autoPan` during programmatic content/layout updates, then performs one
coalesced measurement-based fit with at most one corrective animation-frame
pass. This prevents a member click or preview close from producing a chain of
automatic and corrective `moveend` events.

The E2E characterization now covers both ordinary preview close and an
explicit content-child replacement: the selected member/details must survive,
the mixed-media grid and scroll position must remain intact, and the outer
grouped popup root must remain the same DOM object during preview restore.
The remaining Phase 4 follow-up is to remove or isolate the private Leaflet
layout fallback used only when standalone map test doubles do not supply the
public HTMLElement path, and to keep the real-browser characterization as the
vendor-upgrade boundary.

### Phase 4 — Remove compatibility paths and prove boundaries

Delete obsolete duplicate thumbnail fields, stale-popup fallbacks, and private
Leaflet method calls. Keep only concise diagnostic counters and the documented
test hooks. Run the focused suites followed by the Photo Map E2Es and the full
JS test suite before merging the refactor.

Phase 4 implementation finding: the real Photo Map path now fits grouped
popups exclusively through the public Leaflet `Popup.update()` contract. The
private layout branch and the unused explicit popup-listener refresh hook were
removed, and marker reconciliation no longer copies a previous marker's
thumbnail URL/state into the current catalogue item. A source-level test now
guards the absence of `_updateLayout` and `_updatePosition` from the map
adapter, while the browser E2Es continue to verify the public behavior.

The remaining compatibility surface is intentionally limited to standalone
map test doubles. The adapter no longer
keeps a `thumbnailOverrides` map; unit fixtures now provide the same
path-keyed thumbnail callback used by the host. Because the store update can
precede the adapter callback, grouped cells carry a presentation-only state
attribute so a real state transition still patches the live cell while an
identical ready/error notification remains a no-op. A follow-up Phase 4
cleanup replaces the remaining popup-string doubles with a shared
DOM-backed fixture; do not reintroduce private Leaflet coupling to support
test doubles.

Phase 4 cleanup finding: the cluster-layer rebuild fallback has now been
removed. `MarkerClusterGroup.addLayer()` and `removeLayer()` are the adapter
contract because rebuilding the complete layer can close a grouped popup,
discard spiderfy state, and make unrelated markers look like a viewport
change. The JS fixtures now expose the same incremental methods, and a source
boundary test prevents `clearLayers()`/`addLayers()` from returning through the
map adapter. Popup binding is now HTMLElement-only: the real host and all map
unit fixtures provide a document, and the map adapter no longer binds or
updates a string popup. The shared fixture intentionally serializes
`innerHTML` for assertions while keeping the application contract DOM-shaped;
future work should extend that fixture only when a missing DOM behavior is
needed, not add another map rendering fallback.

Photo Map interaction finding: group-grid buttons must remain selection-only for
every media kind and thumbnail state. A video tile that initially lacked a
thumbnail previously received `data-photo-map-preview-path`; progressive
thumbnail updates patched only its inner contents, so that preview trigger
survived after the poster loaded and the global preview handler opened the video
directly from the grid. Group tiles now always use the same `Show details for …`
selection contract as photo tiles. Full-screen preview remains available only
through the selected detail area's `a.photo-map-preview-link`, and the E2E
covers both direct video-tile selection and subsequent detail-link preview.

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
