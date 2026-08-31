'use client';

import { Headphones, Paperclip, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { C, grad } from './tokens';

type Stage = 'idle' | 'submitting' | 'done' | 'error';

export function SupportButton() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function handleClose() {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title="Customer Support"
        onClick={() => setOpen(true)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 40,
          height: 40,
          minWidth: 40,
          minHeight: 40,
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          background: C.white,
          color: C.mid,
          flexShrink: 0,
          boxSizing: 'border-box',
          cursor: 'pointer',
        }}
      >
        <Headphones size={16} />
      </button>
      {open && <SupportModal onClose={handleClose} />}
    </>
  );
}

export function SupportModal({
  onClose,
  initialMessage = '',
}: {
  onClose: () => void;
  initialMessage?: string;
}) {
  const [message, setMessage] = useState(initialMessage);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [errMsg, setErrMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const canSubmit = message.trim().length > 0 && stage === 'idle';

  useEffect(() => {
    const el = modalRef.current;
    if (!el) return;
    const FOCUSABLE =
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = el.querySelectorAll<HTMLElement>(FOCUSABLE);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => document.removeEventListener('keydown', trap);
  }, [onClose]);

  async function handleSubmit() {
    if (!message.trim()) return;
    setStage('submitting');
    setErrMsg('');
    try {
      let attachmentKey: string | undefined;

      if (file) {
        const { uploadUrl, attachmentKey: key } = await api.post<{
          uploadUrl: string;
          attachmentKey: string;
        }>('/v1/support/presign', { contentType: file.type });
        await fetch(uploadUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': file.type },
        });
        attachmentKey = key;
      }

      await api.post('/v1/support', {
        message: message.trim(),
        attachmentKey,
      });

      setStage('done');
    } catch (e) {
      setErrMsg((e as Error).message || 'Failed to submit ticket');
      setStage('error');
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismisses modal
    <div
      role="presentation"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        zIndex: 1000,
      }}
    >
      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="support-modal-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 1001,
          width: 'min(400px, calc(100vw - 32px))',
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: '85vh',
          overflowY: 'auto',
          background: C.white,
          borderRadius: 14,
          boxShadow: '0 16px 48px rgba(0,0,0,0.18)',
          padding: '20px 20px 18px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            marginBottom: 6,
          }}
        >
          <div>
            <div
              id="support-modal-title"
              style={{ fontSize: 17, fontWeight: 700, color: C.text, lineHeight: 1.3 }}
            >
              {stage === 'done'
                ? 'Thank you for reaching out to us!'
                : "Have a question? We're here to help"}
            </div>
            {stage !== 'done' && (
              <div style={{ fontSize: 13, color: C.mid, marginTop: 4 }}>
                Share your concern and our team will get back to you shortly.
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: C.mid,
              padding: 4,
              borderRadius: 6,
              display: 'flex',
              flexShrink: 0,
              marginLeft: 12,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {stage === 'done' ? (
          <div
            style={{
              marginTop: 24,
              padding: '24px 20px',
              borderRadius: 12,
              background: 'color-mix(in srgb, #7C3AED 8%, transparent)',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 8 }}>✓</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>
              Your message has been sent!
            </div>
            <div style={{ fontSize: 13, color: C.mid, marginTop: 4 }}>
              We&apos;ll get back to you as soon as possible.
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{
                marginTop: 16,
                padding: '8px 24px',
                background: grad,
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </div>
        ) : (
          <>
            {/* Message */}
            <div style={{ marginTop: 20 }}>
              <label
                htmlFor="support-message"
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: C.text,
                  display: 'block',
                  marginBottom: 8,
                }}
              >
                Your Message
              </label>
              <textarea
                id="support-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Please provide a clear description of your query"
                rows={5}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  padding: '10px 12px',
                  fontSize: 13,
                  color: C.text,
                  background: C.field,
                  resize: 'vertical',
                  outline: 'none',
                  fontFamily: 'inherit',
                  lineHeight: 1.55,
                }}
              />
              <div style={{ fontSize: 12, color: C.mid, marginTop: 6 }}>
                The more details you share, the faster we can help.
              </div>
            </div>

            {/* Attachment */}
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 8 }}>
                Attachment
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  overflow: 'hidden',
                  background: C.field,
                }}
              >
                <span
                  style={{
                    flex: 1,
                    padding: '9px 12px',
                    fontSize: 13,
                    color: file ? C.text : C.mid,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {file ? file.name : 'No file chosen'}
                </span>
                {file && (
                  <button
                    type="button"
                    aria-label="Remove file"
                    onClick={() => {
                      setFile(null);
                      if (fileRef.current) fileRef.current.value = '';
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: C.mid,
                      padding: '0 8px',
                      display: 'flex',
                    }}
                  >
                    <X size={14} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  style={{
                    padding: '9px 16px',
                    background: C.white,
                    border: 'none',
                    borderLeft: `1px solid ${C.border}`,
                    fontSize: 13,
                    fontWeight: 600,
                    color: C.text,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <Paperclip size={13} />
                  Browse
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  style={{ display: 'none' }}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </div>
            </div>

            {/* Error */}
            {stage === 'error' && (
              <div style={{ marginTop: 12, fontSize: 13, color: '#DC2626' }}>{errMsg}</div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: '9px 20px',
                  background: 'none',
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 500,
                  color: C.text,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                style={{
                  padding: '9px 24px',
                  background: grad,
                  border: 'none',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#fff',
                  cursor: canSubmit ? 'pointer' : 'default',
                  opacity: canSubmit ? 1 : 0.4,
                  transition: 'opacity 0.15s',
                }}
              >
                {stage === 'submitting' ? 'Sending…' : 'Submit'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
