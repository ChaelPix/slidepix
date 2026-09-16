import { deckSchema, serializeDeck, type Deck } from "./schema.js";

export type DeckMergeResolution = "base" | "ours" | "theirs";
export type DeckMergeConflictKind = "value" | "delete-edit" | "order" | "invalid-result";

export type DeckMergeConflict = {
  id: string;
  kind: DeckMergeConflictKind;
  path: string;
  slideId?: string;
  elementId?: string;
  animationId?: string;
  base?: unknown;
  ours?: unknown;
  theirs?: unknown;
  message: string;
};

export type DeckMergeResult =
  | { ok: true; deck: Deck; text: string; conflicts: [] }
  | { ok: false; deck?: Deck; text?: string; conflicts: DeckMergeConflict[] };

type EntityContext = Pick<DeckMergeConflict, "slideId" | "elementId" | "animationId">;
type MergeState = {
  conflicts: DeckMergeConflict[];
  resolutions: Readonly<Record<string, DeckMergeResolution>>;
};

const missing = Symbol("missing");
type MaybeValue = unknown | typeof missing;

export function mergeDecks(
  base: Deck,
  ours: Deck,
  theirs: Deck,
  resolutions: Readonly<Record<string, DeckMergeResolution>> = {}
): DeckMergeResult {
  const state: MergeState = { conflicts: [], resolutions };
  const candidate = mergeValue(base, ours, theirs, [], {}, state);
  if (candidate === missing || !isRecord(candidate)) {
    addConflict(state, "invalid-result", [], {}, base, ours, theirs, "The merged deck has no document root.");
    return { ok: false, conflicts: state.conflicts };
  }

  const parsed = deckSchema.safeParse(candidate);
  if (!parsed.success) {
    let fallbackResolution: DeckMergeResolution | undefined;
    for (const issue of parsed.error.issues) {
      const issuePath = issue.path.map(String);
      const id = conflictId("invalid-result", issuePath, {});
      fallbackResolution ??= state.resolutions[id];
      addConflict(
        state,
        "invalid-result",
        issuePath,
        {},
        undefined,
        valueAtPath(ours, issue.path),
        valueAtPath(theirs, issue.path),
        `The combined result is invalid: ${issue.message}. Resolving this integrity conflict keeps the complete selected deck version.`
      );
    }
    if (!state.conflicts.length && fallbackResolution) {
      const fallback = fallbackResolution === "base" ? base : fallbackResolution === "theirs" ? theirs : ours;
      const validated = deckSchema.parse(fallback);
      return { ok: true, deck: validated, text: serializeDeck(validated), conflicts: [] };
    }
    return { ok: false, conflicts: state.conflicts };
  }

  const text = serializeDeck(parsed.data);
  return state.conflicts.length
    ? { ok: false, deck: parsed.data, text, conflicts: state.conflicts }
    : { ok: true, deck: parsed.data, text, conflicts: [] };
}

function mergeValue(
  base: MaybeValue,
  ours: MaybeValue,
  theirs: MaybeValue,
  path: string[],
  entity: EntityContext,
  state: MergeState
): MaybeValue {
  if (same(ours, theirs)) return clone(ours);
  if (same(ours, base)) return clone(theirs);
  if (same(theirs, base)) return clone(ours);

  if (base !== missing && ours !== missing && theirs !== missing && isRecord(base) && isRecord(ours) && isRecord(theirs)) {
    const result: Record<string, unknown> = {};
    const keys = orderedKeys(base, ours, theirs);
    for (const key of keys) {
      const merged = mergeValue(
        Object.hasOwn(base, key) ? base[key] : missing,
        Object.hasOwn(ours, key) ? ours[key] : missing,
        Object.hasOwn(theirs, key) ? theirs[key] : missing,
        [...path, key],
        entity,
        state
      );
      if (merged !== missing) result[key] = merged;
    }
    return result;
  }

  if (base !== missing && ours !== missing && theirs !== missing && Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs)) {
    const field = path.at(-1);
    if (field === "slides") return mergeEntityArray(base, ours, theirs, path, "slideId", entity, state);
    if (field === "elements") return mergeEntityArray(base, ours, theirs, path, "elementId", entity, state);
    if (field === "timeline") return mergeEntityArray(base, ours, theirs, path, "animationId", entity, state);
    return mergeIndexedArray(base, ours, theirs, path, entity, state);
  }

  const kind: DeckMergeConflictKind = base !== missing && (ours === missing || theirs === missing) ? "delete-edit" : "value";
  const id = conflictId(kind, path, entity);
  const resolution = state.resolutions[id];
  if (!resolution) {
    addConflict(
      state,
      kind,
      path,
      entity,
      display(base),
      display(ours),
      display(theirs),
      kind === "delete-edit" ? "One side deleted a value that the other side edited." : "Both sides changed the same value differently."
    );
  }
  return clone(selectResolution(resolution ?? "ours", base, ours, theirs));
}

function mergeIndexedArray(base: unknown[], ours: unknown[], theirs: unknown[], path: string[], entity: EntityContext, state: MergeState): unknown[] {
  const length = Math.max(base.length, ours.length, theirs.length);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const merged = mergeValue(
      index < base.length ? base[index] : missing,
      index < ours.length ? ours[index] : missing,
      index < theirs.length ? theirs[index] : missing,
      [...path, String(index)],
      entity,
      state
    );
    if (merged !== missing) result.push(merged);
  }
  return result;
}

function mergeEntityArray(
  base: unknown[],
  ours: unknown[],
  theirs: unknown[],
  path: string[],
  entityKey: "slideId" | "elementId" | "animationId",
  parentEntity: EntityContext,
  state: MergeState
): unknown[] {
  const baseMap = entityMap(base);
  const oursMap = entityMap(ours);
  const theirsMap = entityMap(theirs);
  const ids = orderedUnique([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);
  const merged = new Map<string, unknown>();

  for (const id of ids) {
    const entity = { ...parentEntity, [entityKey]: id };
    const value = mergeValue(
      baseMap.has(id) ? baseMap.get(id)! : missing,
      oursMap.has(id) ? oursMap.get(id)! : missing,
      theirsMap.has(id) ? theirsMap.get(id)! : missing,
      [...path, id],
      entity,
      state
    );
    if (value !== missing) merged.set(id, value);
  }

  const surviving = new Set(merged.keys());
  const baseIds = idsOf(base).filter((id) => surviving.has(id));
  const oursIds = idsOf(ours).filter((id) => surviving.has(id));
  const theirsIds = idsOf(theirs).filter((id) => surviving.has(id));
  const baseMembers = new Set(idsOf(base));
  const oursChanged = reordered(baseIds, oursIds, baseMembers);
  const theirsChanged = reordered(baseIds, theirsIds, baseMembers);
  let orderedBaseIds = baseIds;

  if (oursChanged && theirsChanged && !same(existingIds(oursIds, baseMembers), existingIds(theirsIds, baseMembers))) {
    const orderPath = [...path, "$order"];
    const orderEntity = parentEntity;
    const id = conflictId("order", orderPath, orderEntity);
    const resolution = state.resolutions[id];
    if (!resolution) {
      addConflict(state, "order", orderPath, orderEntity, baseIds, oursIds, theirsIds, "Both sides reordered the same collection differently.");
    }
    orderedBaseIds = existingIds(
      resolution === "theirs" ? theirsIds : resolution === "base" ? baseIds : oursIds,
      baseMembers
    );
  } else if (oursChanged) {
    orderedBaseIds = existingIds(oursIds, baseMembers);
  } else if (theirsChanged) {
    orderedBaseIds = existingIds(theirsIds, baseMembers);
  }

  const additions = additionsByAnchor(oursIds, baseMembers, surviving);
  const theirsAdditions = additionsByAnchor(theirsIds, baseMembers, surviving);
  for (const [anchor, values] of theirsAdditions) {
    const current = additions.get(anchor) ?? [];
    additions.set(anchor, [...current, ...values.filter((id) => !current.includes(id))]);
  }

  const order: string[] = [...(additions.get(undefined) ?? [])];
  for (const id of orderedBaseIds) {
    if (surviving.has(id)) order.push(id);
    order.push(...(additions.get(id) ?? []));
  }
  for (const id of merged.keys()) if (!order.includes(id)) order.push(id);
  return order.map((id) => merged.get(id)!);
}

function entityMap(values: unknown[]): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const value of values) if (isRecord(value) && typeof value.id === "string") result.set(value.id, value);
  return result;
}

function idsOf(values: unknown[]): string[] {
  return values.flatMap((value) => isRecord(value) && typeof value.id === "string" ? [value.id] : []);
}

function existingIds(ids: string[], baseMembers: Set<string>): string[] {
  return ids.filter((id) => baseMembers.has(id));
}

function reordered(baseIds: string[], sideIds: string[], baseMembers: Set<string>): boolean {
  const sideExisting = existingIds(sideIds, baseMembers);
  const sideSet = new Set(sideExisting);
  return !same(sideExisting, baseIds.filter((id) => sideSet.has(id)));
}

function additionsByAnchor(ids: string[], baseMembers: Set<string>, surviving: Set<string>): Map<string | undefined, string[]> {
  const result = new Map<string | undefined, string[]>();
  let anchor: string | undefined;
  for (const id of ids) {
    if (!surviving.has(id)) continue;
    if (baseMembers.has(id)) {
      anchor = id;
      continue;
    }
    const values = result.get(anchor) ?? [];
    if (!values.includes(id)) values.push(id);
    result.set(anchor, values);
  }
  return result;
}

function addConflict(
  state: MergeState,
  kind: DeckMergeConflictKind,
  path: string[],
  entity: EntityContext,
  base: unknown,
  ours: unknown,
  theirs: unknown,
  message: string
): void {
  const id = conflictId(kind, path, entity);
  if (state.resolutions[id] || state.conflicts.some((conflict) => conflict.id === id)) return;
  state.conflicts.push({ id, kind, path: path.join("."), ...entity, base, ours, theirs, message });
}

function conflictId(kind: DeckMergeConflictKind, path: string[], entity: EntityContext): string {
  return [kind, entity.slideId, entity.elementId, entity.animationId, ...path].filter(Boolean).join(":");
}

function selectResolution(resolution: DeckMergeResolution, base: MaybeValue, ours: MaybeValue, theirs: MaybeValue): MaybeValue {
  if (resolution === "base") return base;
  if (resolution === "theirs") return theirs;
  return ours;
}

function orderedKeys(...values: Record<string, unknown>[]): string[] {
  return orderedUnique(values.flatMap((value) => Object.keys(value)));
}

function orderedUnique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(left: MaybeValue, right: MaybeValue): boolean {
  if (left === missing || right === missing) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone(value: MaybeValue): MaybeValue {
  return value === missing ? missing : structuredClone(value);
}

function display(value: MaybeValue): unknown {
  return value === missing ? undefined : value;
}

function valueAtPath(value: unknown, path: PropertyKey[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}
