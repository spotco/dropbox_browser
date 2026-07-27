# Photo Map Coverage Follow-ups — 2026-07-26

Recent grouped-pin regressions involved three independently changing layers:
Leaflet popup lifecycle, application-owned popup DOM, and asynchronous thumbnail
loading. The current focused tests cover the repaired flows, but the following
areas need durable end-to-end coverage before further Photo Map changes.

## Large and mixed-media groups

- Exercise groups with at least 10–16 members, including both photos and
  videos.
- Select members near the start, middle, and end of a scrolled group grid.
- Verify thumbnails, selected details, and grid scroll position survive opening
  and closing the full-screen preview.
- Verify video thumbnails and video preview poster loading separately from
  photo thumbnail loading.

## Popup lifecycle interactions

- Keep a grouped popup open while thumbnail requests complete, then zoom,
  pan, spiderfy/unspiderfy, and regroup.
- Confirm Leaflet does not replace the live group-grid DOM, lose its event
  handlers, clear the selected member, or reset the grid scroll position.
- Verify popup selection and thumbnail state when a popup closes while a
  request is in flight.

## Navigation and preview restoration

- Cover all preview exit paths: dialog close button, backdrop click, Escape,
  browser Back/Forward, and direct preview-link navigation.
- Confirm the correct group remains open, its selected member is restored, and
  the popup is fitted into the visible map area after each path.
- Cover opening the preview in a separate tab/window so the originating popup
  is unaffected.

## Viewport fitting

- Select members that expand a popup near each edge of the map and in both
  normal and full-page pane sizes.
- Assert that fitting pans only as needed and does not loop or move the map
  again for unchanged thumbnail state.
- Include a popup taller than the map, where full containment is impossible.

## Observability expectations

- Keep detailed per-item map and thumbnail events in bounded in-page debug
  state, not as one `/client-log` request per event.
- Assert a full map generation produces only bounded summary client logs.
- When reproducing a failure, capture the Photo Map debug state, browser
  console, thumbnail request statuses, and recent client-log entries together.
