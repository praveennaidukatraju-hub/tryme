'use client';
import { CheckIcon } from '@/components/icons';
import { C } from '@/components/tokens';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const BENEFITS = ['Studio quality output', 'Multiple model options', 'Ready for ecommerce'];

export function PreviewPanel() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        borderRadius: 20,
        background: C.card,
        boxShadow: `inset 0 0 0 1px ${C.border2}, 0 4px 15px rgba(0,0,0,0.08)`,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: 88,
          borderBottom: `1px solid ${C.border2}`,
          padding: 16,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          justifyContent: 'center',
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Catalogue Preview</span>
        <span style={{ fontSize: 12, fontWeight: 500, color: C.mid }}>
          Your generation results will appear here
        </span>
      </div>
      <div style={{ flex: 1, padding: 16, boxSizing: 'border-box' }}>
        <div
          style={{
            height: '100%',
            borderRadius: 8,
            outline: `2px dashed ${C.border2}`,
            outlineOffset: -2,
            padding: 16,
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            alignItems: 'center',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: '100%',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {/* biome-ignore lint/performance/noImgElement: studio placeholder image */}
            <img
              src={`${BASE}/assets/catelouge-preview.png`}
              alt="Catalogue Preview"
              style={{ width: '80%', height: 'auto', objectFit: 'contain' }}
            />
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              width: '100%',
              padding: '16px 8px 0',
              boxSizing: 'border-box',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
              <span
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  textAlign: 'center',
                  color: C.text,
                }}
              >
                Turn garments into catalogue ready visuals
              </span>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  textAlign: 'center',
                  color: C.mid,
                  maxWidth: 500,
                  lineHeight: 1.5,
                }}
              >
                Upload a garment, choose your preferred style, and generate professional catalogue
                images in just a few clicks.
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                gap: 24,
                alignItems: 'center',
                justifyContent: 'center',
                flexWrap: 'wrap',
                marginTop: 8,
              }}
            >
              {BENEFITS.map((b) => (
                <div key={b} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#521D9C', display: 'flex' }}>
                    <CheckIcon size={16} />
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{b}</span>
                </div>
              ))}
            </div>
          </div>
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              fontStyle: 'italic',
              textAlign: 'center',
              color: C.light,
              paddingTop: 16,
            }}
          >
            Preview your AI generated output here before download.
          </span>
        </div>
      </div>
    </div>
  );
}
