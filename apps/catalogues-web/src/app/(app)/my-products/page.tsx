'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { GarmentIcon, SearchIcon, XIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { TopBar } from '@/components/topbar';
import { GradBtn } from '@/components/ui/grad-btn';
import { api } from '@/lib/api';

interface Asset {
  r2Key: string;
  uploadedAt: string;
  jobsCount: number;
}

interface AssetWithThumbnail extends Asset {
  thumbnailUrl?: string | null;
}

export default function AssetsPage(): React.ReactElement {
  const [search, setSearch] = useState('');
  const [zoom, setZoom] = useState<string | null>(null);
  const [zoomVisible, setZoomVisible] = useState(false);
  const [brokenThumbs, setBrokenThumbs] = useState<Set<string>>(new Set());
  const zoomDialogRef = useRef<HTMLDivElement>(null);
  const zoomTriggerRef = useRef<HTMLElement | null>(null);

  const {
    data: assets = [],
    isLoading: loading,
    error: queryError,
  } = useQuery<AssetWithThumbnail[]>({
    queryKey: ['assets'],
    queryFn: () => api.get<AssetWithThumbnail[]>('/v1/assets'),
  });
  const error = queryError instanceof Error ? queryError.message : null;

  useEffect(() => {
    if (zoom) {
      zoomTriggerRef.current = document.activeElement as HTMLElement;
      requestAnimationFrame(() => setZoomVisible(true));
    } else {
      setZoomVisible(false);
      zoomTriggerRef.current?.focus();
    }
  }, [zoom]);

  // Focus trap for lightbox
  useEffect(() => {
    if (!zoom) return;
    const el = zoomDialogRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => document.removeEventListener('keydown', trap);
  }, [zoom]);

  const filtered = assets.filter((a) => a.r2Key?.toLowerCase().includes(search.toLowerCase()));

  return (
    <>
      <TopBar
        title="My Products"
        subtitle="Manage uploaded garments and generated catalogue outputs."
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px' }}>
        {process.env.NODE_ENV !== 'production' && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20 }}>
            <div style={{ position: 'relative', flex: 1, maxWidth: 300 }}>
              <span
                style={{
                  position: 'absolute',
                  left: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: C.mid,
                }}
              >
                <SearchIcon />
              </span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search assets..."
                disabled={loading}
                style={{
                  width: '100%',
                  paddingLeft: 34,
                  height: 38,
                  borderRadius: 8,
                  border: `1px solid ${C.border2}`,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  outline: 'none',
                  background: C.field,
                  color: C.text,
                  opacity: loading ? 0.6 : 1,
                }}
              />
            </div>
          </div>
        )}

        {error && (
          <div
            style={{
              padding: '12px 14px',
              borderRadius: 8,
              background: 'rgba(245,92,122,0.1)',
              color: C.pink,
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        )}

        {loading && (
          <div style={{ padding: '40px', textAlign: 'center', color: C.light, fontSize: 14 }}>
            Loading your assets...
          </div>
        )}

        {!loading && filtered.length === 0 && !error && (
          <div
            style={{
              padding: '64px 24px',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 16,
            }}
          >
            {search ? (
              <p style={{ color: C.light, fontSize: 14, margin: 0 }}>No assets match your search</p>
            ) : (
              <>
                <div style={{ color: C.pink, opacity: 0.8, marginBottom: 4 }}>
                  <GarmentIcon size={48} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <h3 style={{ fontSize: 16, fontWeight: 600, color: C.text, margin: 0 }}>
                    No assets yet
                  </h3>
                  <p style={{ color: C.light, fontSize: 14, margin: 0, maxWidth: 300 }}>
                    Upload your first garment in the Studio to start generating try-ons.
                  </p>
                </div>
                <div style={{ marginTop: 8 }}>
                  <Link href="/studio" style={{ textDecoration: 'none' }}>
                    <GradBtn>Upload your first garment</GradBtn>
                  </Link>
                </div>
              </>
            )}
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 16,
            }}
          >
            {filtered.map((asset, idx) => {
              const thumbUrl = asset.thumbnailUrl ?? '';
              const hasThumb = !!thumbUrl && !brokenThumbs.has(asset.r2Key ?? '');
              const filename = asset.r2Key.split('/').pop() || 'garment.jpg';
              return (
                <div
                  key={asset.r2Key}
                  className="prod-card"
                  style={{
                    width: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    border: `1px solid ${C.border}`,
                    borderRadius: 14,
                    overflow: 'hidden',
                    background: C.card,
                  }}
                >
                  <button
                    type="button"
                    disabled={!hasThumb}
                    aria-label={hasThumb ? `Preview ${filename}` : filename}
                    style={{
                      aspectRatio: '3/4',
                      background: C.lighter,
                      position: 'relative',
                      overflow: 'hidden',
                      cursor: hasThumb ? 'pointer' : 'default',
                      border: 'none',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    onClick={() => {
                      if (thumbUrl) setZoom(thumbUrl);
                    }}
                  >
                    <div className="prod-card-img" style={{ width: '100%', height: '100%' }}>
                      {hasThumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        // biome-ignore lint/performance/noImgElement: presigned R2 URL
                        <img
                          src={thumbUrl}
                          alt={`Uploaded garment — ${filename}`}
                          width={768}
                          height={1024}
                          loading={idx < 3 ? 'eager' : 'lazy'}
                          onError={() =>
                            setBrokenThumbs((prev) => new Set([...prev, asset.r2Key ?? '']))
                          }
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            objectPosition: 'top center',
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            width: '100%',
                            height: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: C.mid,
                            opacity: 0.35,
                          }}
                        >
                          <GarmentIcon size={48} />
                        </div>
                      )}
                    </div>
                  </button>
                  <div
                    style={{
                      padding: '10px 14px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span style={{ fontSize: 12, color: C.mid, flexShrink: 0 }}>
                      {asset.jobsCount} uses
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        color: C.text,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                      }}
                    >
                      {filename}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {zoom && (
        <div
          ref={zoomDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Garment image preview"
          onClick={() => setZoom(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setZoom(null);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 40,
          }}
        >
          <button
            type="button"
            onClick={() => setZoom(null)}
            aria-label="Close preview"
            style={{
              position: 'absolute',
              top: 20,
              right: 20,
              width: 40,
              height: 40,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.15)',
              border: 'none',
              color: C.white,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <XIcon size={20} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {/* biome-ignore lint/performance/noImgElement: presigned R2 URL */}
          <img
            src={zoom}
            alt="Garment preview"
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              borderRadius: 8,
              transform: zoomVisible ? 'translateX(0)' : 'translateX(100%)',
              transition: 'transform 300ms ease-out',
              pointerEvents: 'none',
            }}
          />
        </div>
      )}
    </>
  );
}
