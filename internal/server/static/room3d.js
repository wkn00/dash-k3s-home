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
  PITCH, ROW_GAP, TRAY_MARGIN, SHELF_Y, SHELF_GAP, SHELF_Z, SHELF_PITCH, PER_SHELF,
} from "./room3d-logic.js?v=14";

const YAW = 0;                // square to the wall
const WALL_Z = -5.2;
const LAPTOP_SCALE = 2.0;     // laptops are drawn big enough to read from across the room
const DEVICE_SCALE = 1.75;    // so are the other device models
const LANE0 = 1.95;           // where the first cable lane runs in front of the tray
const LANE_STEP = 0.06;

const NIGHT_BG = {
  ok: new THREE.Color(0x0b1622),
  warn: new THREE.Color(0x2a1d08),
  bad: new THREE.Color(0x2a0f12),
};
const CABLE_NIGHT = new THREE.Color(0x7d8794);
const DAY_BG = new THREE.Color(0xdde4ec);
const ALERT_TINT = { ok: new THREE.Color(0xffffff), warn: new THREE.Color(0xffe2a8), bad: new THREE.Color(0xffb0a8) };
const WALL_DAY = new THREE.Color(0xf6f7f8), WALL_NIGHT = new THREE.Color(0x3a4558);
const FLOOR_DAY = new THREE.Color(0xffffff), FLOOR_NIGHT = new THREE.Color(0x5a6272);

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

// A rounded slab (L long, H tall, T thick, corner radius r) standing on its
// bottom edge. Built by extruding a rounded rectangle so the corners and
// edges are bevelled the way a real chassis is, not box-sharp.
function slabGeometry(L, H, T, r, bevel = 0.012) {
  const w = L / 2;
  const sh = new THREE.Shape();
  sh.moveTo(-w + r, 0); sh.lineTo(w - r, 0); sh.quadraticCurveTo(w, 0, w, r);
  sh.lineTo(w, H - r); sh.quadraticCurveTo(w, H, w - r, H);
  sh.lineTo(-w + r, H); sh.quadraticCurveTo(-w, H, -w, H - r);
  sh.lineTo(-w, r); sh.quadraticCurveTo(-w, 0, -w + r, 0);
  const g = new THREE.ExtrudeGeometry(sh, {
    depth: Math.max(0.001, T - 2 * bevel), bevelEnabled: true, bevelThickness: bevel,
    bevelSize: bevel, bevelSegments: 3, curveSegments: 8,
  });
  g.rotateY(-Math.PI / 2);          // shape x -> world z, extrusion -> world x
  g.computeBoundingBox();
  g.translate(-(g.boundingBox.min.x + g.boundingBox.max.x) / 2, 0, 0);
  return g;
}

// Fine speckle for the matte plastic: a bump map, shared by every laptop.
let _grain = null;
function grainTexture() {
  if (_grain) return _grain;
  _grain = canvasTex(128, 128, (x, w, h) => {
    const img = x.createImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 120 + Math.random() * 110;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
  }, [3, 3]);
  _grain.userData = { shared: true };
  return _grain;
}

// A closed ThinkPad standing on its edge, after the real ones: matte black
// grained plastic, a silver hinge strip and a battery barrel along the top,
// a vented bottom case with a service door and stickers (+x), and the port
// edge (+z) with a D-sub VGA, a shielded RJ45 with its link LED, two USB
// ports and an HDMI/eSATA slot. The lid's outer cover faces -x.
function buildLaptop(slot) {
  const group = new THREE.Group();
  const T = 0.155, H = 0.95, L = 1.36;
  const bottomT = T * 0.62, lidT = T * 0.36, seam = 0.006;
  const grain = grainTexture();
  const matte = body(0x191a1d, { metalness: 0.05, roughness: 0.74, bumpMap: grain, bumpScale: 0.7 });
  const cover = body(0x1f2024, { metalness: 0.08, roughness: 0.58, bumpMap: grain, bumpScale: 0.45 });
  const bx = T / 2 - bottomT / 2, lx = -T / 2 + lidT / 2;
  const bottom = new THREE.Mesh(slabGeometry(L, H, bottomT, 0.07), matte);
  bottom.position.x = bx;
  const lid = new THREE.Mesh(slabGeometry(L, H, lidT, 0.07), cover);
  lid.position.x = lx - seam;
  group.add(bottom, lid);
  group.add(box(0.004, H - 0.05, L - 0.06, body(0x030304), (bx - bottomT / 2 + lx + lidT / 2) / 2, H / 2, 0));

  // top edge: battery barrel, hinge strip and the silver hinge barrels
  const tube = (r, len, color, x, y, z, rough = 0.6, metal = 0.1) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 18), body(color, { roughness: rough, metalness: metal }));
    m.rotation.x = Math.PI / 2; m.position.set(x, y, z);
    return m;
  };
  group.add(tube(0.058, 1.02, 0x0f1012, 0.012, H + 0.012, -0.13));
  group.add(tube(0.036, 1.3, 0x141518, -0.035, H - 0.018, 0.0));
  for (const z of [-0.56, 0.44]) {
    group.add(tube(0.046, 0.22, 0x8a9099, -0.005, H - 0.004, z, 0.3, 0.85));
    group.add(tube(0.05, 0.03, 0x2a2c31, -0.005, H - 0.004, z - 0.125, 0.5, 0.5));
    group.add(tube(0.05, 0.03, 0x2a2c31, -0.005, H - 0.004, z + 0.125, 0.5, 0.5));
  }
  group.add(box(0.075, 0.012, 0.17, body(0xb91c1c, { metalness: 0.1, roughness: 0.4 }), 0.0, H + 0.074, 0.55));
  group.add(box(0.03, 0.02, 0.012, body(0x050506), 0.0, H - 0.07, -0.6));        // lock slot (top rear)

  // bottom case (+x): hot vents, battery latch, grille, service door, stickers
  const faceX = bx + bottomT / 2 + 0.012;
  const dark = body(0x08090b, { roughness: 0.8 });
  const panel = body(0x222428, { roughness: 0.7, bumpMap: grain, bumpScale: 0.5 });
  group.add(box(0.006, 0.34, 0.62, panel, faceX, 0.2, 0.3));
  for (const [dz, dy] of [[-0.27, -0.13], [0.27, -0.13], [-0.27, 0.13], [0.27, 0.13]]) {
    const sc = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.006, 10), body(0x6c7078, { metalness: 0.8 }));
    sc.rotation.z = Math.PI / 2;
    sc.position.set(faceX + 0.004, 0.2 + dy, 0.3 + dz);
    group.add(sc);
  }
  for (let i = 0; i < 7; i++) group.add(box(0.005, 0.02, 0.5, dark, faceX, 0.42 + i * 0.032, 0.36));   // intake grille
  group.add(box(0.006, 0.07, 0.3, body(0x2c2f35, { metalness: 0.4, roughness: 0.5 }), faceX, 0.58, -0.35)); // battery latch
  group.add(box(0.004, 0.1, 0.22, body(0xe8eaee, { roughness: 0.6 }), faceX, 0.3, -0.42));                 // label sticker
  group.add(box(0.004, 0.07, 0.07, body(0x1d4ed8, { roughness: 0.5 }), faceX, 0.22, -0.2));              // blue sticker
  group.add(box(0.004, 0.07, 0.07, body(0x9aa1ab, { metalness: 0.7, roughness: 0.4 }), faceX, 0.22, -0.55)); // silver sticker
  const ventMats = [];
  for (let i = 0; i < 7; i++) {
    const m = new THREE.MeshBasicMaterial({ color: 0x050607 });
    group.add(box(0.005, 0.1, 0.02, m, faceX, 0.8, -0.55 + i * 0.045));
    ventMats.push(m);
  }
  const power = new THREE.Mesh(new THREE.CircleGeometry(0.011, 10), led(BAR_GOOD));
  power.rotation.y = Math.PI / 2;
  power.position.set(faceX + 0.004, 0.8, 0.5);
  group.add(power);

  // port edge (+z), each port in a recessed bezel
  const portZ = L / 2 + 0.012;
  const metal = body(0x9aa1ab, { metalness: 0.85, roughness: 0.3 });
  for (const y of [0.81, 0.63, 0.47, 0.37, 0.22]) group.add(box(0.125, 0.085, 0.01, dark, 0, y, portZ - 0.004));
  // VGA: a D-shaped shell with a blue pin block
  const dsub = new THREE.Shape();
  dsub.moveTo(-0.05, 0.022); dsub.lineTo(0.05, 0.022); dsub.lineTo(0.04, -0.022); dsub.lineTo(-0.04, -0.022); dsub.closePath();
  const dg = new THREE.ExtrudeGeometry(dsub, { depth: 0.012, bevelEnabled: false });
  const vga = new THREE.Mesh(dg, metal); vga.position.set(0, 0.81, portZ - 0.002); group.add(vga);
  group.add(box(0.07, 0.026, 0.016, body(0x1b3a8a), 0, 0.81, portZ + 0.012));
  // RJ45: shield, dark socket, gold contacts
  group.add(box(0.1, 0.075, 0.014, metal, 0, 0.63, portZ + 0.002));
  group.add(box(0.074, 0.05, 0.017, body(0x050506), 0, 0.63, portZ + 0.004));
  group.add(box(0.05, 0.006, 0.018, body(0xd4af37, { metalness: 0.9, roughness: 0.3 }), 0, 0.615, portZ + 0.006));
  // two USB ports with blue tongues, and HDMI
  for (const y of [0.47, 0.37]) {
    group.add(box(0.1, 0.026, 0.014, metal, 0, y, portZ + 0.002));
    group.add(box(0.075, 0.009, 0.016, body(0x1d4ed8), 0, y, portZ + 0.006));
  }
  const hdmi = new THREE.Shape();
  hdmi.moveTo(-0.045, 0.012); hdmi.lineTo(0.045, 0.012); hdmi.lineTo(0.045, -0.002); hdmi.lineTo(0.035, -0.014); hdmi.lineTo(-0.035, -0.014); hdmi.lineTo(-0.045, -0.002); hdmi.closePath();
  const hm = new THREE.Mesh(new THREE.ExtrudeGeometry(hdmi, { depth: 0.012, bevelEnabled: false }), body(0x0c0d0f));
  hm.position.set(0, 0.22, portZ); group.add(hm);

  const linkLed = new THREE.Mesh(new THREE.CircleGeometry(0.011, 10), led(BAR_GOOD));
  linkLed.position.set(-0.056, 0.672, portZ + 0.0135);
  group.add(linkLed);
  const plugColor = PLUGS[(slot ? slot.index : 0) % PLUGS.length];
  const plug = box(0.074, 0.058, 0.1, mat(0xf4f4f4, { metalness: 0.05, roughness: 0.6 }), 0, 0.63, portZ + 0.065);
  plug.add(box(0.078, 0.03, 0.04, mat(plugColor, { metalness: 0.05, roughness: 0.5 }), 0, 0, 0.022));
  plug.add(box(0.05, 0.04, 0.05, mat(0xe9eaec, { metalness: 0.02, roughness: 0.7 }), 0, 0, -0.07));   // strain relief
  group.add(plug);

  const bars = makeBars(0.8, "z", 4);
  bars.group.position.set(0.012, H + 0.074, -0.13);
  group.add(bars.group);

  group.scale.setScalar(LAPTOP_SCALE);
  const ventCold = new THREE.Color(0x0a2a3a), ventWarm = new THREE.Color(0xfb923c).multiplyScalar(1.6), ventHot = new THREE.Color(0xef4444).multiplyScalar(2);
  return {
    group,
    jack: new THREE.Vector3(0, 0.63 * LAPTOP_SCALE, (portZ + 0.115) * LAPTOP_SCALE),
    glow: { w: 0.95, d: 3.3 },
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

// Lenovo ThinkCentre M720q Tiny (179 x 183 x 34.5 mm), drawn from photos:
// a matte black slab with a honeycomb of vent holes across the top of the
// front and down its right side, a smooth port panel on the lower left
// (power button, mic and headphone jacks, USB-C, USB-A), a red Lenovo tab,
// the "ThinkCentre" wordmark, a Lenovo logo on the lid and the full rear
// port row. The front faces +z, towards the camera.
function roundedSlab(W, D, H, r, bevel = 0.008) {
  const w = W / 2, d = D / 2;
  const sh = new THREE.Shape();
  sh.moveTo(-w + r, -d); sh.lineTo(w - r, -d); sh.quadraticCurveTo(w, -d, w, -d + r);
  sh.lineTo(w, d - r); sh.quadraticCurveTo(w, d, w - r, d); sh.lineTo(-w + r, d);
  sh.quadraticCurveTo(-w, d, -w, d - r); sh.lineTo(-w, -d + r); sh.quadraticCurveTo(-w, -d, -w + r, -d);
  const g = new THREE.ExtrudeGeometry(sh, {
    depth: Math.max(0.001, H - 2 * bevel), bevelEnabled: true, bevelThickness: bevel,
    bevelSize: bevel, bevelSegments: 2, curveSegments: 6,
  });
  g.rotateX(-Math.PI / 2);          // shape y -> -z, extrusion -> +y
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox.min.y, 0);
  return g;
}

let _m720Tex = null;
function m720qTextures() {
  if (_m720Tex) return _m720Tex;
  const holes = (x, x0, x1, y0, y1, pitch, rad, skip) => {
    let row = 0;
    for (let y = y0; y < y1; y += pitch * 0.866, row++) {
      for (let px = x0 + (row % 2 ? pitch / 2 : 0); px < x1; px += pitch) {
        if (skip && skip(px, y)) continue;
        x.beginPath(); x.arc(px, y, rad, 0, Math.PI * 2); x.fill();
      }
    }
  };
  // front face: 1600 x 304 (1.0 x 0.19)
  const front = canvasTex(1600, 304, (x, w, h) => {
    x.fillStyle = "#1a1b1e"; x.fillRect(0, 0, w, h);
    x.fillStyle = "#050506";
    const inPanel = (px, py) => px > 28 && px < 884 && py > 138;
    holes(x, 20, w - 20, 22, h - 14, 24, 7.2, inPanel);
    // the smooth port panel on the lower left
    x.fillStyle = "#222327"; x.beginPath(); x.roundRect(26, 134, 862, 146, 10); x.fill();
    x.strokeStyle = "#0d0e10"; x.lineWidth = 3; x.stroke();
    // power button and its LED ring
    x.fillStyle = "#0a0a0c"; x.beginPath(); x.arc(150, 214, 52, 0, 7); x.fill();
    x.strokeStyle = "#3a3c42"; x.lineWidth = 4; x.stroke();
    x.fillStyle = "#16171a"; x.beginPath(); x.arc(150, 214, 40, 0, 7); x.fill();
    x.strokeStyle = "#8d9097"; x.lineWidth = 5; x.beginPath(); x.arc(150, 214, 15, -2.4, 0.9 + 2.4 - 0.4 + Math.PI * 0.35); x.stroke();
    x.beginPath(); x.moveTo(150, 190); x.lineTo(150, 211); x.stroke();
    // 3.5 mm jacks
    for (const jx of [372, 484]) {
      x.fillStyle = "#050506"; x.beginPath(); x.arc(jx, 224, 25, 0, 7); x.fill();
      x.strokeStyle = "#7d8088"; x.lineWidth = 4; x.stroke();
      x.fillStyle = "#34363b"; x.beginPath(); x.arc(jx, 224, 11, 0, 7); x.fill();
    }
    x.fillStyle = "#9a9da4"; x.font = "bold 26px system-ui"; x.fillText("🎤", 354, 176);
    x.font = "bold 22px system-ui"; x.fillText("SS←", 568, 172); x.fillText("SS←", 744, 172);
    // USB-C
    x.fillStyle = "#050506"; x.beginPath(); x.roundRect(590, 202, 96, 40, 20); x.fill();
    x.strokeStyle = "#7d8088"; x.lineWidth = 4; x.stroke();
    x.fillStyle = "#2a2c31"; x.fillRect(610, 218, 56, 8);
    // USB-A
    x.fillStyle = "#c8cbd1"; x.fillRect(724, 196, 124, 52);
    x.fillStyle = "#08090b"; x.fillRect(732, 204, 108, 36);
    x.fillStyle = "#3b6fd8"; x.fillRect(740, 218, 92, 9);
    // wordmark
    x.fillStyle = "#f4f4f4"; x.font = "italic 700 74px system-ui, sans-serif";
    x.fillText("ThinkCentre", 1180, 118);
  });
  front.anisotropy = 8;
  // rear: 1600 x 304
  const rear = canvasTex(1600, 304, (x, w, h) => {
    x.fillStyle = "#1a1b1e"; x.fillRect(0, 0, w, h);
    x.fillStyle = "#050506";
    holes(x, 24, 640, 24, 130, 24, 7.2);               // exhaust grille, upper left
    const port = (px, py, pw, ph, col, inner) => {
      x.fillStyle = "#050506"; x.fillRect(px - 5, py - 5, pw + 10, ph + 10);
      x.fillStyle = col; x.fillRect(px, py, pw, ph);
      if (inner) { x.fillStyle = inner; x.fillRect(px + 8, py + ph * 0.42, pw - 16, ph * 0.22); }
    };
    port(70, 196, 92, 54, "#d6a700");                    // power barrel (slim tip)
    port(228, 200, 120, 46, "#101114");                  // DisplayPort
    port(410, 198, 96, 52, "#9aa0a8", "#050506");        // USB-A
    port(566, 200, 120, 46, "#101114");                  // HDMI
    port(748, 198, 96, 52, "#9aa0a8", "#050506");        // USB-A
    port(900, 198, 96, 52, "#2a62d4", "#08090b");        // USB 3.1 Gen 2
    port(1054, 198, 96, 52, "#2a62d4", "#08090b");
    port(1240, 186, 100, 78, "#8c9199", "#050506");      // RJ45
    x.fillStyle = "#d9dce2"; x.beginPath(); x.roundRect(1380, 40, 170, 80, 6); x.fill();
    x.fillStyle = "#101114"; x.font = "bold 20px system-ui"; x.fillText("S/N", 1392, 72); // label
  });
  // lid: 1024 x 1024 (1.0 x 1.02) with the vertical Lenovo logo
  const lid = canvasTex(1024, 1024, (x, w, h) => {
    x.fillStyle = "#1c1d20"; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) {
      const v = 26 + Math.random() * 22;
      x.fillStyle = `rgb(${v},${v},${v + 2})`; x.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    x.save(); x.translate(w * 0.86, h * 0.34); x.rotate(Math.PI / 2);
    x.fillStyle = "#f4f4f4"; x.font = "italic 800 92px system-ui, sans-serif";
    x.textAlign = "center"; x.fillText("lenovo", 0, 0);
    x.restore();
    // Intel Core sticker, top left
    x.fillStyle = "#e7eaf0"; x.fillRect(64, 70, 150, 150);
    x.fillStyle = "#1d5fb4"; x.fillRect(64, 70, 150, 54);
    x.fillStyle = "#fff"; x.font = "bold 36px system-ui"; x.fillText("intel", 92, 112);
    x.fillStyle = "#1d5fb4"; x.font = "bold 30px system-ui"; x.fillText("CORE i5", 78, 176);
  });
  for (const t of [front, rear, lid]) t.userData = { shared: true };
  _m720Tex = { front, rear, lid };
  return _m720Tex;
}

function buildMiniPc() {
  const group = new THREE.Group();
  const W = 1.0, D = 1.02, H = 0.205, FOOT = 0.012;
  const tex = m720qTextures();
  const grain = grainTexture();
  const shell = body(0x1b1c1f, { metalness: 0.15, roughness: 0.62, bumpMap: grain, bumpScale: 0.4 });
  const chassis = new THREE.Mesh(roundedSlab(W, D, H - FOOT, 0.045), shell);
  chassis.position.y = FOOT;
  group.add(chassis);
  // the seam between the lid and the chassis, as a shallow groove
  group.add(box(W + 0.004, 0.006, D + 0.004, body(0x050506), 0, FOOT + (H - FOOT) * 0.70, 0));
  for (const [fx, fz] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]]) {
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, FOOT, 14), body(0x0a0a0b, { roughness: 0.9, metalness: 0 }));
    foot.position.set(fx, FOOT / 2, fz);
    group.add(foot);
  }
  const faceH = H - FOOT - 0.03, faceY = FOOT + (H - FOOT) / 2 - 0.004;
  const faceMat = (map) => body(0xffffff, { map, roughness: 0.7, metalness: 0.1 });
  const front = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.03, faceH), faceMat(tex.front));
  front.position.set(0, faceY, D / 2 + 0.0105);
  const rear = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.03, faceH), faceMat(tex.rear));
  rear.rotation.y = Math.PI; rear.position.set(0, faceY, -D / 2 - 0.0105);
  const lid = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.02, D - 0.02), faceMat(tex.lid));
  lid.rotation.x = -Math.PI / 2; lid.position.set(0, H + 0.0015, 0);
  group.add(front, rear, lid);
  // red Lenovo tab standing proud of the front, next to the port panel
  const tab = box(0.034, 0.12, 0.014, body(0xd32323, { roughness: 0.45, metalness: 0.05 }), -0.5 + 0.585 * W, faceY - 0.005, D / 2 + 0.008);
  group.add(tab);
  // power button cap
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0235, 0.0235, 0.012, 20), body(0x0e0f11, { roughness: 0.4, metalness: 0.3 }));
  cap.rotation.x = Math.PI / 2; cap.position.set(-0.5 + 150 / 1600 * (W - 0.03) + 0.015, faceY + faceH * (0.5 - 214 / 304), D / 2 + 0.016);
  group.add(cap);
  const power = new THREE.Mesh(new THREE.CircleGeometry(0.006, 10), led(BAR_GOOD));
  power.position.set(cap.position.x + 0.047, cap.position.y + 0.014, D / 2 + 0.0135);
  group.add(power);

  // the usage bars glow along the front edge of the lid
  const bars = makeBars(0.7);
  bars.group.rotation.x = -Math.PI / 2;
  bars.group.position.set(-0.08, H + 0.006, D / 2 - 0.17);
  group.add(bars.group);
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

// A soft round falloff, so a glow on the floor has no hard edge.
let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  _glowTex = canvasTex(128, 128, (x, w, h) => {
    const g = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.45, "rgba(255,255,255,0.45)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  });
  _glowTex.userData = { shared: true };
  return _glowTex;
}

// ---- helpers -------------------------------------------------------------

function disposeTree(root) {
  root.traverse(o => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) {
      if (m.userData && m.userData.shared) continue;
      if (m.map && !(m.map.userData && m.map.userData.shared)) m.map.dispose();
      m.dispose();
    }
  });
}

// A name tag that also carries the node's pod summary: a health dot, the
// name, and "N pods" (or NOT READY), redrawn only when one of those changes.
function makeTag(scale = 1) {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 128;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const s = new THREE.Mesh(
    new THREE.PlaneGeometry(1.3 * scale, 0.325 * scale),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  s.userData.canvas = c;
  s.userData.key = "";
  return s;
}

function drawTag(tag, name, summary) {
  const key = name + "|" + (summary ? summary.text + summary.state : "");
  if (tag.userData.key === key) return;
  tag.userData.key = key;
  const c = tag.userData.canvas, x = c.getContext("2d");
  x.clearRect(0, 0, c.width, c.height);
  x.fillStyle = "rgba(10,16,24,0.82)";
  x.beginPath(); x.roundRect(4, 4, 504, 120, 28); x.fill();
  const dot = !summary ? "#64748b" : summary.state === "bad" ? "#ef4444" : summary.state === "warn" ? "#f59e0b" : "#22c55e";
  x.fillStyle = dot;
  x.beginPath(); x.arc(46, 64, 16, 0, Math.PI * 2); x.fill();
  x.fillStyle = "#e6edf5";
  x.font = "700 54px system-ui, sans-serif";
  x.textAlign = "left"; x.textBaseline = "middle";
  x.fillText(name, 78, 66, summary ? 200 : 420);
  if (summary) {
    x.fillStyle = summary.state === "bad" ? "#fca5a5" : "#9fb3c8";
    x.font = "500 36px system-ui, sans-serif";
    x.textAlign = "right";
    x.fillText(summary.text, 490, 68, 200);
  }
  tag.material.map.needsUpdate = true;
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

  // ---- navigation overlay: prev / home / next, and a small info card
  const css = (n, text) => { n.style.cssText = text; return n; };
  const GLASS = "background:rgba(10,16,24,.82);border:1px solid rgba(140,170,200,.28);color:#e6edf5;backdrop-filter:blur(8px);";
  const navWrap = css(document.createElement("div"), "position:absolute;left:0;right:0;bottom:14px;display:flex;justify-content:center;pointer-events:none;z-index:3;");
  const pill = css(document.createElement("div"), "pointer-events:auto;display:flex;align-items:center;gap:2px;padding:4px;border-radius:999px;font:500 12px system-ui,sans-serif;" + GLASS);
  const navBtn = (text, aria, fn) => {
    const b = css(document.createElement("button"), "all:unset;box-sizing:border-box;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;cursor:pointer;font:600 18px/1 system-ui,sans-serif;color:#e6edf5;");
    b.type = "button"; b.textContent = text; b.setAttribute("aria-label", aria); b.title = aria;
    b.addEventListener("click", fn);
    b.addEventListener("pointerenter", () => { b.style.background = "rgba(140,170,200,.22)"; });
    b.addEventListener("pointerleave", () => { b.style.background = ""; });
    b.addEventListener("focus", () => { b.style.outline = "2px solid #38bdf8"; });
    b.addEventListener("blur", () => { b.style.outline = ""; });
    return b;
  };
  const navStatus = css(document.createElement("span"), "min-width:132px;text-align:center;padding:0 8px;white-space:nowrap;color:#b8c7d8;");
  pill.append(navBtn("\u2039", "Previous device (Left arrow)", () => step(-1)), navBtn("\u2302", "Whole room (Esc)", () => select(null)), navBtn("\u203A", "Next device (Right arrow)", () => step(1)));
  pill.insertBefore(navStatus, pill.children[2]);
  navWrap.appendChild(pill);
  container.appendChild(navWrap);

  const card = css(document.createElement("div"), "position:absolute;top:12px;right:12px;width:236px;display:none;padding:12px 14px;border-radius:12px;font:12px/1.45 system-ui,sans-serif;z-index:3;" + GLASS);
  container.appendChild(card);

  const scene = new THREE.Scene();
  scene.background = DAY_BG.clone();
  scene.fog = new THREE.FogExp2(DAY_BG.clone(), 0.012);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 140);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;               // prev/next/home move the view; no way to get lost
  controls.minPolarAngle = 0.4;
  controls.maxPolarAngle = 1.38;
  controls.minAzimuthAngle = -1.15;
  controls.maxAzimuthAngle = 1.15;
  controls.minDistance = 3;
  controls.maxDistance = 22;
  controls.rotateSpeed = 0.6;

  // Lighting: a window-style sun for the day, a cool lamp for the night.
  const hemi = new THREE.HemisphereLight(0xdfe9f5, 0xb8a58f, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
  sun.position.set(-6, 11, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -15; sun.shadow.camera.right = 15;
  sun.shadow.camera.top = 15; sun.shadow.camera.bottom = -15;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 40;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 4;
  scene.add(sun);
  const lamp = new THREE.SpotLight(0xbcd4ff, 0, 70, Math.PI / 3.2, 0.85, 1.3);
  lamp.position.set(0, 10, 9);
  lamp.target.position.set(0, 0, 0);
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
  scene.add(box(0.55, 0.55, 0.04, outletMat, 0, 0.9, WALL_Z + 0.04));
  scene.add(box(0.3, 0.12, 0.02, mat(0x4a5058, { metalness: 0 }), 0, 0.9, WALL_Z + 0.07));

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
  let trayFront = 1.2;
  const emptyTag = makeTag(1);
  drawTag(emptyTag, "No nodes reported", null);
  emptyTag.position.set(0, 0.9, 0.6);
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

  // ---- furniture: tray, pegs, switch, power strip. Everything is mirrored
  // about x = 0, so the room reads as one centred, balanced object.
  const geo = { half: 3, laneMax: LANE0, swZ: 2.2, swW: 1.8, front: 2.9, back: -1.6 };
  function buildFurniture() {
    for (const c of [...furniture.children]) { furniture.remove(c); disposeTree(c); }
    for (const c of [...swGroup.children]) { swGroup.remove(c); disposeTree(c); }
    swLeds.length = 0;

    const n = layout.perRow;
    const half = n * PITCH / 2 + TRAY_MARGIN;
    const laneMax = LANE0 + LANE_STEP * Math.floor(n / 2);
    const swW = Math.max(1.9, n * 0.2 + 0.8);
    const swZ = laneMax + 0.62;
    const front = swZ + 0.62;
    const back = -2.0 - (layout.rows - 1) * ROW_GAP;
    Object.assign(geo, { half, laneMax, swZ, swW, front, back });
    trayFront = front;

    const t = box(2 * half, 0.05, front - back, traySurface, 0, 0.025, (front + back) / 2);
    t.receiveShadow = true;
    furniture.add(t);
    const rimMat = mat(0x2a2d33, { metalness: 0.2, roughness: 0.5 });
    const D = front - back, cz = (front + back) / 2;
    furniture.add(box(2 * half, 0.04, 0.06, rimMat, 0, 0.07, front - 0.03), box(2 * half, 0.04, 0.06, rimMat, 0, 0.07, back + 0.03),
      box(0.06, 0.04, D, rimMat, -half + 0.03, 0.07, cz), box(0.06, 0.04, D, rimMat, half - 0.03, 0.07, cz));

    // the black pegs between laptops, front and back
    for (let r = 0; r < layout.rows; r++) {
      const inRow = Math.min(layout.perRow, layout.trayCount - r * layout.perRow);
      for (let i = 0; i <= inRow; i++) {
        const px = (i - inRow / 2) * PITCH;
        for (const [pz, ph] of [[0.85, 1.0], [-0.65, 0.85]]) {
          const p = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.055, ph, 12), peg);
          p.position.set(px, 0.05 + ph / 2, pz - r * ROW_GAP);
          furniture.add(p);
        }
      }
    }

    // the switch, centred in front of the row: status LEDs face the viewer,
    // the cables plug in at the back
    swGroup.position.set(0, 0.05, swZ);
    swGroup.add(box(swW, 0.24, 0.62, mat(0x1a1d22, { metalness: 0.5, roughness: 0.45 }), 0, 0.12, 0));
    const pp = portPitch(n, swW);
    for (let k = 0; k < n; k++) {
      const x = (k - (n - 1) / 2) * pp;
      const m = led(BAR_GOOD);
      const l = new THREE.Mesh(new THREE.CircleGeometry(0.026, 10), m);
      l.position.set(x, 0.15, 0.312);
      swGroup.add(l);
      swLeds.push(m);
      swGroup.add(box(Math.min(0.12, pp * 0.7), 0.06, 0.012, mat(0x050607), x, 0.075, 0.312));
    }

    // wall shelves for the devices that are not laptop-shaped: one plank per
    // shelf, centred, on two brackets each
    const plank = mat(0x2a2d33, { metalness: 0.2, roughness: 0.55 });
    for (let sh = 0; sh < (layout.shelves || 0); sh++) {
      const inShelf = Math.min(PER_SHELF, layout.benchCount - sh * PER_SHELF);
      const w = (inShelf - 1) * SHELF_PITCH + 4.0;
      const y = SHELF_Y + sh * SHELF_GAP;
      furniture.add(box(w, 0.1, 2.1, plank, 0, y - 0.05, SHELF_Z));
      for (const sx of [-1, 1]) {
        furniture.add(box(0.1, 0.7, 0.05, plank, sx * (w / 2 - 0.4), y - 0.45, WALL_Z + 0.06));
        furniture.add(box(0.1, 0.05, 1.5, plank, sx * (w / 2 - 0.4), y - 0.12, WALL_Z + 0.75));
      }
    }

    // power strip and cords: centred behind the row, running up to the outlet
    furniture.add(box(1.1, 0.1, 0.36, mat(0xeceef0, { metalness: 0, roughness: 0.5 }), 0, 0.1, back + 0.45));
    const cordMat = new THREE.MeshStandardMaterial({ color: 0xf1f2f3, roughness: 0.6 });
    for (const sgn of [-1, 1]) {
      const pts = [
        new THREE.Vector3(sgn * 0.45, 0.1, back + 0.45),
        new THREE.Vector3(sgn * 0.7, 0.06, back - 0.2),
        new THREE.Vector3(sgn * 0.45, 0.07, back - 1.0),
        new THREE.Vector3(sgn * 0.16, 0.5, WALL_Z + 0.2 - tray.position.z),
        new THREE.Vector3(sgn * 0.1, 0.9, WALL_Z + 0.1 - tray.position.z),
      ];
      furniture.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, 0.03, 6, false), cordMat));
    }
    furniture.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    swGroup.traverse(o => { if (o.isMesh) o.castShadow = true; });
  }
  function portPitch(n, swW) { return Math.min(0.24, (swW - 0.6) / Math.max(1, n - 1)); }

  // ---- node entries
  function createEntry(name) {
    const root = new THREE.Group();
    const e = {
      name, root, kind: null, model: null, cur: null, target: null,
      podInfo: null, glow: null, tag: makeTag(0.47), cable: null, pulses: [],
      lift: 0, bob: Math.random() * 6, slot: null, curve: null, builtFor: null, cableDirty: false,
    };
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
    if (kind !== "laptop" && kind !== "generic") e.model.group.scale.setScalar(DEVICE_SCALE);
    e.model.group.traverse(o => { o.userData.entry = e; if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    e.root.add(e.model.group);
    return true;
  }

  // One lane per cable, mirrored about the centre line so none cross. A
  // cable leaves its jack, drops to its lane in front of the tray, runs
  // toward the middle, then turns up to the back of the centred switch.
  // Laptops further from the middle take outer lanes and outer ports, which
  // is exactly what keeps the runs from crossing.
  function buildCable(e) {
    if (e.cable) { tray.remove(e.cable); disposeTree(e.cable); }
    e.cable = null; e.curve = null; e.pulses = [];
    if (!e.model || !e.model.jack) return;
    const n = Math.max(1, layout.perRow);
    const col = e.slot.index % layout.perRow;
    const u = col - (n - 1) / 2;                   // signed distance from the middle
    const x = e.root.position.x, z0 = e.root.position.z;
    const j = e.model.jack;
    const y0 = 0.05 + j.y, zj = z0 + j.z;
    const laneZ = z0 + LANE0 + LANE_STEP * Math.abs(u);
    const portX = u * portPitch(n, geo.swW);
    const swBack = geo.swZ - 0.31 - z0;
    const dir = Math.sign(portX - x) || 1;         // toward the middle
    const r = 0.12;                                // corner rounding
    const pts = [
      new THREE.Vector3(x, y0, zj),
      new THREE.Vector3(x, y0 - 0.03, zj + 0.1),
      new THREE.Vector3(x, 0.22, laneZ - 0.16),
      new THREE.Vector3(x, 0.09, laneZ - r * 0.45),
      new THREE.Vector3(x + dir * r, 0.075, laneZ),
      new THREE.Vector3(portX - dir * r, 0.075, laneZ),
      new THREE.Vector3(portX, 0.085, laneZ + r),
      new THREE.Vector3(portX, 0.14, swBack - 0.1),
      new THREE.Vector3(portX, 0.16, swBack),
    ];
    if (Math.abs(portX - x) < 2 * r) { pts.splice(4, 2, new THREE.Vector3((x + portX) / 2, 0.075, laneZ)); }
    e.curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(e.curve, 110, 0.024, 8, false),
      new THREE.MeshStandardMaterial({ color: 0xf2f3f4, roughness: 0.5, metalness: 0 }));
    tube.castShadow = true;
    const g = new THREE.Group();
    g.add(tube);
    for (let i = 0; i < 2; i++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x38bdf8).multiplyScalar(HOT) }));
      p.userData.phase = i / 2;
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
    if (e.glow) { e.root.remove(e.glow); disposeTree(e.glow); }
    if (selected === e.name) select(null, true);
    if (hovered === e) { hovered = null; label.style.display = "none"; }
  }

  // Pods are summarised on the name tag and listed in the hover label; the
  // scene itself stays free of floating markers.
  function syncPods(e, info) {
    e.podInfo = info || { total: 0, unhealthy: 0, pods: [] };
    const down = e.target && !e.target.ready;
    const unhealthy = e.podInfo.unhealthy;
    drawTag(e.tag, e.name, {
      text: down ? "DOWN" : e.podInfo.total + (e.podInfo.total === 1 ? " pod" : " pods"),
      state: down || unhealthy > 0 && unhealthy * 4 >= e.podInfo.total ? "bad" : unhealthy > 0 ? "warn" : "ok",
    });
  }

  // A node with a problem (down, or running unhealthy pods) gets a pulsing
  // red glow on the floor under it: visible from across the room, and part
  // of the scene rather than something hovering in it.
  function syncAlert(e, bad) {
    if (bad && !e.glow) {
      const sz = e.model && e.model.glow ? e.model.glow : { w: 1.8, d: 1.8 };
      const g = new THREE.Mesh(new THREE.PlaneGeometry(sz.w * 1.7, sz.d * 1.25), new THREE.MeshBasicMaterial({
        color: 0xef4444, map: glowTexture(), transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      g.rotation.x = -Math.PI / 2;
      g.position.y = 0.012;
      e.glow = g;
      e.root.add(g);
    } else if (!bad && e.glow) {
      e.root.remove(e.glow); disposeTree(e.glow); e.glow = null;
    }
  }

  // ---- public: update
  function update(snap) {
    const nodes = (snap && snap.nodes) || [];
    layout = layoutRoom(nodes);
    const byName = new Map(nodes.map(n => [n.name, n]));
    const key = `${layout.trayCount}:${layout.benchCount}:${layout.perRow}:${layout.rows}:${layout.shelves}`;
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
      e.root.position.set(slot.x, slot.y, slot.z);
      // name plate lying on the tray's front rim (or the floor in front of a
      // bench device), tilted back toward the viewer
      e.tag.rotation.x = -1.05;
      e.tag.position.set(0, slot.bench ? -0.035 : -0.035, (slot.bench ? 1.15 : trayFront - slot.z + 0.22));
      if (isNew || rebuilt || e.cableDirty || oldIndex !== slot.index || oldX !== slot.x || oldZ !== slot.z) {
        buildCable(e);
        e.cableDirty = false;
      }
      e.target = nodeIndicators(n);
      e.info = n;
      if (isNew) e.cur = { ...e.target };
      syncPods(e, pods.get(slot.name));
      syncAlert(e, !e.target.ready || (e.podInfo && e.podInfo.unhealthy > 0));
    }
    for (const [name, e] of [...entries]) {
      if (!seen.has(name)) { removeEntry(e); entries.delete(name); }
    }
    alert = roomAlert(snap);
    if (hovered) showLabel(hovered);
    if (selected && !entries.has(selected)) select(null, true);
    renderCard();
    updateNavStatus();
  }

  // ---- camera
  const home = { pos: new THREE.Vector3(3.6, 4.2, 8), target: new THREE.Vector3(0, 0.55, 0) };
  let anim = null;
  let flyIn = motion ? { t0: null, dur: 1.8 } : null;
  function flyStart(out) { return out.set(home.pos.x * 1.6, home.pos.y + 9, home.pos.z * 1.7); }
  function frameCamera() {
    // look at the middle of the room from straight ahead, close enough that
    // the models read, far enough to take in the tray and any wall shelves
    const halfW = Math.max(layout.reach || 0, layout.half || 3) + 0.4;
    const depth = (layout.rows - 1) * ROW_GAP;
    const top = layout.shelves ? SHELF_Y + (layout.shelves - 1) * SHELF_GAP + 1.6 : 2.2;
    const d = Math.max(8.4, halfW * 1.15 + 2.2 + depth * 0.4, top * 1.75);
    home.target.set(0, Math.max(0.8, top * 0.38), 0.95 - depth * 0.3);
    home.pos.set(0, 1.5 + d * 0.36, home.target.z + d * 0.92);
    controls.maxDistance = Math.max(14, d * 1.9);
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
      const far = e.slot && e.slot.bench ? 6.2 : 5.2;
      glide(_w.clone().addScaledVector(dir, far).add(new THREE.Vector3(0, 1.8, 0)), _w.clone().add(new THREE.Vector3(0, 0.8, 0)));
    } else {
      glide(home.pos, home.target);
    }
    if (e && e.model && e.model.glow) selGlow.scale.set(e.model.glow.w * 1.7, e.model.glow.d * 1.25, 1);
    else selGlow.scale.set(2.2, 2.2, 1);
    selGlow.visible = !!e;
    renderCard();
    updateNavStatus();
    if (!silent && opts.onSelect) opts.onSelect(selected);
  }

  function showLabel(e) {
    const ind = e.target || {};
    const pi = e.podInfo || { total: 0, unhealthy: 0 };
    label.textContent = `${e.name}${ind.ready === false ? "  · NOT READY" : ""}\n` +
      `CPU ${pct(ind.cpu)}   MEM ${pct(ind.mem)}   DISK ${pct(ind.disk)}\n` +
      `${pi.total} pods${pi.unhealthy ? `, ${pi.unhealthy} unhealthy` : ""}`;
    label.style.display = "block";
  }

  // A soft cyan glow under the selected device.
  const selGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
    color: new THREE.Color(0x38bdf8).multiplyScalar(1.4), map: glowTexture(), transparent: true, opacity: 0.0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  selGlow.rotation.x = -Math.PI / 2;
  selGlow.visible = false;
  scene.add(selGlow);

  function updateNavStatus() {
    const names = layout.slots.map(sl => sl.name);
    navStatus.textContent = selected && names.includes(selected)
      ? `${selected} · ${names.indexOf(selected) + 1} of ${names.length}`
      : names.length ? `${names.length} device${names.length === 1 ? "" : "s"}` : "No devices";
  }

  function step(dir) {
    const names = layout.slots.map(sl => sl.name).filter(n => entries.has(n));
    if (!names.length) return;
    const i = selected ? names.indexOf(selected) : (dir > 0 ? -1 : 0);
    select(names[(i + dir + names.length) % names.length]);
  }

  const cardRow = (label, frac, text) => {
    const row = css(document.createElement("div"), "display:grid;grid-template-columns:34px 1fr 38px;align-items:center;gap:8px;margin-top:5px;");
    const l = css(document.createElement("span"), "color:#8fa3b8;"); l.textContent = label;
    const track = css(document.createElement("span"), "height:6px;border-radius:3px;background:rgba(140,170,200,.18);overflow:hidden;display:block;");
    const fill = css(document.createElement("span"), `display:block;height:100%;border-radius:3px;width:${frac == null ? 0 : Math.round(frac * 100)}%;background:${frac == null ? "transparent" : frac < 0.6 ? "#22c55e" : frac < 0.85 ? "#f59e0b" : "#ef4444"};`);
    track.appendChild(fill);
    const v = css(document.createElement("span"), "text-align:right;font-variant-numeric:tabular-nums;"); v.textContent = text;
    row.append(l, track, v);
    return row;
  };

  function renderCard() {
    const e = selected ? entries.get(selected) : null;
    if (!e || !e.target) { card.style.display = "none"; return; }
    const ind = e.target, n = e.info || {}, pi = e.podInfo || { total: 0, unhealthy: 0 };
    const head = css(document.createElement("div"), "display:flex;align-items:center;gap:8px;");
    const dotColor = !ind.ready ? "#ef4444" : pi.unhealthy ? "#f59e0b" : "#22c55e";
    const dot = css(document.createElement("span"), `width:9px;height:9px;border-radius:50%;background:${dotColor};flex:none;`);
    const title = css(document.createElement("strong"), "font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
    title.textContent = n.displayName || e.name;
    const close = navBtn("\u00d7", "Close (Esc)", () => select(null));
    close.style.width = close.style.height = "26px";
    head.append(dot, title, close);
    const sub = css(document.createElement("div"), "color:#8fa3b8;margin:2px 0 6px 17px;");
    sub.textContent = [ind.ready ? "Ready" : "Not ready", n.deviceModel || n.deviceClass, n.internalIP].filter(Boolean).join(" · ");
    const rows = [
      cardRow("CPU", ind.cpu, pct(ind.cpu)), cardRow("Mem", ind.mem, pct(ind.mem)), cardRow("Disk", ind.disk, pct(ind.disk)),
    ];
    if (ind.battery != null) rows.push(cardRow("Batt", ind.battery, pct(ind.battery) + (ind.charging ? "\u26a1" : "")));
    const foot = css(document.createElement("div"), "margin-top:9px;color:#b8c7d8;");
    foot.textContent = `${ind.tempC == null ? "\u2014" : Math.round(ind.tempC) + "\u00b0C"} \u00b7 ${pi.total} pod${pi.total === 1 ? "" : "s"}${pi.unhealthy ? `, ${pi.unhealthy} unhealthy` : ""}`;
    const more = css(document.createElement("button"), "all:unset;box-sizing:border-box;cursor:pointer;margin-top:10px;width:100%;text-align:center;padding:7px;border-radius:8px;background:rgba(56,189,248,.16);color:#7dd3fc;font-weight:600;");
    more.type = "button"; more.textContent = "Open details";
    more.addEventListener("click", () => { if (opts.onDetails) opts.onDetails(e.name); });
    card.replaceChildren(head, sub, ...rows, foot, more);
    card.style.display = "block";
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
  function onKey(ev) {
    if (!visible || document.querySelector("dialog[open]")) return;
    const tag = ev.target && ev.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (ev.key === "Escape" && selected) select(null);
    else if (ev.key === "ArrowRight") { step(1); ev.preventDefault(); }
    else if (ev.key === "ArrowLeft") { step(-1); ev.preventDefault(); }
  }
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
    }
    controls.update();

    // look: day <-> night, plus the alert tint
    night += (nightTarget - night) * Math.min(1, dt * 2.5);
    alertMix += ((alert !== "ok" ? 1 : 0) - alertMix) * Math.min(1, dt * 2);
    alertCol.lerp(ALERT_TINT[alert], Math.min(1, dt * 3));
    bgNight.lerp(NIGHT_BG[alert], Math.min(1, dt * 2));
    sun.intensity = lerp(2.6, 0, night);
    hemi.intensity = lerp(1.1, 0.55, night);
    hemi.color.setHex(0xdfe9f5).lerp(tmpA.setHex(0x2a3f5c), night);
    hemi.groundColor.setHex(0xb8a58f).lerp(tmpA.setHex(0x0a0d12), night);
    lamp.intensity = lerp(0, 250, night);
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
      if (e.cable) e.cable.children[0].material.color.setHex(0xf2f3f4).lerp(CABLE_NIGHT, night);

      const targetLift = e === hovered || e.name === selected ? 0.07 : 0;
      e.lift += (targetLift - e.lift) * k;
      e.model.group.position.y = e.lift;

      if (e.glow) e.glow.material.opacity = motion ? 0.28 + 0.22 * Math.sin(t * 3.2) : 0.4;
      if (motion && e.curve) {
        const speed = 0.1 + (c.cpu == null ? 0 : c.cpu) * 0.6;
        for (const p of e.pulses) {
          p.userData.phase = (p.userData.phase + dt * speed) % 1;
          p.position.copy(e.curve.getPoint(p.userData.phase));
          p.visible = c.ready;
        }
      }
    }
    swLeds.forEach((m, i) => {
      const on = motion ? Math.sin(t * 7 + i * 1.7) > -0.2 : true;
      m.color.copy(BAR_GOOD).multiplyScalar(on ? 1 : 0.15);
    });

    if (selected && entries.has(selected)) {
      const se = entries.get(selected);
      se.root.getWorldPosition(_w);
      selGlow.position.set(_w.x, 0.016, _w.z);
      selGlow.rotation.z = -YAW;
      selGlow.material.opacity = motion ? 0.55 + 0.15 * Math.sin(t * 2.4) : 0.6;
    }

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

  // Park the camera on the home view turned by `azimuth` radians about the
  // vertical, optionally raised or lowered. Used for stills and recordings,
  // where the camera has to be somewhere exact rather than wherever a person
  // dragged it.
  function pose({ azimuth = 0, elevation = 0 } = {}) {
    flyIn = null; anim = null; selected = null;
    const off = home.pos.clone().sub(home.target);
    const r = Math.hypot(off.x, off.z);
    const a = Math.atan2(off.x, off.z) + azimuth;
    camera.position.set(home.target.x + Math.sin(a) * r, home.pos.y + elevation, home.target.z + Math.cos(a) * r);
    controls.target.copy(home.target);
    controls.update();
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
    navWrap.remove();
    card.remove();
  }

  resize();
  update({ nodes: [] });
  setRunning();
  return { update, select, setVisible, setDark, pose, dispose, get selected() { return selected; } };
}
