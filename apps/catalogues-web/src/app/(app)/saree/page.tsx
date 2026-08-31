'use client';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { InfoIcon } from '@/components/icons';
import { C, grad } from '@/components/tokens';
import { TopBar } from '@/components/topbar';
import { useJobStream } from '@/hooks/use-job-stream';
import { api } from '@/lib/api';

const DEFAULT_CREDITS_COST = 5;

type SareeConfig = {
  modelImageUrl: string | null;
  sampleSareeImageUrl: string | null;
  isConfigured: boolean;
  creditsCost: number;
};

function SareeUploadZone({
  preview,
  progress,
  label,
  tip,
  onFile,
  disabled,
  sampleUrl,
  sampleLabel = 'Reference',
}: {
  preview: string | null;
  progress: number;
  label: string;
  tip: string;
  onFile: (f: File) => void;
  disabled?: boolean;
  sampleUrl?: string | null;
  sampleLabel?: string;
}) {
  const [showSamples, setShowSamples] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const accept = (f: File) => {
    if (!f.type.startsWith('image/')) return;
    onFile(f);
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) accept(f);
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: accept is a stable inline closure over onFile, not state
    [accept],
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        borderRadius: 12,
        background: C.bg,
        boxShadow: `inset 0 0 0 1px ${C.border}`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 12,
        boxSizing: 'border-box',
        position: 'relative',
      }}
    >
      {sampleUrl && (
        <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 10 }}>
          <button
            type="button"
            onMouseEnter={() => setShowSamples(true)}
            onMouseLeave={() => setShowSamples(false)}
            style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              border: 'none',
              background: 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <InfoIcon size={16} color={C.mid} />
          </button>
          {showSamples && (
            // biome-ignore lint/a11y/noStaticElementInteractions: hover-only preview popover, not a keyboard-operable control
            <div
              onMouseEnter={() => setShowSamples(true)}
              onMouseLeave={() => setShowSamples(false)}
              style={{
                position: 'absolute',
                top: 26,
                right: 0,
                zIndex: 100,
                background: C.white,
                boxShadow: `0 8px 24px rgba(0,0,0,0.18), inset 0 0 0 1px ${C.border}`,
                borderRadius: 12,
                padding: 10,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: C.mid,
                  display: 'block',
                  marginBottom: 6,
                }}
              >
                {sampleLabel}
              </span>
              {/* biome-ignore lint/performance/noImgElement: presigned/static asset URL */}
              <img
                src={sampleUrl}
                alt=""
                style={{
                  width: 220,
                  height: 220,
                  objectFit: 'cover',
                  borderRadius: 8,
                  display: 'block',
                }}
              />
            </div>
          )}
        </div>
      )}

      <div>
        <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{label}</span>
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: drag-and-drop zone needs div for layout */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => e.key === 'Enter' && !disabled && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{
          flex: 1,
          margin: '12px 0',
          borderRadius: 12,
          outline: `1px dashed ${dragging ? C.pink : preview ? 'transparent' : C.lighter}`,
          outlineOffset: -1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 12,
          boxSizing: 'border-box',
          cursor: disabled ? 'default' : 'pointer',
          overflow: 'hidden',
          position: 'relative',
          transition: 'outline-color .15s',
        }}
      >
        {preview ? (
          // biome-ignore lint/performance/noImgElement: presigned/static asset URL
          <img
            src={preview}
            alt="preview"
            style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 8 }}
          />
        ) : (
          <>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: C.white,
                boxShadow: `inset 0 0 0 1px ${C.border2}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M9 3h6l-1 4 4 14H6l4-14z"
                  stroke={C.mid}
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <span
              style={{
                fontSize: 10,
                fontWeight: 500,
                textAlign: 'center',
                color: C.light,
                lineHeight: 1.5,
              }}
            >
              Drag and drop an image here · JPG, PNG · Max 10MB
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.text }}>
              {/* biome-ignore lint/performance/noImgElement: presigned/static asset URL */}
              <img
                src="/assets/image-upload.svg"
                alt=""
                width={14}
                height={14}
                style={{ opacity: 0.7, filter: 'var(--icon-invert)' }}
              />
              <span style={{ fontSize: 12, fontWeight: 500 }}>Browse Image</span>
            </div>
          </>
        )}

        {progress > 0 && progress < 100 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.45)',
              borderRadius: 12,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            <span style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>{progress}%</span>
            <div
              style={{
                width: '60%',
                height: 4,
                background: 'rgba(255,255,255,0.2)',
                borderRadius: 4,
              }}
            >
              <div
                style={{
                  width: `${progress}%`,
                  height: '100%',
                  background: grad,
                  borderRadius: 4,
                  transition: 'width .2s',
                }}
              />
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
        {/* biome-ignore lint/performance/noImgElement: static SVG asset */}
        <img
          src="/assets/bulb.svg"
          alt=""
          width={12}
          height={14}
          style={{ flexShrink: 0, marginTop: 1 }}
        />
        <span style={{ fontSize: 10, fontWeight: 600, color: C.pink, flexShrink: 0 }}>Tips</span>
        <span style={{ fontSize: 10, fontWeight: 400, lineHeight: '16px', color: C.mid }}>
          {tip}
        </span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) accept(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

export default function SareePage() {
  const [sareeFile, setSareeFile] = useState<File | null>(null);
  const [sareePreview, setSareePreview] = useState<string | null>(null);
  const [sareeProgress, setSareeProgress] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);

  const { data: cfg } = useQuery<SareeConfig>({
    queryKey: ['saree-config'],
    queryFn: () => api.get('/v1/saree/config'),
    staleTime: 5 * 60_000,
  });
  const sampleSareeImageUrl = cfg?.sampleSareeImageUrl ?? null;
  const isConfigured = cfg?.isConfigured ?? false;
  const creditsCost = cfg?.creditsCost ?? DEFAULT_CREDITS_COST;

  const { data: credits } = useQuery<{ balance: number }>({
    queryKey: ['credits'],
    queryFn: () => api.get('/v1/credits'),
  });

  useJobStream(
    useCallback(
      (evt) => {
        if (!pendingJobId || evt.jobId !== pendingJobId) return;
        if (evt.status === 'COMPLETED') {
          setPendingJobId(null);
          api
            .get<{ url: string }>(`/v1/jobs/${pendingJobId}/result`)
            .then(({ url }) => setResultUrl(url))
            .catch(() => setError('Generation failed. Please try again.'))
            .finally(() => {
              setGenerating(false);
              setSareeProgress(0);
            });
        } else if (evt.status === 'FAILED') {
          setPendingJobId(null);
          setError('Generation failed. Please try again.');
          setGenerating(false);
          setSareeProgress(0);
        }
      },
      [pendingJobId],
    ),
  );

  const pickFile = (file: File, setFile: (f: File) => void, setPreview: (s: string) => void) => {
    setFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target?.result as string);
    reader.readAsDataURL(file);
    setError(null);
    setResultUrl(null);
  };

  const handleGenerate = async () => {
    if (!sareeFile) {
      setError('Upload a saree image first.');
      return;
    }
    setGenerating(true);
    setError(null);
    setResultUrl(null);
    setSareeProgress(1);
    try {
      const presign = await api.post<{ uploadUrl: string; r2Key: string }>('/v1/uploads/presign', {
        contentType: sareeFile.type,
        contentLength: sareeFile.size,
      });
      await api.uploadToR2WithProgress(presign.uploadUrl, sareeFile, setSareeProgress);
      setSareeProgress(100);
      const { jobId } = await api.post<{ jobId: string; catalogueId: string }>('/v1/jobs/saree', {
        garmentKey: presign.r2Key,
      });
      setPendingJobId(jobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      const safe = /upload|credit|image|file|size|format/i.test(msg);
      setError(safe ? msg : 'Something went wrong. Please try again.');
      setGenerating(false);
      setSareeProgress(0);
    }
  };

  const canGenerate = !generating && !!sareeFile && isConfigured;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <TopBar title="Saree Draping (Beta)" subtitle="" />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '20px 20px 24px',
          boxSizing: 'border-box',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gridTemplateRows: '1fr',
          gap: 20,
        }}
      >
        {/* ── Upload panel ── */}
        <div
          style={{
            borderRadius: 24,
            background: C.white,
            boxShadow: `inset 0 0 0 1px ${C.border}, 0 4px 15px rgba(0,0,0,0.04)`,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            padding: 16,
            boxSizing: 'border-box',
            minHeight: 400,
            minWidth: 320,
          }}
        >
          {!isConfigured && (
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: '#b45309',
                background: 'rgba(245,158,11,0.12)',
                borderRadius: 8,
                padding: '10px 12px',
              }}
            >
              Saree catalogue generation is not yet configured by the admin. Check back soon.
            </div>
          )}

          <SareeUploadZone
            preview={sareePreview}
            progress={sareeProgress}
            label="Upload Saree Image"
            tip="Use a flat, top-down photo of the saree for best draping results."
            disabled={generating || !isConfigured}
            sampleUrl={sampleSareeImageUrl}
            sampleLabel="Example input"
            onFile={(f) => pickFile(f, setSareeFile, setSareePreview)}
          />

          {error && (
            <div
              style={{
                fontSize: 13,
                color: '#f87171',
                padding: '6px 10px',
                background: 'rgba(220,38,38,0.12)',
                borderRadius: 8,
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              height: 52,
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
              {/* biome-ignore lint/performance/noImgElement: presigned/static asset URL */}
              <img
                src="/assets/credit.png"
                alt=""
                width={16}
                height={16}
                style={{ opacity: 0.6 }}
              />
              <span style={{ fontSize: 14, fontWeight: 500, color: C.mid }}>
                Uses {creditsCost} credits
                {credits && (
                  <span style={{ color: C.light, marginLeft: 6 }}>
                    ({credits.balance} available)
                  </span>
                )}
              </span>
            </div>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canGenerate}
              style={{
                height: 52,
                paddingInline: 32,
                borderRadius: 12,
                background: canGenerate ? grad : C.border,
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                cursor: canGenerate ? 'pointer' : 'not-allowed',
                boxShadow: canGenerate ? '0 6px 18px rgba(245,92,122,0.28)' : 'none',
                transition: 'opacity .15s',
                flexShrink: 0,
              }}
            >
              <span
                style={{ fontSize: 15, fontWeight: 600, color: canGenerate ? '#fff' : C.light }}
              >
                {generating ? 'Generating…' : 'Generate Catalogue Image'}
              </span>
              {!generating && (
                /* biome-ignore lint/performance/noImgElement: static SVG asset */
                <img
                  src="/assets/generate-icon.svg"
                  alt=""
                  width={20}
                  height={20}
                  style={{ opacity: canGenerate ? 1 : 0.4 }}
                />
              )}
            </button>
          </div>
        </div>

        {/* ── Preview panel ── */}
        <div
          style={{
            borderRadius: 24,
            background: C.bg,
            boxShadow: `inset 0 0 0 1px ${C.border}, 0 4px 15px rgba(0,0,0,0.04)`,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            minHeight: 400,
            minWidth: 320,
          }}
        >
          <div
            style={{
              borderBottom: `1px solid ${C.border}`,
              padding: 16,
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              justifyContent: 'center',
              flexShrink: 0,
              height: 76,
            }}
          >
            <span style={{ fontSize: 18, fontWeight: 600, color: C.text }}>
              Your Saree Catalogues Preview
            </span>
            {resultUrl && (
              <span style={{ fontSize: 13, fontWeight: 500, color: C.mid }}>
                Saree generated successfully.
              </span>
            )}
          </div>

          <div
            style={{
              flex: 1,
              minHeight: 0,
              padding: 16,
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {resultUrl ? (
              <div style={{ flex: 1, borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
                {/* biome-ignore lint/performance/noImgElement: presigned/static asset URL */}
                <img
                  src={resultUrl}
                  alt="Saree result"
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              </div>
            ) : (
              <div
                style={{
                  flex: 1,
                  borderRadius: 8,
                  outline: `2px dashed ${C.border2}`,
                  outlineOffset: -2,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 16,
                  padding: 24,
                  boxSizing: 'border-box',
                }}
              >
                <div
                  style={{
                    width: 120,
                    height: 120,
                    borderRadius: '50%',
                    background: C.bg,
                    boxShadow: `inset 0 0 0 1px ${C.border}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {generating ? (
                    <svg aria-hidden="true" width="40" height="40" viewBox="0 0 40 40" fill="none">
                      <circle cx="20" cy="20" r="16" stroke={C.border2} strokeWidth="3" />
                      <path
                        d="M20 4 A16 16 0 0 1 36 20"
                        stroke={C.pink}
                        strokeWidth="3"
                        strokeLinecap="round"
                      >
                        <animateTransform
                          attributeName="transform"
                          type="rotate"
                          from="0 20 20"
                          to="360 20 20"
                          dur="1s"
                          repeatCount="indefinite"
                        />
                      </path>
                    </svg>
                  ) : (
                    <svg aria-hidden="true" width="48" height="48" viewBox="0 0 48 48" fill="none">
                      <path
                        d="M18 6h12l-2 8 8 28H12l8-28z"
                        stroke={C.border2}
                        strokeWidth="2"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M18 14h12"
                        stroke={C.border2}
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                      <path
                        d="M18 24h12"
                        stroke={C.border2}
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                      <path
                        d="M18 34h12"
                        stroke={C.border2}
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  )}
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}
                >
                  <span
                    style={{ fontSize: 16, fontWeight: 600, color: C.text, textAlign: 'center' }}
                  >
                    {generating ? 'Generating your catalogue image…' : 'No saree generated yet'}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: C.mid,
                      textAlign: 'center',
                      maxWidth: 340,
                      lineHeight: 1.5,
                    }}
                  >
                    {generating
                      ? 'This may take a moment. Please wait.'
                      : 'Upload a flat saree image and click Generate Catalogue Image to preview the result here.'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
