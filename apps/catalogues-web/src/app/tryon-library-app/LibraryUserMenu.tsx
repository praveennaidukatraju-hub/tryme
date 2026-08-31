'use client';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { LogOutIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { catalogAppApi, catalogAppLogout } from './catalog-app-api';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

interface MerchantMeResponse {
  displayName: string | null;
  email: string | null;
  balance: number;
}

export function LibraryUserMenu({
  onLoggedOut,
  compact,
}: {
  onLoggedOut: () => void;
  compact?: boolean;
}) {
  const [popupOpen, setPopupOpen] = useState(false);
  const [popupRect, setPopupRect] = useState<{ bottom: number; right: number } | null>(null);
  const [profileHover, setProfileHover] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  const { data: me } = useQuery<MerchantMeResponse>({
    queryKey: ['catalog-app-me'],
    queryFn: () => catalogAppApi.get('/v1/merchant/me'),
    retry: false,
  });

  const balance = me?.balance ?? 0;
  const displayName = me?.displayName ?? me?.email?.split('@')[0] ?? 'User';
  const initials = displayName.slice(0, 2).toUpperCase() || 'U';

  async function handleSignOut() {
    await catalogAppLogout();
    onLoggedOut();
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {!compact && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 14px',
            height: 40,
            boxSizing: 'border-box',
            borderRadius: 8,
            background: C.bg,
            border: `1px solid ${C.border}`,
          }}
        >
          <span style={{ display: 'flex' }}>
            {/* biome-ignore lint/performance/noImgElement: credit icon, standalone page not using next/image */}
            <img src={`${BASE}/assets/credit.png`} alt="" width={16} height={16} />
          </span>
          <span style={{ color: C.text, fontSize: 13, fontWeight: 500 }}>{balance} Credits</span>
        </div>
      )}

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
                right: popupRect ? popupRect.right : 10,
                width: 200,
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
              setPopupRect({ bottom: r.bottom, right: window.innerWidth - r.right });
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
                'linear-gradient(rgba(0,0,0,0.15), rgba(0,0,0,0.15)), linear-gradient(135deg, #521D9C 0.33%, #BD2587 50.77%, #F96657 99.67%)',
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
