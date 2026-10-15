# k3s-dash 3D Server Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cards | 3D Room toggle to k3s-dash that renders the cluster as a procedural, live-data-driven 3D server room.

**Architecture:** three.js r160 (ES modules, vendored) plus our own `room3d.js` / `room3d-logic.js` are embedded in the Go binary via a second `go:embed` and served from `/static/`. `ui.html` gets a toggle, an inline import map, and a lazy `import()` loader; the scene reads the same `/api/state` snapshot the cards use.

**Tech Stack:** Go 1.25 (stdlib only, run through docker `golang:1.25-alpine` because Go is not installed on the host), three.js r160 ES modules + EffectComposer/UnrealBloomPass/OrbitControls, plain `node` for pure-logic tests, Playwright for the real-browser check.

**Spec:** `docs/superpowers/specs/2026-10-15-k3s-dash-3d-room-design.md`

## Global Constraints

- Read-only: no new RBAC verbs, no write actions.
- Never show a fake zero: null readings render as "no data" (em dash), never 0.
- No new Go dependencies; Docker image still builds offline.
- Same data source: the `/api/state` snapshot; no new backend data or API.
- Static files only same-origin; page must still contain no `<script src`, `cdn.`, `integrity=`, `@import`.
- Cluster-supplied strings go through `textContent`, never `innerHTML`.
- `prefers-reduced-motion`: no fly-in, drift, or cable pulses.
- Renders only while tab visible and 3D view open.

## Review Focus

- Snapshot with zero nodes: empty room with a "no nodes" label, no crash.
- Node with every metric null (agent down): dark model, em dashes, no NaN heights.
- `deviceClass` null or unknown string: generic model.
- Node count changing between polls: models added/removed without rebuilding the scene or leaking GPU memory.
- WebGL unavailable or context lost: toggle disabled / cards view still works.
- Hidden tab / switching back to Cards: render loop stops.

## File Structure

- Create `internal/server/static/vendor/…` — vendored three.js r160 (module build, addons, LICENSE).
- Create `internal/server/static/room3d-logic.js` — pure functions, no WebGL.
- Create `internal/server/static/room3d-logic.test.mjs` — node tests.
- Create `internal/server/static/room3d.js` — scene, models, effects, interaction. Exports `mount(container, getSnapshot, opts)` returning `{update(snapshot), dispose()}`.
- Modify `internal/server/server.go` — `//go:embed static`, `GET /static/` route.
- Modify `internal/server/server_test.go` — static route test.
- Modify `internal/server/ui.html` — toggle, import map, loader.
- Modify `internal/server/ui_test.go` — assert toggle + loader present.
- Modify `README.md` — document the 3D view.

---

### Task 1: Vendor three.js and serve `/static/`

**Files:** Create `internal/server/static/vendor/*`; modify `server.go`, `server_test.go`.

**Interfaces:** Produces `GET /static/<path>` serving embedded files with correct content types (`text/javascript` for `.js`/`.mjs`).

- [ ] Write failing test `TestStaticServesVendoredThree` requesting `/static/vendor/three.module.min.js` expecting 200 and `javascript` in Content-Type, and `/static/nope.js` expecting 404.
- [ ] Run via docker: `docker run --rm -v ~/k3s-dash:/src -w /src golang:1.25-alpine go test ./internal/server/` — expect FAIL.
- [ ] Copy vendored files into `static/vendor/` (three.module.min.js, LICENSE, `postprocessing/`, `shaders/`, `controls/` keeping relative imports valid).
- [ ] Add `//go:embed static` `var staticFS embed.FS` and route `mux.Handle("GET /static/", http.FileServerFS(staticFS))` with `Cache-Control: public, max-age=3600`, and explicit `.js`→`text/javascript` via `mime.AddExtensionType`.
- [ ] Run test: PASS. Commit.

### Task 2: Pure logic module with node tests

**Files:** Create `room3d-logic.js`, `room3d-logic.test.mjs`.

**Interfaces — Produces (named ES exports):**
- `modelFor(deviceClass: string|null): "laptop"|"minipc"|"sbc"|"server"|"vm"|"generic"`
- `nodeIndicators(node): {cpu:number|null, mem:number|null, disk:number|null, tempC:number|null, battery:number|null, charging:boolean|null, ready:boolean}` — fractions 0..1 clamped, null preserved.
- `podsByNode(snapshot): Map<string, {total:number, unhealthy:number, workloads: {namespace,name,healthy,restarts}[]}>`
- `roomAlert(snapshot): "ok"|"warn"|"bad"`
- `layoutPositions(nodes): {name:string,x:number,z:number,shelf:number}[]` — control-plane first, deterministic by name.

- [ ] Write tests: each class mapping incl. null/unknown → generic; indicators keep null and clamp >100% and negative; NaN → null; empty snapshot; roomAlert from unhealthy workloads / not-ready nodes / events; layout stable across calls and independent of input order.
- [ ] Run `node --test internal/server/static/` — FAIL.
- [ ] Implement. Run — PASS. Commit.

### Task 3: Scene, models, effects, interaction

**Files:** Create `room3d.js`.

**Interfaces — Consumes:** Task 2 exports; vendored three modules via bare specifier `three` (import map). **Produces:** `export function mount(container, opts) → {update(snapshot), setVisible(bool), dispose()}`; `opts.onSelect(nodeName|null)`.

- [ ] Renderer: WebGLRenderer, EffectComposer + RenderPass + UnrealBloomPass + OutputPass, OrbitControls, fog, reflective floor (mirror-free: glossy plane + grid), pixel ratio ≤ 2, auto-disable bloom if 20 frames average > 40 ms.
- [ ] Procedural builders `buildLaptop/Minipc/Sbc/Server/Vm/Generic` each returning `{group, setIndicators(ind, t)}`; the group exposes screen/LED/fan/heat meshes; null → dark materials.
- [ ] Per-snapshot tween (value eased toward target over ~1.2 s); add/remove models on node set change, dispose geometries/materials of removed ones.
- [ ] Pod blocks above nodes (green/pulsing red), cables to central switch with travelling light pulses (speed ∝ CPU), alert beacon, ambient tint from `roomAlert`.
- [ ] Interaction: raycast hover (lift + label via DOM overlay using `textContent`), click → camera glide + `onSelect`; Esc / `select(null)` returns; fly-in on first mount; idle drift; reduced-motion disables fly-in/drift/pulses.
- [ ] `setVisible(false)` stops rAF; `visibilitychange` pauses; `webglcontextlost` handled by `preventDefault` and notifying `opts.onError`.
- [ ] Syntax check with `node --check`. Commit.

### Task 4: Wire into `ui.html`

**Files:** Modify `ui.html`, `ui_test.go`.

- [ ] Add `<script type="importmap">` mapping `three` → `/static/vendor/three.module.min.js` and `three/addons/` → `/static/vendor/`; add `Cards | 3D Room` segmented toggle in the devices section header and an `#room3d` container (hidden by default) with a detail side panel built with `textContent`.
- [ ] Loader: on first 3D click `import("/static/room3d.js")`, `mount`, feed every `render(s)` into `update`; Cards click hides container and calls `setVisible(false)`. WebGL probe (`canvas.getContext("webgl2")`) disables the toggle with a tooltip on failure; import errors show a message in the container and keep Cards active. Persist choice in `localStorage` try/catch like density.
- [ ] Update `ui_test.go`: require `id="room3d"`, `importmap`, `/static/room3d.js`; keep forbidden-list intact. Run Go tests in docker: PASS. Commit.

### Task 5: Real-browser verification, docs, build

- [ ] Build image locally (`docker build`), or run `go run` in docker with a fake snapshot server; open with Playwright (wk0 or local), click 3D Room, assert canvas exists, no console errors, hover + click opens panel, screenshot. Also screenshot empty and all-null snapshots.
- [ ] README section "3D Room"; project-docs note. Final `go vet` + `go test ./...` in docker. Commit.
