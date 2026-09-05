import test from "node:test";
import assert from "node:assert/strict";

// Minimal DOM stand-ins: this library only touches document.modelContext,
// submit events, and the page-exit signals.
function setupDom() {
  const listeners = new Map();
  const registered = [];
  const key = (t, c) => `${t}:${Boolean(c)}`;
  globalThis.document = {
    visibilityState: "visible",
    modelContext: {
      registerTool(tool) { registered.push(tool); return Promise.resolve(); },
    },
    addEventListener: (t, fn, c) => listeners.set(key(t, c), fn),
    removeEventListener: (t, _fn, c) => listeners.delete(key(t, c)),
  };
  globalThis.window = {
    addEventListener: (t, fn) => listeners.set(key(t, false), fn),
    removeEventListener: (t) => listeners.delete(key(t, false)),
  };
  return { registered, fire: (t, ev, capture = true) => listeners.get(key(t, capture))?.(ev) };
}

const load = async () => import(`../dist/index.js?${Math.random()}`);
const only = (events, type) => events.filter((e) => e.type === type);

test("a tool call carries its place in the journey", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });

  await document.modelContext.registerTool({ name: "search", execute: async () => "a" });
  await document.modelContext.registerTool({ name: "add_to_cart", execute: async () => "b" });
  await dom.registered[0].execute({ query: "pan" });
  await dom.registered[1].execute({ product_id: "p1" });

  const calls = only(seen, "tool_call");
  assert.equal(calls[0].step, 1);
  assert.equal(calls[0].previousTool, undefined, "the first call has nothing before it");
  assert.equal(calls[1].step, 2);
  assert.equal(calls[1].previousTool, "search", "one hop of the journey, without a join");
  assert.ok(calls[1].sinceStartMs >= 0);
  stop();
});

// The moment a session is known to be agent-driven, which is what makes
// "agents vs humans" a segment rather than a guess.
test("the first call opens an agent session, and only the first", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });

  await document.modelContext.registerTool({ name: "search", execute: async () => null });
  await dom.registered[0].execute({});
  await dom.registered[0].execute({});

  const starts = only(seen, "session_start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].firstTool, "search");
  assert.equal(seen[0].type, "session_start", "it precedes the call that triggered it");
  stop();
});

test("the page going away closes the session with a summary", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });

  await document.modelContext.registerTool({ name: "search", execute: async () => null });
  await document.modelContext.registerTool({ name: "boom", execute: async () => { throw new Error("x"); } });
  await dom.registered[0].execute({});
  await assert.rejects(() => dom.registered[1].execute({}));

  dom.fire("pagehide", {}, false);
  const [end] = only(seen, "session_end");
  assert.equal(end.toolCount, 2);
  assert.equal(end.errorCount, 1);
  assert.equal(end.lastTool, "boom");
  assert.equal(end.converted, false);
  stop();
});

test("a session that saw no agent activity is never reported", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });
  dom.fire("pagehide", {}, false);
  assert.equal(seen.length, 0, "a human visit is not ours to report");
  stop();
});

test("the session closes once, however many exit signals fire", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });
  await document.modelContext.registerTool({ name: "t", execute: async () => null });
  await dom.registered[0].execute({});

  dom.fire("pagehide", {}, false);
  document.visibilityState = "hidden";
  dom.fire("visibilitychange", {}, true);
  assert.equal(only(seen, "session_end").length, 1);
  stop();
});

test("an outcome ties the journey to something the business cares about", async () => {
  const dom = setupDom();
  const { instrument, custom, recordOutcome } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });

  await document.modelContext.registerTool({ name: "checkout", execute: async () => null });
  await dom.registered[0].execute({});
  recordOutcome("purchase", { value: 129, currency: "USD" });

  const [outcome] = only(seen, "outcome");
  assert.equal(outcome.name, "purchase");
  assert.equal(outcome.value, 129);
  assert.equal(outcome.toolCount, 1);

  dom.fire("pagehide", {}, false);
  assert.equal(only(seen, "session_end")[0].converted, true);
  stop();
});

// A human converting is ordinary analytics; claiming it here would inflate
// every number that makes this worth installing.
test("an outcome outside an agent session is ignored", async () => {
  setupDom();
  const { instrument, custom, recordOutcome } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });
  recordOutcome("purchase", { value: 129 });
  assert.equal(only(seen, "outcome").length, 0);
  stop();
});

test("a failing tool is reported and still throws", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });

  await document.modelContext.registerTool({
    name: "checkout",
    execute: async () => { throw new Error("card declined"); },
  });
  await assert.rejects(() => dom.registered[0].execute({}), /card declined/);

  const [call] = only(seen, "tool_call");
  assert.equal(call.ok, false);
  assert.match(call.error, /card declined/);
  stop();
});

test("arguments are recorded as shapes by default", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });
  await document.modelContext.registerTool({ name: "t", execute: async () => null });
  await dom.registered[0].execute({ query: "cast iron", limit: 5, tags: ["a", "b"] });
  assert.deepEqual(only(seen, "tool_call")[0].args, {
    query: "string[9]", limit: "number", tags: "array[2]",
  });
  stop();
});

test("capturing values redacts sensitive names, including camelCase", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))], captureArguments: "values" });
  await document.modelContext.registerTool({ name: "t", execute: async () => null });
  await dom.registered[0].execute({ query: "pan", userEmail: "a@b.com", password: "hunter2" });

  const { args } = only(seen, "tool_call")[0];
  assert.equal(args.query, "pan");
  assert.equal(args.userEmail, "[redacted]");
  assert.equal(args.password, "[redacted]");
  stop();
});

test("agent-triggered form submits are captured, human ones are not", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });

  const target = { getAttribute: (k) => (k === "toolname" ? "subscribe" : null) };
  dom.fire("submit", { agentInvoked: true, target });
  dom.fire("submit", { agentInvoked: false, target });

  const calls = only(seen, "tool_call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "declarative");
  stop();
});

test("a sink that throws never breaks the tool", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const good = [];
  const stop = instrument({
    sinks: [custom(() => { throw new Error("analytics is down"); }), custom((e) => good.push(e))],
  });
  await document.modelContext.registerTool({ name: "t", execute: async () => "fine" });
  assert.equal(await dom.registered[0].execute({}), "fine");
  assert.ok(good.length >= 1);
  stop();
});

test("stopping restores the original registerTool", async () => {
  setupDom();
  const { instrument, custom } = await load();
  const before = document.modelContext.registerTool;
  const stop = instrument({ sinks: [custom(() => {})] });
  assert.notEqual(document.modelContext.registerTool, before);
  stop();
  assert.equal(document.modelContext.registerTool, before);
});

test("each event kind gets its own analytics name and flat shape", async () => {
  setupDom();
  const { gtag } = await load();
  const calls = [];
  globalThis.gtag = (...args) => calls.push(args);
  const sink = gtag();

  sink({ type: "tool_call", sessionId: "s", tool: "search", kind: "imperative",
         durationMs: 12.7, ok: true, step: 2, sinceStartMs: 900, previousTool: "get",
         args: { "weird-key!": "x".repeat(200) } });
  sink({ type: "session_end", sessionId: "s", toolCount: 3, errorCount: 0, durationMs: 5000, converted: true });
  sink({ type: "outcome", sessionId: "s", name: "purchase", value: 129, toolCount: 3, sinceStartMs: 4000 });

  assert.deepEqual(calls.map((c) => c[1]),
    ["agent_tool_call", "agent_session_end", "agent_outcome"]);
  const params = calls[0][2];
  assert.equal(params.step, 2);
  assert.equal(params.previous_tool, "get");
  assert.ok("arg_weird_key_" in params, "names must be sanitized for GA4");
  assert.ok(params.arg_weird_key_.length <= 100, "values must be truncated for GA4");
  assert.equal(calls[2][2].value, 129);
  delete globalThis.gtag;
});

test("sinks stay quiet when their vendor is not on the page", async () => {
  setupDom();
  const { posthog, segment, mixpanel } = await load();
  const event = { type: "session_start", sessionId: "s", firstTool: "t" };
  for (const make of [posthog, segment, mixpanel]) {
    assert.doesNotThrow(() => make()(event));
  }
});
