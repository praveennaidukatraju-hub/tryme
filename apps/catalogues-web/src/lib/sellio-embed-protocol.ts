// Shared contract for the postMessage channel between the Sellio demo
// page (parent, apps/catalogues-web .../sellio/sellio-demo.tsx)
// and the embedded generation wizard it loads in a same-origin <iframe>
// (apps/catalogues-web/src/app/embed/sellio-studio/). Both sides must
// stay in lockstep with this shape — import it, never hand-roll the message.

export const EMBED_IMAGE_SELECTED = 'tryme:image-selected' as const;

export interface EmbedImageSelectedMessage {
  type: typeof EMBED_IMAGE_SELECTED;
  imageUrl: string;
  jobId: string;
  poseLabel: string;
}

export function isEmbedImageSelectedMessage(data: unknown): data is EmbedImageSelectedMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === EMBED_IMAGE_SELECTED &&
    typeof msg.imageUrl === 'string' &&
    typeof msg.jobId === 'string' &&
    typeof msg.poseLabel === 'string'
  );
}

/** Call from inside the embedded iframe when the merchant confirms a result. */
export function postImageSelectedToParent(msg: {
  imageUrl: string;
  jobId: string;
  poseLabel: string;
}): void {
  const payload: EmbedImageSelectedMessage = { type: EMBED_IMAGE_SELECTED, ...msg };
  window.parent.postMessage(payload, window.location.origin);
}
