'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Film, Plus } from 'lucide-react';
import { useCallback, useState } from 'react';

import { C } from '@/components/tokens';
import { TopBar } from '@/components/topbar';
import { GradBtn } from '@/components/ui/grad-btn';
import { useJobStream } from '@/hooks/use-job-stream';
import { api } from '@/lib/api';

import { CatalogVideoWizard } from './CatalogVideoWizard';

interface CatalogVideoItem {
  id: string;
  status: string;
  createdAt: string;
  sampleVideoId: string | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
}

function statusColor(status: string): string {
  if (status === 'COMPLETED') return C.mint;
  if (status === 'FAILED' || status === 'CANCELLED') return C.pink;
  return C.amber;
}

/** The dispatcher's raw statuses are internal pipeline stages — collapse the three
 *  in-flight ones into a single "Generating" so the pill reads as progress. */
function statusLabel(status: string): string {
  switch (status) {
    case 'QUEUED':
      return 'Queued';
    case 'PREPROCESSING':
    case 'GENERATING':
    case 'UPLOADING':
      return 'Generating';
    case 'COMPLETED':
      return 'Ready';
    case 'FAILED':
      return 'Failed';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return status;
  }
}

export default function CatalogVideoPage(): React.ReactElement {
  const qc = useQueryClient();
  const [wizardOpen, setWizardOpen] = useState(false);

  const { data: items, isLoading } = useQuery<CatalogVideoItem[]>({
    queryKey: ['catalog-videos'],
    queryFn: () => api.get('/v1/catalog-videos'),
    refetchInterval: 5 * 60 * 1000,
  });

  useJobStream(
    useCallback(
      (event) => {
        qc.setQueryData<CatalogVideoItem[]>(['catalog-videos'], (old) => {
          if (!old) return old;
          return old.map((item) =>
            item.id === event.jobId ? { ...item, status: event.status } : item,
          );
        });
        if (event.status === 'COMPLETED') {
          void qc.invalidateQueries({ queryKey: ['catalog-videos'] });
        }
      },
      [qc],
    ),
  );

  return (
    <>
      <style>{`
        .cat-video-main {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: 20px 24px 32px;
          background: ${C.bg};
          box-sizing: border-box;
        }

        .cat-video-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 20px;
        }

        .cat-video-title {
          margin: 0;
          color: ${C.text};
          font-size: 20px;
        }

        .cat-video-subtitle {
          margin: 5px 0 0;
          color: ${C.mid};
          font-size: 13px;
        }

        .cat-video-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 16px;
        }

        @media (max-width: 1023px) {
          .cat-video-main {
            padding: 16px 20px 24px;
          }
          .cat-video-grid {
            grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
            gap: 12px;
          }
        }

        @media (max-width: 639px) {
          .cat-video-main {
            padding: 12px 16px 20px;
          }
          .cat-video-header {
            flex-direction: column;
            align-items: center;
            text-align: center;
            gap: 12px;
          }
          .cat-video-title {
            font-size: 18px;
          }
          .cat-video-subtitle {
            font-size: 12px;
          }
          .cat-video-grid {
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
          }
        }
      `}</style>
      <TopBar
        title="Catalog Video"
        subtitle="Create motion-ready product video from your catalogue images"
      />
      <main className="cat-video-main">
        <div className="cat-video-header">
          <div>
            <h1 className="cat-video-title">Catalog Videos</h1>
            <p className="cat-video-subtitle">Your generated product videos</p>
          </div>
          <GradBtn onClick={() => setWizardOpen(true)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <Plus size={15} />
              New catalog video
            </span>
          </GradBtn>
        </div>

        {isLoading ? (
          <p style={{ color: C.mid, fontSize: 13 }}>Loading videos...</p>
        ) : !items || items.length === 0 ? (
          <div
            style={{
              minHeight: 280,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              border: `1px dashed ${C.border}`,
              borderRadius: 8,
              color: C.mid,
            }}
          >
            <Film size={28} strokeWidth={1.5} />
            <span style={{ fontSize: 13 }}>No catalog videos yet.</span>
            <GradBtn onClick={() => setWizardOpen(true)}>Create video</GradBtn>
          </div>
        ) : (
          <div className="cat-video-grid">
            {items.map((item) => {
              const color = statusColor(item.status);
              return (
                <article
                  key={item.id}
                  className="prod-card"
                  style={{
                    overflow: 'hidden',
                    border: `1px solid ${C.border}`,
                    borderRadius: 14,
                    background: C.card,
                  }}
                >
                  <div
                    className="prod-card-img"
                    style={{
                      position: 'relative',
                      aspectRatio: '9 / 16',
                      background: C.lighter,
                      display: 'grid',
                      placeItems: 'center',
                    }}
                  >
                    {item.status === 'COMPLETED' && item.videoUrl ? (
                      // biome-ignore lint/a11y/useMediaCaption: silent garment-preview clip, no dialogue/narration
                      <video
                        src={item.videoUrl}
                        poster={item.thumbnailUrl ?? undefined}
                        controls
                        preload="metadata"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    ) : item.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      // biome-ignore lint/performance/noImgElement: presigned R2 URL
                      <img
                        src={item.thumbnailUrl}
                        alt="Catalog video preview"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    ) : (
                      <Film size={24} color={C.mid} strokeWidth={1.5} />
                    )}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '10px 14px',
                    }}
                  >
                    <span
                      style={{
                        color,
                        background: `color-mix(in srgb, ${color} 12%, transparent)`,
                        borderRadius: 20,
                        padding: '2px 7px',
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      {statusLabel(item.status)}
                    </span>
                    <time style={{ color: C.light, fontSize: 12 }} dateTime={item.createdAt}>
                      {new Date(item.createdAt).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                      })}
                    </time>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      {wizardOpen && (
        <CatalogVideoWizard
          onClose={() => setWizardOpen(false)}
          onCreated={() => setWizardOpen(false)}
        />
      )}
    </>
  );
}
