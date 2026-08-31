export function resizeToMax(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    throw new Error(`resizeToMax: invalid dimensions ${width}x${height}`);
  }
  if (width === height) {
    return { width: max, height: max };
  }
  if (width > height) {
    const ratio = height / width;
    return { width: max, height: Math.round(max * ratio) };
  }
  const ratio = width / height;
  return { width: Math.round(max * ratio), height: max };
}
