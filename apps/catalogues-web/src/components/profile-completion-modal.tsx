'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { C, grad } from './tokens';

const PHONE_REGEX = /^\d{10}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sanitizePhone = (v: string) => v.replace(/\D/g, '').slice(0, 10);

export function ProfileCompletionModal({
  open,
  email,
  phone,
  companyName,
}: {
  open: boolean;
  email: string | null;
  phone: string | null;
  companyName: string | null;
}): React.ReactElement | null {
  const qc = useQueryClient();
  const modalRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const [phoneValue, setPhoneValue] = useState('');
  const [emailValue, setEmailValue] = useState('');
  const [companyValue, setCompanyValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setPhoneValue(sanitizePhone(phone ?? ''));
    setEmailValue(email ?? '');
    setCompanyValue(companyName ?? '');
    setError('');
  }, [open, email, phone, companyName]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => phoneRef.current?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = modalRef.current;
    if (!el) return;
    const focusable =
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const nodes = el.querySelectorAll<HTMLElement>(focusable);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
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

  async function handleSave() {
    const nextPhone = sanitizePhone(phoneValue);
    if (!PHONE_REGEX.test(nextPhone)) {
      setError('Enter a valid 10-digit mobile number.');
      return;
    }
    const needsEmail = !email;
    if (needsEmail && !EMAIL_REGEX.test(emailValue.trim())) {
      setError('Enter a valid email address.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await api.patch('/v1/me', {
        phone: nextPhone,
        companyName: companyValue.trim() || null,
        ...(needsEmail ? { email: emailValue.trim() } : {}),
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['me'] }),
        qc.invalidateQueries({ queryKey: ['credits'] }),
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save profile.';
      if (msg.includes('already assigned')) {
        setPhoneValue('');
      }
      if (msg.includes('already registered')) {
        setEmailValue('');
      }
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  const phoneValid = PHONE_REGEX.test(phoneValue);
  const emailValid = Boolean(email) || EMAIL_REGEX.test(emailValue.trim());

  return (
    <>
      <div
        role="presentation"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.52)',
          backdropFilter: 'blur(4px)',
          zIndex: 1200,
        }}
      />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-completion-title"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1201,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
        }}
      >
        <div
          style={{
            width: 560,
            maxWidth: '100%',
            borderRadius: 18,
            background: C.white,
            boxShadow: '0 24px 80px rgba(0,0,0,0.22)',
            border: `1px solid ${C.border}`,
            padding: 28,
          }}
        >
          <div style={{ marginBottom: 18 }}>
            <div
              id="profile-completion-title"
              style={{ fontSize: 22, fontWeight: 700, color: C.text, lineHeight: 1.25 }}
            >
              Complete your profile to unlock free credits
            </div>
            <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.6, color: C.mid }}>
              Complete your profile details to instantly receive free AI credits and start creating
              amazing catalog images
            </p>
          </div>

          {error && (
            <div
              role="alert"
              style={{
                marginBottom: 16,
                padding: '12px 14px',
                borderRadius: 10,
                border: `1px solid ${C.pink}`,
                background: 'rgba(245,92,122,0.06)',
                color: C.pink,
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {!email && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label
                  htmlFor="profile-email"
                  style={{ fontSize: 14, fontWeight: 600, color: C.text }}
                >
                  Email Address *
                </label>
                <input
                  id="profile-email"
                  type="email"
                  value={emailValue}
                  onChange={(e) => setEmailValue(e.target.value)}
                  placeholder="you@example.com"
                  style={{
                    height: 44,
                    borderRadius: 10,
                    border: `1px solid ${error ? C.pink : C.border}`,
                    background: C.field,
                    color: C.text,
                    fontFamily: 'inherit',
                    fontSize: 14,
                    padding: '0 14px',
                    outline: 'none',
                  }}
                />
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label
                htmlFor="profile-phone"
                style={{ fontSize: 14, fontWeight: 600, color: C.text }}
              >
                Mobile Number *
              </label>
              <input
                ref={phoneRef}
                id="profile-phone"
                type="tel"
                inputMode="numeric"
                maxLength={10}
                value={phoneValue}
                onChange={(e) => setPhoneValue(sanitizePhone(e.target.value))}
                placeholder="10-digit mobile number"
                style={{
                  height: 44,
                  borderRadius: 10,
                  border: `1px solid ${error ? C.pink : C.border}`,
                  background: C.field,
                  color: C.text,
                  fontFamily: 'inherit',
                  fontSize: 14,
                  padding: '0 14px',
                  outline: 'none',
                }}
              />
              <div style={{ fontSize: 12, color: C.mid }}>
                This number unlocks free credits and stays private.
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label
                htmlFor="profile-company"
                style={{ fontSize: 14, fontWeight: 600, color: C.text }}
              >
                Company Name <span style={{ color: C.mid, fontWeight: 500 }}>(optional)</span>
              </label>
              <input
                id="profile-company"
                type="text"
                value={companyValue}
                onChange={(e) => setCompanyValue(e.target.value)}
                placeholder="Enter company name"
                style={{
                  height: 44,
                  borderRadius: 10,
                  border: `1px solid ${C.border}`,
                  background: C.field,
                  color: C.text,
                  fontFamily: 'inherit',
                  fontSize: 14,
                  padding: '0 14px',
                  outline: 'none',
                }}
              />
            </div>
          </div>

          <div
            style={{
              marginTop: 22,
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 12,
            }}
          >
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !phoneValid || !emailValid}
              style={{
                height: 44,
                padding: '0 20px',
                borderRadius: 10,
                border: 'none',
                background: grad,
                color: C.white,
                fontFamily: 'inherit',
                fontSize: 14,
                fontWeight: 600,
                cursor: saving || !phoneValid ? 'not-allowed' : 'pointer',
                opacity: saving || !phoneValid ? 0.65 : 1,
                minWidth: 160,
              }}
            >
              {saving ? 'Saving…' : 'Unlock Free Credits'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
