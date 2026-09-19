export type AlignBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  locked?: boolean;
};

export type PageSize = { width: number; height: number };
export type AlignAction = "left" | "center" | "right" | "top" | "middle" | "bottom" | "center-page";
export type AlignRelativeTo = "page" | "selection";
export type DistributeAction = "horizontal-centers" | "horizontal-gaps" | "vertical-centers" | "vertical-gaps";

type Bounds = { left: number; top: number; right: number; bottom: number; centerX: number; centerY: number };

export function applyAlign(boxes: AlignBox[], action: AlignAction, relativeTo: AlignRelativeTo, page: PageSize): AlignBox[] {
  const movable = boxes.filter((box) => !box.locked);
  if (!movable.length) return boxes;
  if (action === "center-page") {
    return boxes.map((box) => box.locked ? box : { ...box, x: (page.width - box.width) / 2, y: (page.height - box.height) / 2 });
  }
  const frame = relativeTo === "page" || boxes.length === 1 ? pageBounds(page) : boundsOf(boxes);
  return boxes.map((box) => {
    if (box.locked) return box;
    if (action === "left") return { ...box, x: frame.left };
    if (action === "center") return { ...box, x: frame.centerX - box.width / 2 };
    if (action === "right") return { ...box, x: frame.right - box.width };
    if (action === "top") return { ...box, y: frame.top };
    if (action === "middle") return { ...box, y: frame.centerY - box.height / 2 };
    return { ...box, y: frame.bottom - box.height };
  });
}

export function applyDistribute(boxes: AlignBox[], action: DistributeAction): AlignBox[] {
  const movable = boxes.filter((box) => !box.locked);
  if (movable.length < 3) return boxes;
  const horizontal = action === "horizontal-centers" || action === "horizontal-gaps";
  const ordered = [...movable].sort((a, b) => horizontal ? a.x - b.x || a.id.localeCompare(b.id) : a.y - b.y || a.id.localeCompare(b.id));
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const updates = new Map<string, AlignBox>();
  if (action === "horizontal-centers" || action === "vertical-centers") {
    const start = horizontal ? first.x + first.width / 2 : first.y + first.height / 2;
    const end = horizontal ? last.x + last.width / 2 : last.y + last.height / 2;
    const step = (end - start) / (ordered.length - 1);
    ordered.forEach((box, index) => {
      if (index === 0 || index === ordered.length - 1) return;
      const center = start + step * index;
      updates.set(box.id, horizontal ? { ...box, x: center - box.width / 2 } : { ...box, y: center - box.height / 2 });
    });
  } else {
    const span = horizontal
      ? last.x + last.width - first.x
      : last.y + last.height - first.y;
    const used = ordered.reduce((sum, box) => sum + (horizontal ? box.width : box.height), 0);
    const gap = (span - used) / (ordered.length - 1);
    let cursor = horizontal ? first.x : first.y;
    ordered.forEach((box, index) => {
      if (index > 0) {
        updates.set(box.id, horizontal ? { ...box, x: cursor } : { ...box, y: cursor });
      }
      cursor += (horizontal ? box.width : box.height) + gap;
    });
  }
  return boxes.map((box) => updates.get(box.id) ?? box);
}

function pageBounds(page: PageSize): Bounds {
  return { left: 0, top: 0, right: page.width, bottom: page.height, centerX: page.width / 2, centerY: page.height / 2 };
}

function boundsOf(boxes: AlignBox[]): Bounds {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { left, top, right, bottom, centerX: (left + right) / 2, centerY: (top + bottom) / 2 };
}
