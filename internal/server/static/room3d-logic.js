// Pure logic for the 3D room: no WebGL, no DOM, so plain `node` can test it.
// The one rule carried over from the cards: unknown stays unknown. A null
// reading comes out as null, never as 0, so the renderer can draw "no data"
// instead of a confident empty bar.

const MODELS = {
  laptop: "laptop", tablet: "laptop",
  desktop: "minipc", "all-in-one": "minipc", "mini-pc": "minipc", "stick-pc": "minipc",
  sbc: "sbc", embedded: "sbc",
  server: "server",
  vm: "vm",
};

export function modelFor(deviceClass) {
  if (typeof deviceClass !== "string") return "generic";
  return MODELS[deviceClass.toLowerCase()] || "generic";
}

// Percent (0..100, possibly absurd) -> fraction 0..1, or null if unknown.
function fraction(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v / 100));
}

export function nodeIndicators(node) {
  const n = node || {};
  const bat = n.battery || null;
  const temp = typeof n.tempC === "number" && Number.isFinite(n.tempC) ? n.tempC : null;
  const status = bat && typeof bat.status === "string" ? bat.status.toLowerCase() : null;
  return {
    ready: n.ready === true,
    cpu: fraction(n.cpuPercent),
    mem: fraction(n.memPercent),
    disk: fraction(n.diskPercent),
    tempC: temp,
    battery: bat ? fraction(bat.percent) : null,
    charging: bat ? (status ? status === "charging" : (typeof bat.acOnline === "boolean" ? bat.acOnline : null)) : null,
  };
}

// Pods grouped by node name. Pods with no node (Pending, unscheduled) are
// left out: there is nowhere in the room to put them.
export function podsByNode(snapshot) {
  const out = new Map();
  for (const p of (snapshot && snapshot.pods) || []) {
    if (!p || !p.node) continue;
    let g = out.get(p.node);
    if (!g) { g = { total: 0, unhealthy: 0, pods: [] }; out.set(p.node, g); }
    g.total++;
    if (!p.healthy) g.unhealthy++;
    g.pods.push({ namespace: p.namespace, name: p.name, healthy: !!p.healthy, restarts: p.restarts || 0 });
  }
  return out;
}

// "bad" if a node is down, "warn" if anything is unhealthy or warning, else "ok".
export function roomAlert(snapshot) {
  const s = snapshot || {};
  if ((s.nodes || []).some(n => n && n.ready === false)) return "bad";
  const unhealthy = (s.workloads || []).some(w => w && w.healthy === false) ||
    (s.pods || []).some(p => p && p.healthy === false);
  if (unhealthy || (s.events || []).length > 0) return "warn";
  return "ok";
}

// Placement mirrors the physical setup: laptops stand on edge side by side in
// one black tray (twelve to a row, extra rows behind).
export const PITCH = 0.7;        // distance between neighbouring laptops
export const ROW_LENGTH = 12;    // laptops per tray row
export const ROW_GAP = 4.4;      // distance between tray rows
export const SHELF_PITCH = 4.1;  // distance between devices on the wall shelf
export const PER_SHELF = 5;      // devices per shelf
export const SHELF_Y = 3.1;      // height of the lowest shelf
export const SHELF_GAP = 2.5;    // distance between shelves
export const SHELF_Z = -3.9;     // shelves hang on the back wall
export const TRAY_MARGIN = 0.8;  // tray overhang past the first/last laptop

export function inTray(deviceClass) {
  const m = modelFor(deviceClass);
  return m === "laptop" || m === "generic";
}

// Mini PCs stand on the floor in front of the tray, where the switch used to be.
export function onFloor(deviceClass) {
  return modelFor(deviceClass) === "minipc";
}

export const FLOOR_PITCH = 2.3;  // distance between neighbouring floor devices

// Everything is mirrored about x = 0. Laptops stand in one centred tray; mini
// PCs stand on the floor in front of it; the network switch has the lowest
// wall shelf to itself (the room draws it), and anything else that is not
// laptop-shaped sits on the shelves above that, centred. Deterministic and
// independent of input order: by name, numbers in numeric order.
export function layoutRoom(nodes) {
  const sorted = [...(nodes || [])].sort((a, b) =>
    String(a.name).localeCompare(String(b.name), "en", { numeric: true }));
  const tray = sorted.filter(n => inTray(n.deviceClass));
  const floor = sorted.filter(n => onFloor(n.deviceClass));
  const bench = sorted.filter(n => !inTray(n.deviceClass) && !onFloor(n.deviceClass));
  const perRow = Math.min(ROW_LENGTH, Math.max(1, tray.length));
  const half = perRow * PITCH / 2 + TRAY_MARGIN;
  const slots = [];
  tray.forEach((n, i) => {
    const row = Math.floor(i / ROW_LENGTH), col = i % ROW_LENGTH;
    slots.push({ name: n.name, bench: false, index: i, row, x: (col - (perRow - 1) / 2) * PITCH, y: 0.05, z: -row * ROW_GAP });
  });
  floor.forEach((n, j) => {
    slots.push({ name: n.name, bench: false, floor: true, index: tray.length + j, row: 0, x: (j - (floor.length - 1) / 2) * FLOOR_PITCH, y: 0.05, z: 0 });
  });
  const shelves = 1 + Math.ceil(bench.length / PER_SHELF);   // shelf 0 holds the switch
  bench.forEach((n, j) => {
    const shelf = 1 + Math.floor(j / PER_SHELF), col = j % PER_SHELF;
    const inShelf = Math.min(PER_SHELF, bench.length - (shelf - 1) * PER_SHELF);
    slots.push({ name: n.name, bench: true, index: tray.length + floor.length + j, row: 0, shelf, x: (col - (inShelf - 1) / 2) * SHELF_PITCH, y: SHELF_Y + shelf * SHELF_GAP, z: SHELF_Z });
  });
  const shelfHalf = bench.length ? (Math.min(PER_SHELF, bench.length) - 1) / 2 * SHELF_PITCH + 1.9 : 0;
  return {
    slots, trayCount: tray.length, floorCount: floor.length, benchCount: bench.length, perRow, shelves,
    rows: Math.max(1, Math.ceil(tray.length / ROW_LENGTH)), half, reach: Math.max(half, shelfHalf),
  };
}
