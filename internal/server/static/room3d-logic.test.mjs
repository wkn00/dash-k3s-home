import test from "node:test";
import assert from "node:assert/strict";
import { modelFor, nodeIndicators, podsByNode, roomAlert, layoutRoom, PITCH } from "./room3d-logic.js";

test("modelFor maps every device class the backend emits", () => {
  const want = { laptop: "laptop", tablet: "laptop", desktop: "minipc", "all-in-one": "minipc",
    "mini-pc": "minipc", "stick-pc": "minipc", sbc: "sbc", embedded: "sbc", server: "server", vm: "vm" };
  for (const [k, v] of Object.entries(want)) assert.equal(modelFor(k), v, k);
});

test("modelFor falls back to generic for null, empty, unknown and non-strings", () => {
  for (const v of [null, undefined, "", "toaster", 7, {}]) assert.equal(modelFor(v), "generic");
});

test("nodeIndicators keeps null as null, never 0", () => {
  const i = nodeIndicators({ ready: true, cpuPercent: null, memPercent: null, diskPercent: null, tempC: null, battery: null });
  assert.deepEqual(i, { ready: true, cpu: null, mem: null, disk: null, tempC: null, battery: null, charging: null });
});

test("nodeIndicators handles an entirely empty or missing node", () => {
  assert.equal(nodeIndicators(undefined).cpu, null);
  assert.equal(nodeIndicators({}).ready, false);
});

test("nodeIndicators clamps and rejects NaN/Infinity", () => {
  const i = nodeIndicators({ cpuPercent: 250, memPercent: -5, diskPercent: NaN, tempC: Infinity });
  assert.equal(i.cpu, 1);
  assert.equal(i.mem, 0);
  assert.equal(i.disk, null);
  assert.equal(i.tempC, null);
});

test("nodeIndicators reads battery and charging", () => {
  const a = nodeIndicators({ battery: { percent: 80, status: "Charging", acOnline: true } });
  assert.equal(a.battery, 0.8); assert.equal(a.charging, true);
  const b = nodeIndicators({ battery: { percent: 20, status: "Discharging", acOnline: false } });
  assert.equal(b.charging, false);
  const c = nodeIndicators({ battery: { percent: null, status: null, acOnline: null } });
  assert.equal(c.battery, null); assert.equal(c.charging, null);
});

test("podsByNode groups, counts unhealthy, skips unscheduled", () => {
  const m = podsByNode({ pods: [
    { node: "a", namespace: "x", name: "p1", healthy: true, restarts: 0 },
    { node: "a", namespace: "x", name: "p2", healthy: false, restarts: 3 },
    { node: "", namespace: "x", name: "p3", healthy: false },
    { node: "b", namespace: "y", name: "p4", healthy: true },
  ]});
  assert.equal(m.get("a").total, 2);
  assert.equal(m.get("a").unhealthy, 1);
  assert.equal(m.get("b").total, 1);
  assert.equal(m.size, 2);
});

test("podsByNode tolerates empty / missing snapshot", () => {
  assert.equal(podsByNode(null).size, 0);
  assert.equal(podsByNode({}).size, 0);
});

test("roomAlert", () => {
  assert.equal(roomAlert({}), "ok");
  assert.equal(roomAlert({ nodes: [{ ready: true }], pods: [], events: [] }), "ok");
  assert.equal(roomAlert({ nodes: [{ ready: false }] }), "bad");
  assert.equal(roomAlert({ workloads: [{ healthy: false }] }), "warn");
  assert.equal(roomAlert({ events: [{}] }), "warn");
});

test("layoutRoom is deterministic and order independent, control plane first", () => {
  const nodes = [{ name: "wk3", deviceClass: "laptop" }, { name: "wk0", controlPlane: true, deviceClass: "laptop" },
    { name: "wk1", deviceClass: "laptop" }, { name: "wk2" }];
  const a = layoutRoom(nodes);
  const b = layoutRoom([...nodes].reverse());
  assert.deepEqual(a, b);
  assert.equal(a.slots[0].name, "wk0");
  assert.equal(a.trayCount, 4); // an unknown class is laptop-shaped by default
  assert.equal(a.benchCount, 0);
});

test("layoutRoom spaces tray laptops by PITCH and centres the row", () => {
  const nodes = ["a", "b", "c"].map(name => ({ name, deviceClass: "laptop" }));
  const { slots } = layoutRoom(nodes);
  assert.ok(Math.abs(slots[1].x - slots[0].x - PITCH) < 1e-9);
  assert.ok(Math.abs(slots[0].x + slots[2].x) < 1e-9);
});

test("layoutRoom puts non-laptops on the bench and starts a second tray row after twelve", () => {
  const nodes = [{ name: "srv", deviceClass: "server" }, { name: "pi", deviceClass: "sbc" }];
  for (let i = 0; i < 13; i++) nodes.push({ name: "l" + String(i).padStart(2, "0"), deviceClass: "laptop" });
  const r = layoutRoom(nodes);
  assert.equal(r.benchCount, 2);
  assert.equal(r.rows, 2);
  assert.equal(r.slots.filter(s => s.bench).length, 2);
  assert.equal(r.slots.find(s => s.name === "l12").row, 1);
});

test("layoutRoom is mirror-symmetric: tray centred, other devices centred on a wall shelf", () => {
  const nodes = [{ name: "a", deviceClass: "laptop" }, { name: "b", deviceClass: "laptop" }, { name: "c", deviceClass: "laptop" },
    { name: "s1", deviceClass: "server" }, { name: "s2", deviceClass: "sbc" }, { name: "s3", deviceClass: "vm" }];
  const r = layoutRoom(nodes);
  const tray = r.slots.filter(s => !s.bench), bench = r.slots.filter(s => s.bench);
  assert.ok(Math.abs(tray.reduce((a, s) => a + s.x, 0)) < 1e-9, "tray centred on x = 0");
  assert.ok(Math.abs(bench.reduce((a, s) => a + s.x, 0)) < 1e-9, "shelf devices centred on x = 0");
  assert.ok(bench.every(s => s.y > tray[0].y), "shelf devices sit above the tray");
  assert.ok(r.reach >= Math.max(...bench.map(s => Math.abs(s.x))));
});

test("layoutRoom: a single shelf device sits dead centre; a sixth starts a second shelf", () => {
  const one = layoutRoom([{ name: "x", deviceClass: "server" }]);
  assert.equal(one.slots[0].x, 0);
  const six = layoutRoom(Array.from({ length: 6 }, (_, i) => ({ name: "d" + i, deviceClass: "server" })));
  assert.equal(six.shelves, 2);
  assert.ok(six.slots[5].y > six.slots[0].y);
  assert.equal(six.slots[5].x, 0);
});

test("layoutRoom with no nodes", () => {
  assert.deepEqual(layoutRoom([]).slots, []);
  assert.deepEqual(layoutRoom(undefined).slots, []);
  assert.equal(layoutRoom([]).rows, 1);
});
