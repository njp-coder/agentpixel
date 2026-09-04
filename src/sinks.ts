import type { Sink, ToolEvent } from "./index.js";

/**
 * Adapters for the analytics people already run.
 *
 * Every existing WebMCP instrumentation library terminates in OpenTelemetry —
 * excellent for engineers watching traces, useless to the person asking how
 * many conversions came from agents. These put the answer where that person
 * already looks.
 */

/** GA4 event name: snake_case, and the value most sites will end up segmenting on. */
export const EVENT_NAME = "agent_tool_call";

export interface SinkOptions {
  /** Override the event name if it collides with something you already send. */
  eventName?: string;
}

/** Google Tag Manager. Push a `agent_tool_call` event onto the data layer. */
export function dataLayer(options: SinkOptions = {}): Sink {
  const eventName = options.eventName ?? EVENT_NAME;
  return (event) => {
    const target = globalThis as unknown as { dataLayer?: unknown[] };
    target.dataLayer = target.dataLayer ?? [];
    target.dataLayer.push({ event: eventName, ...flatten(event) });
  };
}

/** GA4 via gtag.js. Parameter names stay under GA4's 40-character limit. */
export function gtag(options: SinkOptions = {}): Sink {
  const eventName = options.eventName ?? EVENT_NAME;
  return (event) => {
    const fn = (globalThis as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
    if (typeof fn !== "function") return;
    fn("event", eventName, flatten(event));
  };
}

/** PostHog. Uses the global `posthog` if present. */
export function posthog(options: SinkOptions = {}): Sink {
  const eventName = options.eventName ?? EVENT_NAME;
  return (event) => {
    const client = (globalThis as unknown as { posthog?: { capture?: Function } }).posthog;
    if (typeof client?.capture !== "function") return;
    client.capture(eventName, flatten(event));
  };
}

/** Segment analytics.js. */
export function segment(options: SinkOptions = {}): Sink {
  const eventName = options.eventName ?? EVENT_NAME;
  return (event) => {
    const client = (globalThis as unknown as { analytics?: { track?: Function } }).analytics;
    if (typeof client?.track !== "function") return;
    client.track(eventName, flatten(event));
  };
}

/** Mixpanel. */
export function mixpanel(options: SinkOptions = {}): Sink {
  const eventName = options.eventName ?? EVENT_NAME;
  return (event) => {
    const client = (globalThis as unknown as { mixpanel?: { track?: Function } }).mixpanel;
    if (typeof client?.track !== "function") return;
    client.track(eventName, flatten(event));
  };
}

/** Anything else — your own endpoint, a queue, a console, a test spy. */
export function custom(handler: (event: ToolEvent) => void): Sink {
  return handler;
}

/** Prints each call. Useful while wiring things up, not in production. */
export function debug(): Sink {
  return (event) => {
    const status = event.ok ? "ok" : `failed: ${event.error ?? "unknown"}`;
    console.info(
      `[sponsio] ${event.tool} (${event.kind}) ${Math.round(event.durationMs)}ms — ${status}`,
      event.args ?? {},
    );
  };
}

/**
 * Analytics products take flat properties, not nested objects, so arguments are
 * flattened to `arg_<name>` and non-primitives are stringified.
 */
function flatten(event: ToolEvent): Record<string, unknown> {
  const flat: Record<string, unknown> = {
    tool_name: event.tool,
    tool_kind: event.kind,
    duration_ms: Math.round(event.durationMs),
    ok: event.ok,
    session_id: event.sessionId,
  };
  if (event.error) flat["error"] = truncate(event.error, 100);

  for (const [key, value] of Object.entries(event.args ?? {})) {
    flat[`arg_${sanitize(key)}`] =
      value === null || ["string", "number", "boolean"].includes(typeof value)
        ? typeof value === "string"
          ? truncate(value, 100)
          : value
        : truncate(JSON.stringify(value) ?? "", 100);
  }
  return flat;
}

/** GA4 rejects parameter names outside `[A-Za-z0-9_]` and longer than 40 characters. */
function sanitize(key: string): string {
  return key.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 36);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
