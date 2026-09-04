/**
 * Sends WebMCP tool calls to the analytics you already use.
 *
 * A tool call is a plain function call inside the page: it fires no page view,
 * no click, no form submission. So an agent that searches, adds to a cart and
 * checks out leaves one page view and a conversion with no funnel behind it.
 * Neither the WebMCP spec nor Chrome's docs mention measurement, and agentic
 * browsers arrive on ordinary Chrome user agents that bot filters cannot catch.
 *
 * This closes that hole in one line, without asking anyone to adopt a new
 * analytics stack.
 */

export type ToolKind = "imperative" | "declarative";

export interface ToolEvent {
  /** Tool name as registered, or the form's `toolname` for declarative tools. */
  tool: string;
  kind: ToolKind;
  /** Milliseconds from invocation to settle. Always zero for declarative submits, which we cannot time. */
  durationMs: number;
  /**
   * Whether the call completed without throwing.
   *
   * For declarative form tools this reports that an agent *submitted* the form,
   * not what the server did with it — the browser gives us the submit event and
   * nothing after it. Build funnels accordingly.
   */
  ok: boolean;
  error?: string;
  /** Shapes or values, depending on `captureArguments`. Absent when "none". */
  args?: Record<string, unknown>;
  /** Ephemeral, per page load. Never stored, never sent anywhere by us. */
  sessionId: string;
}

export type Sink = (event: ToolEvent) => void;

export interface InstrumentOptions {
  sinks: Sink[];
  /**
   * How much of the arguments to record. Defaults to "shapes", which records
   * `{ query: "string" }` rather than what was searched for — safe to turn on
   * without a privacy review.
   */
  captureArguments?: "none" | "shapes" | "values";
  /** Parameter names to drop when capturing values. Matched case-insensitively. */
  redact?: string[];
  /** Capture agent-triggered form submits. On by default; it is free and covers auto-generated tools. */
  declarative?: boolean;
}

const DEFAULT_REDACT = [
  "password", "passwd", "pin", "token", "secret", "apikey", "api_key",
  "card", "card_number", "cvv", "cvc", "ssn", "email", "phone",
];

/**
 * Starts recording. Returns a function that stops and restores everything.
 *
 * Safe to call more than once; later calls are ignored until you stop.
 */
export function instrument(options: InstrumentOptions): () => void {
  if (typeof document === "undefined") return () => {};
  if (active) return active.stop;

  const sessionId = newSessionId();
  const emit = makeEmitter(options.sinks);
  const teardowns: (() => void)[] = [];

  const patched = patchRegisterTool(options, sessionId, emit);
  if (patched) teardowns.push(patched);

  if (options.declarative !== false) {
    teardowns.push(watchAgentSubmits(options, sessionId, emit));
  }

  const stop = () => {
    for (const teardown of teardowns.reverse()) teardown();
    active = undefined;
  };
  active = { stop };
  return stop;
}

let active: { stop: () => void } | undefined;

/**
 * Wraps `registerTool` so every tool registered afterwards reports itself.
 *
 * Patching is a workaround, not a design: the spec has open proposals for
 * native lifecycle events (`toolwillexecute`/`toolcomplete`/`toolerror`) and
 * for real-user measurement. When those ship, only this function needs to
 * change — the event shape and every sink stay exactly as they are.
 */
function patchRegisterTool(
  options: InstrumentOptions,
  sessionId: string,
  emit: (event: ToolEvent) => void,
): (() => void) | undefined {
  const context = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
  if (!context || typeof context.registerTool !== "function") return undefined;

  // Keep the original reference for restoration, and a bound copy for calling —
  // restoring a bound copy would leave the page subtly different from how we
  // found it.
  const original = context.registerTool;
  const call = original.bind(context);

  context.registerTool = function registerTool(tool: ToolLike, ...rest: unknown[]) {
    if (!tool || typeof tool.execute !== "function") {
      return call(tool as ToolLike, ...rest);
    }

    const execute = tool.execute.bind(tool);
    const instrumented = { ...tool };

    instrumented.execute = async (args: unknown, ...extra: unknown[]) => {
      const startedAt = now();
      try {
        const result = await execute(args, ...extra);
        emit({
          tool: tool.name,
          kind: "imperative",
          durationMs: Math.round(now() - startedAt),
          ok: true,
          ...withArgs(args, options),
          sessionId,
        });
        return result;
      } catch (error) {
        emit({
          tool: tool.name,
          kind: "imperative",
          durationMs: Math.round(now() - startedAt),
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...withArgs(args, options),
          sessionId,
        });
        // Never swallow the page's own failure.
        throw error;
      }
    };

    return call(instrumented, ...rest);
  } as ModelContextLike["registerTool"];

  return () => {
    context.registerTool = original;
  };
}

/**
 * Declarative tools — forms annotated with `toolname` — never go through
 * `registerTool`, so instrumenting registration misses them entirely. The
 * browser sets `agentInvoked` on the submit event instead, which is the only
 * agent signal a site gets for free. Shopify and Cloudflare auto-generate
 * exactly this kind of tool, so for a lot of sites it is the whole surface.
 */
function watchAgentSubmits(
  options: InstrumentOptions,
  sessionId: string,
  emit: (event: ToolEvent) => void,
): () => void {
  const onSubmit = (event: Event) => {
    if (!(event as SubmitEventLike).agentInvoked) return;

    const form = event.target as HTMLFormElement | null;
    const name = form?.getAttribute?.("toolname") ?? form?.getAttribute?.("name") ?? "(form)";

    emit({
      tool: name,
      kind: "declarative",
      durationMs: 0,
      ok: true,
      ...withArgs(readForm(form), options),
      sessionId,
    });
  };

  document.addEventListener("submit", onSubmit, true);
  return () => document.removeEventListener("submit", onSubmit, true);
}

function readForm(form: HTMLFormElement | null): Record<string, unknown> {
  if (!form || typeof FormData === "undefined") return {};
  const out: Record<string, unknown> = {};
  try {
    for (const [key, value] of new FormData(form).entries()) {
      out[key] = typeof value === "string" ? value : "(file)";
    }
  } catch {
    /* a detached or exotic form is not worth failing over */
  }
  return out;
}

function withArgs(args: unknown, options: InstrumentOptions): { args?: Record<string, unknown> } {
  const mode = options.captureArguments ?? "shapes";
  if (mode === "none") return {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};

  const redact = new Set(
    [...DEFAULT_REDACT, ...(options.redact ?? [])].map((word) => word.toLowerCase()),
  );
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (mode === "shapes") {
      out[key] = describe(value);
      continue;
    }
    out[key] = isRedacted(key, redact) ? "[redacted]" : value;
  }
  return { args: out };
}

/** Matches whole words inside snake_case and camelCase names, so `userEmail` is caught. */
function isRedacted(key: string, redact: Set<string>): boolean {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return redact.has(key.toLowerCase()) || parts.some((part) => redact.has(part));
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === "string") return `string[${value.length}]`;
  return typeof value;
}

/** A sink that throws must never break a tool call, so every one is isolated. */
function makeEmitter(sinks: Sink[]): (event: ToolEvent) => void {
  return (event) => {
    for (const sink of sinks) {
      try {
        sink(event);
      } catch {
        /* analytics is never worth breaking the page for */
      }
    }
  };
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function newSessionId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
  return `s-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

interface ToolLike {
  name: string;
  execute?: (args: unknown, ...rest: unknown[]) => unknown;
  [key: string]: unknown;
}

interface ModelContextLike {
  registerTool: (tool: ToolLike, ...rest: unknown[]) => unknown;
}

interface SubmitEventLike extends Event {
  agentInvoked?: boolean;
}

export * from "./sinks.js";
