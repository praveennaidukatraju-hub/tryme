'use client';
import { useRef, useState } from 'react';
import { ArrowLeft } from '@/components/icons';
import { C } from '@/components/tokens';
import { BoldPlusIcon } from './BoldPlusIcon';

// Same stops as the shared `grad` token, different angle — kept local to this
// app section so it doesn't shift the gradient on other pages that use `grad`.
const ctaGradient = 'linear-gradient(135deg, #521D9C 0.33%, #BD2587 50.77%, #F96657 99.67%)';

// This app section is designed light-only (see page.tsx's LIGHT constant) —
// the title/subtitle/back-icon must stay dark regardless of theme, since
// C.text turns near-white under html.dark and would vanish on the forced
// white background.
const HEADER_TEXT = '#141414';
const HEADER_SUBTITLE = '#626262';

interface HeaderAction {
  label: string;
  onClick: () => void;
}

type ScreenHeaderProps =
  | { variant: 'root' }
  | {
      variant: 'back';
      title: string;
      subtitle?: string;
      onBack: () => void;
      actions?: HeaderAction[];
    };

// Single action renders as the usual gradient CTA. 2+ actions collapse into one
// "+" trigger with an anchored popup menu — same pattern as LibraryUserMenu's
// sign-out popup (fixed position under the trigger, backdrop + Escape to close).
function HeaderActions({ actions }: { actions: HeaderAction[] }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ bottom: number; right: number } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  if (actions.length <= 1) {
    const single = actions[0];
    if (!single) return null;
    return (
      <button
        type="button"
        onClick={single.onClick}
        className="focus-ring hover-surface"
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 36,
          padding: '0 14px',
          borderRadius: 8,
          border: 'none',
          background: ctaGradient,
          color: '#fff',
          fontWeight: 600,
          fontSize: 13,
          whiteSpace: 'nowrap',
          cursor: 'pointer',
        }}
      >
        <BoldPlusIcon size={12} />
        {single.label}
      </button>
    );
  }

  return (
    <div ref={anchorRef} style={{ position: 'relative', flexShrink: 0 }}>
      {open && (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop closes popup */}
          <div
            role="presentation"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
            }}
            style={{ position: 'fixed', inset: 0, zIndex: 99 }}
          />
          <div
            style={{
              position: 'fixed',
              top: rect ? rect.bottom + 8 : 80,
              right: rect ? rect.right : 10,
              width: 230,
              background: C.card,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              overflow: 'hidden',
              zIndex: 100,
              boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            }}
          >
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="hover-surface"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  a.onClick();
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '12px 16px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: C.text,
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  textAlign: 'left',
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!open && anchorRef.current) {
            const r = anchorRef.current.getBoundingClientRect();
            setRect({ bottom: r.bottom, right: window.innerWidth - r.right });
          }
          setOpen((v) => !v);
        }}
        aria-label="More actions"
        className="focus-ring hover-surface"
        style={{
          width: 36,
          height: 36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 8,
          border: 'none',
          background: ctaGradient,
          color: '#fff',
          cursor: 'pointer',
        }}
      >
        <BoldPlusIcon size={14} />
      </button>
    </div>
  );
}

export function ScreenHeader(props: ScreenHeaderProps) {
  return (
    <>
      {props.variant === 'back' && (
        <div style={{ padding: '12px 16px 0', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            onClick={props.onBack}
            aria-label="Back"
            className="focus-ring hover-surface"
            style={{
              width: 40,
              height: 40,
              flexShrink: 0,
              borderRadius: 10,
              border: 'none',
              background: 'transparent',
              color: HEADER_TEXT,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <ArrowLeft />
          </button>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 17,
                fontWeight: 600,
                color: HEADER_TEXT,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {props.title}
            </div>
            {props.subtitle && (
              <div
                style={{
                  fontSize: 12,
                  color: HEADER_SUBTITLE,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {props.subtitle}
              </div>
            )}
          </div>

          {props.actions && props.actions.length > 0 && <HeaderActions actions={props.actions} />}
        </div>
      )}
    </>
  );
}
