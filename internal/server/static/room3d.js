// The 3D server room. Every model is built in code from primitives, so there
// are no asset files, and every indicator on every model is a live reading
// from /api/state. A null reading is drawn as "no data" (a dim dotted bar),
// never as an empty-but-confident zero.
//
// Cluster-supplied strings (node, pod and namespace names) only ever reach
// the page through textContent or a canvas fillText, never innerHTML.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import {
  modelFor, nodeIndicators, podsByNode, roomAlert, layoutPositions,
  SHELVES_PER_RACK, RACK_SPACING,
} from "./room3d-logic.js";

const SHELF_GAP = 1.75;       // vertical distance between shelves
const SHELF_BASE = 0.5;       // height of the lowest shelf top
const MAX_PODS_SHOWN = 24;    // per node; the label says how many more
const SWITCH_POS = new THREE.Vector3(0, 0.6, -4.2);

const COLORS = {
  ok: new THREE.Color(0x0b1622),
  warn: new THREE.Color(0x2a1d08),
  bad: new THREE.Color(0x2a0f12),
};
const BAR_GOOD = new THREE.Color(0x22c55e).multiplyScalar(1.6);
const BAR_WARN = new THREE.Color(0xf59e0b).multiplyScalar(1.6);
const BAR_BAD = new THREE.Color(0xef4444).multiplyScalar(1.7);
const BAR_OFF = new THREE.Color(0x121c27);
const BAR_NODATA = new THREE.Color(0x3a4350);

// Shared, never disposed per node.
const podGeo = new THREE.SphereGeometry(0.055, 12, 10);
const podOk = new THREE.MeshStandardMaterial({ color: 0x16a34a, emissive: 0x16a34a, emissiveIntensity: 0.9, roughness: 0.4 });
const podBad = new THREE.MeshStandardMaterial({ color: 0xdc2626, emissive: 0xef4444, emissiveIntensity: 1.2, roughness: 0.4 });
for (const o of [podGeo, podOk, podBad]) o.userData.shared = true;

const ease = (cur, target, k) => (target == null ? null : cur == null ? target : cur + (target - cur) * k);
const barColor = v => (v < 0.6 ? BAR_GOOD : v < 0.85 ? BAR_WARN : BAR_BAD);

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.35, ...opts });
}
function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  return m;
}
function led(color = BAR_GOOD) {
  return new THREE.MeshBasicMaterial({ color: color.clone() });
}

// Three rows of eight segments: CPU, memory, disk. Each segment is lit when
// the reading passes its threshold; null readings alternate dim grey.
function makeBars(width = 0.9) {
  const group = new THREE.Group();
  const rows = [];
  const seg = width / 8;
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let i = 0; i < 8; i++) {
      const m = led(BAR_OFF);
      const s = new THREE.Mesh(new THREE.BoxGeometry(seg * 0.8, 0.035, 0.02), m);
      s.position.set((i - 3.5) * seg, (1 - r) * 0.055, 0);
      group.add(s);
      row.push(m);
    }
    rows.push(row);
  }
  const set = (vals, dead) => {
    vals.forEach((v, r) => {
      rows[r].forEach((m, i) => {
        if (dead) m.color.copy(BAR_OFF);
        else if (v == null) m.color.copy(i % 2 ? BAR_OFF : BAR_NODATA);
        else if (i < Math.round(v * 8) || (v > 0 && i === 0)) m.color.copy(barColor(v));
        else m.color.copy(BAR_OFF);
      });
    });
  };
  return { group, set };
}

function makeFan(radius, blades = 5) {
  const g = new THREE.Group();
  const bm = mat(0x9aa4b2, { metalness: 0.6 });
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.18, radius * 0.18, 0.03, 16), bm));
  for (let i = 0; i < blades; i++) {
    const b = box(radius * 0.85, 0.012, radius * 0.22, bm, radius * 0.45, 0, 0);
    const pivot = new THREE.Group();
    pivot.rotation.y = (i / blades) * Math.PI * 2;
    b.rotation.y = 0.35;
    pivot.add(b);
    g.add(pivot);
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.018, 8, 32), mat(0x1c2430));
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  return g;
}

// Under-glow that warms with temperature; invisible when temperature is unknown.
function makeHeat(w, d) {
  const m = new THREE.MeshBasicMaterial({
    color: 0x38bdf8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const p = new THREE.Mesh(new THREE.PlaneGeometry(w, d), m);
  p.rotation.x = -Math.PI / 2;
  p.position.y = 0.005;
  const cold = new THREE.Color(0x38bdf8), warm = new THREE.Color(0xfb923c), hot = new THREE.Color(0xef4444);
  const set = tempC => {
    if (tempC == null) { m.opacity = 0; return; }
    const t = Math.min(1, Math.max(0, (tempC - 35) / 45));
    if (t < 0.5) m.color.copy(cold).lerp(warm, t * 2); else m.color.copy(warm).lerp(hot, (t - 0.5) * 2);
    m.opacity = 0.18 + 0.5 * t;
  };
  return { mesh: p, set };
}

// ---- device models ------------------------------------------------------
// Each builder returns { group, update(ind, t, dt, motion) }. `ind` holds the
// eased indicator values (fractions, or null for unknown).

function darken(group, dead) {
  group.traverse(o => {
    const m = o.material;
    if (!m || !m.userData || !m.userData.base) return;
    m.color.copy(m.userData.base).multiplyScalar(dead ? 0.3 : 1);
  });
}
function body(color, opts) {
  const m = mat(color, opts);
  m.userData.base = m.color.clone();
  return m;
}

function buildLaptop() {
  const group = new THREE.Group();
  const shell = body(0x8b95a5, { metalness: 0.7, roughness: 0.35 });
  group.add(box(1.5, 0.06, 1.0, shell, 0, 0.03, 0));
  group.add(box(1.2, 0.012, 0.5, body(0x10151c), 0, 0.066, -0.08));
  group.add(box(0.4, 0.01, 0.22, body(0x1c232d), 0, 0.066, 0.36));
  const hinge = new THREE.Group();
  hinge.position.set(0, 0.06, -0.5);
  hinge.rotation.x = -Math.PI * 0.56;
  hinge.add(box(1.5, 0.04, 1.0, shell, 0, 0, 0.5));
  const screenMat = new THREE.MeshBasicMaterial({ color: 0x0a0f14 });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.36, 0.88), screenMat);
  screen.rotation.x = Math.PI / 2;
  screen.position.set(0, -0.0215, 0.5);
  hinge.add(screen);
  group.add(hinge);

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.13, 32, 1, 0, Math.PI * 2), led(BAR_OFF));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(0.55, 0.075, 0.36);
  group.add(ring);

  const bars = makeBars(0.9);
  bars.group.position.set(0, 0.03, 0.505);
  group.add(bars.group);
  const heat = makeHeat(1.6, 1.1);
  group.add(heat.mesh);

  let ringKey = "";
  return {
    group,
    update(ind, t, dt, motion) {
      const dead = !ind.ready;
      darken(group, dead);
      bars.set([ind.cpu, ind.mem, ind.disk], dead);
      heat.set(dead ? null : ind.tempC);
      if (dead || ind.cpu == null) screenMat.color.setRGB(0.02, 0.025, 0.03);
      else {
        const flick = motion ? 0.06 * Math.sin(t * 6 + ind.cpu * 9) : 0;
        screenMat.color.setRGB(0.05 + ind.cpu * 0.3 + flick, 0.3 - ind.cpu * 0.15, 0.5 - ind.cpu * 0.25);
      }
      const k = dead || ind.battery == null ? "x" : ind.battery.toFixed(2);
      if (k !== ringKey) {
        ringKey = k;
        ring.geometry.dispose();
        if (k === "x") {
          ring.geometry = new THREE.RingGeometry(0.09, 0.13, 32, 1, 0, Math.PI * 2);
          ring.material.color.copy(BAR_NODATA).multiplyScalar(0.5);
        } else {
          ring.geometry = new THREE.RingGeometry(0.09, 0.13, 32, 1, 0, Math.max(0.05, ind.battery * Math.PI * 2));
          ring.material.color.copy(ind.charging ? new THREE.Color(0x38bdf8).multiplyScalar(1.6) : barColor(1 - ind.battery));
        }
      }
    },
  };
}

function buildMiniPc() {
  const group = new THREE.Group();
  const shell = body(0x2b3340, { metalness: 0.6, roughness: 0.4 });
  group.add(box(1.0, 0.28, 1.0, shell, 0, 0.14, 0));
  group.add(box(1.02, 0.02, 1.02, body(0x151a22), 0, 0.29, 0));
  const fan = makeFan(0.32);
  fan.position.set(0, 0.3, 0);
  group.add(fan);
  const bars = makeBars(0.7);
  bars.group.position.set(0, 0.14, 0.505);
  group.add(bars.group);
  const power = new THREE.Mesh(new THREE.CircleGeometry(0.025, 12), led(BAR_GOOD));
  power.position.set(-0.4, 0.22, 0.506);
  group.add(power);
  const heat = makeHeat(1.2, 1.2);
  group.add(heat.mesh);
  return {
    group,
    update(ind, t, dt, motion) {
      const dead = !ind.ready;
      darken(group, dead);
      bars.set([ind.cpu, ind.mem, ind.disk], dead);
      power.material.color.copy(dead ? BAR_OFF : BAR_GOOD);
      heat.set(dead ? null : ind.tempC);
      if (motion && !dead) fan.rotation.y += dt * (2 + (ind.cpu || 0) * 22);
    },
  };
}

function buildSbc() {
  const group = new THREE.Group();
  const pcb = body(0x0f7a45, { metalness: 0.2, roughness: 0.6 });
  group.add(box(1.2, 0.035, 0.8, pcb, 0, 0.0175, 0));
  const chipMat = body(0x15181d, { metalness: 0.5 });
  group.add(box(0.28, 0.04, 0.28, chipMat, -0.1, 0.055, 0.0));
  group.add(box(0.16, 0.03, 0.16, chipMat, 0.25, 0.05, -0.15));
  const metal = body(0xaab3bf, { metalness: 0.9, roughness: 0.3 });
  group.add(box(0.2, 0.14, 0.22, metal, 0.52, 0.1, 0.18));
  group.add(box(0.2, 0.14, 0.2, metal, 0.52, 0.1, -0.12));
  group.add(box(0.16, 0.06, 0.14, metal, -0.5, 0.06, 0.3));
  group.add(box(1.0, 0.04, 0.05, body(0x1a1a1a), 0.0, 0.055, -0.36));
  const sink = new THREE.Group();
  for (let i = 0; i < 7; i++) sink.add(box(0.31, 0.12, 0.018, metal, 0, 0.1, (i - 3) * 0.04));
  sink.position.set(-0.1, 0, 0);
  group.add(sink);
  const bars = makeBars(0.6);
  bars.group.position.set(-0.1, 0.045, 0.43);
  group.add(bars.group);
  const act = new THREE.Mesh(new THREE.CircleGeometry(0.02, 10), led(BAR_GOOD));
  act.rotation.x = -Math.PI / 2;
  act.position.set(0.4, 0.04, 0.33);
  group.add(act);
  const heat = makeHeat(1.3, 0.9);
  group.add(heat.mesh);
  return {
    group,
    update(ind, t, dt, motion) {
      const dead = !ind.ready;
      darken(group, dead);
      bars.set([ind.cpu, ind.mem, ind.disk], dead);
      heat.set(dead ? null : ind.tempC);
      const blink = dead ? 0 : motion ? (Math.sin(t * (4 + (ind.cpu || 0) * 20)) > 0 ? 1 : 0.25) : 1;
      act.material.color.copy(BAR_GOOD).multiplyScalar(blink);
    },
  };
}

function buildServer() {
  const group = new THREE.Group();
  const shell = body(0x9aa3b0, { metalness: 0.75, roughness: 0.35 });
  group.add(box(1.9, 0.22, 1.3, shell, 0, 0.11, 0));
  const bays = [];
  for (let i = 0; i < 8; i++) {
    group.add(box(0.15, 0.13, 0.015, body(0x11151b), -0.7 + i * 0.185, 0.11, 0.655));
    const l = new THREE.Mesh(new THREE.CircleGeometry(0.012, 8), led(BAR_OFF));
    l.position.set(-0.7 + i * 0.185, 0.16, 0.664);
    group.add(l);
    bays.push(l.material);
  }
  for (let i = 0; i < 2; i++) { const f = makeFan(0.28, 7); f.position.set(-0.45 + i * 0.9, 0.225, -0.1); f.userData.fan = true; group.add(f); }
  const bars = makeBars(0.9);
  bars.group.position.set(0.0, 0.035, 0.66);
  group.add(bars.group);
  const heat = makeHeat(2.0, 1.4);
  group.add(heat.mesh);
  const fans = group.children.filter(c => c.userData.fan);
  return {
    group,
    update(ind, t, dt, motion) {
      const dead = !ind.ready;
      darken(group, dead);
      bars.set([ind.cpu, ind.mem, ind.disk], dead);
      heat.set(dead ? null : ind.tempC);
      bays.forEach((m, i) => {
        if (dead) m.color.copy(BAR_OFF);
        else if (ind.disk == null) m.color.copy(i % 2 ? BAR_OFF : BAR_NODATA);
        else m.color.copy(i < Math.round(ind.disk * 8) ? barColor(ind.disk) : BAR_OFF);
      });
      if (motion && !dead) for (const f of fans) f.rotation.y += dt * (3 + (ind.cpu || 0) * 25);
    },
  };
}

function buildVm() {
  const group = new THREE.Group();
  const glass = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.09, depthWrite: false });
  const edgeMat = new THREE.LineBasicMaterial({ color: new THREE.Color(0x38bdf8).multiplyScalar(1.5) });
  const g = new THREE.BoxGeometry(1.2, 0.6, 1.0);
  const shell = new THREE.Mesh(g, glass);
  shell.position.y = 0.3;
  group.add(shell);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g), edgeMat);
  edges.position.y = 0.3;
  group.add(edges);
  const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x67e8f9).multiplyScalar(1.5) });
  const core = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), coreMat);
  core.position.y = 0.3;
  group.add(core);
  const bars = makeBars(0.8);
  bars.group.position.set(0, 0.05, 0.505);
  group.add(bars.group);
  return {
    group,
    update(ind, t, dt, motion) {
      const dead = !ind.ready;
      bars.set([ind.cpu, ind.mem, ind.disk], dead);
      edgeMat.color.copy(dead ? BAR_NODATA : new THREE.Color(0x38bdf8).multiplyScalar(1.5));
      const s = ind.cpu == null || dead ? 0.35 : 0.45 + ind.cpu * 0.9;
      core.scale.setScalar(s);
      coreMat.color.copy(dead || ind.cpu == null ? BAR_NODATA : new THREE.Color(0x67e8f9).multiplyScalar(1.5));
      if (motion && !dead) { core.rotation.y += dt * (0.6 + (ind.cpu || 0) * 3); core.rotation.x += dt * 0.3; }
      core.position.y = 0.3 + (motion ? Math.sin(t * 1.5) * 0.03 : 0);
    },
  };
}

function buildGeneric() {
  const group = new THREE.Group();
  group.add(box(1.0, 0.3, 0.9, body(0x3a4351), 0, 0.15, 0));
  const bars = makeBars(0.7);
  bars.group.position.set(0, 0.15, 0.455);
  group.add(bars.group);
  const heat = makeHeat(1.2, 1.1);
  group.add(heat.mesh);
  return {
    group,
    update(ind) {
      const dead = !ind.ready;
      darken(group, dead);
      bars.set([ind.cpu, ind.mem, ind.disk], dead);
      heat.set(dead ? null : ind.tempC);
    },
  };
}

const BUILDERS = {
  laptop: buildLaptop, minipc: buildMiniPc, sbc: buildSbc,
  server: buildServer, vm: buildVm, generic: buildGeneric,
};

// ---- helpers -------------------------------------------------------------

function disposeTree(root) {
  root.traverse(o => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) {
      if (m.userData && m.userData.shared) continue;
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
}

function nameTag(text) {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 96;
  const x = c.getContext("2d");
  x.fillStyle = "rgba(8,14,22,0.72)";
  x.beginPath(); x.roundRect(4, 4, 504, 88, 18); x.fill();
  x.fillStyle = "#e6edf5";
  x.font = "600 44px system-ui, sans-serif";
  x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText(text, 256, 50, 480);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(1.3, 0.244, 1);
  return s;
}

const pct = v => (v == null ? "—" : Math.round(v * 100) + "%");

// ---- mount ---------------------------------------------------------------

export function mount(container, opts = {}) {
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const motion = !reduced;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "3D view of the cluster's nodes");
  container.appendChild(canvas);

  const label = document.createElement("div");
  label.className = "room3d-label";
  label.style.cssText = "position:absolute;pointer-events:none;display:none;padding:6px 9px;border-radius:8px;" +
    "background:rgba(8,14,22,.88);color:#e6edf5;font:12px/1.4 system-ui,sans-serif;white-space:pre;z-index:2;" +
    "border:1px solid rgba(120,160,200,.35)";
  container.appendChild(label);

  const scene = new THREE.Scene();
  scene.background = COLORS.ok.clone();
  scene.fog = new THREE.FogExp2(COLORS.ok.clone(), 0.012);

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 2.5;
  controls.maxDistance = 40;
  controls.autoRotateSpeed = 0.5;

  // Lighting
  scene.add(new THREE.HemisphereLight(0x8fb0d8, 0x141a24, 1.5));
  const key = new THREE.SpotLight(0xdbeaff, 900, 70, Math.PI / 3.2, 0.7, 1.4);
  key.position.set(3, 14, 9);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0004;
  scene.add(key);
  scene.add(key.target);
  const rim = new THREE.PointLight(0x38bdf8, 18, 26, 1.8);
  rim.position.set(-9, 7, -4);
  scene.add(rim);

  // Floor: a mirror under a dark glossy overlay, plus a grid.
  const mirror = new Reflector(new THREE.PlaneGeometry(80, 80), {
    textureWidth: 512, textureHeight: 512, color: 0x667788,
    clipBias: 0.003,
  });
  mirror.rotation.x = -Math.PI / 2;
  mirror.position.y = -0.002;
  scene.add(mirror);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x070b10, roughness: 0.35, metalness: 0.2, transparent: true, opacity: 0.86 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(80, 80, 0x1f3a52, 0x12212f);
  grid.position.y = 0.004;
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);

  // Back wall panel and the central switch every node cables into.
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 14), new THREE.MeshStandardMaterial({ color: 0x0a1018, roughness: 0.9 }));
  wall.position.set(0, 6, -9);
  scene.add(wall);
  const sw = new THREE.Group();
  sw.position.copy(SWITCH_POS);
  sw.add(box(2.6, 0.3, 0.9, mat(0x1d2530, { metalness: 0.6 }), 0, 0, 0));
  const swLeds = [];
  for (let i = 0; i < 16; i++) {
    const m = led(BAR_GOOD);
    const l = new THREE.Mesh(new THREE.CircleGeometry(0.025, 8), m);
    l.position.set(-1.1 + i * 0.147, 0, 0.451);
    sw.add(l);
    swLeds.push(m);
  }
  scene.add(sw);

  const racksGroup = new THREE.Group();
  scene.add(racksGroup);
  const emptyTag = nameTag("No nodes reported");
  emptyTag.position.set(0, 1.5, 0);
  emptyTag.visible = false;
  scene.add(emptyTag);

  // Post-processing
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.45, 0.62);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  let bloomOn = true;

  const entries = new Map(); // node name -> entry
  let rackCount = 0;
  let snapshot = null;
  let alert = "ok";
  let selected = null;
  let hovered = null;
  const pointer = new THREE.Vector2();
  let pointerMoved = false;
  let pointerInside = false;
  const ray = new THREE.Raycaster();

  // ---- racks
  function buildRacks(n) {
    for (const c of [...racksGroup.children]) { racksGroup.remove(c); disposeTree(c); }
    rackCount = n;
    const frame = mat(0x1a212b, { metalness: 0.7, roughness: 0.4 });
    const h = SHELF_BASE + SHELVES_PER_RACK * SHELF_GAP;
    for (let r = 0; r < n; r++) {
      const g = new THREE.Group();
      g.position.x = (r - (n - 1) / 2) * RACK_SPACING;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(0.06, h, 0.06, frame, sx * 1.15, h / 2, sz * 0.8));
      for (let s = 0; s < SHELVES_PER_RACK; s++) g.add(box(2.4, 0.06, 1.7, frame, 0, SHELF_BASE + s * SHELF_GAP - 0.03, 0));
      g.add(box(2.4, 0.06, 1.7, frame, 0, h, 0));
      g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      racksGroup.add(g);
    }
    homeCamera();
  }

  const home = { pos: new THREE.Vector3(0, 4.6, 12), target: new THREE.Vector3(0, 2.9, 0) };
  function homeCamera() {
    const d = 9.5 + Math.max(0, rackCount - 1) * 2.2;
    home.pos.set(0, 4.6, d);
  }

  // ---- node entries
  function createEntry(name) {
    const root = new THREE.Group();
    const e = {
      name, root, kind: null, model: null, cur: null, target: null, pods: new THREE.Group(),
      podKey: "", podInfo: null, tag: nameTag(name), cable: null, pulses: [], beacon: null, ready: true,
      lift: 0, bob: Math.random() * 6,
    };
    root.add(e.pods);
    root.add(e.tag);
    e.tag.position.set(0, -0.05, 1.05);
    root.userData.entry = e;
    scene.add(root);
    return e;
  }

  function setKind(e, kind) {
    if (e.kind === kind) return;
    if (e.model) { e.root.remove(e.model.group); disposeTree(e.model.group); }
    e.kind = kind;
    e.model = BUILDERS[kind]();
    e.model.group.traverse(o => { o.userData.entry = e; if (o.isMesh) o.castShadow = true; });
    e.root.add(e.model.group);
  }

  function buildCable(e) {
    if (e.cable) { scene.remove(e.cable); disposeTree(e.cable); }
    const from = new THREE.Vector3(e.root.position.x, e.root.position.y + 0.1, e.root.position.z - 0.5);
    const to = SWITCH_POS.clone().add(new THREE.Vector3((from.x / 12) * 1.2, -0.05, 0.4));
    const mid = from.clone().lerp(to, 0.5);
    mid.y = Math.max(0.05, Math.min(from.y, to.y) - 0.35);
    e.curve = new THREE.CatmullRomCurve3([from, new THREE.Vector3(from.x, mid.y, from.z - 0.8), mid, to]);
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(e.curve, 40, 0.018, 6, false),
      new THREE.MeshStandardMaterial({ color: 0x0e1620, roughness: 0.6, emissive: 0x0a2a44, emissiveIntensity: 0.6 }));
    const g = new THREE.Group();
    g.add(tube);
    e.pulses = [];
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x67e8f9).multiplyScalar(1.8) }));
      p.userData.phase = i / 3;
      p.visible = motion;
      g.add(p);
      e.pulses.push(p);
    }
    e.cable = g;
    scene.add(g);
  }

  function removeEntry(e) {
    scene.remove(e.root);
    disposeTree(e.root);
    if (e.cable) { scene.remove(e.cable); disposeTree(e.cable); }
    if (e.beacon) { scene.remove(e.beacon); disposeTree(e.beacon); }
    if (selected === e.name) select(null, true);
    if (hovered === e) { hovered = null; label.style.display = "none"; }
  }

  function syncPods(e, info) {
    const list = info ? info.pods : [];
    const shown = list.slice(0, MAX_PODS_SHOWN);
    const key = shown.map(p => (p.healthy ? "1" : "0")).join("") + ":" + list.length;
    e.podInfo = info || { total: 0, unhealthy: 0, pods: [] };
    if (key === e.podKey) return;
    e.podKey = key;
    for (const c of [...e.pods.children]) e.pods.remove(c);
    shown.forEach((p, i) => {
      const m = new THREE.Mesh(podGeo, p.healthy ? podOk : podBad);
      m.userData.entry = e;
      m.userData.pod = p;
      const col = i % 8, row = Math.floor(i / 8);
      m.position.set((col - 3.5) * 0.15, 1.18 + row * 0.15, 0);
      e.pods.add(m);
    });
  }

  function syncBeacon(e, bad) {
    if (bad && !e.beacon) {
      const g = new THREE.Group();
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.22, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xef4444).multiplyScalar(2) }));
      cone.rotation.x = Math.PI;
      g.add(cone);
      e.beacon = g;
      scene.add(g);
    } else if (!bad && e.beacon) {
      scene.remove(e.beacon); disposeTree(e.beacon); e.beacon = null;
    }
  }

  // ---- public: update
  function update(snap) {
    snapshot = snap;
    const nodes = (snap && snap.nodes) || [];
    const layout = layoutPositions(nodes);
    const byName = new Map(nodes.map(n => [n.name, n]));
    const racks = Math.max(1, Math.ceil(layout.length / SHELVES_PER_RACK));
    if (racks !== rackCount) buildRacks(racks);
    emptyTag.visible = nodes.length === 0;

    const pods = podsByNode(snap);
    const seen = new Set();
    for (const slot of layout) {
      seen.add(slot.name);
      const n = byName.get(slot.name);
      let e = entries.get(slot.name);
      const isNew = !e;
      if (!e) { e = createEntry(slot.name); entries.set(slot.name, e); }
      setKind(e, modelFor(n.deviceClass));
      const y = SHELF_BASE + slot.shelf * SHELF_GAP;
      const moved = Math.abs(e.root.position.x - slot.x) + Math.abs(e.root.position.y - y) > 1e-6;
      e.root.position.set(slot.x, y, slot.z);
      if (moved || isNew) buildCable(e);
      e.target = nodeIndicators(n);
      e.info = n;
      if (isNew) e.cur = { ...e.target };
      syncPods(e, pods.get(slot.name));
      syncBeacon(e, !e.target.ready || (e.podInfo && e.podInfo.unhealthy > 0));
    }
    for (const [name, e] of [...entries]) {
      if (!seen.has(name)) { removeEntry(e); entries.delete(name); }
    }
    alert = roomAlert(snap);
    if (hovered) showLabel(hovered);
  }

  // ---- selection / camera glide
  let anim = null;
  function glide(toPos, toTarget, dur = 0.9) {
    if (!motion) { camera.position.copy(toPos); controls.target.copy(toTarget); return; }
    anim = { fp: camera.position.clone(), ft: controls.target.clone(), tp: toPos.clone(), tt: toTarget.clone(), t0: clock.elapsed, dur };
  }
  function select(name, silent) {
    const e = name ? entries.get(name) : null;
    selected = e ? e.name : null;
    controls.autoRotate = false;
    if (e) {
      const c = e.root.position;
      glide(new THREE.Vector3(c.x + 0.8, c.y + 1.4, c.z + 4.2), new THREE.Vector3(c.x, c.y + 0.5, c.z));
    } else {
      glide(home.pos, home.target);
    }
    if (!silent && opts.onSelect) opts.onSelect(selected);
  }

  function showLabel(e) {
    const ind = e.target || {};
    const pi = e.podInfo || { total: 0, unhealthy: 0 };
    const more = pi.total > MAX_PODS_SHOWN ? ` (+${pi.total - MAX_PODS_SHOWN} not shown)` : "";
    label.textContent = `${e.name}${ind.ready === false ? "  · NOT READY" : ""}\n` +
      `CPU ${pct(ind.cpu)}   MEM ${pct(ind.mem)}   DISK ${pct(ind.disk)}\n` +
      `${pi.total} pods${pi.unhealthy ? `, ${pi.unhealthy} unhealthy` : ""}${more}`;
    label.style.display = "block";
  }

  // ---- input
  let downAt = null;
  function toNDC(ev) {
    const r = canvas.getBoundingClientRect();
    pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    return r;
  }
  canvas.addEventListener("pointermove", ev => {
    const r = toNDC(ev);
    pointerMoved = true;
    pointerInside = true;
    label.style.left = Math.min(ev.clientX - r.left + 14, r.width - 220) + "px";
    label.style.top = Math.max(0, ev.clientY - r.top + 14) + "px";
  });
  canvas.addEventListener("pointerleave", () => { pointerInside = false; setHover(null); });
  canvas.addEventListener("pointerdown", ev => { downAt = { x: ev.clientX, y: ev.clientY }; idleSince = clock.elapsed; controls.autoRotate = false; });
  canvas.addEventListener("pointerup", ev => {
    if (!downAt) return;
    const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
    downAt = null;
    if (moved > 5) return;
    toNDC(ev);
    const hit = pick();
    select(hit ? hit.entry.name : null);
  });
  function onKey(ev) { if (ev.key === "Escape" && visible && selected) select(null); }
  window.addEventListener("keydown", onKey);

  function pick() {
    ray.setFromCamera(pointer, camera);
    const roots = [...entries.values()].map(e => e.root);
    const hits = ray.intersectObjects(roots, true);
    for (const h of hits) {
      if (h.object.isSprite) continue;
      let o = h.object;
      while (o && !o.userData.entry) o = o.parent;
      if (o) return { entry: o.userData.entry, pod: h.object.userData.pod };
    }
    return null;
  }
  function setHover(e) {
    if (e === hovered) return;
    hovered = e;
    canvas.style.cursor = e ? "pointer" : "";
    if (e) showLabel(e); else label.style.display = "none";
  }

  // ---- size
  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  // ---- loop
  const clock = { elapsed: 0, last: 0 };
  let idleSince = 0;
  let running = false;
  let visible = true;
  let raf = 0;
  let frames = 0, slow = 0;
  let flyIn = motion ? { t0: null, dur: 2.6 } : null;
  homeCamera();
  camera.position.copy(motion ? new THREE.Vector3(0, 14, 28) : home.pos);
  controls.target.copy(home.target);

  const tmp = new THREE.Color();
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - (clock.last || now)) / 1000);
    clock.last = now;
    clock.elapsed += dt;
    const t = clock.elapsed;

    // performance guard: if frames average slow, drop bloom and the mirror
    frames++;
    if (dt * 1000 > 40) slow++;
    if (frames === 40) {
      if (slow > 28 && bloomOn) { bloomOn = false; mirror.visible = false; floorMat.opacity = 1; }
      frames = 0; slow = 0;
    }

    if (flyIn) {
      if (flyIn.t0 == null) flyIn.t0 = t;
      const k = Math.min(1, (t - flyIn.t0) / flyIn.dur);
      const e = 1 - Math.pow(1 - k, 3);
      camera.position.lerpVectors(new THREE.Vector3(0, 14, 26 + rackCount * 2), home.pos, e);
      if (k >= 1) { flyIn = null; idleSince = t; }
    } else if (anim) {
      const k = Math.min(1, (t - anim.t0) / anim.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      camera.position.lerpVectors(anim.fp, anim.tp, e);
      controls.target.lerpVectors(anim.ft, anim.tt, e);
      if (k >= 1) { anim = null; idleSince = t; }
    } else if (motion && !selected && t - idleSince > 8) {
      controls.autoRotate = true;
    }
    controls.update();

    // ambient mood follows the room alert
    tmp.copy(COLORS[alert]);
    scene.background.lerp(tmp, Math.min(1, dt * 2));
    scene.fog.color.copy(scene.background);

    const k = Math.min(1, dt * 3);
    for (const e of entries.values()) {
      const c = e.cur, tg = e.target;
      for (const f of ["cpu", "mem", "disk", "tempC", "battery"]) c[f] = ease(c[f], tg[f], k);
      c.ready = tg.ready;
      c.charging = tg.charging;
      e.model.update(c, t, dt, motion);

      const targetLift = e === hovered || e.name === selected ? 0.08 : 0;
      e.lift += (targetLift - e.lift) * k;
      e.model.group.position.y = e.lift;
      e.pods.position.y = motion ? Math.sin(t * 1.4 + e.bob) * 0.03 : 0;

      if (e.beacon) {
        e.beacon.position.set(e.root.position.x, e.root.position.y + 1.62, e.root.position.z);
        if (motion) e.beacon.rotation.y += dt * 3;
        e.beacon.visible = motion ? Math.sin(t * 6) > -0.3 : true;
      }
      if (motion && e.curve) {
        const speed = 0.12 + (c.cpu == null ? 0 : c.cpu) * 0.7;
        for (const p of e.pulses) {
          p.userData.phase = (p.userData.phase + dt * speed) % 1;
          p.position.copy(e.curve.getPoint(p.userData.phase));
          p.visible = c.ready;
        }
      }
    }
    podBad.emissiveIntensity = motion ? 0.9 + 0.7 * Math.sin(t * 5) : 1.2;
    swLeds.forEach((m, i) => {
      const on = motion ? Math.sin(t * 7 + i * 1.7) > -0.2 : true;
      m.color.copy(BAR_GOOD).multiplyScalar(on ? 1 : 0.15);
    });

    if (pointerMoved && pointerInside && !downAt) {
      pointerMoved = false;
      const hit = pick();
      setHover(hit ? hit.entry : null);
    }

    if (bloomOn) composer.render(dt);
    else renderer.render(scene, camera);
  }

  function setRunning() {
    const want = visible && !document.hidden;
    if (want && !running) { running = true; clock.last = 0; raf = requestAnimationFrame(frame); }
    else if (!want && running) { running = false; cancelAnimationFrame(raf); }
  }
  const onVis = () => setRunning();
  document.addEventListener("visibilitychange", onVis);

  canvas.addEventListener("webglcontextlost", ev => {
    ev.preventDefault();
    running = false;
    cancelAnimationFrame(raf);
    if (opts.onError) opts.onError("The 3D view lost its graphics context. Switch to Cards and back to retry.");
  });

  function setVisible(v) {
    visible = !!v;
    if (visible) resize();
    setRunning();
  }

  function dispose() {
    running = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("keydown", onKey);
    for (const e of entries.values()) removeEntry(e);
    entries.clear();
    disposeTree(scene);
    composer.dispose();
    controls.dispose();
    renderer.dispose();
    canvas.remove();
    label.remove();
  }

  resize();
  buildRacks(1);
  setRunning();
  return { update, select, setVisible, dispose, get selected() { return selected; } };
}
