'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { LogoAuth } from '@/components/logo';
import { C, grad } from '@/components/tokens';
import { downloadErrorMessage } from '@/lib/errors';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Item = { jobId: string; url: string };
type Phase = 'loading' | 'ready' | 'zipping' | 'error';

function KioskDownloadInner(): React.ReactElement {
  const searchParams = useSearchParams();
  const jobIds = searchParams.get('jobs') ?? '';

  const [phase, setPhase] = useState<Phase>('loading');
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState('');
  const [zipProgress, setZipProgress] = useState(0);

  useEffect(() => {
    if (!jobIds) {
      setError('This link is missing its images. Please scan the QR code again.');
      setPhase('error');
      return;
    }
    const controller = new AbortController();
    fetch(`${API_URL}/v1/kiosk-download/batch?jobIds=${encodeURIComponent(jobIds)}`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(downloadErrorMessage(res.status));
        return res.json() as Promise<{ items: Item[] }>;
      })
      .then((body) => {
        if (body.items.length === 0) {
          setError('These images have expired. Please try on again for a fresh link.');
          setPhase('error');
          return;
        }
        setItems(body.items);
        setPhase('ready');
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
        setPhase('error');
      });
    return () => controller.abort();
  }, [jobIds]);

  async function downloadAll() {
    setPhase('zipping');
    setZipProgress(0);
    try {
      const blobResults = await Promise.allSettled(
        items.map(async (item) => {
          const res = await fetch(item.url);
          if (!res.ok) throw new Error(downloadErrorMessage(res.status));
          return { jobId: item.jobId, blob: await res.blob() };
        }),
      );
      const succeeded = blobResults
        .filter(
          (r): r is PromiseFulfilledResult<{ jobId: string; blob: Blob }> =>
            r.status === 'fulfilled',
        )
        .map((r) => r.value);

      if (succeeded.length === 0) {
        setError('Could not download the images. Please try again.');
        setPhase('error');
        return;
      }

      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      succeeded.forEach((item, idx) => {
        zip.file(`tryon-${idx + 1}.jpg`, item.blob);
      });

      const zipBlob = await zip.generateAsync({ type: 'blob' }, (meta: { percent: number }) => {
        setZipProgress(meta.percent);
      });

      const date = new Date().toISOString().slice(0, 10);
      const objectUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `tryme-tryon-${date}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 100);

      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      setPhase('error');
    }
  }

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        padding: 24,
        background: C.bg,
        color: C.text,
        textAlign: 'center',
      }}
    >
      <LogoAuth />
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Your try-on images</h1>

      {phase === 'loading' && <p style={{ color: C.mid, margin: 0 }}>Loading your images…</p>}

      {phase === 'error' && <p style={{ color: C.danger, maxWidth: 320, margin: 0 }}>{error}</p>}

      {(phase === 'ready' || phase === 'zipping') && items.length > 0 && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
              gap: 12,
              maxWidth: 420,
              width: '100%',
            }}
          >
            {items.map((item) => (
              // eslint-disable-next-line @next/next/no-img-element
              // biome-ignore lint/performance/noImgElement: remote presigned thumbnail, not a Next-optimizable local asset
              <img
                key={item.jobId}
                src={item.url}
                alt="Try-on result"
                style={{
                  width: '100%',
                  aspectRatio: '3 / 4',
                  objectFit: 'cover',
                  borderRadius: 12,
                  border: `1px solid ${C.border}`,
                }}
              />
            ))}
          </div>

          <p style={{ color: C.mid, fontSize: 13, margin: 0 }}>
            {items.length} image{items.length === 1 ? '' : 's'} ready to download
          </p>

          <button
            type="button"
            onClick={downloadAll}
            disabled={phase === 'zipping'}
            style={{
              padding: '14px 28px',
              borderRadius: 999,
              border: 'none',
              background: grad,
              color: C.white,
              fontWeight: 600,
              fontSize: 16,
              cursor: phase === 'zipping' ? 'not-allowed' : 'pointer',
              opacity: phase === 'zipping' ? 0.7 : 1,
            }}
          >
            {phase === 'zipping' ? `Zipping… ${Math.round(zipProgress)}%` : 'Download all'}
          </button>
        </>
      )}
    </div>
  );
}

export default function KioskDownloadPage(): React.ReactElement {
  return (
    <Suspense fallback={<div style={{ minHeight: '100dvh', background: C.bg }} />}>
      <KioskDownloadInner />
    </Suspense>
  );
}
