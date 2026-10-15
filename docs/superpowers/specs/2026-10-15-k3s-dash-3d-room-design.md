# k3s-dash 3D Server Room — Design

Date: 2026-10-15
Status: draft, awaiting review

## Goal

Add a "3D Room" view to k3s-dash: a show-off server-room scene where each
cluster node is a recognisable 3D device model whose live state (CPU,
memory, disk, temperature, battery, health) is visible on the model, with
workloads as blocks above it. It is a toggle beside the existing node cards
(Cards | 3D Room), not a replacement.

## Constraints (carried from the existing project)

- Read-only. No new RBAC verbs, no write actions.
- Never show a fake zero: a null reading renders as "no data", not 0.
- No new Go dependencies; the Docker image still builds offline.
- Same data source: the 15s `/api/state` snapshot. No new backend data or API.
- Works in a normal desktop browser; degrades gracefully without WebGL.

## Decisions

| Question | Choice |
|---|---|
| Renderer | three.js, vendored (version-pinned) and embedded with `go:embed` |
| Scene | Server room: devices on racks/floor, workloads as blocks above |
| Models | Procedural, built in code from three.js primitives; no asset files |

## Architecture

- `internal/server/static/three.min.js` — vendored three.js (pinned version,
  licence header kept).
- `internal/server/static/room3d.js` — scene code (rendering, effects).
- `internal/server/static/room3d-logic.js` — pure logic with no WebGL
  (device class → model, snapshot → per-node indicator values, null
  handling, health aggregation). Testable under plain `node`.
- `server.go` gains a second `go:embed` for `static/` and a `/static/`
  route serving the files with correct content types.
- `ui.html` gains only the Cards | 3D Room toggle and a lazy loader: the JS
  is fetched on first open of the 3D view, not on page load.
- If WebGL context creation fails, the toggle is disabled with a tooltip and
  the cards view is unaffected.

## Scene

- Dark room, reflective floor, grid. Nodes sit on rack shelves or the floor;
  the control-plane node has its own position. Cables run from each node to
  a central switch model.
- Model chosen by `deviceClass`: laptop (hinged lid, glowing screen),
  mini-PC (box with front LED bar), SBC (green PCB, ports, heatsink),
  server (1U rack-mount), VM (translucent wireframe box), generic fallback.
- Live data on each model:
  - CPU: fan spin speed and LED bar
  - Memory: fill-level strip
  - Disk: drive-bay indicator
  - Temperature: heat glow
  - Battery: charge ring (laptops)
  - Not ready: model goes dark/grey
  - Null reading: indicator absent / dark, label shows an em dash
- Workloads/pods: small blocks hovering above their node; healthy green,
  unhealthy pulsing red.

## Effects and interaction

- Entrance: camera flies from a high wide shot into the room on first open.
  Orbit/zoom/pan by mouse or touch; slow auto-drift when idle.
- Look: bloom on LEDs/screens, soft shadows, light fog, reflective floor.
  Light pulses travel along cables, speed following node CPU.
- Hover: node lifts slightly, outline, floating label (name, CPU/mem/disk).
- Click: camera glides to the node; side panel shows the same details as the
  card. Pod blocks are clickable (namespace, workload, restarts). Esc or
  back returns to the room view.
- Alerts: warning events or unhealthy workloads add a red beacon over the
  affected node; ambient light shifts amber/red when anything is wrong.

## Data handling

- Each snapshot is applied by tweening from old to new values, so nothing
  jumps every 15s.
- Nodes joining/leaving add/remove models without rebuilding the scene.
- Nulls are carried through as null all the way to the renderer.

## Performance and accessibility

- Renders only while the tab is visible and the 3D view is open; pauses
  otherwise.
- Pixel ratio capped; bloom auto-disabled if frame rate drops.
- `prefers-reduced-motion`: no fly-in, no auto-drift, no cable pulses.

## Testing

- Go: `/static/` route serves both JS files with correct content types;
  existing `ui_test.go` still passes; embedded files exist.
- JS unit tests: `room3d-logic.js` run directly with `node` (no added
  repo dependencies) — device class mapping, snapshot → indicators, nulls,
  health aggregation.
- Real browser: Playwright against a local server with a fake snapshot —
  toggle works, WebGL context created, hover and click work, no console
  errors, screenshot of the scene. Unit tests alone are not sufficient.

## Out of scope (v1)

Photoreal glTF models, VR/AR, historical playback, write actions.

## Open items for the plan

- Pick and pin the three.js version (needs to be at least two weeks old,
  with the licence preserved in the vendored file).
- Check whether the current deployment sets a Content-Security-Policy that
  would block the embedded script or WebGL (none found in `internal/`).
