import test from "node:test";
import assert from "node:assert/strict";

// Minimal DOM stand-ins: this library only touches document.modelContext and submit events.
function setupDom() {
  const listeners = new Map();
  const registered = [];
  globalThis.document = {
    modelContext: {
      registerTool(tool) {
        registered.push(tool);
        return Promise.resolve();
      },
    },
    addEventListener: (type, fn, capture) => listeners.set(`${type}:${capture}`, fn),
    removeEventListener: (type, _fn, capture) => listeners.delete(`${type}:${capture}`),
  };
  return { registered, fire: (type, ev) => listeners.get(`${type}:true`)?.(ev) };
}

const load = async () => {
  const mod = await import(`../dist/index.js?${Math.random()}`);
  return mod;
};

test("imperative tool calls are reported with duration and success", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });

  await document.modelContext.registerTool({
    name: "search_products",
    execute: async () => ({ ok: true }),
  });
  const result = await dom.registered[0].execute({ query: "pan" });

  assert.deepEqual(result, { ok: true }, "the tool's own result must pass through untouched");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, "search_products");
  assert.equal(seen[0].kind, "imperative");
  assert.equal(seen[0].ok, true);
  assert.ok(seen[0].durationMs >= 0);
  stop();
});

test("a failing tool is reported and still throws", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });

  await document.modelContext.registerTool({
    name: "checkout",
    execute: async () => {
      throw new Error("card declined");
    },
  });

  await assert.rejects(
    () => dom.registered[0].execute({}),
    /card declined/,
    "instrumentation must not swallow the page's own error",
  );
  assert.equal(seen[0].ok, false);
  assert.match(seen[0].error, /card declined/);
  stop();
});

test("arguments are recorded as shapes by default", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });

  await document.modelContext.registerTool({ name: "t", execute: async () => null });
  await dom.registered[0].execute({ query: "cast iron", limit: 5, tags: ["a", "b"] });

  assert.deepEqual(seen[0].args, { query: "string[9]", limit: "number", tags: "array[2]" });
  stop();
});

test("capturing values redacts sensitive names, including camelCase", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({
    sinks: [custom((e) => seen.push(e))],
    captureArguments: "values",
  });

  await document.modelContext.registerTool({ name: "t", execute: async () => null });
  await dom.registered[0].execute({
    query: "pan",
    userEmail: "a@b.com",
    card_number: "4242",
    password: "hunter2",
  });

  assert.equal(seen[0].args.query, "pan");
  assert.equal(seen[0].args.userEmail, "[redacted]");
  assert.equal(seen[0].args.card_number, "[redacted]");
  assert.equal(seen[0].args.password, "[redacted]");
  stop();
});

test("arguments can be dropped entirely", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))], captureArguments: "none" });
  await document.modelContext.registerTool({ name: "t", execute: async () => null });
  await dom.registered[0].execute({ query: "x" });
  assert.equal(seen[0].args, undefined);
  stop();
});

// The half nobody else covers.
test("agent-triggered form submits are captured", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });

  dom.fire("submit", {
    agentInvoked: true,
    target: { getAttribute: (k) => (k === "toolname" ? "subscribe_newsletter" : null) },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, "subscribe_newsletter");
  assert.equal(seen[0].kind, "declarative");
  stop();
});

test("ordinary human submits are ignored", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const seen = [];
  const stop = instrument({ sinks: [custom((e) => seen.push(e))] });
  dom.fire("submit", { agentInvoked: false, target: { getAttribute: () => "x" } });
  assert.equal(seen.length, 0);
  stop();
});

test("a sink that throws never breaks the tool", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const good = [];
  const stop = instrument({
    sinks: [
      custom(() => {
        throw new Error("analytics is down");
      }),
      custom((e) => good.push(e)),
    ],
  });

  await document.modelContext.registerTool({ name: "t", execute: async () => "fine" });
  assert.equal(await dom.registered[0].execute({}), "fine");
  assert.equal(good.length, 1, "a broken sink must not stop the others");
  stop();
});

test("stopping restores the original registerTool", async () => {
  const dom = setupDom();
  const { instrument, custom } = await load();
  const before = document.modelContext.registerTool;
  const stop = instrument({ sinks: [custom(() => {})] });
  assert.notEqual(document.modelContext.registerTool, before);
  stop();
  assert.equal(document.modelContext.registerTool, before);
});

test("the GA4 sink flattens into allowed parameter names", async () => {
  setupDom();
  const { gtag } = await load();
  const calls = [];
  globalThis.gtag = (...args) => calls.push(args);

  gtag()({
    tool: "search_products",
    kind: "imperative",
    durationMs: 12.7,
    ok: true,
    args: { "weird-key!": "x".repeat(200) },
    sessionId: "s1",
  });

  const [type, name, params] = calls[0];
  assert.equal(type, "event");
  assert.equal(name, "agent_tool_call");
  assert.equal(params.tool_name, "search_products");
  assert.equal(params.duration_ms, 13);
  assert.ok("arg_weird_key_" in params, "parameter names must be sanitized for GA4");
  assert.ok(params.arg_weird_key_.length <= 100, "values must be truncated for GA4");
  delete globalThis.gtag;
});

test("the GTM sink creates the data layer if absent", async () => {
  setupDom();
  const { dataLayer } = await load();
  delete globalThis.dataLayer;
  dataLayer()({ tool: "t", kind: "imperative", durationMs: 1, ok: true, sessionId: "s" });
  assert.equal(globalThis.dataLayer[0].event, "agent_tool_call");
  assert.equal(globalThis.dataLayer[0].tool_name, "t");
  delete globalThis.dataLayer;
});

test("sinks stay quiet when their vendor is not on the page", async () => {
  setupDom();
  const { posthog, segment, mixpanel } = await load();
  for (const make of [posthog, segment, mixpanel]) {
    assert.doesNotThrow(() =>
      make()({ tool: "t", kind: "imperative", durationMs: 1, ok: true, sessionId: "s" }),
    );
  }
});
