import { useState } from 'react';
import { Icon } from '../components/Icons';
import type { Toast } from './assets/AssetsContext';
import { AssetsProvider, useAssetsContext } from './assets/AssetsContext';
import { BackgroundsTab } from './assets/BackgroundsTab';
import { CatalogTab } from './assets/CatalogTab';
import { CatalogueTemplatesTab } from './assets/CatalogueTemplatesTab';
import { FacesTab } from './assets/FacesTab';
import { GarmentTypesTab } from './assets/GarmentTypesTab';
import { PoseAssetsTab } from './assets/PoseAssetsTab';
import { SampleVideosTab } from './assets/SampleVideosTab';
import { SareeStylesTab } from './assets/SareeStylesTab';

interface Props {
  onNav: (_page: string, _filter?: { page: string; filter?: string }) => void;
  toast: Toast;
}

const TABS = [
  { k: 'garment-types' as const, l: 'Garment Types' },
  { k: 'faces' as const, l: 'Model Faces' },
  { k: 'backgrounds' as const, l: 'Backgrounds' },
  { k: 'pose-assets' as const, l: 'Pose Assets' },
  { k: 'lower' as const, l: 'Lower garments' },
  { k: 'shoe' as const, l: 'Shoes' },
  { k: 'catalogue-templates' as const, l: 'Templates' },
  { k: 'saree-styles' as const, l: 'Saree Styles' },
  { k: 'sample-videos' as const, l: 'Sample Videos' },
];

function AssetsShell() {
  const { activeTab, setActiveTab, loading, previewUrl, setPreviewUrl } = useAssetsContext();
  const [isOpen, setIsOpen] = useState(false);

  const activeTabObj = TABS.find((t) => t.k === activeTab) || TABS[0];

  return (
    <>
      {/* Desktop horizontal tabs */}
      <div className="desktop-only">
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.k}
              type="button"
              className={`tab ${activeTab === t.k ? 'active' : ''}`}
              onClick={() => setActiveTab(t.k)}
            >
              {t.l}
            </button>
          ))}
        </div>
      </div>

      {/* Mobile/Tablet vertical accordion bar */}
      <div className="mobile-only" style={{ position: 'relative', marginBottom: 20 }}>
        {/* Accordion Bar */}
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 20px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            cursor: 'pointer',
            textAlign: 'left',
            color: 'var(--ink)',
            fontSize: 15,
            fontWeight: 600,
            boxShadow: 'var(--shadow-sm)',
            transition: 'border-color 0.2s, box-shadow 0.2s',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--accent)',
              }}
            />
            {activeTabObj.l}
          </div>
          <span
            style={{
              color: 'var(--muted-2)',
              transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s',
              display: 'inline-flex',
            }}
          >
            <Icon.Chevron />
          </span>
        </button>

        {isOpen && (
          <>
            {/* Click outside backdrop */}
            <div
              onClick={() => setIsOpen(false)}
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 99,
                background: 'transparent',
              }}
            />
            {/* Navlinks list items displayed one-by-one */}
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                left: 0,
                right: 0,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                boxShadow: 'var(--shadow-lg)',
                zIndex: 100,
                padding: '8px 0',
                display: 'flex',
                flexDirection: 'column',
                maxHeight: '350px',
                overflowY: 'auto',
              }}
            >
              {TABS.map((t) => (
                <button
                  key={t.k}
                  type="button"
                  onClick={() => {
                    setActiveTab(t.k);
                    setIsOpen(false);
                  }}
                  style={{
                    width: '100%',
                    padding: '12px 20px',
                    background: activeTab === t.k ? 'var(--bg-2)' : 'none',
                    border: 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontSize: 14,
                    fontWeight: activeTab === t.k ? 600 : 400,
                    color: activeTab === t.k ? 'var(--accent)' : 'var(--ink)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    transition: 'background 0.15s, color 0.15s',
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: activeTab === t.k ? 'var(--accent)' : 'transparent',
                      display: 'inline-block',
                    }}
                  />
                  {t.l}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {loading && (
        <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>Loading…</div>
      )}

      {activeTab === 'backgrounds' && <BackgroundsTab />}
      {activeTab === 'faces' && <FacesTab />}
      {activeTab === 'garment-types' && <GarmentTypesTab />}
      {activeTab === 'pose-assets' && <PoseAssetsTab />}
      {(activeTab === 'lower' || activeTab === 'shoe') && <CatalogTab />}
      {activeTab === 'catalogue-templates' && <CatalogueTemplatesTab />}
      {activeTab === 'saree-styles' && <SareeStylesTab />}
      {activeTab === 'sample-videos' && <SampleVideosTab />}

      {previewUrl && (
        <div
          onClick={() => setPreviewUrl(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.82)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            cursor: 'zoom-out',
          }}
        >
          {/* biome-ignore lint/performance/noImgElement: admin panel */}
          <img
            src={previewUrl}
            alt="preview"
            style={{
              maxWidth: '90vw',
              maxHeight: '90vh',
              borderRadius: 8,
              boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

export default function AssetsPage({ onNav: _onNav, toast }: Props) {
  return (
    <AssetsProvider toast={toast}>
      <AssetsShell />
    </AssetsProvider>
  );
}
