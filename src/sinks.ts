import type { AgentEvent, Sink } from "./index.js";

/**
 * Adapters for the analytics people already run.
 *
 * Every other WebMCP instrumentation library terminates in OpenTelemetry —
 * excellent for engineers watching traces, useless to the person asking how
 * many conversions came from agents. These put the answer where that person
 * already looks.
 */

/** One analytics event name per kind, so each is segmentable on its own. */
export const EVENT_NAMES = {
  tool_call: "agent_tool_call",
  session_start: "agent_session_start",
  session_end: "agent_session_end",
  outcome: "agent_outcome",
} as const;

export interface SinkOptions {
  /** Prefix every event name, if `agent_` collides with something you already send. */
  prefix?: string;
}

function nameFor(event: AgentEvent, options: SinkOptions): string {
  return `${options.prefix ?? ""}${EVENT_NAMES[event.type]}`;
}

/** Google Tag Manager. Pushes each event onto the data layer. */
export function dataLayer(options: SinkOptions = {}): Sink {
  return (event) => {
    const target = globalThis as unknown as { dataLayer?: unknown[] };
    target.dataLayer = target.dataLayer ?? [];
    target.dataLayer.push({ event: nameFor(event, options), ...flatten(event) });
  };
}

/** GA4 via gtag.js. Parameter names stay inside GA4's limits. */
export function gtag(options: SinkOptions = {}): Sink {
  return (event) => {
    const fn = (globalThis as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
    if (typeof fn !== "function") return;
    fn("event", nameFor(event, options), flatten(event));
  };
}

/** PostHog. */
export function posthog(options: SinkOptions = {}): Sink {
  return (event) => {
    const client = (globalThis as unknown as { posthog?: { capture?: Function } }).posthog;
    if (typeof client?.capture !== "function") return;
    client.capture(nameFor(event, options), flatten(event));
  };
}

/** Segment analytics.js. */
export function segment(options: SinkOptions = {}): Sink {
  return (event) => {
    const client = (globalThis as unknown as { analytics?: { track?: Function } }).analytics;
    if (typeof client?.track !== "function") return;
    client.track(nameFor(event, options), flatten(event));
  };
}

/** Mixpanel. */
export function mixpanel(options: SinkOptions = {}): Sink {
  return (event) => {
    const client = (globalThis as unknown as { mixpanel?: { track?: Function } }).mixpanel;
    if (typeof client?.track !== "function") return;
    client.track(nameFor(event, options), flatten(event));
  };
}

/** Anything else — your own endpoint, a queue, a test spy. */
export function custom(handler: (event: AgentEvent) => void): Sink {
  return handler;
}

/** Prints each event. Useful while wiring up, not in production. */
export function debug(): Sink {
  return (event) => {
    if (event.type === "tool_call") {
      const status = event.ok ? "ok" : `failed: ${event.error ?? "unknown"}`;
      console.info(
        `[agentpixel] ${event.step}. ${event.tool} (${event.kind}) ${event.durationMs}ms — ${status}`,
        event.args ?? {},
      );
      return;
    }
    console.info(`[agentpixel] ${event.type}`, flatten(event));
  };
}

/**
 * Analytics products take flat properties, not nested objects, so arguments are
 * flattened to `arg_<name>` and non-primitives are stringified.
 */
function flatten(event: AgentEvent): Record<string, unknown> {
  const flat: Record<string, unknown> = { session_id: event.sessionId };

  switch (event.type) {
    case "tool_call":
      flat["tool_name"] = event.tool;
      flat["tool_kind"] = event.kind;
      flat["duration_ms"] = event.durationMs;
      flat["ok"] = event.ok;
      flat["step"] = event.step;
      flat["since_start_ms"] = event.sinceStartMs;
      if (event.previousTool) flat["previous_tool"] = event.previousTool;
      if (event.error) flat["error"] = truncate(event.error, 100);
      for (const [key, value] of Object.entries(event.args ?? {})) {
        flat[`arg_${sanitize(key)}`] = primitive(value);
      }
      break;

    case "session_start":
      flat["first_tool"] = event.firstTool;
      break;

    case "session_end":
      flat["tool_count"] = event.toolCount;
      flat["error_count"] = event.errorCount;
      flat["duration_ms"] = event.durationMs;
      flat["converted"] = event.converted;
      if (event.lastTool) flat["last_tool"] = event.lastTool;
      break;

    case "outcome":
      flat["outcome"] = event.name;
      flat["tool_count"] = event.toolCount;
      flat["since_start_ms"] = event.sinceStartMs;
      if (event.value !== undefined) flat["value"] = event.value;
      if (event.currency) flat["currency"] = event.currency;
      break;
  }

  return flat;
}

function primitive(value: unknown): unknown {
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "string") return truncate(value, 100);
  return truncate(JSON.stringify(value) ?? "", 100);
}

/** GA4 rejects parameter names outside `[A-Za-z0-9_]` and longer than 40 characters. */
function sanitize(key: string): string {
  return key.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 36);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
