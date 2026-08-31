'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, KeyRound, MonitorPlay, Package, Phone, Store } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { MoonIcon, SunIcon } from './icons';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const NAV: {
  id: string;
  href: string;
  label: string;
  icon: string;
  badge?: string;
  devOnly?: boolean;
  merchantOnly?: boolean;
  catalogVideoOnly?: boolean;
}[] = [
  { id: 'studio', href: '/studio', label: 'Studio', icon: `${BASE}/assets/studio-icon.svg` },
  // Standalone saree feature — superseded by the flat-saree garment type in
  // Studio. Not removed (still fully functional, kept for historical-data
  // reasons), just hidden from the sidebar for now.
  // {
  //   id: 'saree',
  //   href: '/saree',
  //   label: 'Saree',
  //   icon: `${BASE}/assets/saree-icon.svg`,
  //   badge: 'New',
  // },
  {
    id: 'catalogues',
    href: '/catalogs',
    label: 'Catalogs',
    icon: `${BASE}/assets/catalog-icon.svg`,
  },
  {
    id: 'catalog-video',
    href: '/catalog-video',
    label: 'Catalog Video',
    icon: `${BASE}/assets/catalog-video-icon.svg`,
    catalogVideoOnly: true,
  },
  {
    id: 'assets',
    href: '/my-products',
    label: 'My Products',
    icon: `${BASE}/assets/asset-icon.svg`,
  },
  {
    id: 'tryon',
    href: '/tryon',
    label: 'Try-On',
    icon: 'package',
    merchantOnly: true,
  },
  {
    id: 'developers',
    href: '/developers',
    label: 'Developers',
    icon: 'key',
    merchantOnly: true,
  },
  // Sellio preview — not ready for real users. Not removed (page still fully
  // functional), just hidden from the sidebar; the route itself is also
  // blocked in every environment, see middleware.ts's ALWAYS_BLOCKED_PATHS.
  // {
  //   id: 'sellio',
  //   href: '/sellio',
  //   label: 'Sellio',
  //   icon: 'store',
  //   merchantOnly: true,
  // },
  { id: 'pricing', href: '/pricing', label: 'Pricing', icon: `${BASE}/assets/pricing-icon.svg` },
  {
    id: 'tutorials',
    href: '/tutorials',
    label: 'Tutorials',
    icon: 'monitor-play',
  },
  { id: 'contact', href: '/contact-us', label: 'Contact Us', icon: 'phone' },
];

const SIDEBAR_WIDTH = 200;

export function Sidebar({
  onNavigate,
  fillWidth,
}: {
  onNavigate?: () => void;
  fillWidth?: boolean;
}) {
  const pathname = usePathname();
  const qc = useQueryClient();
  const [darkMode, setDarkMode] = useState(false);
  // Same '/v1/me' call the user-menu makes — react-query dedupes it under the
  // shared 'me' key, so this doesn't add an extra network request. Default to
  // not-a-merchant while loading so merchant-only links never flash for
  // non-merchants before the check resolves.
  const { data: me } = useQuery<{ isMerchant?: boolean; catalogVideoEnabled?: boolean }>({
    queryKey: ['me'],
    queryFn: () => api.get('/v1/me'),
    retry: false,
  });
  const isMerchant = me?.isMerchant ?? false;
  // Same default-hidden-until-confirmed pattern as isMerchant above — the
  // server may restrict this feature to a soft-launch cohort, so don't flash
  // the nav item before the check resolves.
  const catalogVideoEnabled = me?.catalogVideoEnabled ?? false;

  useEffect(() => {
    setDarkMode(document.documentElement.classList.contains('dark'));
  }, []);

  function toggleTheme() {
    const next = !darkMode;
    setDarkMode(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  }

  function prefetchRoute(id: string) {
    if (id === 'catalogues') {
      qc.prefetchQuery({ queryKey: ['catalogues'], queryFn: () => api.get('/v1/catalogues') });
    } else if (id === 'catalog-video') {
      qc.prefetchQuery({
        queryKey: ['catalog-videos'],
        queryFn: () => api.get('/v1/catalog-videos'),
      });
    } else if (id === 'pricing') {
      qc.prefetchQuery({
        queryKey: ['credit-plans'],
        queryFn: () => api.get('/v1/payments/plans'),
        staleTime: 5 * 60 * 1000,
      });
    } else if (id === 'assets') {
      qc.prefetchQuery({ queryKey: ['assets'], queryFn: () => api.get('/v1/assets') });
    } else if (id === 'studio') {
      qc.prefetchQuery({
        queryKey: ['garmentTypes', 'women'],
        queryFn: () => api.get('/v1/models/garment-types?gender=women'),
      });
    } else if (id === 'saree') {
      qc.prefetchQuery({ queryKey: ['saree-config'], queryFn: () => api.get('/v1/saree/config') });
    }
  }

  const activeId = NAV.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  )?.id;
  const visibleNav = NAV.filter((item) => {
    if (item.devOnly && process.env.NODE_ENV === 'production') return false;
    if (item.merchantOnly && !isMerchant) return false;
    if (item.catalogVideoOnly && !catalogVideoEnabled) return false;
    return true;
  });

  const groups = [
    {
      title: 'CREATE',
      items: visibleNav.filter((item) =>
        ['studio', 'tryon', 'saree', 'catalogues', 'catalog-video', 'assets'].includes(item.id),
      ),
    },
    {
      title: 'BUSINESS',
      items: visibleNav.filter((item) => ['pricing', 'developers'].includes(item.id)),
    },
    {
      title: 'HELP',
      items: visibleNav.filter((item) => ['tutorials', 'contact'].includes(item.id)),
    },
  ];

  return (
    <div
      style={{
        width: fillWidth ? '100%' : SIDEBAR_WIDTH,
        minWidth: fillWidth ? 0 : SIDEBAR_WIDTH,
        height: '100vh',
        background: '#080C18',
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid rgba(57, 61, 70, 0.4)',
        position: 'sticky',
        top: 0,
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      <style
        // biome-ignore lint/security/noDangerouslySetInnerHtml: safe static css
        dangerouslySetInnerHTML={{
          __html: `
        .sidebar-link-hover:hover {
          background-color: rgba(189, 37, 135, 0.08) !important;
          box-shadow: inset 3px 0 0 0 rgba(189, 37, 135, 0.4) !important;
          color: #FFFFFF !important;
        }
        .sidebar-credits-card:hover {
          border-color: rgba(189, 37, 135, 0.8) !important;
          background: #11172a !important;
        }
        .sidebar-theme-btn:hover {
          background-color: rgba(189, 37, 135, 0.08) !important;
          border-color: rgba(189, 37, 135, 0.4) !important;
        }
        .sidebar-link-hover:focus,
        .sidebar-link-hover:focus-visible,
        .sidebar-theme-btn:focus,
        .sidebar-theme-btn:focus-visible,
        a:focus,
        a:focus-visible,
        button:focus,
        button:focus-visible {
          outline: none !important;
        }
      `,
        }}
      />

      {/* Logo row */}
      <div
        style={{
          height: 76,
          borderBottom: '1px solid rgba(57, 61, 70, 0.4)',
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 20,
          boxSizing: 'border-box',
          flexShrink: 0,
        }}
      >
        <Link
          href="/studio"
          onClick={() => onNavigate?.()}
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {/* biome-ignore lint/performance/noImgElement: logo */}
          <img
            src={`${BASE}/assets/logo.svg`}
            alt="Ai Vastra"
            style={{ height: 24, width: 'auto', flexShrink: 0 }}
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {/* biome-ignore lint/performance/noImgElement: logo */}
          <img
            src={`${BASE}/assets/logo-text.svg`}
            alt="Ai Vastra"
            style={{ height: 28, width: 'auto', flexShrink: 0 }}
          />
        </Link>
      </div>

      {/* Nav groups */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {groups.map((group) => {
          if (group.items.length === 0) return null;
          return (
            <div key={group.title} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  color: '#B2B4B7',
                  paddingLeft: 12,
                  letterSpacing: '0.05em',
                }}
              >
                {group.title}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {group.items.map((item) => {
                  const isActive = activeId === item.id;
                  const linkContent = (
                    <>
                      <span style={{ display: 'flex', flexShrink: 0 }}>
                        {item.icon === 'monitor-play' ? (
                          <MonitorPlay
                            size={16}
                            style={{ color: isActive ? '#FFFFFF' : '#BABABB' }}
                          />
                        ) : item.icon === 'phone' ? (
                          <Phone size={16} style={{ color: isActive ? '#FFFFFF' : '#BABABB' }} />
                        ) : item.icon === 'package' ? (
                          <Package size={16} style={{ color: isActive ? '#FFFFFF' : '#BABABB' }} />
                        ) : item.icon === 'key' ? (
                          <KeyRound size={16} style={{ color: isActive ? '#FFFFFF' : '#BABABB' }} />
                        ) : item.icon === 'store' ? (
                          <Store size={16} style={{ color: isActive ? '#FFFFFF' : '#BABABB' }} />
                        ) : item.icon === 'bar-chart' ? (
                          <BarChart3
                            size={16}
                            style={{ color: isActive ? '#FFFFFF' : '#BABABB' }}
                          />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          // biome-ignore lint/performance/noImgElement: user upload icon
                          <img
                            src={item.icon}
                            alt=""
                            width={16}
                            height={16}
                            style={{
                              filter: isActive ? 'brightness(0) invert(1)' : 'none',
                              ...(item.id === 'saree' && !isActive
                                ? { filter: 'invert(0.6)' }
                                : {}),
                            }}
                          />
                        )}
                      </span>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: isActive ? 600 : 500,
                          color: isActive ? '#FFFFFF' : '#B2B4B7',
                        }}
                      >
                        {item.label}
                      </span>
                      {'badge' in item && item.badge && (
                        <span
                          style={{
                            marginLeft: 'auto',
                            flexShrink: 0,
                            background: 'linear-gradient(180deg, #7c3aed 0%, #66479c 100%)',
                            borderRadius: 20,
                            padding: '2px 8px',
                            fontSize: 10,
                            fontWeight: 700,
                            color: '#fff',
                            lineHeight: '14px',
                            letterSpacing: 0.3,
                            textTransform: 'uppercase',
                          }}
                        >
                          {item.badge}
                        </span>
                      )}
                    </>
                  );

                  if (isActive) {
                    return (
                      <Link
                        key={item.id}
                        href={item.href}
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 12,
                          padding: '10px 16px',
                          borderRadius: 8,
                          textDecoration: 'none',
                          border: 'none',
                          boxShadow: 'inset 3px 0 0 0 #BD2587',
                          background:
                            'linear-gradient(90deg, rgba(189, 37, 135, 0.15) 0%, rgba(189, 37, 135, 0) 100%)',
                          boxSizing: 'border-box',
                          width: '100%',
                        }}
                        onMouseEnter={() => prefetchRoute(item.id)}
                        onFocus={() => prefetchRoute(item.id)}
                        onClick={() => onNavigate?.()}
                      >
                        {linkContent}
                      </Link>
                    );
                  }

                  return (
                    <Link
                      key={item.id}
                      href={item.href}
                      className="sidebar-link-hover"
                      style={{
                        display: 'flex',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        padding: '10px 16px',
                        borderRadius: 8,
                        textDecoration: 'none',
                        background: 'transparent',
                        border: 'none',
                        boxShadow: 'none',
                        width: '100%',
                        boxSizing: 'border-box',
                        transition: 'box-shadow 0.2s, background-color 0.2s',
                      }}
                      onMouseEnter={() => prefetchRoute(item.id)}
                      onFocus={() => prefetchRoute(item.id)}
                      onClick={() => onNavigate?.()}
                    >
                      {linkContent}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Credits Card Linked to Pricing */}
      <div
        style={{ padding: '0 12px 16px', width: '100%', boxSizing: 'border-box', flexShrink: 0 }}
      >
        <Link
          href="/pricing"
          onClick={() => onNavigate?.()}
          style={{
            textDecoration: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: 16,
            borderRadius: 12,
            border: '1px solid rgba(57, 61, 70, 0.7)',
            background: '#0d1222',
            boxSizing: 'border-box',
            width: '100%',
            transition: 'all 0.2s',
          }}
          className="sidebar-credits-card"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: '#FFFFFF' }}>
              Need more credits?
            </span>
            <span style={{ fontSize: 11, color: '#B2B4B7', lineHeight: 1.4 }}>
              Get credit packages at the best price.
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              height: 36,
              background: 'rgba(189, 37, 135, 0.15)',
              border: '1px solid rgba(189, 37, 135, 0.5)',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              color: '#FFFFFF',
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {/* biome-ignore lint/performance/noImgElement: compact static UI icon */}
            <img src={`${BASE}/assets/add_credits.png`} alt="" width={14} height={14} />
            View Plans
          </div>
        </Link>
      </div>

      {/* Theme Toggler */}
      <div
        style={{ padding: '0 12px 16px', width: '100%', boxSizing: 'border-box', flexShrink: 0 }}
      >
        <button
          type="button"
          onClick={toggleTheme}
          className="sidebar-theme-btn"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            borderRadius: 8,
            background: 'rgba(57, 61, 70, 0.2)',
            border: '1px solid rgba(57, 61, 70, 0.5)',
            color: '#FFFFFF',
            width: '100%',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 500,
            fontFamily: 'inherit',
            boxSizing: 'border-box',
            transition: 'all 0.2s',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {darkMode ? <MoonIcon /> : <SunIcon />}
            <span>{darkMode ? 'Dark Theme' : 'Light Theme'}</span>
          </div>
          <div>
            {darkMode ? (
              <span style={{ opacity: 0.5, display: 'flex' }}>
                <SunIcon />
              </span>
            ) : (
              <span style={{ opacity: 0.5, display: 'flex' }}>
                <MoonIcon />
              </span>
            )}
          </div>
        </button>
      </div>
    </div>
  );
}
