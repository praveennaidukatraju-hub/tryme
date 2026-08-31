'use client';

import { X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { C, grad } from '@/components/tokens';
import type { PaymentResult } from './use-pricing-data';

export function PaymentResultModal({
  result,
  onClose,
}: {
  result: PaymentResult;
  onClose: () => void;
}) {
  const router = useRouter();
  const modalRef = useRef<HTMLDivElement>(null);

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
      {/* Modal panel */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-result-modal-title"
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
        {/* Close Button */}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={{
            position: 'absolute',
            top: 16,
            right: 16,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: C.mid,
            padding: 4,
            borderRadius: 6,
            display: 'flex',
          }}
        >
          <X size={18} />
        </button>

        {result.kind === 'success' ? (
          <div>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: 'color-mix(in srgb, #7C3AED 8%, transparent)',
                color: '#7C3AED',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 22,
                fontWeight: 700,
                margin: '4px auto 12px',
              }}
            >
              ✓
            </div>
            <div
              id="payment-result-modal-title"
              style={{
                fontSize: 17,
                fontWeight: 700,
                color: C.text,
                textAlign: 'center',
                marginBottom: 20,
              }}
            >
              Payment Successful — {result.planName}
            </div>

            {/* Price breakdown */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 13,
                  color: C.mid,
                }}
              >
                <span>Plan price</span>
                <span style={{ color: C.text, fontWeight: 500 }}>{result.base}</span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 13,
                  color: C.mid,
                }}
              >
                <span>GST (18%)</span>
                <span style={{ color: C.text, fontWeight: 500 }}>{result.tax}</span>
              </div>
              <div style={{ height: 1, background: C.border, margin: '2px 0' }} />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 14,
                  fontWeight: 600,
                  color: C.text,
                }}
              >
                <span>Total paid</span>
                <span>{result.total}</span>
              </div>
            </div>

            <div style={{ height: 1, background: C.border, margin: '16px 0' }} />

            {/* Credits breakdown */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {result.bonusPercent ? (
                <>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 13,
                      color: C.mid,
                    }}
                  >
                    <span>Plan credits</span>
                    <span style={{ color: C.text, fontWeight: 500 }}>
                      {result.baseCredits.toLocaleString('en-IN')}
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 13,
                      color: C.mid,
                    }}
                  >
                    <span>Bonus credits (+{result.bonusPercent}%)</span>
                    <span style={{ color: C.text, fontWeight: 500 }}>
                      +{result.bonusCredits.toLocaleString('en-IN')}
                    </span>
                  </div>
                  <div style={{ height: 1, background: C.border, margin: '2px 0' }} />
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 14,
                      fontWeight: 700,
                      color: C.pink,
                    }}
                  >
                    <span>Total credited</span>
                    <span>{result.totalCredits.toLocaleString('en-IN')}</span>
                  </div>
                </>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 14,
                    fontWeight: 700,
                    color: C.pink,
                  }}
                >
                  <span>Credits added</span>
                  <span>{result.totalCredits.toLocaleString('en-IN')}</span>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                router.push('/tryon');
                onClose();
              }}
              style={{
                width: '100%',
                marginTop: 24,
                padding: '10px 24px',
                background: grad,
                border: 'none',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              Continue
            </button>
          </div>
        ) : (
          <div>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: 'color-mix(in srgb, #DC2626 8%, transparent)',
                color: '#DC2626',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 22,
                fontWeight: 700,
                margin: '4px auto 12px',
              }}
            >
              !
            </div>
            <div
              id="payment-result-modal-title"
              style={{
                fontSize: 17,
                fontWeight: 700,
                color: C.text,
                textAlign: 'center',
                marginBottom: 8,
              }}
            >
              Payment Failed
            </div>
            <div
              style={{
                fontSize: 13,
                color: C.mid,
                textAlign: 'center',
                lineHeight: 1.5,
                marginBottom: 8,
              }}
            >
              {result.message}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  flex: 1,
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
                Close
              </button>
              <button
                type="button"
                onClick={() => {
                  result.onRetry();
                  onClose();
                }}
                style={{
                  flex: 1,
                  padding: '9px 24px',
                  background: grad,
                  border: 'none',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                Try Again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
