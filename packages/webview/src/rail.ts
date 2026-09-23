export function railDropIndex(midpoints: number[], pointerY: number, from: number): number {
  let insert = 0;
  for (let index = 0; index < midpoints.length; index += 1) {
    if (pointerY > midpoints[index]!) insert = index + 1;
  }
  return Math.max(0, Math.min(midpoints.length - 1, insert > from ? insert - 1 : insert));
}
