'use client';

import { GSTIN_REGEX } from '@tryme/types';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { C, grad } from '@/components/tokens';
import type { CreditPlan } from './use-pricing-data';

export function GstinConfirmModal({
  plan,
  gstin,
  setGstin,
  displayBase,
  displayTax,
  displayTotal,
  onClose,
  onPay,
}: {
  plan: CreditPlan;
  gstin: string;
  setGstin: (v: string) => void;
  displayBase: (basePaise: number) => string;
  displayTax: (basePaise: number) => string;
  displayTotal: (basePaise: number) => string;
  onClose: () => void;
  onPay: () => void;
}) {
  const [error, setError] = useState('');
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

  function handlePay() {
    const trimmed = gstin.trim().toUpperCase();
    if (trimmed && !GSTIN_REGEX.test(trimmed)) {
      setError('Invalid GSTIN format');
      return;
    }
    setError('');
    setGstin(trimmed);
    onPay();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismisses modal
    <div
      role="presentation"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000 }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(420px, calc(100vw - 32px))',
          background: C.white,
          borderRadius: 16,
          padding: 24,
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 16,
            right: 16,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: C.mid,
          }}
        >
          <X size={20} />
        </button>

        <div
          style={{
            background: C.field,
            borderRadius: 12,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>
            Have a GSTIN? <span style={{ fontWeight: 400, color: C.mid }}>(optional)</span>
          </div>
          <div style={{ fontSize: 12, color: C.mid, marginBottom: 10 }}>
            Add it to get a GST invoice you can claim as input tax credit. Leave blank and you'll
            still get a tax invoice for your records.
          </div>
          <input
            placeholder="GSTIN (e.g. 27AAPFU0939F1ZV)"
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
            style={{
              width: '100%',
              height: 44,
              borderRadius: 8,
              background: C.white,
              border: `1px solid ${error ? C.pink : C.border}`,
              fontFamily: 'inherit',
              fontSize: 14,
              color: C.text,
              padding: '0 14px',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          {error && <div style={{ fontSize: 12, color: C.pink, marginTop: 6 }}>{error}</div>}
        </div>

        <div
          style={{
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 13,
              marginBottom: 8,
            }}
          >
            <span style={{ color: C.mid }}>Subtotal</span>
            <span style={{ color: C.text }}>{displayBase(plan.basePaise)}</span>
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 13,
              marginBottom: 8,
            }}
          >
            <span style={{ color: C.mid }}>GST @ 18%</span>
            <span style={{ color: C.text }}>{displayTax(plan.basePaise)}</span>
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 15,
              fontWeight: 700,
              paddingTop: 8,
              borderTop: `1px solid ${C.border}`,
            }}
          >
            <span style={{ color: C.text }}>Total</span>
            <span style={{ color: C.text }}>{displayTotal(plan.basePaise)}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={handlePay}
          style={{
            width: '100%',
            padding: '14px 0',
            borderRadius: 12,
            border: 'none',
            background: grad,
            color: '#fff',
            fontWeight: 700,
            fontSize: 15,
            cursor: 'pointer',
          }}
        >
          Pay {displayTotal(plan.basePaise)}
        </button>
        <div style={{ textAlign: 'center', fontSize: 11, color: C.mid, marginTop: 8 }}>
          Secure payment via Razorpay
        </div>
      </div>
    </div>
  );
}
