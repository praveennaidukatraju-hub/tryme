'use client';

import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { C, grad } from '@/components/tokens';
import type { CreditPlan } from './use-pricing-data';

export function CouponModal({
  plan,
  couponCode,
  setCouponCode,
  couponApplying,
  couponError,
  couponApplied,
  couponBonusPercent,
  displayBase,
  displayTax,
  displayTotal,
  onApply,
  onClose,
  onContinue,
}: {
  plan: CreditPlan;
  couponCode: string;
  setCouponCode: (v: string) => void;
  couponApplying: boolean;
  couponError: string;
  couponApplied: boolean;
  couponBonusPercent: number | null;
  displayBase: (basePaise: number) => string;
  displayTax: (basePaise: number) => string;
  displayTotal: (basePaise: number) => string;
  onApply: () => void;
  onClose: () => void;
  onContinue: () => void;
}) {
  const bonusCredits = couponBonusPercent
    ? Math.round(plan.credits * (couponBonusPercent / 100))
    : 0;
  const totalCredits = plan.credits + bonusCredits;
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
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000 }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="coupon-modal-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 1001,
          width: 'min(380px, calc(100vw - 32px))',
          maxWidth: 'calc(100vw - 32px)',
          background: C.white,
          borderRadius: 14,
          boxShadow: '0 16px 48px rgba(0,0,0,0.18)',
          padding: '20px 20px 18px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
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

        <div
          id="coupon-modal-title"
          style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 4 }}
        >
          {plan.name}
        </div>
        <div style={{ fontSize: 13, color: C.mid, marginBottom: 16 }}>
          {plan.credits.toLocaleString('en-IN')} credits
        </div>

        {/* Price breakdown */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: C.mid }}
          >
            <span>Plan price</span>
            <span style={{ color: C.text, fontWeight: 500 }}>{displayBase(plan.basePaise)}</span>
          </div>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: C.mid }}
          >
            <span>GST (18%)</span>
            <span style={{ color: C.text, fontWeight: 500 }}>{displayTax(plan.basePaise)}</span>
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
            <span>Total to pay</span>
            <span>{displayTotal(plan.basePaise)}</span>
          </div>
        </div>

        {couponApplied ? (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              background: 'rgba(0,180,100,0.08)',
              border: '1px solid rgba(0,180,100,0.3)',
              fontSize: 13,
              color: '#00a860',
              marginBottom: 16,
              lineHeight: 1.5,
            }}
          >
            {couponBonusPercent ? (
              <>
                🎉 Coupon applied — <strong>+{couponBonusPercent}% bonus</strong> on your first
                purchase.
                <br />
                {plan.credits.toLocaleString('en-IN')} + {bonusCredits.toLocaleString('en-IN')}{' '}
                bonus = <strong>{totalCredits.toLocaleString('en-IN')} credits</strong> total, at no
                extra cost.
              </>
            ) : (
              'Coupon applied — your first purchase now includes a bonus.'
            )}
          </div>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <label
              htmlFor="coupon-code"
              style={{
                display: 'block',
                fontSize: 13,
                fontWeight: 600,
                color: C.text,
                marginBottom: 2,
              }}
            >
              Have a coupon code?
            </label>
            <p style={{ fontSize: 12, color: C.mid, margin: '0 0 8px' }}>
              First-time buyers get bonus credits added to this purchase at no extra cost — enter a
              valid code below to apply it.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id="coupon-code"
                type="text"
                value={couponCode}
                onChange={(e) => setCouponCode(e.target.value)}
                placeholder="Enter code"
                disabled={couponApplying}
                style={{
                  flex: 1,
                  padding: '9px 12px',
                  borderRadius: 8,
                  border: `1px solid ${C.border}`,
                  fontSize: 13,
                  color: C.text,
                  outline: 'none',
                }}
              />
              <button
                type="button"
                onClick={onApply}
                disabled={couponApplying || !couponCode.trim()}
                style={{
                  padding: '9px 16px',
                  borderRadius: 8,
                  border: 'none',
                  background: '#141414',
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: couponApplying || !couponCode.trim() ? 'not-allowed' : 'pointer',
                  opacity: couponApplying || !couponCode.trim() ? 0.5 : 1,
                }}
              >
                {couponApplying ? 'Applying…' : 'Apply'}
              </button>
            </div>
            {couponError ? (
              <p style={{ fontSize: 12, color: C.pink, margin: '8px 0 0' }}>{couponError}</p>
            ) : (
              <p style={{ fontSize: 11, color: C.light, margin: '8px 0 0' }}>
                No code? No problem — you can continue without one.
              </p>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onContinue}
          disabled={couponApplying}
          style={{
            width: '100%',
            padding: '10px 24px',
            background: grad,
            border: 'none',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            color: '#fff',
            cursor: couponApplying ? 'not-allowed' : 'pointer',
            opacity: couponApplying ? 0.6 : 1,
          }}
        >
          Continue to Payment
        </button>
      </div>
    </div>
  );
}
