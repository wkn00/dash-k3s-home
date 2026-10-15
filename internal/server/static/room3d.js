// The 3D server room, modelled on the real thing: closed laptops standing on
// edge in a black pegboard tray, ports facing out, patch cables looping to a
// switch, in a white-panelled room with a wood floor. Every model is built in
// code from primitives (no asset files) and every indicator is a live reading
// from /api/state. A null reading is drawn as "no data" (a dim dotted bar),
// never as an empty-but-confident zero.
//
// Follows the page theme: daylight by default, lights-out in dark mode, when
// the LEDs and bloom take over.
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
  modelFor, nodeIndicators, podsByNode, roomAlert, layoutRoom,
  PITCH, ROW_GAP,
} from "./room3d-logic.js?v=12";

const MAX_PODS_SHOWN = 24;    // per node; the label says how many more
const YAW = 0.5;              // the tray is turned so the port edges face the viewer
const WALL_Z = -3.9;

const NIGHT_BG = {
  ok: new THREE.Color(0x0b1622),
  warn: new THREE.Color(0x2a1d08),
  bad: new THREE.Color(0x2a0f12),
};
const DAY_BG = new THREE.Color(0xdde4ec);
const ALERT_TINT = { ok: new THREE.Color(0xffffff), warn: new THREE.Color(0xffe2a8), bad: new THREE.Color(0xffb0a8) };
const WALL_DAY = new THREE.Color(0xf6f7f8), WALL_NIGHT = new THREE.Color(0x232b38);
const FLOOR_DAY = new THREE.Color(0xffffff), FLOOR_NIGHT = new THREE.Color(0x3d4350);

// LED colours are pushed past 1.0 on purpose: only values above the bloom
// threshold glow, so the LEDs bloom and the white walls do not.
const HOT = 2.4;
const BAR_GOOD = new THREE.Color(0x22c55e).multiplyScalar(HOT);
const BAR_WARN = new THREE.Color(0xf59e0b).multiplyScalar(HOT);
const BAR_BAD = new THREE.Color(0xef4444).multiplyScalar(HOT);
const BAR_CHARGE = new THREE.Color(0x38bdf8).multiplyScalar(HOT);
const BAR_OFF = new THREE.Color(0x0e141b);
const BAR_NODATA = new THREE.Color(0x4a5360);
const PLUGS = [0xf2f2f2, 0x2563eb, 0xfacc15, 0x2563eb, 0x2563eb, 0xf2f2f2, 0x2563eb];

// Shared, never disposed per node.
const podGeo = new THREE.SphereGeometry(0.038, 12, 10);
const podOk = new THREE.MeshStandardMaterial({ color: 0x16a34a, emissive: 0x16a34a, emissiveIntensity: 0.9, roughness: 0.4 });
const podBad = new THREE.MeshStandardMaterial({ color: 0xdc2626, emissive: 0xef4444, emissiveIntensity: 1.2, roughness: 0.4 });
for (const o of [podGeo, podOk, podBad]) o.userData.shared = true;

const ease = (cur, target, k) => (target == null ? null : cur == null ? target : cur + (target - cur) * k);
const lerp = (a, b, t) => a + (b - a) * t;
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

// Rows of eight segments (CPU, memory, disk and optionally battery). `axis`
// is the direction the segments run: "x" on a front panel, "z" along the top
// edge of a standing laptop. Null readings alternate dim grey; a row is
// hidden entirely when it has no value to show (a machine with no battery).
function makeBars(width = 0.9, axis = "x", rowCount = 3) {
  const group = new THREE.Group();
  const rows = [];
  const seg = width / 8;
  const pitch = axis === "x" ? 0.055 : 0.04;
  for (let r = 0; r < rowCount; r++) {
    const row = [];
    const g = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      const m = led(BAR_OFF);
      const s = axis === "x"
        ? new THREE.Mesh(new THREE.BoxGeometry(seg * 0.8, 0.035, 0.02), m)
        : new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.012, seg * 0.8), m);
      if (axis === "x") s.position.set((i - 3.5) * seg, 0, 0);
      else s.position.set(0, 0, (i - 3.5) * seg);
      g.add(s);
      row.push(m);
    }
    if (axis === "x") g.position.y = (1 - r) * pitch; else g.position.x = (r - (rowCount - 1) / 2) * pitch;
    group.add(g);
    rows.push({ g, row });
  }
  const set = (vals, dead, charging) => {
    vals.forEach((v, r) => {
      const { g, row } = rows[r];
      if (v === undefined) { g.visible = false; return; }
      g.visible = true;
      row.forEach((m, i) => {
        if (dead) m.color.copy(BAR_OFF);
        else if (v == null) m.color.copy(i % 2 ? BAR_OFF : BAR_NODATA);
        else if (i < Math.round(v * 8) || (v > 0 && i === 0)) m.color.copy(r === 3 ? (charging ? BAR_CHARGE : barColor(1 - v)) : barColor(v));
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

// ---- device models ------------------------------------------------------
// Each builder returns { group, update(ind, t, dt, motion) }. `ind` holds the
// eased indicator values (fractions, or null for unknown). `slot` is the
// device's place in the layout, used to vary patch-cable plugs.

// A closed ThinkPad standing on its edge: the ports face +z, the hinge strip
// runs along the top, the broad faces point along +/-x.
function buildLaptop(slot) {
  const group = new THREE.Group();
  const T = 0.17, H = 0.95, L = 1.35;
  const black = body(0x1b1c20, { metalness: 0.12, roughness: 0.55 });
  const lid = body(0x232429, { metalness: 0.1, roughness: 0.5 });
  group.add(box(T * 0.58, H, L, black, -T * 0.21, H / 2, 0));
  group.add(box(T * 0.38, H, L, lid, T * 0.31, H / 2, 0));
  group.add(box(0.006, H - 0.04, L - 0.04, body(0x050506), T * 0.08, H / 2, 0));

  // battery barrel and hinges along the top edge
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1.05, 14), body(0x0e0f11, { roughness: 0.6 }));
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(-0.015, H + 0.005, -0.12);
  group.add(barrel);
  const hingeMat = body(0x7a7f87, { metalness: 0.8, roughness: 0.35 });
  for (const z of [-0.58, 0.28]) {
    const h = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.15, 12), hingeMat);
    h.rotation.x = Math.PI / 2;
    h.position.set(0.04, H - 0.01, z);
    group.add(h);
  }
  group.add(box(0.1, 0.014, 0.2, body(0xb91c1c, { metalness: 0.1 }), 0.0, H + 0.05, 0.5));

  // port edge (+z): VGA, Ethernet, USB x2, HDMI
  const portZ = L / 2;
  group.add(box(0.1, 0.06, 0.016, body(0x2f4a78), 0, 0.8, portZ));
  group.add(box(0.1, 0.075, 0.016, body(0x08090a), 0, 0.62, portZ));
  group.add(box(0.1, 0.026, 0.016, body(0x9aa1ab, { metalness: 0.8 }), 0, 0.47, portZ));
  group.add(box(0.1, 0.026, 0.016, body(0x9aa1ab, { metalness: 0.8 }), 0, 0.37, portZ));
  group.add(box(0.1, 0.03, 0.016, body(0x1a1b1e), 0, 0.22, portZ));
  const linkLed = new THREE.Mesh(new THREE.CircleGeometry(0.011, 8), led(BAR_GOOD));
  linkLed.position.set(-0.055, 0.665, portZ + 0.0095);
  group.add(linkLed);
  const plugColor = PLUGS[(slot ? slot.index : 0) % PLUGS.length];
  const plug = box(0.07, 0.055, 0.1, mat(0xf4f4f4, { metalness: 0.05, roughness: 0.6 }), 0, 0.62, portZ + 0.06);
  plug.add(box(0.074, 0.03, 0.04, mat(plugColor, { metalness: 0.05, roughness: 0.5 }), 0, 0, 0.02));
  group.add(plug);

  // side vents (+x face) glow with temperature
  const ventMats = [];
  for (let i = 0; i < 6; i++) {
    const m = new THREE.MeshBasicMaterial({ color: 0x050607 });
    const v = box(0.004, 0.16, 0.022, m, T * 0.5 + 0.002, 0.26, -0.25 + i * 0.09);
    group.add(v);
    ventMats.push(m);
  }
  const power = new THREE.Mesh(new THREE.CircleGeometry(0.012, 8), led(BAR_GOOD));
  power.rotation.y = Math.PI / 2;
  power.position.set(T * 0.5 + 0.003, H - 0.1, -0.62);
  group.add(power);

  const bars = makeBars(0.8, "z", 4);
  bars.group.position.set(-0.015, H + 0.066, -0.12);
  group.add(bars.group);

  group.scale.setScalar(1.2);
  const ventCold = new THREE.Color(0x0a2a3a), ventWarm = new THREE.Color(0xfb923c).multiplyScalar(1.6), ventHot = new THREE.Color(0xef4444).multiplyScalar(2);
  return {
    group,
    jack: new THREE.Vector3(0, 0.62 * 1.2, (portZ + 0.11) * 1.2),
    update(ind, t, dt, motion) {
      const dead = !ind.ready;
      darken(group, dead);
      bars.set([ind.cpu, ind.mem, ind.disk, ind.battery == null ? undefined : ind.battery], dead, ind.charging);
      const temp = dead ? null : ind.tempC;
      const heat = temp == null ? 0 : Math.min(1, Math.max(0, (temp - 35) / 45));
      for (let i = 0; i < ventMats.length; i++) {
        const c = ventMats[i].color;
        if (temp == null) c.setHex(0x050607);
        else if (heat < 0.5) c.copy(ventCold).lerp(ventWarm, heat * 2);
        else c.copy(ventWarm).lerp(ventHot, (heat - 0.5) * 2);
      }
      power.material.color.copy(dead ? BAR_OFF : BAR_GOOD);
      const blink = dead ? 0 : motion ? (Math.sin(t * (3 + (ind.cpu || 0) * 18) + (slot ? slot.index : 0)) > -0.2 ? 1 : 0.15) : 1;
      linkLed.material.color.copy(BAR_GOOD).multiplyScalar(blink);
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
  const fans = [];
  for (let i = 0; i < 2; i++) { const f = makeFan(0.28, 7); f.position.set(-0.45 + i * 0.9, 0.225, -0.1); fans.push(f); group.add(f); }
  const bars = makeBars(0.9);
  bars.group.position.set(0.0, 0.035, 0.66);
  group.add(bars.group);
  const heat = makeHeat(2.0, 1.4);
  group.add(heat.mesh);
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
      core.scale.setScalar(ind.cpu == null || dead ? 0.35 : 0.45 + ind.cpu * 0.9);
      coreMat.color.copy(dead || ind.cpu == null ? BAR_NODATA : new THREE.Color(0x67e8f9).multiplyScalar(1.5));
      if (motion && !dead) { core.rotation.y += dt * (0.6 + (ind.cpu || 0) * 3); core.rotation.x += dt * 0.3; }
      core.position.y = 0.3 + (motion ? Math.sin(t * 1.5) * 0.03 : 0);
    },
  };
}

// An unrecognised device is shown as a laptop: that is what a homelab
// node most likely is, and it fits the tray.
const BUILDERS = {
  laptop: buildLaptop, generic: buildLaptop, minipc: buildMiniPc, sbc: buildSbc,
  server: buildServer, vm: buildVm,
};

// ---- environment textures -------------------------------------------------

function canvasTex(w, h, draw, repeat) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (repeat) t.repeat.set(repeat[0], repeat[1]);
  return t;
}

function woodTexture() {
  return canvasTex(1024, 1024, (x, w, h) => {
    const planks = 6, pw = w / planks;
    for (let i = 0; i < planks; i++) {
      const l = 58 + ((i * 37) % 9);
      x.fillStyle = `hsl(30, 9%, ${l + 6}%)`;
      x.fillRect(i * pw, 0, pw, h);
      for (let k = 0; k < 70; k++) {
        const gx = i * pw + ((k * 53 + i * 17) % pw);
        x.strokeStyle = `hsla(28, 14%, ${38 + (k % 7) * 3}%, ${0.05 + (k % 5) * 0.022})`;
        x.lineWidth = 1 + (k % 3);
        x.beginPath();
        x.moveTo(gx, 0);
        for (let y = 0; y <= h; y += 64) x.lineTo(gx + Math.sin(y * 0.011 + k + i) * 5, y);
        x.stroke();
      }
      x.fillStyle = "rgba(40,28,20,.45)";
      x.fillRect(i * pw, 0, 2, h);
    }
    for (let j = 0; j < 4; j++) { x.fillStyle = "rgba(40,28,20,.35)"; x.fillRect(0, j * 256 + (j % 2) * 90, w, 2); }
  }, [14, 14]);
}

function panelTexture() {
  return canvasTex(1024, 256, (x, w, h) => {
    x.fillStyle = "#f4f5f6"; x.fillRect(0, 0, w, h);
    const boards = 8, bw = w / boards;
    for (let i = 0; i < boards; i++) {
      x.fillStyle = "rgba(120,128,138,.55)"; x.fillRect(i * bw, 0, 4, h);
      x.fillStyle = "rgba(255,255,255,.9)"; x.fillRect(i * bw + 4, 0, 3, h);
      const g = x.createLinearGradient(i * bw, 0, (i + 1) * bw, 0);
      g.addColorStop(0, "rgba(0,0,0,.05)"); g.addColorStop(0.5, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.03)");
      x.fillStyle = g; x.fillRect(i * bw, 0, bw, h);
    }
  }, [5, 1]);
}

function trayTexture() {
  return canvasTex(256, 256, (x, w, h) => {
    x.fillStyle = "#202226"; x.fillRect(0, 0, w, h);
    x.fillStyle = "#08090b";
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      x.beginPath(); x.ellipse(16 + c * 32, 16 + r * 32, 4, 9, 0, 0, Math.PI * 2); x.fill();
    }
  }, [6, 3]);
}

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

function nameTag(text, scale = 1) {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 96;
  const x = c.getContext("2d");
  x.fillStyle = "rgba(8,14,22,0.78)";
  x.beginPath(); x.roundRect(4, 4, 504, 88, 18); x.fill();
  x.fillStyle = "#e6edf5";
  x.font = "600 44px system-ui, sans-serif";
  x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText(text, 256, 50, 480);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(1.3 * scale, 0.244 * scale, 1);
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
    "background:rgba(8,14,22,.9);color:#e6edf5;font:12px/1.4 system-ui,sans-serif;white-space:pre;z-index:2;" +
    "border:1px solid rgba(120,160,200,.35)";
  container.appendChild(label);

  const scene = new THREE.Scene();
  scene.background = DAY_BG.clone();
  scene.fog = new THREE.FogExp2(DAY_BG.clone(), 0.012);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 140);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 2;
  controls.maxDistance = 40;
  controls.autoRotateSpeed = 0.45;

  // Lighting: a window-style sun for the day, a cool lamp for the night.
  const hemi = new THREE.HemisphereLight(0xdfe9f5, 0xb8a58f, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
  sun.position.set(-7, 9, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -9; sun.shadow.camera.right = 9;
  sun.shadow.camera.top = 9; sun.shadow.camera.bottom = -9;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 40;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 4;
  scene.add(sun);
  const lamp = new THREE.SpotLight(0xa9c8ff, 0, 60, Math.PI / 3.4, 0.8, 1.4);
  lamp.position.set(3, 9, 8);
  scene.add(lamp);
  scene.add(lamp.target);
  const alertLight = new THREE.PointLight(0xef4444, 0, 18, 1.6);
  alertLight.position.set(0, 3.2, 1.5);
  scene.add(alertLight);

  // The room: wood floor over a mirror (so the models reflect a little),
  // and a white panelled wall.
  const mirror = new Reflector(new THREE.PlaneGeometry(80, 80), { textureWidth: 512, textureHeight: 512, color: 0x888888, clipBias: 0.003 });
  mirror.rotation.x = -Math.PI / 2;
  mirror.position.y = -0.003;
  scene.add(mirror);
  const floorMat = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.5, metalness: 0.0, transparent: true, opacity: 0.93 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const wallMat = new THREE.MeshStandardMaterial({ map: panelTexture(), roughness: 0.85, metalness: 0 });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 12), wallMat);
  wall.position.set(0, 6, WALL_Z);
  wall.receiveShadow = true;
  scene.add(wall);
  const trimMat = mat(0xe9ebee, { metalness: 0, roughness: 0.7 });
  const base = box(40, 0.28, 0.06, trimMat, 0, 0.14, WALL_Z + 0.03);
  base.receiveShadow = true;
  scene.add(base);
  // outlet plate the power cords run up to
  const outletMat = mat(0xf3f4f5, { metalness: 0, roughness: 0.5 });
  scene.add(box(0.55, 0.55, 0.04, outletMat, 3.6, 0.9, WALL_Z + 0.04));
  scene.add(box(0.3, 0.12, 0.02, mat(0x4a5058, { metalness: 0 }), 3.6, 0.9, WALL_Z + 0.07));

  // Everything physical lives in `tray`, turned so port edges face the viewer.
  const tray = new THREE.Group();
  tray.rotation.y = YAW;
  scene.add(tray);
  const furniture = new THREE.Group();
  tray.add(furniture);
  const traySurface = new THREE.MeshStandardMaterial({ map: trayTexture(), roughness: 0.6, metalness: 0.1 });
  const peg = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.5, metalness: 0.2 });
  const swGroup = new THREE.Group();
  tray.add(swGroup);
  const swLeds = [];
  const emptyTag = nameTag("No nodes reported");
  emptyTag.position.set(0, 1.2, 0);
  emptyTag.visible = false;
  tray.add(emptyTag);

  // Post-processing
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.3, 0.45, 0.95);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  let bloomOn = true;

  const entries = new Map();
  let layout = { slots: [], trayCount: 0, benchCount: 0, perRow: 1, rows: 1 };
  let layoutKey = "";
  const switchLocal = new THREE.Vector3();
  let alert = "ok";
  let selected = null;
  let hovered = null;
  const pointer = new THREE.Vector2();
  let pointerMoved = false;
  let pointerInside = false;
  const ray = new THREE.Raycaster();

  // ---- day / night
  let night = opts.dark ? 1 : 0;
  let nightTarget = night;
  let alertMix = 0;
  const alertCol = new THREE.Color(0xffffff);
  const bgNight = NIGHT_BG.ok.clone();
  const tmpA = new THREE.Color();

  // ---- furniture: tray, pegs, switch, power strip
  function buildFurniture() {
    for (const c of [...furniture.children]) { furniture.remove(c); disposeTree(c); }
    for (const c of [...swGroup.children]) { swGroup.remove(c); disposeTree(c); }
    swLeds.length = 0;

    const n = layout.perRow;
    const rowSpan = n * PITCH;
    const left = -rowSpan / 2 - 0.55 - 2.3;       // room on the left for the switch
    const right = rowSpan / 2 + 0.55;
    const front = 1.2;
    const back = -1.2 - (layout.rows - 1) * ROW_GAP;
    const t = box(right - left, 0.05, front - back, traySurface, (left + right) / 2, 0.025, (front + back) / 2);
    t.receiveShadow = true;
    furniture.add(t);

    // the black pegs between laptops, front and back
    for (let r = 0; r < layout.rows; r++) {
      const inRow = Math.min(layout.perRow, layout.trayCount - r * layout.perRow);
      for (let i = 0; i <= inRow; i++) {
        const px = (i - 0.5 - (layout.perRow - 1) / 2) * PITCH;
        for (const [pz, ph] of [[0.5, 0.62], [-0.38, 0.5]]) {
          const p = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.04, ph, 10), peg);
          p.position.set(px, 0.05 + ph / 2, pz - r * ROW_GAP);
          furniture.add(p);
        }
      }
    }

    // the switch, at the left end of the tray
    switchLocal.set(left + 1.35, 0.05, 0.55);
    swGroup.position.copy(switchLocal);
    swGroup.add(box(2.0, 0.16, 0.5, mat(0x1a1d22, { metalness: 0.5, roughness: 0.45 }), 0, 0.08, 0));
    for (let i = 0; i < 16; i++) {
      const m = led(BAR_GOOD);
      const l = new THREE.Mesh(new THREE.CircleGeometry(0.022, 8), m);
      l.position.set(-0.86 + i * 0.115, 0.115, 0.252);
      swGroup.add(l);
      swLeds.push(m);
      swGroup.add(box(0.07, 0.045, 0.012, mat(0x050607), -0.86 + i * 0.115, 0.055, 0.252));
    }

    // power strip and cords behind the row
    const stripX = right - 0.6;
    furniture.add(box(0.9, 0.09, 0.32, mat(0xeceef0, { metalness: 0, roughness: 0.5 }), stripX, 0.095, back + 0.35));
    const cordMat = new THREE.MeshStandardMaterial({ color: 0xf1f2f3, roughness: 0.6 });
    for (let k = 0; k < 3; k++) {
      const pts = [
        new THREE.Vector3(stripX + 0.4, 0.1, back + 0.35 - k * 0.04),
        new THREE.Vector3(stripX + 0.9 + k * 0.2, 0.06, back - 0.2),
        new THREE.Vector3(stripX + 1.3 + k * 0.1, 0.07, back - 0.9 - k * 0.1),
        new THREE.Vector3(stripX + 1.2, 0.4 + k * 0.25, back - 1.6),
      ];
      furniture.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, 0.028, 6, false), cordMat));
    }
    furniture.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    swGroup.traverse(o => { if (o.isMesh) o.castShadow = true; });
  }

  // ---- node entries
  function createEntry(name) {
    const root = new THREE.Group();
    const e = {
      name, root, kind: null, model: null, cur: null, target: null, pods: new THREE.Group(),
      podKey: "", podInfo: null, tag: nameTag(name, 0.62), cable: null, pulses: [], beacon: null,
      lift: 0, bob: Math.random() * 6, slot: null, curve: null, builtFor: null, cableDirty: false,
    };
    root.add(e.pods);
    root.add(e.tag);
    root.userData.entry = e;
    tray.add(root);
    return e;
  }

  function setKind(e, kind) {
    const idx = e.slot ? e.slot.index : null;
    if (e.kind === kind && e.builtFor === idx) return false;
    if (e.model) { e.root.remove(e.model.group); disposeTree(e.model.group); }
    e.kind = kind;
    e.builtFor = idx;
    e.model = BUILDERS[kind](e.slot);
    e.model.group.traverse(o => { o.userData.entry = e; if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    e.root.add(e.model.group);
    return true;
  }

  function buildCable(e) {
    if (e.cable) { tray.remove(e.cable); disposeTree(e.cable); }
    e.cable = null; e.curve = null; e.pulses = [];
    if (!e.model || !e.model.jack) return;
    const x = e.root.position.x, z0 = e.root.position.z;
    const j = e.model.jack;
    const start = new THREE.Vector3(x + j.x, 0.05 + j.y, z0 + j.z);
    const lane = (e.slot.index % 5) * 0.075;
    const toX = switchLocal.x + ((e.slot.index % 8) / 7 - 0.5) * 1.5;
    const front = z0 + 1.12 + lane;
    const pts = [
      start,
      new THREE.Vector3(x, start.y - 0.04, start.z + 0.1),
      new THREE.Vector3(x - 0.02, 0.32, start.z + 0.2),
      new THREE.Vector3(x - 0.1, 0.08, front),
      new THREE.Vector3((x + toX) / 2, 0.08, front + 0.04),
      new THREE.Vector3(toX + 0.05, 0.1, switchLocal.z + 0.55 + lane * 0.3),
      new THREE.Vector3(toX, 0.2, switchLocal.z + 0.3),
    ];
    e.curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(e.curve, 64, 0.02, 6, false),
      new THREE.MeshStandardMaterial({ color: 0xf2f3f4, roughness: 0.55, metalness: 0 }));
    tube.castShadow = true;
    const g = new THREE.Group();
    g.add(tube);
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x38bdf8).multiplyScalar(HOT) }));
      p.userData.phase = i / 3;
      p.visible = motion;
      g.add(p);
      e.pulses.push(p);
    }
    e.cable = g;
    tray.add(g);
  }

  function removeEntry(e) {
    tray.remove(e.root);
    disposeTree(e.root);
    if (e.cable) { tray.remove(e.cable); disposeTree(e.cable); }
    if (e.beacon) { tray.remove(e.beacon); disposeTree(e.beacon); }
    if (selected === e.name) select(null, true);
    if (hovered === e) { hovered = null; label.style.display = "none"; }
  }

  function podPos(e, i) {
    const col = i % 8, row = Math.floor(i / 8);
    if (e.kind === "laptop" || e.kind === "generic") return [(row - 1) * 0.12, 1.44, (col - 3.5) * 0.17];
    return [(col - 3.5) * 0.15, 1.18 + row * 0.15, 0];
  }

  function syncPods(e, info) {
    const list = info ? info.pods : [];
    const shown = list.slice(0, MAX_PODS_SHOWN);
    const key = e.kind + shown.map(p => (p.healthy ? "1" : "0")).join("") + ":" + list.length;
    e.podInfo = info || { total: 0, unhealthy: 0, pods: [] };
    if (key === e.podKey) return;
    e.podKey = key;
    for (const c of [...e.pods.children]) e.pods.remove(c);
    shown.forEach((p, i) => {
      const m = new THREE.Mesh(podGeo, p.healthy ? podOk : podBad);
      m.userData.entry = e;
      m.userData.pod = p;
      m.position.set(...podPos(e, i));
      e.pods.add(m);
    });
  }

  function syncBeacon(e, bad) {
    if (bad && !e.beacon) {
      const g = new THREE.Group();
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.2, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xef4444).multiplyScalar(2.4) }));
      cone.rotation.x = Math.PI;
      g.add(cone);
      e.beacon = g;
      tray.add(g);
    } else if (!bad && e.beacon) {
      tray.remove(e.beacon); disposeTree(e.beacon); e.beacon = null;
    }
  }

  // ---- public: update
  function update(snap) {
    const nodes = (snap && snap.nodes) || [];
    layout = layoutRoom(nodes);
    const byName = new Map(nodes.map(n => [n.name, n]));
    const key = `${layout.trayCount}:${layout.benchCount}:${layout.perRow}:${layout.rows}`;
    if (key !== layoutKey) { layoutKey = key; buildFurniture(); for (const e of entries.values()) e.cableDirty = true; frameCamera(); }
    emptyTag.visible = nodes.length === 0;

    const pods = podsByNode(snap);
    const seen = new Set();
    for (const slot of layout.slots) {
      seen.add(slot.name);
      const n = byName.get(slot.name);
      let e = entries.get(slot.name);
      const isNew = !e;
      if (!e) { e = createEntry(slot.name); entries.set(slot.name, e); }
      const oldIndex = e.slot ? e.slot.index : null;
      const oldX = e.root.position.x, oldZ = e.root.position.z;
      e.slot = slot;
      const rebuilt = setKind(e, modelFor(n.deviceClass));
      e.root.position.set(slot.x, 0.05, slot.z);
      e.tag.position.set(0, slot.bench ? 1.75 : 1.75 + (slot.index % 2) * 0.2, 0);
      if (isNew || rebuilt || e.cableDirty || oldIndex !== slot.index || oldX !== slot.x || oldZ !== slot.z) {
        buildCable(e);
        e.cableDirty = false;
      }
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

  // ---- camera
  const home = { pos: new THREE.Vector3(3.6, 4.2, 8), target: new THREE.Vector3(0, 0.55, 0) };
  let anim = null;
  let flyIn = motion ? { t0: null, dur: 2.8 } : null;
  function flyStart(out) { return out.set(home.pos.x * 1.6, home.pos.y + 9, home.pos.z * 1.7); }
  function frameCamera() {
    const span = Math.max(3, layout.perRow * PITCH + 3.2) + (layout.rows - 1) * ROW_GAP;
    const d = 2.6 + span * 0.66 + (layout.benchCount ? 1.8 : 0);
    home.target.set(-0.5 - layout.perRow * 0.04, 0.55, layout.benchCount ? -0.6 : 0.1);
    home.pos.set(home.target.x + d * 0.42, 1.2 + d * 0.38, home.target.z + d * 0.9);
    if (!flyIn && !anim && !selected) { camera.position.copy(home.pos); controls.target.copy(home.target); }
  }

  function glide(toPos, toTarget, dur = 0.9) {
    if (!motion) { camera.position.copy(toPos); controls.target.copy(toTarget); return; }
    anim = { fp: camera.position.clone(), ft: controls.target.clone(), tp: toPos.clone(), tt: toTarget.clone(), t0: performance.now() / 1000, dur };
  }
  const _w = new THREE.Vector3();
  function select(name, silent) {
    const e = name ? entries.get(name) : null;
    selected = e ? e.name : null;
    controls.autoRotate = false;
    if (e) {
      e.root.getWorldPosition(_w);
      const dir = new THREE.Vector3(Math.sin(YAW), 0, Math.cos(YAW));
      const far = e.slot && e.slot.bench ? 5 : 3.6;
      glide(_w.clone().addScaledVector(dir, far).add(new THREE.Vector3(0, 1.7, 0)), _w.clone().add(new THREE.Vector3(0, 0.55, 0)));
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
  frameCamera();
  if (motion) flyStart(camera.position); else camera.position.copy(home.pos);
  controls.target.copy(home.target);

  const _fly = new THREE.Vector3();
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - (clock.last || now)) / 1000);
    clock.last = now;
    clock.elapsed += dt;
    const t = clock.elapsed;
    // Camera moves run on wall-clock time so a slow device sees the same
    // glide, not slow motion; everything else follows the capped clock.
    const rt = performance.now() / 1000;

    // performance guard: if frames average slow, drop bloom and the mirror
    frames++;
    if (dt * 1000 > 40) slow++;
    if (frames === 40) {
      if (slow > 28 && bloomOn) { bloomOn = false; mirror.visible = false; floorMat.opacity = 1; }
      frames = 0; slow = 0;
    }

    if (flyIn) {
      if (flyIn.t0 == null) flyIn.t0 = rt;
      const k = Math.min(1, (rt - flyIn.t0) / flyIn.dur);
      const e = 1 - Math.pow(1 - k, 3);
      camera.position.lerpVectors(flyStart(_fly), home.pos, e);
      if (k >= 1) { flyIn = null; idleSince = t; }
    } else if (anim) {
      const k = Math.min(1, (rt - anim.t0) / anim.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      camera.position.lerpVectors(anim.fp, anim.tp, e);
      controls.target.lerpVectors(anim.ft, anim.tt, e);
      if (k >= 1) { anim = null; idleSince = t; }
    } else if (motion && !selected && t - idleSince > 10) {
      controls.autoRotate = true;
    }
    controls.update();

    // look: day <-> night, plus the alert tint
    night += (nightTarget - night) * Math.min(1, dt * 2.5);
    alertMix += ((alert !== "ok" ? 1 : 0) - alertMix) * Math.min(1, dt * 2);
    alertCol.lerp(ALERT_TINT[alert], Math.min(1, dt * 3));
    bgNight.lerp(NIGHT_BG[alert], Math.min(1, dt * 2));
    sun.intensity = lerp(2.6, 0, night);
    hemi.intensity = lerp(1.1, 0.22, night);
    hemi.color.setHex(0xdfe9f5).lerp(tmpA.setHex(0x2a3f5c), night);
    hemi.groundColor.setHex(0xb8a58f).lerp(tmpA.setHex(0x0a0d12), night);
    lamp.intensity = lerp(0, 70, night);
    alertLight.color.setHex(alert === "bad" ? 0xef4444 : 0xf59e0b);
    alertLight.intensity = alertMix * lerp(6, 55, night) * (motion ? 0.85 + 0.15 * Math.sin(t * 4) : 1);
    wallMat.color.copy(WALL_DAY).lerp(WALL_NIGHT, night).lerp(alertCol, 0.1 * alertMix * (1 - night));
    trimMat.color.setHex(0xe9ebee).lerp(WALL_NIGHT, night * 0.85);
    outletMat.color.setHex(0xf3f4f5).lerp(WALL_NIGHT, night * 0.85);
    floorMat.color.copy(FLOOR_DAY).lerp(FLOOR_NIGHT, night).lerp(alertCol, 0.07 * alertMix * (1 - night));
    scene.background.copy(DAY_BG).lerp(bgNight, night);
    scene.fog.color.copy(scene.background);
    scene.fog.density = lerp(0.006, 0.014, night);
    bloom.strength = lerp(0.22, 0.6, night);
    bloom.threshold = lerp(0.97, 0.62, night);

    const k = Math.min(1, dt * 3);
    for (const e of entries.values()) {
      const c = e.cur, tg = e.target;
      for (const f of ["cpu", "mem", "disk", "tempC", "battery"]) c[f] = ease(c[f], tg[f], k);
      c.ready = tg.ready;
      c.charging = tg.charging;
      e.model.update(c, t, dt, motion);

      const targetLift = e === hovered || e.name === selected ? 0.07 : 0;
      e.lift += (targetLift - e.lift) * k;
      e.model.group.position.y = e.lift;
      e.pods.position.y = motion ? Math.sin(t * 1.4 + e.bob) * 0.025 : 0;

      if (e.beacon) {
        e.beacon.position.set(e.root.position.x, 2.4, e.root.position.z);
        if (motion) e.beacon.rotation.y += dt * 3;
        e.beacon.visible = motion ? Math.sin(t * 6) > -0.3 : true;
      }
      if (motion && e.curve) {
        const speed = 0.1 + (c.cpu == null ? 0 : c.cpu) * 0.6;
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
  function setDark(d) { nightTarget = d ? 1 : 0; }

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
  update({ nodes: [] });
  setRunning();
  return { update, select, setVisible, setDark, dispose, get selected() { return selected; } };
}
