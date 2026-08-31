// Accepts a full YouTube URL (youtu.be/<id>, youtube.com/watch?v=<id>,
// youtube.com/embed/<id>, with or without extra query params) or a bare
// video ID, and returns just the video ID for embedding/thumbnails.
export function extractYoutubeId(input: string): string {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1);
    if (url.hostname.includes('youtube.com')) {
      const v = url.searchParams.get('v');
      if (v) return v;
      const embedMatch = url.pathname.match(/\/embed\/([^/?]+)/);
      if (embedMatch?.[1]) return embedMatch[1];
    }
  } catch {
    // Not a URL — assume it's already a bare video ID.
  }
  return trimmed;
}
