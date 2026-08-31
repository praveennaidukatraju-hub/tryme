'use client';
import { useEffect, useRef } from 'react';
import { SpinnerIcon } from '@/components/icons';
import { C } from '@/components/tokens';

/**
 * Branded confirmation modal — replacement for native window.confirm().
 * Controlled via `open`; parent owns the action + busy/error state.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  const dialogRef = useRef<HTMLDivElement>(null);
  // Focus trap + initial focus
  useEffect(() => {
    if (!open) return;
    const el = dialogRef.current;
    if (!el) return;
    const FOCUSABLE =
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = el.querySelectorAll<HTMLElement>(FOCUSABLE);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    // Focus the confirm button (last) by default so Enter is ready
    last?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => document.removeEventListener('keydown', trap);
  }, [open]);

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-outside-to-dismiss backdrop; Escape key is already handled above for keyboard users
    <div
      role="presentation"
      onClick={() => {
        if (!busy) onCancel();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 1100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: onClick only stops the backdrop click from bubbling, not a real click action */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.white,
          borderRadius: 14,
          padding: 24,
          width: 380,
          maxWidth: '100%',
          boxShadow: '0 12px 48px rgba(0,0,0,0.18)',
        }}
      >
        <h3
          id="confirm-dialog-title"
          style={{ fontSize: 16, fontWeight: 700, color: C.text, margin: '0 0 8px' }}
        >
          {title}
        </h3>
        {message && (
          <p style={{ fontSize: 14, lineHeight: 1.6, color: C.mid, margin: '0 0 16px' }}>
            {message}
          </p>
        )}
        {error && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: `1px solid ${C.pink}`,
              background: 'rgba(245,92,122,0.06)',
              fontSize: 13,
              color: C.pink,
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              height: 40,
              padding: '0 18px',
              borderRadius: 8,
              border: `1px solid ${C.border2}`,
              background: C.white,
              color: C.text,
              fontFamily: 'inherit',
              fontSize: 14,
              fontWeight: 600,
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={{
              height: 40,
              padding: '0 18px',
              borderRadius: 8,
              border: 'none',
              background: danger ? C.pink : C.dark,
              color: C.white,
              fontFamily: 'inherit',
              fontSize: 14,
              fontWeight: 600,
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.7 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {busy && <SpinnerIcon size={14} />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
