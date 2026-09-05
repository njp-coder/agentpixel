/**
 * Tool-surface experiments.
 *
 * "Agents invoke `find_products` 37% more often than your current schema" reads
 * like it needs a panel of sites to compute. It does not: register two variants
 * of the same tool, assign one per page load, and the difference is measurable
 * from your own traffic.
 *
 * The assignment is recorded on every event this session emits, so the analysis
 * is a breakdown rather than a join.
 */

const assignments = new Map<string, string>();

/**
 * Assign this page load to one variant and remember it for the session.
 *
 * Call it before registering the tool it varies, then use the returned value
 * for whatever you are testing — the tool's name, its description, an enum, a
 * parameter you are considering adding.
 *
 * ```js
 * const naming = experiment("search-naming", ["search_products", "find_products"]);
 * ctx.registerTool({ name: naming.value, ... });
 * ```
 */
export function experiment<T extends string>(
  name: string,
  variants: readonly T[],
): { name: string; value: T } {
  if (variants.length === 0) {
    throw new Error(`experiment("${name}") needs at least one variant.`);
  }

  const existing = assignments.get(name);
  if (existing !== undefined && variants.includes(existing as T)) {
    return { name, value: existing as T };
  }

  const value = variants[Math.floor(Math.random() * variants.length)]!;
  assignments.set(name, value);
  return { name, value };
}

/** Force an assignment — for tests, or to honour an assignment made server-side. */
export function assign(name: string, value: string): void {
  assignments.set(name, value);
}

/** Every assignment made this page load, attached to each emitted event. */
export function currentAssignments(): Record<string, string> | undefined {
  if (assignments.size === 0) return undefined;
  return Object.fromEntries(assignments);
}

/** Clears assignments. Exposed for tests; a real page load starts empty anyway. */
export function resetExperiments(): void {
  assignments.clear();
}
