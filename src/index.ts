/**
 * Sends WebMCP tool calls to the analytics you already use.
 *
 * A tool call is a plain function call inside the page: it fires no page view,
 * no click, no form submission. So an agent that searches, adds to a cart and
 * checks out leaves one page view and a conversion with no funnel behind it.
 *
 * What this can see, it reports precisely. What it cannot see, it does not
 * estimate — see the "Cannot be observed" note in the README.
 */

export type ToolKind = "imperative" | "declarative";

interface BaseEvent {
  /** Ephemeral, per page load. Never stored, never sent anywhere by us. */
  sessionId: string;
}

export interface ToolEvent extends BaseEvent {
  type: "tool_call";
  tool: string;
  kind: ToolKind;
  /** Milliseconds from invocation to settle. Always zero for declarative submits. */
  durationMs: number;
  /**
   * Whether the call completed without throwing.
   *
   * For declarative form tools this reports that an agent *submitted* the form,
   * not what the server did with it — the browser gives us the submit event and
   * nothing after it.
   */
  ok: boolean;
  error?: string;
  args?: Record<string, unknown>;
  /** 1-based position in this session, so a funnel is a query rather than a join. */
  step: number;
  /** Milliseconds since the first agent activity on this page. */
  sinceStartMs: number;
  /** The tool called immediately before this one — one hop of the journey. */
  previousTool?: string;
}

/** Emitted once, on the first tool call — the moment a session is known to be agent-driven. */
export interface SessionStartEvent extends BaseEvent {
  type: "session_start";
  firstTool: string;
}

/** Emitted as the page goes away, so abandonment is visible rather than inferred. */
export interface SessionEndEvent extends BaseEvent {
  type: "session_end";
  toolCount: number;
  errorCount: number;
  lastTool?: string;
  durationMs: number;
  /** Whether the site reported a business outcome during this session. */
  converted: boolean;
}

/** A business outcome the site itself reports, tied to the agent session. */
export interface OutcomeEvent extends BaseEvent {
  type: "outcome";
  name: string;
  value?: number;
  currency?: string;
  toolCount: number;
  sinceStartMs: number;
}

export type AgentEvent = ToolEvent | SessionStartEvent | SessionEndEvent | OutcomeEvent;
export type Sink = (event: AgentEvent) => void;

export interface InstrumentOptions {
  sinks: Sink[];
  /**
   * How much of the arguments to record. Defaults to "shapes", which records
   * `{ query: "string" }` rather than what was searched for.
   */
  captureArguments?: "none" | "shapes" | "values";
  /** Parameter names to drop when capturing values. Matched case-insensitively. */
  redact?: string[];
  /** Capture agent-triggered form submits. On by default. */
  declarative?: boolean;
  /** Emit a session_end event when the page goes away. On by default. */
  sessionEnd?: boolean;
}

const DEFAULT_REDACT = [
  "password", "passwd", "pin", "token", "secret", "apikey", "api_key",
  "card", "card_number", "cvv", "cvc", "ssn", "email", "phone",
];

interface SessionState {
  id: string;
  startedAt: number;
  step: number;
  errors: number;
  lastTool?: string;
  converted: boolean;
  started: boolean;
  ended: boolean;
}

let active: { stop: () => void; session: SessionState; emit: (event: AgentEvent) => void } | undefined;

/**
 * Starts recording. Returns a function that stops and restores everything.
 * Safe to call more than once; later calls are ignored until you stop.
 */
export function instrument(options: InstrumentOptions): () => void {
  if (typeof document === "undefined") return () => {};
  if (active) return active.stop;

  const session: SessionState = {
    id: newSessionId(),
    startedAt: now(),
    step: 0,
    errors: 0,
    converted: false,
    started: false,
    ended: false,
  };
  const emit = makeEmitter(options.sinks);
  const teardowns: (() => void)[] = [];

  const record = (tool: string, kind: ToolKind, durationMs: number, ok: boolean, args: unknown, error?: string) => {
    if (!session.started) {
      session.started = true;
      session.startedAt = now();
      emit({ type: "session_start", sessionId: session.id, firstTool: tool });
    }

    const previousTool = session.lastTool;
    session.step += 1;
    session.lastTool = tool;
    if (!ok) session.errors += 1;

    emit({
      type: "tool_call",
      sessionId: session.id,
      tool,
      kind,
      durationMs: Math.round(durationMs),
      ok,
      ...(error ? { error } : {}),
      ...withArgs(args, options),
      step: session.step,
      sinceStartMs: Math.round(now() - session.startedAt),
      ...(previousTool ? { previousTool } : {}),
    });
  };

  const patched = patchRegisterTool(record);
  if (patched) teardowns.push(patched);

  if (options.declarative !== false) {
    teardowns.push(watchAgentSubmits(record));
  }

  if (options.sessionEnd !== false) {
    teardowns.push(watchPageExit(session, emit));
  }

  const stop = () => {
    for (const teardown of teardowns.reverse()) teardown();
    active = undefined;
  };
  active = { stop, session, emit };
  return stop;
}

/**
 * Report a business outcome — a purchase, a signup, a booking — so the journey
 * ties to something the business cares about.
 *
 * Deliberately silent outside an agent session: a human converting is your
 * ordinary analytics, and claiming it here would inflate every number that
 * makes this worth installing.
 */
export function recordOutcome(
  name: string,
  details: { value?: number; currency?: string } = {},
): void {
  if (!active || !active.session.started) return;

  active.session.converted = true;
  active.emit({
    type: "outcome",
    sessionId: active.session.id,
    name,
    ...(details.value !== undefined ? { value: details.value } : {}),
    ...(details.currency ? { currency: details.currency } : {}),
    toolCount: active.session.step,
    sinceStartMs: Math.round(now() - active.session.startedAt),
  });
}

type Recorder = (
  tool: string,
  kind: ToolKind,
  durationMs: number,
  ok: boolean,
  args: unknown,
  error?: string,
) => void;

/**
 * Wraps `registerTool` so every tool registered afterwards reports itself.
 *
 * Patching is a workaround, not a design: the spec has open proposals for
 * native lifecycle events and for real-user measurement. When those ship, only
 * this function changes — the event shapes and every sink stay as they are.
 */
function patchRegisterTool(record: Recorder): (() => void) | undefined {
  const context = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
  if (!context || typeof context.registerTool !== "function") return undefined;

  // Keep the original reference for restoration and a bound copy for calling —
  // restoring a bound copy would leave the page subtly different.
  const original = context.registerTool;
  const call = original.bind(context);

  context.registerTool = function registerTool(tool: ToolLike, ...rest: unknown[]) {
    if (!tool || typeof tool.execute !== "function") return call(tool as ToolLike, ...rest);

    const execute = tool.execute.bind(tool);
    const instrumented = { ...tool };

    instrumented.execute = async (args: unknown, ...extra: unknown[]) => {
      const startedAt = now();
      try {
        const result = await execute(args, ...extra);
        record(tool.name, "imperative", now() - startedAt, true, args);
        return result;
      } catch (error) {
        record(
          tool.name,
          "imperative",
          now() - startedAt,
          false,
          args,
          error instanceof Error ? error.message : String(error),
        );
        throw error; // never swallow the page's own failure
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
 * `registerTool`. The browser sets `agentInvoked` on the submit event instead,
 * which is the only agent signal a site gets for free, and it is the whole
 * surface on sites where the platform generated the tools.
 */
function watchAgentSubmits(record: Recorder): () => void {
  const onSubmit = (event: Event) => {
    if (!(event as SubmitEventLike).agentInvoked) return;
    const form = event.target as HTMLFormElement | null;
    const name = form?.getAttribute?.("toolname") ?? form?.getAttribute?.("name") ?? "(form)";
    record(name, "declarative", 0, true, readForm(form));
  };

  document.addEventListener("submit", onSubmit, true);
  return () => document.removeEventListener("submit", onSubmit, true);
}

/**
 * `pagehide` is the one exit signal browsers still honour reliably, and the
 * only chance to say whether the journey ended in a conversion or an abandon.
 */
function watchPageExit(session: SessionState, emit: (event: AgentEvent) => void): () => void {
  const finish = () => {
    if (!session.started || session.ended) return;
    session.ended = true;
    emit({
      type: "session_end",
      sessionId: session.id,
      toolCount: session.step,
      errorCount: session.errors,
      ...(session.lastTool ? { lastTool: session.lastTool } : {}),
      durationMs: Math.round(now() - session.startedAt),
      converted: session.converted,
    });
  };

  const onHide = () => {
    if (document.visibilityState === "hidden") finish();
  };

  window.addEventListener("pagehide", finish);
  document.addEventListener("visibilitychange", onHide);
  return () => {
    window.removeEventListener("pagehide", finish);
    document.removeEventListener("visibilitychange", onHide);
  };
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
    out[key] = mode === "shapes" ? describe(value) : isRedacted(key, redact) ? "[redacted]" : value;
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
function makeEmitter(sinks: Sink[]): (event: AgentEvent) => void {
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
