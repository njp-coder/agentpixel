# agentpixel

[![npm](https://img.shields.io/npm/v/agentpixel?color=%237c8cff)](https://www.npmjs.com/package/agentpixel)
[![license](https://img.shields.io/npm/l/agentpixel?color=%237c8cff)](https://github.com/njp-coder/agentpixel/blob/main/LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-%237c8cff)](https://www.npmjs.com/package/agentpixel?activeTab=dependencies)

**The pixel for AI agent traffic.** See what agents actually do on your site, in the analytics you already use.

A WebMCP tool call is a plain function call inside your page. It fires no page view, no click, no form submission. So an agent that searches your catalog, adds to a cart and checks out leaves you **one page view and a conversion with no funnel behind it**.

Neither the WebMCP spec nor Chrome's documentation mentions measurement anywhere. This is one line of setup, and no new analytics stack.

```bash
npm install agentpixel
```

```js
import { instrument, dataLayer } from "agentpixel";

instrument({ sinks: [dataLayer()] });
```

Every agent tool call now arrives in GTM as `agent_tool_call`, with the tool name, duration, whether it succeeded, and an ephemeral session id.

## The whole journey, not just the calls

Four events, so a funnel is a query rather than a join:

```
agent_session_start   first_tool: search_products
agent_tool_call       step: 1  search_products      142ms  ok
agent_tool_call       step: 2  add_to_cart          38ms   ok   previous_tool: search_products
agent_tool_call       step: 3  checkout             91ms   ok   previous_tool: add_to_cart
agent_outcome         purchase  value: 129  tool_count: 3
agent_session_end     tool_count: 3  error_count: 0  converted: true
```

**`agent_session_start`** fires on the first tool call — the moment a session is *known* to be agent-driven. That is what makes "agents versus humans" a segment you can select rather than a number you guess at.

**Every call carries `step` and `previous_tool`**, so drop-off between two tools is one dimension pair in GA4 — no sequencing query, no BigQuery export.

**`agent_session_end`** fires on `pagehide` with the tool count, error count, last tool and whether it converted, so abandonment is visible instead of inferred.

**Report your own conversions** to tie the journey to something the business cares about:

```js
import { recordOutcome } from "agentpixel";
recordOutcome("purchase", { value: 129, currency: "USD" });
```

It is deliberately silent outside an agent session — a human converting is your ordinary analytics, and counting it here would inflate every number that makes this worth installing.

## Testing your tool surface

"Agents invoke `find_products` 37% more often than your current schema" sounds like it needs a panel of sites. It doesn't — register both variants, assign one per page load, and measure it on your own traffic.

```js
import { experiment, instrument, gtag } from "agentpixel";

instrument({ sinks: [gtag()] });

const naming = experiment("search-naming", ["search_products", "find_products"]);
document.modelContext.registerTool({ name: naming.value, /* … */ });
```

Every event this session emits then carries `exp_search_naming`, so invocation rate by variant is a breakdown in GA4 rather than a query you have to write. Vary anything you like — the name, the description, an enum, a parameter you are thinking of adding.

**The denominator works because of `agent_session_start`.** A session counts toward whichever variant was live the moment *any* tool was called, so you can divide sessions-that-called-`find_products` by sessions-that-saw-`find_products`.

Three things to know before you trust a result:

- **It excludes sessions where the agent called nothing at all**, because those are indistinguishable from a human visit. The measurement is biased toward agents that engaged with something.
- **It needs volume.** Two variants and a handful of agent sessions is not a result, it is noise wearing a percentage sign.
- **Varying your surface is real contract drift.** [`sponsio`](https://www.npmjs.com/package/sponsio) will flag it, and it is right to — baseline the control variant and treat the experiment as a deliberate exception.

## What cannot be observed

Stated plainly, because the alternative is you finding out in front of a customer.

**Which agent it was.** Agentic browsers arrive on ordinary Chrome user agents with no distinguishing token, riding the user's own connection. Nothing here can tell ChatGPT from Claude from Gemini, and any tool claiming otherwise is guessing.

**The prompt.** "Find me black running shoes under $150" lives in the agent's context and never reaches your page.

**Agents that considered you and never arrived.** No request, nothing to observe. There is no lost-prompt metric to be had from a page.

**Agents that arrived and called nothing.** Without a tool call there is no signal separating an agent from a person, so this is not measurable either — which means a "tool-call rate" with an eligible-intent denominator cannot be computed honestly today.

What *is* fully observable is everything after the first call: the sequence, the timing, the failures, the abandonment, and the conversion. That is the funnel, and it is enough.

## Adapters

```js
import { instrument, gtag, dataLayer, posthog, segment, mixpanel, custom, debug } from "agentpixel";

instrument({ sinks: [gtag(), posthog()] });
```

`gtag()` · `dataLayer()` · `posthog()` · `segment()` · `mixpanel()` · `custom(fn)` for your own endpoint · `debug()` while wiring up.

Every adapter is a no-op when its vendor isn't on the page, so shipping one you haven't installed yet costs nothing.

## It covers forms too

Most WebMCP instrumentation only wraps `registerTool`, which misses **declarative tools** entirely — the ones the browser synthesizes from annotated HTML forms. That matters more than it sounds: Shopify enabled WebMCP across every Liquid storefront and Cloudflare auto-generates it, so for a lot of sites declarative tools *are* the whole surface.

The browser sets a read-only `agentInvoked` flag on the submit event — the one agent signal you get for free. This reads it, so both halves land in the same event stream with a `tool_kind` of `imperative` or `declarative`.

One honest limit: for a declarative tool the browser hands us the submit and nothing after it, so `ok` means *an agent submitted this form* rather than *the server accepted it*, and `duration_ms` is always zero. Build funnels accordingly — usually by pairing the submit with whatever you already track on the resulting page.

## Arguments, and what it won't record

By default it records the **shape** of the arguments, never their contents:

```js
{ query: "string[9]", limit: "number", tags: "array[2]" }
```

Safe to turn on without a privacy review. If you want the values:

```js
instrument({
  sinks: [gtag()],
  captureArguments: "values",
  redact: ["coupon_code"],
});
```

Passwords, PINs, tokens, secrets, card numbers, CVVs, SSNs, emails and phone numbers are redacted by default, matched across `snake_case` and `camelCase` — so `userEmail` is caught without being listed. Or record nothing at all with `captureArguments: "none"`.

The session id is generated per page load, held in memory, and never stored. This library sends nothing anywhere itself; it only hands events to the sinks you choose.

## It will not break your site

A tool call is on your critical path, so this is written to stay out of the way. A sink that throws is caught and the others still run. A tool that throws still throws — instrumentation never swallows your own failure. Results pass through untouched. `instrument()` returns a `stop()` that restores the original `registerTool` exactly as it found it.

Zero dependencies.

## Event shape

```ts
{
  tool: string
  kind: "imperative" | "declarative"
  durationMs: number
  ok: boolean
  error?: string
  args?: Record<string, unknown>
  sessionId: string
}
```

Adapters flatten this into `tool_name`, `tool_kind`, `duration_ms`, `ok`, `session_id`, and `arg_*`, with names sanitized and values truncated to GA4's limits.

## A note on the standard

Wrapping `registerTool` is a workaround, not a design. The spec has open proposals for native lifecycle events and for real-user measurement ([#85](https://github.com/webmachinelearning/webmcp/issues/85), [#186](https://github.com/webmachinelearning/webmcp/issues/186)). When those land, only the internals change — the event shape and every adapter stay exactly as they are.

If you want traces rather than analytics events, [`autotel-webmcp`](https://github.com/jagreehal/autotel) does OpenTelemetry for the same surface and does it well.

## Related

[`sponsio`](https://www.npmjs.com/package/sponsio) — contract testing for the tools your site exposes to agents. Its audit tells you when none of your tools emit any telemetry; this is the fix.

## Links

[npm](https://www.npmjs.com/package/agentpixel) · [source](https://github.com/njp-coder/agentpixel) · [issues](https://github.com/njp-coder/agentpixel/issues) · companion package [sponsio](https://www.npmjs.com/package/sponsio)

MIT
