'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GSTIN_REGEX } from '@tryme/types';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ChevronDown, Eye, EyeOff, LogOutIcon } from '@/components/icons';
import { C, grad } from '@/components/tokens';
import { TopBar } from '@/components/topbar';
import { PremiumSelect } from '@/components/ui/premium-select';
import { Tooltip } from '@/components/ui/tooltip';
import { useGoogleDriveStatus } from '@/hooks/use-google-drive-status';
import { useMediaQuery } from '@/hooks/use-media-query';
import { api } from '@/lib/api';
import { BREAKPOINTS } from '@/lib/breakpoints';
import { GOOGLE_DRIVE_ENABLED } from '@/lib/feature-flags';

type Tab = 'Profile Details' | 'Billing' | 'Credit History' | 'Invoices';
const TABS: Tab[] = ['Profile Details', 'Billing', 'Credit History', 'Invoices'];

interface MeResponse {
  id: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  phone: string | null;
  companyName: string | null;
  gstin: string | null;
  tier: string;
  hasPassword: boolean;
  defaultResolution: string;
  defaultAspectRatio: string;
  defaultPlatform: string;
}
interface CreditsResponse {
  balance: number;
  recent: { id: string; delta: number; reason: string; createdAt: string }[];
}
interface PaymentRow {
  id: string;
  planId: string;
  planName: string | null;
  credits: number;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  status: string;
  createdAt: string;
  paidAt: string | null;
  invoiceNumber: string | null;
  invoiceUrl: string | null;
}
interface PaymentHistoryResponse {
  payments: PaymentRow[];
}

// ── Field ────────────────────────────────────────────────
function Field({
  label,
  value,
  placeholder,
  type = 'text',
  dropdown,
  disabled,
  onChange,
  prefix,
  inputMode,
  maxLength,
  error,
}: {
  label: string;
  value?: string;
  placeholder?: string;
  type?: string;
  dropdown?: boolean;
  disabled?: boolean;
  onChange?: (v: string) => void;
  prefix?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  maxLength?: number;
  error?: string;
}) {
  const [internal, setInternal] = useState(value ?? '');
  const [show, setShow] = useState(false);
  const val = onChange ? (value ?? '') : internal;
  const inputId = `field-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <div
      className="settings-field-col"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 280 }}
    >
      <label htmlFor={inputId} style={{ fontWeight: 500, fontSize: 14, color: C.text }}>
        {label}
      </label>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        {prefix && (
          <span
            style={{
              position: 'absolute',
              left: 12,
              color: disabled ? C.light : C.mid,
              fontSize: 14,
              pointerEvents: 'none',
            }}
          >
            {prefix}
          </span>
        )}
        <input
          id={inputId}
          type={type === 'password' && show ? 'text' : type}
          value={val}
          placeholder={placeholder}
          disabled={disabled}
          inputMode={inputMode}
          maxLength={maxLength}
          onChange={(e) => (onChange ? onChange(e.target.value) : setInternal(e.target.value))}
          style={{
            width: '100%',
            height: 44,
            borderRadius: 8,
            background: C.field,
            border: `1px solid ${error ? C.pink : C.border}`,
            fontFamily: 'inherit',
            fontSize: 14,
            color: disabled ? C.light : C.mid,
            padding: dropdown || type === 'password' ? '0 36px 0 14px' : '0 14px',
            ...(prefix ? { paddingLeft: 36 } : {}),
            outline: 'none',
            appearance: 'none',
            cursor: disabled ? 'not-allowed' : 'text',
          }}
        />
        {dropdown && (
          <span
            style={{
              position: 'absolute',
              right: 12,
              pointerEvents: 'none',
              color: C.mid,
              display: 'flex',
            }}
          >
            <ChevronDown />
          </span>
        )}
        {type === 'password' && (
          <button
            type="button"
            onClick={() => setShow(!show)}
            style={{
              position: 'absolute',
              right: 12,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: C.mid,
              display: 'flex',
            }}
          >
            {show ? <EyeOff /> : <Eye />}
          </button>
        )}
      </div>
      {error && <p style={{ fontSize: 12, color: C.pink, margin: 0 }}>{error}</p>}
    </div>
  );
}

const ASPECT_RATIOS = ['1:1', '2:3', '3:4', '4:5'];
const PLATFORMS = ['Amazon', 'Flipkart', 'Myntra', 'AJIO', 'Meesho', 'Nykaa Fashion', 'Shopify'];

// ── SelectField ──────────────────────────────────────────
function SelectField({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div
      className="settings-field-col"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 280 }}
    >
      <span style={{ fontWeight: 500, fontSize: 14, color: C.text }}>{label}</span>
      <div
        style={{
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          background: C.field,
        }}
      >
        <PremiumSelect
          ariaLabel={label}
          value={value}
          options={options.map((o) => ({ value: o, label: o }))}
          disabled={disabled}
          onChange={(v) => onChange(String(v))}
          fullWidth
          height={44}
          fontSize={14}
        />
      </div>
    </div>
  );
}

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="settings-row" style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
    {children}
  </div>
);

function Section({
  title,
  children,
  noBorder,
  badge,
  action,
}: {
  title: string;
  children: React.ReactNode;
  noBorder?: boolean;
  badge?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{ padding: '20px 24px', borderBottom: noBorder ? 'none' : `1px solid ${C.border}` }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <h3 style={{ fontWeight: 700, fontSize: 14, color: C.text, flex: 1 }}>{title}</h3>
        {badge && (
          <span
            style={{
              padding: '2px 10px',
              borderRadius: 99,
              fontSize: 11,
              fontWeight: 600,
              background: 'rgba(246,181,83,0.15)',
              color: C.amber,
            }}
          >
            {badge}
          </span>
        )}
        {action}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>{children}</div>
    </div>
  );
}

// India-only mobile numbers: exactly 10 digits, stored without the +91 prefix.
const PHONE_REGEX = /^\d{10}$/;
const sanitizePhone = (v: string) => v.replace(/\D/g, '').slice(0, 10);

const fmtDate = (s: string) =>
  new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (s: string) =>
  new Date(s).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

export default function SettingsPage(): React.ReactElement {
  const router = useRouter();
  const qc = useQueryClient();
  const isNarrow = useMediaQuery(`(max-width: ${BREAKPOINTS.sm}px)`);
  const [tab, setTab] = useState<Tab>('Profile Details');
  const [name, setName] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [gstin, setGstin] = useState<string | null>(null);
  const [gstinError, setGstinError] = useState('');
  const [defaultResolution, setDefaultResolution] = useState<string | null>(null);
  const [defaultAspectRatio, setDefaultAspectRatio] = useState<string | null>(null);
  const [defaultPlatform, setDefaultPlatform] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editingPassword, setEditingPassword] = useState(false);
  const [curPwd, setCurPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdError, setPwdError] = useState('');
  const [pwdSaved, setPwdSaved] = useState(false);
  const driveStatus = useGoogleDriveStatus();
  const [disconnectingDrive, setDisconnectingDrive] = useState(false);

  async function handleDisconnectDrive() {
    if (disconnectingDrive) return;
    setDisconnectingDrive(true);
    try {
      await api.post('/v1/integrations/google-drive/disconnect', {});
      void qc.invalidateQueries({ queryKey: ['google-drive-status'] });
      setToast({ type: 'success', message: 'Google Drive disconnected' });
    } catch (e) {
      setToast({ type: 'error', message: (e as Error).message ?? 'Failed to disconnect' });
    } finally {
      setDisconnectingDrive(false);
    }
  }

  // auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const { data: me } = useQuery<MeResponse>({ queryKey: ['me'], queryFn: () => api.get('/v1/me') });
  const { data: credits } = useQuery<CreditsResponse>({
    queryKey: ['credits'],
    queryFn: () => api.get('/v1/credits'),
  });
  const { data: paymentHistory } = useQuery<PaymentHistoryResponse>({
    queryKey: ['payments-history'],
    queryFn: () => api.get('/v1/payments/history'),
  });

  const emailVal = email ?? me?.email ?? '';
  const canEditEmail = !me?.email; // once an email is on file, it isn't editable here
  const nameVal = name ?? me?.displayName ?? '';
  const phoneVal = sanitizePhone(phone ?? me?.phone ?? '');
  const companyNameVal = companyName ?? me?.companyName ?? '';
  const gstinVal = gstin ?? me?.gstin ?? '';
  const defaultResolutionVal = defaultResolution ?? me?.defaultResolution ?? 'HD';
  const defaultAspectRatioVal = defaultAspectRatio ?? me?.defaultAspectRatio ?? '1:1';
  const defaultPlatformVal = defaultPlatform ?? me?.defaultPlatform ?? 'Amazon';
  const phoneValid = PHONE_REGEX.test(phoneVal);
  const profileComplete = phoneValid;

  const recent = credits?.recent ?? [];
  const purchased = recent.filter((r) => r.delta > 0).reduce((a, r) => a + r.delta, 0);
  const used = recent.filter((r) => r.delta < 0).reduce((a, r) => a + Math.abs(r.delta), 0);
  const remaining = credits?.balance ?? 0;

  async function saveProfile() {
    if (gstinVal.trim() && !GSTIN_REGEX.test(gstinVal.trim().toUpperCase())) {
      setGstinError('Invalid GSTIN format');
      return;
    }
    setGstinError('');

    setSaving(true);
    try {
      await api.patch('/v1/me', {
        displayName: nameVal.trim() || undefined,
        email: canEditEmail && emailVal.trim() ? emailVal.trim() : undefined,
        phone: phoneVal || null,
        companyName: companyNameVal.trim() || null,
        gstin: gstinVal.trim() || null,
        defaultResolution: defaultResolutionVal,
        defaultAspectRatio: defaultAspectRatioVal,
        defaultPlatform: defaultPlatformVal,
      });
      void qc.invalidateQueries({ queryKey: ['me'] });
      setSaved(true);
      setEditingProfile(false);
      setToast({ type: 'success', message: 'Profile updated successfully' });
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save profile';
      if (msg.includes('already assigned')) {
        setPhone(null);
      }
      setToast({ type: 'error', message: msg });
    } finally {
      setSaving(false);
    }
  }

  const hasPassword = me?.hasPassword ?? true;

  async function changePassword() {
    setPwdError('');
    if (newPwd.length < 8) {
      setPwdError('New password must be at least 8 characters.');
      return;
    }
    if (newPwd !== confirmPwd) {
      setPwdError('Passwords do not match.');
      return;
    }
    setPwdSaving(true);
    try {
      await api.patch('/v1/me/password', {
        ...(hasPassword ? { currentPassword: curPwd } : {}),
        newPassword: newPwd,
      });
      setPwdSaved(true);
      setEditingPassword(false);
      setCurPwd('');
      setNewPwd('');
      setConfirmPwd('');
      void qc.invalidateQueries({ queryKey: ['me'] });
      setTimeout(() => setPwdSaved(false), 2500);
    } catch (e) {
      setPwdError((e as Error).message ?? 'Failed to update password.');
    } finally {
      setPwdSaving(false);
    }
  }

  async function handleSignOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  const cardWrap: React.CSSProperties = {
    background: C.white,
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  };

  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @media (max-width: 1023px) {
              .settings-page-content {
                padding: 16px !important;
              }
              .settings-tab-bar {
                overflow-x: auto;
                -webkit-overflow-scrolling: touch;
              }
              .settings-tab-bar::-webkit-scrollbar {
                display: none;
              }
              .settings-row {
                flex-direction: column !important;
                gap: 16px !important;
              }
              .settings-field-col {
                min-width: 100% !important;
              }
            }
          `,
        }}
      />
      <TopBar
        title={isNarrow ? 'Settings' : 'Account Settings'}
        subtitle="Manage your profile, billing, credits, subscriptions, and account activity."
        right={
          <button
            type="button"
            onClick={() => void handleSignOut()}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: isNarrow ? '9px' : '9px 16px',
              borderRadius: 8,
              border: `1px solid ${C.border2}`,
              background: C.white,
              fontFamily: 'inherit',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              color: C.text,
              flexShrink: 0,
            }}
          >
            <LogOutIcon /> {!isNarrow && 'Log Out'}
          </button>
        }
      />
      <div
        className="settings-page-content"
        style={{ flex: 1, overflowY: 'auto', padding: '20px 28px' }}
      >
        {/* Tab bar */}
        <div
          className="settings-tab-bar"
          style={{
            display: 'flex',
            borderBottom: `1px solid ${C.border}`,
            marginBottom: 20,
            overflowX: 'auto',
          }}
        >
          {TABS.map((t) => {
            const isActive = tab === t;
            return (
              <button
                type="button"
                key={t}
                onClick={() => setTab(t)}
                style={{
                  padding: '10px 20px',
                  border: 'none',
                  borderBottom: isActive ? `2px solid ${C.text}` : '2px solid transparent',
                  background: 'transparent',
                  fontFamily: 'inherit',
                  fontSize: 14,
                  fontWeight: isActive ? 600 : 500,
                  color: isActive ? C.text : C.mid,
                  cursor: 'pointer',
                  marginBottom: -1,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {t}
              </button>
            );
          })}
        </div>

        {tab === 'Profile Details' && (
          <div style={cardWrap}>
            {/* ── Part 1: Personal Information + Account Preferences ── */}
            <Section
              title="Personal Information"
              action={
                !editingProfile ? (
                  <button
                    type="button"
                    onClick={() => setEditingProfile(true)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 12px',
                      borderRadius: 8,
                      border: `1px solid ${C.border2}`,
                      background: C.white,
                      cursor: 'pointer',
                      color: C.mid,
                      fontFamily: 'inherit',
                      fontSize: 13,
                      fontWeight: 500,
                    }}
                  >
                    <svg
                      aria-hidden="true"
                      xmlns="http://www.w3.org/2000/svg"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
                    </svg>
                    Edit
                  </button>
                ) : undefined
              }
            >
              <Row>
                <Field label="Full Name" value={nameVal} onChange={setName} />
                <Field
                  label="Email Address"
                  value={emailVal}
                  placeholder="you@example.com"
                  disabled={!editingProfile || !canEditEmail}
                  onChange={canEditEmail ? setEmail : undefined}
                />
                {me?.username && <Field label="Username" value={me.username} disabled />}
                <Field
                  label="Phone Number"
                  value={phoneVal}
                  placeholder="10-digit mobile number"
                  prefix="+91"
                  inputMode="numeric"
                  maxLength={10}
                  disabled={!editingProfile}
                  onChange={(v) => setPhone(sanitizePhone(v))}
                  error={
                    phoneVal.length > 0 && !phoneValid
                      ? 'Enter a valid 10-digit mobile number'
                      : undefined
                  }
                />
              </Row>
              <Row>
                <Field
                  label="Company Name (Optional)"
                  value={companyNameVal}
                  placeholder="Enter your company name"
                  disabled={!editingProfile}
                  onChange={setCompanyName}
                />
                <Field
                  label="GSTIN (Optional)"
                  value={gstinVal}
                  placeholder="e.g. 27AAPFU0939F1ZV"
                  disabled={!editingProfile}
                  onChange={(v) => {
                    setGstin(v.toUpperCase());
                    if (gstinError) setGstinError('');
                  }}
                  error={gstinError || undefined}
                />
                <div style={{ flex: 1, minWidth: 280 }} />
              </Row>
              {!profileComplete && (
                <p style={{ fontSize: 13, color: C.pink, margin: '-8px 0 0' }}>
                  Phone number is required before free credits unlock. Company name is optional.
                </p>
              )}
            </Section>
            <Section title="Account Preferences">
              {/* Default Resolution field hidden until Studio has an actual resolution
                  picker to feed it into — see docs/progress.md. State/save payload for
                  it are kept so the stored value round-trips unchanged. */}
              <Row>
                <SelectField
                  label="Default Aspect Ratio"
                  value={defaultAspectRatioVal}
                  options={ASPECT_RATIOS}
                  disabled={!editingProfile}
                  onChange={setDefaultAspectRatio}
                />
                <SelectField
                  label="Default Platform"
                  value={defaultPlatformVal}
                  options={PLATFORMS}
                  disabled={!editingProfile}
                  onChange={setDefaultPlatform}
                />
              </Row>
            </Section>
            {editingProfile && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                  gap: 12,
                  padding: '16px 24px',
                  borderTop: `1px solid ${C.border}`,
                  background: C.white,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setEditingProfile(false);
                    setName(null);
                    setEmail(null);
                    setPhone(null);
                    setCompanyName(null);
                    setGstin(null);
                    setGstinError('');
                    setDefaultResolution(null);
                    setDefaultAspectRatio(null);
                    setDefaultPlatform(null);
                  }}
                  style={{
                    padding: '10px 24px',
                    borderRadius: 8,
                    border: `1px solid ${C.border2}`,
                    background: C.white,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontWeight: 600,
                    fontSize: 14,
                    color: C.mid,
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveProfile}
                  disabled={saving || !phoneValid}
                  style={{
                    padding: '10px 24px',
                    borderRadius: 8,
                    border: 'none',
                    cursor: saving || !phoneValid ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                    fontWeight: 600,
                    fontSize: 14,
                    color: C.white,
                    background: saved ? C.mint : grad,
                    opacity: saving || !phoneValid ? 0.6 : 1,
                    transition: 'background .3s',
                  }}
                >
                  {saved
                    ? '✓ Saved!'
                    : saving
                      ? 'Saving…'
                      : !phoneValid
                        ? 'Fill Required Fields'
                        : 'Update Changes'}
                </button>
              </div>
            )}

            {/* ── Part 2: Change Password ── */}
            <Section
              title={hasPassword ? 'Change Password' : 'Set Password'}
              action={
                !editingPassword ? (
                  <button
                    type="button"
                    onClick={() => setEditingPassword(true)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 12px',
                      borderRadius: 8,
                      border: `1px solid ${C.border2}`,
                      background: C.white,
                      cursor: 'pointer',
                      color: C.mid,
                      fontFamily: 'inherit',
                      fontSize: 13,
                      fontWeight: 500,
                    }}
                  >
                    <svg
                      aria-hidden="true"
                      xmlns="http://www.w3.org/2000/svg"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
                    </svg>
                    Edit
                  </button>
                ) : undefined
              }
            >
              {!hasPassword && (
                <p style={{ fontSize: 13, color: C.mid, margin: '0 0 4px' }}>
                  Your account was created with Google. Set a password to also sign in with email.
                </p>
              )}
              {editingPassword && (
                <Row>
                  {hasPassword && (
                    <Field
                      label="Current Password"
                      placeholder="Enter current password"
                      type="password"
                      value={curPwd}
                      onChange={setCurPwd}
                    />
                  )}
                  <Field
                    label="New Password"
                    placeholder="Enter new password (min 8 chars)"
                    type="password"
                    value={newPwd}
                    onChange={setNewPwd}
                  />
                  <Field
                    label="Confirm New Password"
                    placeholder="Re-enter new password"
                    type="password"
                    value={confirmPwd}
                    onChange={setConfirmPwd}
                  />
                </Row>
              )}
              {pwdError && (
                <div
                  style={{ fontSize: 13, color: '#E53935', marginTop: editingPassword ? -8 : 0 }}
                >
                  {pwdError}
                </div>
              )}
              {editingPassword && (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    gap: 12,
                    marginTop: 16,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setEditingPassword(false);
                      setCurPwd('');
                      setNewPwd('');
                      setConfirmPwd('');
                      setPwdError('');
                    }}
                    style={{
                      padding: '10px 24px',
                      borderRadius: 8,
                      border: `1px solid ${C.border2}`,
                      background: C.white,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontWeight: 600,
                      fontSize: 14,
                      color: C.mid,
                    }}
                  >
                    Cancel
                  </button>
                  <Tooltip
                    tip={
                      hasPassword && !curPwd
                        ? 'Enter your current password'
                        : !newPwd
                          ? 'Enter a new password'
                          : !confirmPwd
                            ? 'Confirm your new password'
                            : undefined
                    }
                    position="top"
                  >
                    <button
                      type="button"
                      onClick={() => void changePassword()}
                      disabled={pwdSaving || (hasPassword && !curPwd) || !newPwd || !confirmPwd}
                      style={{
                        padding: '10px 24px',
                        borderRadius: 8,
                        border: 'none',
                        cursor:
                          pwdSaving || (hasPassword && !curPwd) || !newPwd || !confirmPwd
                            ? 'not-allowed'
                            : 'pointer',
                        fontFamily: 'inherit',
                        fontWeight: 600,
                        fontSize: 14,
                        color: C.white,
                        background: pwdSaved ? C.mint : grad,
                        opacity:
                          pwdSaving || (hasPassword && !curPwd) || !newPwd || !confirmPwd ? 0.6 : 1,
                        transition: 'background .3s',
                      }}
                    >
                      {pwdSaved
                        ? `✓ Password ${hasPassword ? 'Updated' : 'Set'}!`
                        : pwdSaving
                          ? hasPassword
                            ? 'Updating…'
                            : 'Setting…'
                          : hasPassword
                            ? 'Update Password'
                            : 'Set Password'}
                    </button>
                  </Tooltip>
                </div>
              )}
            </Section>

            {/* ── Part 3: Integrations (Google Drive) — hidden while the OAuth
                consent screen is unverified; see lib/feature-flags.ts ── */}
            {GOOGLE_DRIVE_ENABLED && (
              <Section title="Integrations" noBorder>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 14,
                        color: C.text,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      Google Drive
                      {driveStatus.data?.status === 'CONNECTED' && (
                        <span
                          style={{
                            padding: '2px 8px',
                            borderRadius: 99,
                            fontSize: 11,
                            fontWeight: 600,
                            background: 'rgba(32,158,70,0.1)',
                            color: C.mint,
                          }}
                        >
                          Connected
                        </span>
                      )}
                    </div>
                    <p style={{ fontSize: 13, color: C.mid, margin: 0 }}>
                      {driveStatus.data?.status === 'CONNECTED'
                        ? `Connected as ${driveStatus.data.googleEmail ?? 'Google Account'}. Studio results can be saved directly to your Drive.`
                        : driveStatus.data?.status === 'REAUTH_REQUIRED'
                          ? 'Authorization expired or revoked. Reconnect to save Studio results to Drive.'
                          : 'Connect your Google Drive account to save generated Studio results directly.'}
                    </p>
                  </div>
                  {driveStatus.data?.status === 'CONNECTED' ? (
                    <button
                      type="button"
                      onClick={() => void handleDisconnectDrive()}
                      disabled={disconnectingDrive}
                      style={{
                        padding: '8px 16px',
                        borderRadius: 8,
                        border: `1px solid ${C.border2}`,
                        background: C.white,
                        cursor: disconnectingDrive ? 'not-allowed' : 'pointer',
                        fontFamily: 'inherit',
                        fontWeight: 600,
                        fontSize: 13,
                        color: C.pink,
                        opacity: disconnectingDrive ? 0.6 : 1,
                      }}
                    >
                      {disconnectingDrive ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  ) : (
                    <a
                      href="/api/integrations/google-drive/connect"
                      style={{
                        padding: '8px 16px',
                        borderRadius: 8,
                        border: 'none',
                        background: grad,
                        color: C.white,
                        fontWeight: 600,
                        fontSize: 13,
                        textDecoration: 'none',
                        display: 'inline-flex',
                        alignItems: 'center',
                      }}
                    >
                      {driveStatus.data?.status === 'REAUTH_REQUIRED'
                        ? 'Reconnect Google Drive'
                        : 'Connect Google Drive'}
                    </a>
                  )}
                </div>
              </Section>
            )}
          </div>
        )}

        {tab === 'Billing' && (
          <div style={cardWrap}>
            <Section title="Payment Method" noBorder>
              <p style={{ fontSize: 14, color: C.mid, margin: 0 }}>
                Payments are processed securely via Razorpay at checkout. No card details are stored
                on Tryme servers.
              </p>
              <a
                href="/pricing"
                style={{
                  display: 'inline-block',
                  padding: '10px 20px',
                  borderRadius: 8,
                  background: grad,
                  color: C.white,
                  fontWeight: 600,
                  fontSize: 14,
                  textDecoration: 'none',
                  alignSelf: 'flex-start',
                }}
              >
                Buy Credits
              </a>
            </Section>
          </div>
        )}

        {tab === 'Credit History' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {[
                {
                  label: 'Total Credits Purchased',
                  val: purchased.toLocaleString('en-IN'),
                  color: C.text,
                },
                { label: 'Credits Used', val: used.toLocaleString('en-IN'), color: C.pink },
                {
                  label: 'Credits Remaining',
                  val: remaining.toLocaleString('en-IN'),
                  color: C.mint,
                },
              ].map(({ label, val, color }) => (
                <div
                  key={label}
                  style={{
                    flex: 1,
                    minWidth: 200,
                    background: C.white,
                    border: `1px solid ${C.border}`,
                    borderRadius: 12,
                    padding: '18px 20px',
                  }}
                >
                  <div style={{ fontSize: 13, color: C.mid, marginBottom: 6 }}>{label}</div>
                  <div style={{ fontSize: 26, fontWeight: 700, color }}>{val}</div>
                </div>
              ))}
            </div>
            <div
              style={{
                background: C.white,
                border: `1px solid ${C.border}`,
                borderRadius: 12,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.5fr 2fr 1fr 1fr',
                  background: C.field,
                  borderBottom: `1px solid ${C.border}`,
                  padding: '14px 20px',
                }}
              >
                {['Date / Time', 'Activity', 'Credits', 'Status'].map((c) => (
                  <span key={c} style={{ fontSize: 13, fontWeight: 600, color: C.mid }}>
                    {c}
                  </span>
                ))}
              </div>
              {recent.length === 0 ? (
                <div
                  style={{ padding: '40px 24px', textAlign: 'center', color: C.mid, fontSize: 14 }}
                >
                  No activity yet.
                </div>
              ) : (
                recent.map((r, i) => {
                  const credit = r.delta > 0;
                  return (
                    <div
                      key={r.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1.5fr 2fr 1fr 1fr',
                        padding: '14px 20px',
                        borderBottom: i < recent.length - 1 ? `1px solid ${C.border}` : 'none',
                        alignItems: 'center',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: C.text }}>
                          {fmtDate(r.createdAt)}
                        </div>
                        <div style={{ fontSize: 11, color: C.light }}>{fmtTime(r.createdAt)}</div>
                      </div>
                      <span style={{ fontSize: 13, color: C.text }}>{r.reason}</span>
                      <span
                        style={{ fontSize: 13, fontWeight: 600, color: credit ? C.mint : C.pink }}
                      >
                        {credit ? '+' : ''}
                        {r.delta} Credits
                      </span>
                      <span>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '3px 10px',
                            borderRadius: 20,
                            fontSize: 12,
                            fontWeight: 500,
                            background: credit ? 'rgba(32,158,70,0.1)' : 'rgba(245,92,122,0.1)',
                            color: credit ? C.mint : C.pink,
                          }}
                        >
                          {credit ? 'Successful' : 'Used'}
                        </span>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {tab === 'Invoices' &&
          (() => {
            const rows = paymentHistory?.payments ?? [];
            const fmt = (paise: number) =>
              `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
            return (
              <div
                style={{
                  background: C.white,
                  border: `1px solid ${C.border}`,
                  borderRadius: 12,
                  overflow: 'hidden',
                }}
              >
                <div style={{ padding: '18px 24px', borderBottom: `1px solid ${C.border}` }}>
                  <h3 style={{ fontWeight: 700, fontSize: 14, color: C.text, margin: 0 }}>
                    Payment Receipts
                  </h3>
                  <p style={{ fontSize: 13, color: C.mid, margin: '4px 0 0' }}>
                    A receipt email is sent to your address after every successful purchase.
                  </p>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1.4fr 1.2fr 0.8fr 1fr 1fr 0.7fr 0.9fr',
                    background: C.field,
                    borderBottom: `1px solid ${C.border}`,
                    padding: '12px 20px',
                  }}
                >
                  {[
                    'Date',
                    'Plan',
                    'Credits',
                    'Amount (incl. GST)',
                    'Payment ID',
                    'Status',
                    'Invoice',
                  ].map((h) => (
                    <span key={h} style={{ fontSize: 12, fontWeight: 600, color: C.mid }}>
                      {h}
                    </span>
                  ))}
                </div>
                {rows.length === 0 ? (
                  <div
                    style={{
                      padding: '48px 24px',
                      textAlign: 'center',
                      color: C.mid,
                      fontSize: 14,
                    }}
                  >
                    No purchases yet.{' '}
                    <a
                      href="/pricing"
                      style={{ color: C.pink, textDecoration: 'none', fontWeight: 600 }}
                    >
                      Buy credits
                    </a>
                  </div>
                ) : (
                  rows.map((p, i) => (
                    <div
                      key={p.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1.4fr 1.2fr 0.8fr 1fr 1fr 0.7fr 0.9fr',
                        padding: '14px 20px',
                        borderBottom: i < rows.length - 1 ? `1px solid ${C.border}` : 'none',
                        alignItems: 'center',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: C.text }}>
                          {fmtDate(p.paidAt ?? p.createdAt)}
                        </div>
                        <div style={{ fontSize: 11, color: C.light }}>
                          {fmtTime(p.paidAt ?? p.createdAt)}
                        </div>
                      </div>
                      <span style={{ fontSize: 13, color: C.text }}>{p.planName ?? p.planId}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: C.mint }}>
                        +{p.credits.toLocaleString('en-IN')}
                      </span>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                          {fmt(p.totalPaise)}
                        </div>
                        <div style={{ fontSize: 11, color: C.light }}>
                          incl. GST {fmt(p.gstPaise)}
                        </div>
                      </div>
                      <span
                        style={{
                          fontSize: 11,
                          color: C.light,
                          fontFamily: 'monospace',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {p.razorpayPaymentId ?? '—'}
                      </span>
                      <span>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '3px 10px',
                            borderRadius: 20,
                            fontSize: 12,
                            fontWeight: 500,
                            background:
                              p.status === 'paid'
                                ? 'rgba(32,158,70,0.1)'
                                : p.status === 'failed'
                                  ? 'rgba(245,92,122,0.1)'
                                  : 'rgba(180,180,180,0.15)',
                            color:
                              p.status === 'paid' ? C.mint : p.status === 'failed' ? C.pink : C.mid,
                          }}
                        >
                          {p.status === 'paid'
                            ? 'Paid'
                            : p.status === 'failed'
                              ? 'Failed'
                              : 'Pending'}
                        </span>
                      </span>
                      <span>
                        {p.invoiceUrl ? (
                          <a
                            href={p.invoiceUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              color: C.pink,
                              textDecoration: 'none',
                            }}
                          >
                            Download
                          </a>
                        ) : (
                          <span style={{ fontSize: 12, color: C.light }}>—</span>
                        )}
                      </span>
                    </div>
                  ))
                )}
              </div>
            );
          })()}
      </div>

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 28,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            background: toast.type === 'error' ? C.pink : C.mint,
            color: '#fff',
            padding: '10px 20px',
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 500,
            boxShadow: '0 4px 24px rgba(0,0,0,0.18)',
            maxWidth: 480,
            textAlign: 'center',
            whiteSpace: 'pre-wrap',
          }}
        >
          {toast.message}
        </div>
      )}
    </>
  );
}
