interface CatalogThumbProps {
  url?: string;
  style?: React.CSSProperties;
  type?: string;
  label?: string;
}

export function CatalogThumb({ url, style, label }: CatalogThumbProps) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: url ? `url(${url}) center/cover` : 'var(--subtle)',
        position: 'relative',
        display: 'grid',
        placeItems: 'center',
        ...style,
      }}
    >
      {label && (
        <span
          style={{
            fontFamily: 'monospace',
            fontSize: 9,
            letterSpacing: '0.1em',
            color: 'rgba(255,255,255,0.85)',
            textTransform: 'uppercase',
            background: 'rgba(0,0,0,0.5)',
            padding: '2px 6px',
            borderRadius: 3,
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}
