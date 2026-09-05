import test from "node:test";
import assert from "node:assert/strict";

function setupDom() {
  const listeners = new Map();
  const registered = [];
  const key = (t, c) => `${t}:${Boolean(c)}`;
  globalThis.document = {
    visibilityState: "visible",
    modelContext: { registerTool(tool) { registered.push(tool); return Promise.resolve(); } },
    addEventListener: (t, fn, c) => listeners.set(key(t, c), fn),
    removeEventListener: (t, _fn, c) => listeners.delete(key(t, c)),
  };
  globalThis.window = {
    addEventListener: (t, fn) => listeners.set(key(t, false), fn),
    removeEventListener: (t) => listeners.delete(key(t, false)),
  };
  return { registered, fire: (t, ev, c = true) => listeners.get(key(t, c))?.(ev) };
}

const load = async () => import(`../dist/index.js?${Math.random()}`);

test("an assignment is stable for the whole page load", async () => {
  const { experiment, resetExperiments } = await load();
  resetExperiments();
  const first = experiment("naming", ["a", "b"]);
  for (let i = 0; i < 20; i++) {
    assert.equal(experiment("naming", ["a", "b"]).value, first.value);
  }
});

test("both variants are reachable across page loads", async () => {
  const { experiment, resetExperiments } = await load();
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    resetExperiments();
    seen.add(experiment("naming", ["a", "b"]).value);
  }
  assert.deepEqual([...seen].sort(), ["a", "b"], "assignment must actually vary");
});

test("a single variant is a valid, always-on rollout", async () => {
  const { experiment, resetExperiments } = await load();
  resetExperiments();
  assert.equal(experiment("solo", ["only"]).value, "only");
});

test("an empty variant list is a mistake worth surfacing", async () => {
  const { experiment } = await load();
  assert.throws(() => experiment("bad", []), /at least one variant/);
});

// The assignment has to reach the events, or there is nothing to break down by.
test("every event carries the variant it was assigned", async () => {
  const dom = setupDom();
  const { instrument, custom, assign, resetExperiments } = await load();
  resetExperiments();
  assign("naming", "find_products");

  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });
  await document.modelContext.registerTool({ name: "find_products", execute: async () => null });
  await dom.registered[0].execute({});
  dom.fire("pagehide", {}, false);

  assert.ok(seen.length >= 3);
  for (const event of seen) {
    assert.deepEqual(event.experiments, { naming: "find_products" }, event.type);
  }
  stop();
});

// The denominator: a session is only known to be agent-driven once something
// is called, so session_start is what makes invocation rate computable.
test("session_start carries the variant, so the denominator is countable", async () => {
  const dom = setupDom();
  const { instrument, custom, assign, resetExperiments } = await load();
  resetExperiments();
  assign("naming", "search_products");

  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });
  await document.modelContext.registerTool({ name: "other_tool", execute: async () => null });
  await dom.registered[0].execute({});

  const start = seen.find((e) => e.type === "session_start");
  assert.equal(start.experiments.naming, "search_products",
    "an agent session counts toward the variant even when the varied tool was not called");
  stop();
});

test("a variant assigned after instrument() still reaches later events", async () => {
  const dom = setupDom();
  const { instrument, custom, assign, resetExperiments } = await load();
  resetExperiments();

  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });
  assign("late", "b");
  await document.modelContext.registerTool({ name: "t", execute: async () => null });
  await dom.registered[0].execute({});

  assert.equal(seen.find((e) => e.type === "tool_call").experiments.late, "b");
  stop();
});

test("the variant flattens into a breakdown dimension", async () => {
  setupDom();
  const { gtag } = await load();
  const calls = [];
  globalThis.gtag = (...args) => calls.push(args);

  gtag()({
    type: "tool_call", sessionId: "s", tool: "find_products", kind: "imperative",
    durationMs: 5, ok: true, step: 1, sinceStartMs: 0,
    experiments: { "search-naming": "find_products" },
  });

  assert.equal(calls[0][2].exp_search_naming, "find_products");
  delete globalThis.gtag;
});
