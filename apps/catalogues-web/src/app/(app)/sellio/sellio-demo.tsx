'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { SparkleIcon, XIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { api } from '@/lib/api';
import { isEmbedImageSelectedMessage } from '@/lib/sellio-embed-protocol';
import { MOCK_PRODUCT, SHOPIFY_LEFT_NAV, SHOPIFY_SALES_CHANNELS } from './shopify-mock-data';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export interface MediaImage {
  id: string;
  url: string;
  source: 'seed' | 'tryme';
}

function ShopifyChrome({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: '#f1f2f4',
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ flexShrink: 0, display: 'flex', background: '#1a1a1a' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`${BASE}/assets/sellio-logo.png`}
          alt="Sellio Nav"
          style={{ width: '100%', height: 'auto', display: 'block' }}
        />
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          style={{
            width: 200,
            background: '#fff',
            color: '#3c3f42',
            borderRight: '1px solid #e3e3e3',
            flexShrink: 0,
            padding: '16px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            fontSize: 13,
          }}
        >
          {SHOPIFY_LEFT_NAV.map((label) => (
            <div
              key={label}
              style={{
                padding: '8px 12px',
                borderRadius: 6,
                fontWeight: label === 'Products' ? 600 : 400,
                background: label === 'Products' ? '#f1f2f4' : 'transparent',
                color: label === 'Products' ? '#1a1a1a' : '#3c3f42',
              }}
            >
              {label}
            </div>
          ))}
          <div style={{ marginTop: 16, fontSize: 11, color: '#8a8d93', padding: '0 12px' }}>
            Sales channels
          </div>
          {SHOPIFY_SALES_CHANNELS.map((label) => (
            <div
              key={label}
              style={{ padding: '8px 12px', borderRadius: 6, fontSize: 13, color: '#3c3f42' }}
            >
              {label}
            </div>
          ))}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>{children}</div>
      </div>
    </div>
  );
}

function StaticCard({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #e3e3e3',
        borderRadius: 12,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {title && (
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1a1a1a' }}>{title}</h3>
      )}
      {children}
    </div>
  );
}

function StaticField({
  label,
  value,
  placeholder,
  multiline,
}: {
  label: string;
  value?: string;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 500, color: '#1a1a1a' }}>{label}</span>
      <div
        style={{
          border: '1px solid #c9cccf',
          borderRadius: 8,
          padding: '8px 12px',
          fontSize: 14,
          color: value ? '#1a1a1a' : '#8a8a8a',
          background: '#fff',
          minHeight: multiline ? 120 : undefined,
        }}
      >
        {value || placeholder}
      </div>
    </div>
  );
}

export function SellioDemo() {
  const { data: me, isLoading: meLoading } = useQuery<{ isMerchant?: boolean }>({
    queryKey: ['me'],
    queryFn: () => api.get('/v1/me'),
    retry: false,
  });

  const [mediaImages, setMediaImages] = useState<MediaImage[]>([]);
  const [studioModalOpen, setStudioModalOpen] = useState(false);

  useEffect(() => {
    if (!studioModalOpen) return;
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (!isEmbedImageSelectedMessage(event.data)) return;
      setMediaImages((prev) => [
        ...prev,
        {
          id: `${event.data.jobId}-${Date.now()}`,
          url: event.data.imageUrl,
          source: 'tryme' as const,
        },
      ]);
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [studioModalOpen]);

  if (!meLoading && !me?.isMerchant) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: C.mid, fontSize: 14 }}>
        This preview is available for merchant accounts. Contact us to enable merchant features on
        your account.
      </div>
    );
  }

  return (
    <ShopifyChrome>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 20 }}>
        <span style={{ fontSize: 12, color: '#6b6f76' }}>Products &gt; Add product</span>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, color: '#1a1a1a' }}>Add product</h1>
      </div>
      <div
        style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, alignItems: 'start' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <StaticCard>
            <StaticField label="Title" value={MOCK_PRODUCT.title} />
            <StaticField label="Description" multiline placeholder="Short sleeve t-shirt" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: '#1a1a1a' }}>Media</span>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {mediaImages.map((img) => (
                  <div
                    key={img.id}
                    style={{
                      position: 'relative',
                      width: 100,
                      height: 100,
                      borderRadius: 8,
                      overflow: 'hidden',
                      border: '1px solid #c9cccf',
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {/* biome-ignore lint/performance/noImgElement: dynamic remote thumbnail */}
                    <img
                      src={img.url}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    {img.source === 'tryme' && (
                      <span
                        style={{
                          position: 'absolute',
                          bottom: 4,
                          left: 4,
                          right: 4,
                          fontSize: 9,
                          fontWeight: 700,
                          color: '#fff',
                          background:
                            'linear-gradient(91.84deg, #521D9C 0.33%, #BD2587 50.77%, #F96657 99.67%)',
                          borderRadius: 6,
                          padding: '2px 4px',
                          textAlign: 'center',
                        }}
                      >
                        ✨ Ai Vastra
                      </span>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  style={{
                    height: 36,
                    padding: '0 18px',
                    borderRadius: 8,
                    border: '1px solid #c9cccf',
                    background: '#fff',
                    color: '#1a1a1a',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    alignSelf: 'flex-start',
                  }}
                >
                  Upload Images
                </button>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    height: 36,
                    color: '#8a8a8a',
                    fontSize: 13,
                    fontWeight: 500,
                  }}
                >
                  or
                </div>

                <button
                  type="button"
                  onClick={() => setStudioModalOpen(true)}
                  style={{
                    height: 36,
                    padding: '0 18px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'linear-gradient(135deg, #7c3aed 0%, #BD2587 100%)',
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    alignSelf: 'flex-start',
                  }}
                >
                  <svg
                    aria-hidden="true"
                    width={16}
                    height={16}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
                    <path d="M20 2v4" />
                    <path d="M22 4h-4" />
                    <circle cx="4" cy="20" r="2" />
                  </svg>
                  Create AI Catalogue
                </button>
              </div>
            </div>
            <StaticField label="Category" placeholder="Choose a product category" />
          </StaticCard>
          <StaticCard title="Price">
            <div style={{ display: 'flex', gap: 12 }}>
              <StaticField label="Price" value="$ 0.00" />
              <StaticField label="Compare-at price" placeholder="$ 0.00" />
            </div>
          </StaticCard>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <StaticCard title="Status">
            <StaticField label="" value="Active" />
          </StaticCard>
          <StaticCard title="Publishing">
            <StaticField label="" value="All channels" />
          </StaticCard>
          <StaticCard title="Product organization">
            <StaticField label="Type" placeholder="None" />
            <StaticField label="Vendor" placeholder="None" />
            <StaticField label="Collections" placeholder="+ Add collections" />
            <StaticField label="Tags" placeholder="+ Add tags" />
          </StaticCard>
          <StaticCard title="Theme template">
            <StaticField label="" value="Default product" />
          </StaticCard>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, marginTop: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <StaticCard title="Inventory">
            <div
              style={{
                border: '1px solid #e3e3e3',
                borderRadius: 8,
                overflow: 'hidden',
                fontSize: 13,
              }}
            >
              {['My Custom Location', 'Shop location'].map((loc, i) => (
                <div
                  key={loc}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 14px',
                    borderTop: i === 0 ? 'none' : '1px solid #e3e3e3',
                    background: i === 0 ? '#fafafa' : '#fff',
                  }}
                >
                  <span style={{ color: '#1a1a1a' }}>{loc}</span>
                  <span
                    style={{
                      border: '1px solid #c9cccf',
                      borderRadius: 6,
                      padding: '4px 10px',
                      color: '#1a1a1a',
                    }}
                  >
                    0
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <StaticField label="SKU" placeholder="" />
              <StaticField label="Barcode" placeholder="" />
            </div>
          </StaticCard>
          <StaticCard title="Shipping">
            <StaticField
              label="Package"
              value="Store default · Sample box - 8.6 x 5.4 x 1.6 in, 0 lb"
            />
            <StaticField label="Product weight" value="0.0 lb" />
          </StaticCard>
          <StaticCard title="Variants">
            <StaticField label="" placeholder="+ Add options like size or color" />
          </StaticCard>
          <StaticCard title="Purchase options">
            <StaticField
              label=""
              placeholder="+ Subscriptions, preorders, try before you buy, and more"
            />
          </StaticCard>
        </div>
        <div />
      </div>

      {studioModalOpen && (
        // biome-ignore lint/a11y/noStaticElementInteractions: click-outside-to-dismiss backdrop; Close button below is the keyboard path
        <div
          role="presentation"
          onClick={() => setStudioModalOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation only */}
          <div
            role="presentation"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 820,
              maxWidth: '92vw',
              height: 720,
              maxHeight: '90vh',
              background: '#fff',
              borderRadius: 12,
              boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 20px',
                borderBottom: `1px solid ${C.border}`,
              }}
            >
              <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}></span>
              <button
                type="button"
                onClick={() => setStudioModalOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: C.mid,
                  display: 'flex',
                }}
              >
                <XIcon size={20} />
              </button>
            </div>
            <iframe
              src={`${BASE}/embed/sellio-studio`}
              title="Ai Vastra product photo generator"
              style={{ flex: 1, border: 'none', width: '100%' }}
            />
          </div>
        </div>
      )}
    </ShopifyChrome>
  );
}
