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

// Deterministic placement, independent of input order: control plane first,
// then by name. Nodes fill racks of four shelves; racks sit in a row.
export const SHELVES_PER_RACK = 4;
export const RACK_SPACING = 3.2;

export function layoutPositions(nodes) {
  const sorted = [...(nodes || [])].sort((a, b) =>
    (b.controlPlane === true) - (a.controlPlane === true) || String(a.name).localeCompare(String(b.name)));
  const racks = Math.max(1, Math.ceil(sorted.length / SHELVES_PER_RACK));
  return sorted.map((n, i) => {
    const rack = Math.floor(i / SHELVES_PER_RACK);
    return {
      name: n.name,
      x: (rack - (racks - 1) / 2) * RACK_SPACING,
      z: 0,
      shelf: i % SHELVES_PER_RACK,
    };
  });
}
