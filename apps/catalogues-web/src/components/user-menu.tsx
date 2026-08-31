'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { LogOutIcon, SettingsIcon } from './icons';
import { C } from './tokens';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

interface CreditsResponse {
  balance: number;
}
interface MeResponse {
  email: string;
  displayName: string | null;
}

export function UserMenu() {
  const router = useRouter();
  const [popupOpen, setPopupOpen] = useState(false);
  const [popupRect, setPopupRect] = useState<{ bottom: number; right: number } | null>(null);
  const [profileHover, setProfileHover] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  const { data: credits } = useQuery<CreditsResponse>({
    queryKey: ['credits'],
    queryFn: () => api.get('/v1/credits'),
  });
  const { data: me } = useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: () => api.get('/v1/me'),
    retry: false,
  });

  const balance = credits?.balance ?? 0;
  const email = me?.email ?? '';
  const displayName = me?.displayName ?? email.split('@')[0] ?? 'User';
  const initials = displayName.slice(0, 2).toUpperCase() || 'U';

  async function handleSignOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      <Link
        href="/pricing"
        className="user-menu-credits-btn"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          textDecoration: 'none',
          padding: '0 12px',
          height: 40,
          boxSizing: 'border-box',
          borderRadius: 8,
          background: C.bg,
          border: `1px solid ${C.border}`,
          flexShrink: 0,
        }}
      >
        <span style={{ display: 'flex' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {/* biome-ignore lint/performance/noImgElement: credit icon */}
          <img src={`${BASE}/assets/credit.png`} alt="" width={16} height={16} />
        </span>
        <span style={{ color: C.text, fontSize: 13, fontWeight: 500 }}>
          {balance} <span className="user-menu-credits-word">Credits</span>
        </span>
      </Link>

      <div ref={popupRef} style={{ position: 'relative' }}>
        {popupOpen && (
          <>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop closes popup */}
            <div
              role="presentation"
              onClick={(e) => {
                e.stopPropagation();
                setPopupOpen(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setPopupOpen(false);
              }}
              style={{ position: 'fixed', inset: 0, zIndex: 99 }}
            />
            <div
              style={{
                position: 'fixed',
                top: popupRect ? popupRect.bottom + 8 : 80,
                right: popupRect ? Math.max(16, popupRect.right) : 16,
                width: 240,
                background: C.card,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                overflow: 'hidden',
                zIndex: 100,
                boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
              }}
            >
              <button
                type="button"
                className="hover-bg"
                onClick={(e) => {
                  e.stopPropagation();
                  setPopupOpen(false);
                  router.push('/settings');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '12px 16px',
                  width: '100%',
                  background: 'none',
                  border: 'none',
                  textAlign: 'left',
                  cursor: 'pointer',
                  color: C.text,
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                }}
              >
                <span style={{ opacity: 0.6, display: 'flex' }}>
                  <SettingsIcon />
                </span>
                Settings
              </button>
              <div style={{ height: 1, background: C.border, margin: '0 16px' }} />
              <button
                type="button"
                className="hover-danger-tint"
                onClick={(e) => {
                  e.stopPropagation();
                  setPopupOpen(false);
                  void handleSignOut();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '12px 16px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: '#F87171',
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  textAlign: 'left',
                }}
              >
                <span style={{ opacity: 0.8, display: 'flex' }}>
                  <LogOutIcon />
                </span>
                Log Out
              </button>
            </div>
          </>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!popupOpen && popupRef.current) {
              const r = popupRef.current.getBoundingClientRect();
              setPopupRect({ bottom: r.bottom, right: Math.max(16, window.innerWidth - r.right) });
            }
            setPopupOpen((v) => !v);
          }}
          title={displayName}
          onMouseEnter={() => setProfileHover(true)}
          onMouseLeave={() => setProfileHover(false)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: popupOpen || profileHover ? C.bg : 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            borderRadius: 8,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              background:
                'linear-gradient(rgba(0,0,0,0.15), rgba(0,0,0,0.15)), linear-gradient(91.84deg, #521D9C 0.33%, #BD2587 50.77%, #F96657 99.67%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              fontWeight: 600,
              color: '#ffffff',
              flexShrink: 0,
            }}
          >
            {initials}
          </div>
        </button>
      </div>
    </div>
  );
}
