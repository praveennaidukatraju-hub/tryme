import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Option {
  id: string;
  label: string;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder,
  disabled,
  emptyLabel,
  id,
  style,
  ariaLabel,
}: {
  options: Option[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** When set, prepends a clearable "— none —"-style option that calls onChange(''). */
  emptyLabel?: string;
  id?: string;
  /** Passed through to the underlying input, e.g. for compact inline sizing in a toolbar. */
  style?: CSSProperties;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [coords, setCoords] = useState<{
    left: number;
    top: number;
    width: number;
    upward: boolean;
    maxHeight: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const DROPDOWN_MAX_HEIGHT = 220;

  function computeCoords() {
    const rect = inputRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const upward = spaceBelow < DROPDOWN_MAX_HEIGHT + 12 && spaceAbove > spaceBelow;
    const avail = (upward ? spaceAbove : spaceBelow) - 12;
    setCoords({
      left: rect.left,
      top: upward ? rect.top - 4 : rect.bottom + 4,
      width: rect.width,
      upward,
      maxHeight: Math.max(120, Math.min(DROPDOWN_MAX_HEIGHT, avail)),
    });
  }

  function openDropdown() {
    computeCoords();
    setOpen(true);
    setQuery('');
  }

  const allOptions = emptyLabel ? [{ id: '', label: emptyLabel }, ...options] : options;
  const selectedLabel = allOptions.find((o) => o.id === value)?.label ?? '';
  const filtered = query
    ? allOptions.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : allOptions;

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const inRoot = rootRef.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      if (!inRoot && !inDropdown) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  // Reposition the portalled dropdown when the page scrolls or resizes so it
  // stays glued to the input (portal is position:fixed relative to viewport).
  useEffect(() => {
    if (!open) return;
    const onReflow = () => computeCoords();
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        id={id}
        className="select"
        style={style}
        aria-label={ariaLabel}
        disabled={disabled}
        placeholder={placeholder}
        value={open ? query : selectedLabel}
        onFocus={openDropdown}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            setQuery('');
          }
        }}
      />
      {open &&
        coords &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: 'fixed',
              left: coords.left,
              width: coords.width,
              ...(coords.upward
                ? { bottom: window.innerHeight - coords.top }
                : { top: coords.top }),
              zIndex: 1000,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r)',
              boxShadow: 'var(--shadow-lg)',
              maxHeight: coords.maxHeight,
              overflowY: 'auto',
            }}
          >
            {filtered.length === 0 ? (
              <div style={{ padding: '9px 12px', fontSize: 13, color: 'var(--muted)' }}>
                No matches
              </div>
            ) : (
              filtered.map((o) => (
                <div
                  key={o.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange(o.id);
                    setOpen(false);
                    setQuery('');
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--surface-2)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background =
                      o.id === value ? 'var(--surface-2)' : 'transparent';
                  }}
                  style={{
                    padding: '9px 12px',
                    fontSize: 14,
                    color: 'var(--ink)',
                    cursor: 'pointer',
                    background: o.id === value ? 'var(--surface-2)' : 'transparent',
                  }}
                >
                  {o.label}
                </div>
              ))
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
