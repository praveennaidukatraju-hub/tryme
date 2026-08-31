import { useState } from 'react';

export function AssetThumb({
  thumbnailUrl,
  fullUrl,
  label,
  w = 64,
  h = 64,
  onPreview,
  cursor,
}: {
  thumbnailUrl?: string | null;
  fullUrl?: string | null;
  label: string;
  w?: number;
  h?: number;
  onPreview?: (url: string) => void;
  cursor?: string;
}) {
  const [broken, setBroken] = useState(false);
  const src = thumbnailUrl && !broken ? thumbnailUrl : null;
  if (src) {
    const img = (
      // biome-ignore lint/performance/noImgElement: admin panel
      <img
        src={src}
        alt={label}
        loading="lazy"
        style={{
          width: w,
          height: h,
          objectFit: 'cover',
          borderRadius: 6,
          flexShrink: 0,
          display: 'block',
          cursor: cursor ?? (fullUrl ? 'zoom-in' : undefined),
        }}
        onError={() => setBroken(true)}
      />
    );
    return fullUrl ? (
      <a
        href={fullUrl}
        rel="noreferrer"
        style={{ flexShrink: 0 }}
        onClick={(e) => {
          e.preventDefault();
          onPreview?.(fullUrl);
        }}
      >
        {img}
      </a>
    ) : (
      img
    );
  }
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: 6,
        background: 'var(--subtle)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        color: 'var(--muted)',
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {label.slice(0, 2).toUpperCase()}
    </div>
  );
}
