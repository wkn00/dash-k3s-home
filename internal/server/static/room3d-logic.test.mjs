import test from "node:test";
import assert from "node:assert/strict";
import { modelFor, nodeIndicators, podsByNode, roomAlert, layoutPositions } from "./room3d-logic.js";

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

test("layoutPositions is deterministic and order independent, control plane first", () => {
  const nodes = [{ name: "wk3" }, { name: "wk0", controlPlane: true }, { name: "wk1" }, { name: "wk2" }, { name: "wk4" }];
  const a = layoutPositions(nodes);
  const b = layoutPositions([...nodes].reverse());
  assert.deepEqual(a, b);
  assert.equal(a[0].name, "wk0");
  assert.equal(a[0].shelf, 0);
  assert.equal(a[4].name, "wk4"); // fifth node starts the second rack
  assert.equal(a[4].shelf, 0);
  assert.ok(a[4].x > a[0].x);
});

test("layoutPositions with no nodes", () => {
  assert.deepEqual(layoutPositions([]), []);
  assert.deepEqual(layoutPositions(undefined), []);
});
