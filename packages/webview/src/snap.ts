export type SnapBox = { id?: string; x: number; y: number; width: number; height: number };
export type PageSize = { width: number; height: number };
export type SnapGuide = { axis: "x" | "y"; position: number };
export type SnapMove = { x: number; y: number; guides: SnapGuide[] };
export type SnapSize = SnapMove & { width: number; height: number };

export const SNAP_SCREEN_PX = 24;

export function snapThreshold(zoom: number): number {
  return SNAP_SCREEN_PX / Math.max(zoom, 0.1);
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

export function snapResize(moving: SnapBox, targets: SnapBox[], page: PageSize, threshold: number): SnapSize {
  const xs = xStops(targets, page);
  const ys = yStops(targets, page);
  const left = closestStop(moving.x, xs, threshold);
  const right = closestStop(moving.x + moving.width, xs, threshold);
  const top = closestStop(moving.y, ys, threshold);
  const bottom = closestStop(moving.y + moving.height, ys, threshold);
  let { x, y, width, height } = moving;
  const guides: SnapGuide[] = [];
  if (left !== undefined && right !== undefined) {
    x = left;
    width = Math.max(1, right - left);
    guides.push({ axis: "x", position: left }, { axis: "x", position: right });
  } else if (left !== undefined) {
    width = Math.max(1, x + width - left);
    x = left;
    guides.push({ axis: "x", position: left });
  } else if (right !== undefined) {
    width = Math.max(1, right - x);
    guides.push({ axis: "x", position: right });
  }
  if (top !== undefined && bottom !== undefined) {
    y = top;
    height = Math.max(1, bottom - top);
    guides.push({ axis: "y", position: top }, { axis: "y", position: bottom });
  } else if (top !== undefined) {
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

function closestStop(value: number, stops: number[], threshold: number): number | undefined {
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
