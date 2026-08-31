'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { C } from '../tokens';

export type PremiumSelectOption = {
  value: string | number;
  label: string;
};

type Props = {
  value: string | number;
  onChange: (value: string | number) => void;
  options: PremiumSelectOption[];
  ariaLabel?: string;
  minWidth?: number;
  align?: 'left' | 'right';
  fullWidth?: boolean;
  height?: number;
  fontSize?: number;
  placeholder?: string;
  disabled?: boolean;
};

export function PremiumSelect({
  value,
  onChange,
  options,
  ariaLabel,
  minWidth = 110,
  align = 'left',
  fullWidth = false,
  height = 28,
  fontSize = 12.5,
  placeholder,
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number>(-1);
  const [popupRect, setPopupRect] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  const current = options.find((o) => o.value === value);
  const currentIdx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const baseId = useId();
  const listboxId = `listbox-${baseId}`;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Portal the popup to document.body so it isn't clipped by scrollable/overflow-hidden
  // ancestors (e.g. the rounded card wrapper on the Settings page), and keep it anchored
  // to the trigger as the page scrolls or resizes while open.
  useEffect(() => {
    if (!open) {
      setPopupRect(null);
      return;
    }
    const updateRect = () => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPopupRect({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    };
    updateRect();
    window.addEventListener('scroll', updateRect, true);
    window.addEventListener('resize', updateRect);
    return () => {
      window.removeEventListener('scroll', updateRect, true);
      window.removeEventListener('resize', updateRect);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setHoverIdx(-1);
      return;
    }
    setHoverIdx(currentIdx);
  }, [open, currentIdx]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHoverIdx((i) => Math.min(options.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHoverIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (hoverIdx >= 0 && hoverIdx < options.length) {
          const opt = options[hoverIdx];
          if (opt) onChange(opt.value);
          setOpen(false);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, hoverIdx, options, onChange]);

  useEffect(() => {
    if (open && listRef.current && hoverIdx >= 0) {
      const el = listRef.current.querySelector<HTMLDivElement>(`[data-idx="${hoverIdx}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }, [open, hoverIdx]);

  return (
    <div
      ref={wrapRef}
      style={{
        position: 'relative',
        display: fullWidth ? 'flex' : 'inline-flex',
        width: fullWidth ? '100%' : undefined,
      }}
    >
      <button
        type="button"
        role="combobox"
        className={disabled ? undefined : 'focus-ring hover-surface'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && hoverIdx >= 0 ? `${listboxId}-opt-${hoverIdx}` : undefined}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        style={{
          appearance: 'none',
          WebkitAppearance: 'none',
          MozAppearance: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          width: fullWidth ? '100%' : undefined,
          minWidth: fullWidth ? undefined : minWidth,
          height,
          padding: fullWidth ? '0 12px' : '0 22px 0 10px',
          borderRadius: 6,
          border: 'none',
          background: 'transparent',
          fontFamily: 'inherit',
          fontSize,
          fontWeight: 600,
          color: disabled ? C.light : C.text,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.7 : 1,
          transition: 'background-color .12s',
        }}
      >
        <span
          style={{
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: current ? C.text : C.mid,
            fontWeight: current ? 600 : 500,
          }}
        >
          {current?.label ?? placeholder ?? ''}
        </span>
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`,
            transition: 'transform .15s',
            opacity: 0.7,
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open &&
        popupRect &&
        createPortal(
          <div
            id={listboxId}
            ref={(node) => {
              listRef.current = node;
              popupRef.current = node;
            }}
            role="listbox"
            style={{
              position: 'fixed',
              top: popupRect.top,
              ...(align === 'right'
                ? { right: window.innerWidth - (popupRect.left + popupRect.width) }
                : { left: popupRect.left }),
              minWidth: popupRect.width,
              maxHeight: 240,
              overflowY: 'auto',
              background: C.card,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              boxShadow: '0 6px 20px rgba(0,0,0,0.12)',
              zIndex: 1200,
              padding: 4,
            }}
          >
            {options.map((opt, i) => {
              const isSelected = opt.value === value;
              const isHovered = i === hoverIdx;
              return (
                // biome-ignore lint/a11y/useFocusableInteractive: listbox managed focus via keyboard handler on container
                // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation handled by onKeyDown on trigger
                <div
                  key={opt.value}
                  id={`${listboxId}-opt-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setHoverIdx(i)}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '7px 10px',
                    borderRadius: 5,
                    fontSize: 12.5,
                    fontWeight: isSelected ? 600 : 500,
                    color: isSelected ? C.pink : C.text,
                    background: isHovered ? 'var(--c-merchant-hover)' : 'transparent',
                    cursor: 'pointer',
                    transition: 'background-color .08s, color .08s',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>{opt.label}</span>
                  {isSelected && (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
