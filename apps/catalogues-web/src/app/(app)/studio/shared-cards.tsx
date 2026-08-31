'use client';
import { CheckIcon } from '@/components/icons';
import { C } from '@/components/tokens';

// ── Gender card — horizontal landscape layout (SVG/PNG spec: Frame 446) ──
// border-image + border-radius are incompatible in CSS; gradient border is
// achieved via a 1px gradient-background wrapper (same visual result).
export function GenderCard({
  selected,
  onClick,
  img,
  label,
}: {
  selected: boolean;
  onClick: () => void;
  img: string | null;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="gender-card-hover"
      style={{
        cursor: 'pointer',
        background: selected
          ? `linear-gradient(${C.card}, ${C.card}) padding-box, linear-gradient(135deg, #BD2587 0%, #ff5b94 100%) border-box`
          : `linear-gradient(${C.card}, ${C.card}) padding-box, linear-gradient(${C.border}, ${C.border}) border-box`,
        border: '1.5px solid transparent',
        borderRadius: 12,
        padding: 0,
        boxShadow: selected ? '0px 2px 10px rgba(189, 37, 135, 0.1)' : 'none',
        height: 72,
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        textAlign: 'left',
        transition: 'box-shadow 0.2s, transform 0.2s',
        overflow: 'hidden',
      }}
    >
      <div
        className="gender-card-content"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: selected
            ? 'linear-gradient(135deg, rgba(189,37,135,0.06) 0%, rgba(255,91,148,0.04) 100%)'
            : C.card,
          borderRadius: 10,
          padding: '0 10px',
          position: 'relative',
          height: '100%',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            flexShrink: 0,
            width: 40,
            height: 40,
            borderRadius: '50%',
            overflow: 'hidden',
            background: C.lighter,
            boxSizing: 'border-box',
          }}
        >
          {img && (
            // eslint-disable-next-line @next/next/no-img-element
            // biome-ignore lint/performance/noImgElement: small UI thumbnail, Next Image not needed
            <img
              src={img}
              alt={label}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'top center',
                transform: 'scale(1.35)',
                transformOrigin: 'center 5%',
              }}
            />
          )}
        </div>

        <span
          className="gender-card-label"
          style={{
            fontFamily: 'inherit',
            fontWeight: 600,
            fontSize: 14,
            lineHeight: '1.3',
            letterSpacing: 0,
            color: C.text,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>

        {selected && (
          <div
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #BD2587 0%, #ff5b94 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CheckIcon color={C.white} size={11} />
          </div>
        )}
      </div>
    </button>
  );
}

// ── Selection card (model / bg / pose / catalog) ──
export function SelCard({
  selected,
  onClick,
  imageUrl,
  label,
  w = 130,
  h = 170,
  ratio,
  badges,
  emptyContent,
  borderWidth,
  fillHeight,
  imageObjectPosition = 'center',
}: {
  selected: boolean;
  onClick: () => void;
  imageUrl?: string | null;
  label?: string;
  w?: number | string;
  h?: number;
  ratio?: number;
  badges?: React.ReactNode;
  emptyContent?: React.ReactNode;
  borderWidth?: number;
  fillHeight?: boolean;
  imageObjectPosition?: string;
}) {
  const fluid = typeof w === 'string';
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: preview tile; parent button handles keyboard a11y
    <div
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick?.();
      }}
      className="garment-card"
      style={{
        cursor: 'pointer',
        textAlign: 'center',
        flexShrink: 0,
        width: typeof w === 'string' ? '100%' : w,
        background: selected
          ? `linear-gradient(${C.card}, ${C.card}) padding-box, linear-gradient(135deg, #BD2587 0%, #ff5b94 100%) border-box`
          : `linear-gradient(${C.card}, ${C.card}) padding-box, linear-gradient(${C.border}, ${C.border}) border-box`,
        border: `${borderWidth ?? 1.5}px solid transparent`,
        borderRadius: 12,
        padding: 0,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        transition: 'box-shadow 0.2s, transform 0.2s',
        boxShadow: selected ? '0px 2px 10px rgba(189, 37, 135, 0.1)' : 'none',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: 10,
          background: C.card,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          overflow: 'hidden',
        }}
      >
        <div
          className="sel-card-image"
          style={{
            width: '100%',
            aspectRatio: fluid && !fillHeight ? ratio : undefined,
            flex: fillHeight ? 1 : undefined,
            height: fluid ? undefined : h - 30,
            borderRadius: fillHeight ? 10 : '10px 10px 0 0',
            overflow: 'hidden',
            position: 'relative',
            background: C.lighter,
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              borderRadius: fillHeight ? 10 : '10px 10px 0 0',
              overflow: 'hidden',
              background: C.lighter,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {imageUrl ? (
              <div data-zoom style={{ width: '100%', height: '100%', transition: 'transform .3s' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {/* biome-ignore lint/performance/noImgElement: small selection card thumbnail */}
                <img
                  src={imageUrl}
                  alt={label}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    objectPosition: imageObjectPosition,
                  }}
                />
              </div>
            ) : emptyContent ? (
              emptyContent
            ) : (
              <span
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: C.mid,
                  textTransform: 'uppercase',
                  lineHeight: 1,
                }}
              >
                {label?.charAt(0)}
              </span>
            )}
          </div>
          {selected && (
            <div
              style={{
                position: 'absolute',
                top: 6,
                right: 6,
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #BD2587 0%, #ff5b94 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 2,
              }}
            >
              <CheckIcon color="#fff" size={11} />
            </div>
          )}
          {badges}
        </div>
        {label && (
          <div
            title={label}
            className="sel-card-label-box"
            style={{
              fontSize: 12,
              fontWeight: 600,
              lineHeight: 1.25,
              color: C.text,
              padding: '4px 6px',
              width: '100%',
              textAlign: 'center',
              height: 38,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              boxSizing: 'border-box',
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
            }}
          >
            {label}
          </div>
        )}
      </div>
    </div>
  );
}

export function SectionHead({
  title,
  subtitle,
  stepNumber,
  titleSuffix,
  right,
}: {
  title: string;
  subtitle?: string;
  stepNumber?: number;
  titleSuffix?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
        position: 'relative',
        width: '100%',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {stepNumber && (
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #BD2587 0%, #ff5b94 100%)',
              color: '#FFFFFF',
              fontSize: 13,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {stepNumber}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h3
            style={{
              fontWeight: 600,
              fontSize: 14,
              color: C.text,
              margin: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {title}
            {titleSuffix}
          </h3>
          {subtitle && <span style={{ fontSize: 11, color: C.mid }}>{subtitle}</span>}
        </div>
      </div>
      {right}
    </div>
  );
}

export const sectionCardStyle: React.CSSProperties = {
  background: C.card,
  borderRadius: 16,
  border: `1px solid ${C.border}`,
  boxShadow: '0 4px 12px rgba(0,0,0,0.03)',
  padding: '24px 20px',
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  boxSizing: 'border-box',
};
