const COLORS = ["#e85d4c", "#3d8bfd", "#2ea043", "#d4a017", "#a371f7", "#39c5cf", "#f0883e", "#db61a2"];

export function colorForId(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length] ?? COLORS[0]!;
}
