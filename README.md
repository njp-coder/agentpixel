# @sponsio/telemetry

**See what AI agents actually do on your site — in the analytics you already use.**

A WebMCP tool call is a plain function call inside your page. It fires no page view, no click, no form submission. So an agent that searches your catalog, adds to a cart and checks out leaves you **one page view and a conversion with no funnel behind it**.

Neither the WebMCP spec nor Chrome's documentation mentions measurement anywhere. This is one line of setup, and no new analytics stack.

```bash
npm install @sponsio/telemetry
```

```js
import { instrument, dataLayer } from "@sponsio/telemetry";

instrument({ sinks: [dataLayer()] });
```

Every agent tool call now arrives in GTM as `agent_tool_call`, with the tool name, duration, whether it succeeded, and an ephemeral session id.

## Adapters

```js
import { instrument, gtag, dataLayer, posthog, segment, mixpanel, custom, debug } from "@sponsio/telemetry";

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

[`sponsio`](https://github.com/sponsio/sponsio) — contract testing for the tools your site exposes to agents. Its audit tells you when none of your tools emit any telemetry; this is the fix.

MIT
