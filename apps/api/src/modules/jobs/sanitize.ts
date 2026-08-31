export function promptGuard(s: string | undefined): string | null {
  if (!s) return null;
  return s
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
