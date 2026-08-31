export interface TrayGarment {
  /** Stable client-side id. Not the R2 key — that arrives after the upload. */
  id: string;
  /** null while the upload is in flight or has failed. */
  r2Key: string | null;
  previewUrl: string;
  fileName: string;
  progress: number;
  error: string | null;
}

export interface BatchRowState {
  id: string;
  garmentId: string | null;
  faceId: string;
  backgroundId: string;
  poseIds: string[];
  lowerCatalogId: string;
  shoeCatalogId: string;
}

export interface PoseOption {
  id: string;
  hasLower: boolean;
  hasShoes: boolean;
}
