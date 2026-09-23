export type SnapBox = { id?: string; x: number; y: number; width: number; height: number };
export type PageSize = { width: number; height: number };
export type SnapGuide = { axis: "x" | "y"; position: number };
export type SnapMove = { x: number; y: number; guides: SnapGuide[] };
export type SnapSize = SnapMove & { width: number; height: number };
export type SnapEdges = { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean };

export const SNAP_SCREEN_PX = 24;
export const SNAP_RELEASE = 1.5;

export function snapThreshold(zoom: number): number {
  return SNAP_SCREEN_PX / Math.max(zoom, 0.1);
}

export function resizeEdges(direction: readonly number[]): SnapEdges {
  const dx = direction[0] ?? 0;
  const dy = direction[1] ?? 0;
  return { left: dx < 0, right: dx > 0, top: dy < 0, bottom: dy > 0 };
}

export function peerBoxes(
  elements: Array<{ id: string; x: number; y: number; width: number; height: number; hidden?: boolean }>,
  selectedIds: Iterable<string>,
): SnapBox[] {
  const skip = new Set(selectedIds);
  return elements
    .filter((element) => !element.hidden && !skip.has(element.id))
    .map((element) => ({ id: element.id, x: element.x, y: element.y, width: element.width, height: element.height }));
}

export function snapMove(moving: SnapBox, targets: SnapBox[], page: PageSize, threshold: number): SnapMove {
  const xs = xStops(targets, page);
  const ys = yStops(targets, page);
  const xSnap = closestDelta([moving.x, moving.x + moving.width / 2, moving.x + moving.width], xs, threshold);
  const ySnap = closestDelta([moving.y, moving.y + moving.height / 2, moving.y + moving.height], ys, threshold);
  const guides: SnapGuide[] = [];
  if (xSnap) guides.push({ axis: "x", position: xSnap.stop });
  if (ySnap) guides.push({ axis: "y", position: ySnap.stop });
  return { x: moving.x + (xSnap?.delta ?? 0), y: moving.y + (ySnap?.delta ?? 0), guides };
}

export function snapResize(
  moving: SnapBox,
  targets: SnapBox[],
  page: PageSize,
  threshold: number,
  edges: SnapEdges,
  hold: SnapGuide[] = [],
): SnapSize {
  const xs = xStops(targets, page);
  const ys = yStops(targets, page);
  const holdX = hold.find((guide) => guide.axis === "x")?.position;
  const holdY = hold.find((guide) => guide.axis === "y")?.position;
  const left = edges.left ? snapEdge(moving.x, xs, threshold, holdX) : undefined;
  const right = edges.right ? snapEdge(moving.x + moving.width, xs, threshold, holdX) : undefined;
  const top = edges.top ? snapEdge(moving.y, ys, threshold, holdY) : undefined;
  const bottom = edges.bottom ? snapEdge(moving.y + moving.height, ys, threshold, holdY) : undefined;
  let { x, y, width, height } = moving;
  const guides: SnapGuide[] = [];
  if (left !== undefined) {
    width = Math.max(1, x + width - left);
    x = left;
    guides.push({ axis: "x", position: left });
  } else if (right !== undefined) {
    width = Math.max(1, right - x);
    guides.push({ axis: "x", position: right });
  }
  if (top !== undefined) {
    height = Math.max(1, y + height - top);
    y = top;
    guides.push({ axis: "y", position: top });
  } else if (bottom !== undefined) {
    height = Math.max(1, bottom - y);
    guides.push({ axis: "y", position: bottom });
  }
  return { x, y, width, height, guides };
}

function xStops(targets: SnapBox[], page: PageSize): number[] {
  return unique([0, page.width / 2, page.width, ...targets.flatMap((box) => [box.x, box.x + box.width / 2, box.x + box.width])]);
}

function yStops(targets: SnapBox[], page: PageSize): number[] {
  return unique([0, page.height / 2, page.height, ...targets.flatMap((box) => [box.y, box.y + box.height / 2, box.y + box.height])]);
}

function closestDelta(edges: number[], stops: number[], threshold: number): { delta: number; stop: number } | undefined {
  let best: { delta: number; stop: number; distance: number } | undefined;
  for (const edge of edges) {
    for (const stop of stops) {
      const distance = Math.abs(edge - stop);
      if (distance > threshold) continue;
      if (!best || distance < best.distance) best = { delta: stop - edge, stop, distance };
    }
  }
  return best;
}

function snapEdge(value: number, stops: number[], threshold: number, hold?: number): number | undefined {
  if (hold !== undefined && Math.abs(value - hold) <= threshold * SNAP_RELEASE) return hold;
  let best: { stop: number; distance: number } | undefined;
  for (const stop of stops) {
    const distance = Math.abs(value - stop);
    if (distance > threshold) continue;
    if (!best || distance < best.distance) best = { stop, distance };
  }
  return best?.stop;
}

function unique(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value * 1000) / 1000))];
}
