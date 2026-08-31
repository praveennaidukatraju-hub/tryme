import { useEffect, useState } from 'react';
import { apiFetch, UPLOAD_NETWORK_ERROR, uploadErrorMessage } from '../lib/data';
import { makeGifFromVideo } from '../lib/gif';
import { EditDrawer } from './EditDrawer';
import { Icon } from './Icons';

interface PresignResult {
  videoUploadUrl: string;
  videoR2Key: string;
  thumbnailUploadUrl: string;
  thumbnailR2Key: string;
}
export interface SampleVideo {
  id: string;
  title: string;
  videoR2Key: string;
  thumbnailR2Key: string;
  prompt: string;
  isActive: boolean;
  sortOrder: number;
  videoUrl: string;
  thumbnailUrl: string;
}

function uploadFile(url: string, file: Blob, contentType: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(uploadErrorMessage(xhr.status)));
    xhr.onerror = () => reject(new Error(UPLOAD_NETWORK_ERROR));
    xhr.send(file);
  });
}

export function SampleVideoUploadModal({
  onClose,
  onDone,
  toast,
}: {
  onClose: () => void;
  onDone: (created: SampleVideo) => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [gifBlob, setGifBlob] = useState<Blob | null>(null);
  const [gifPreviewUrl, setGifPreviewUrl] = useState<string | null>(null);
  const [generatingGif, setGeneratingGif] = useState(false);
  const [gifError, setGifError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [sortOrder, setSortOrder] = useState(0);
  const [uploading, setUploading] = useState(false);
  const canSubmit = Boolean(title.trim() && prompt.trim());

  // Regenerate the preview GIF whenever a new video file is chosen — it's the auto
  // thumbnail now, there's no separate manual poster upload step.
  useEffect(() => {
    if (!videoFile) {
      setGifBlob(null);
      setGifPreviewUrl(null);
      return;
    }
    let cancelled = false;
    setGeneratingGif(true);
    setGifError(null);
    makeGifFromVideo(videoFile)
      .then((blob) => {
        if (cancelled) return;
        setGifBlob(blob);
        setGifPreviewUrl(URL.createObjectURL(blob));
      })
      .catch((err) => {
        if (cancelled) return;
        setGifError(err instanceof Error ? err.message : 'Failed to generate GIF preview');
      })
      .finally(() => {
        if (!cancelled) setGeneratingGif(false);
      });
    return () => {
      cancelled = true;
    };
  }, [videoFile]);

  useEffect(() => {
    return () => {
      if (gifPreviewUrl) URL.revokeObjectURL(gifPreviewUrl);
    };
  }, [gifPreviewUrl]);

  const submit = async () => {
    if (!videoFile || !gifBlob || !canSubmit) return;
    setUploading(true);
    try {
      const presign = await apiFetch<PresignResult>('/admin/assets/sample-videos/presign', {
        method: 'POST',
        body: JSON.stringify({
          videoContentType: 'video/mp4',
          thumbnailContentType: 'image/gif',
        }),
      });
      await Promise.all([
        uploadFile(presign.videoUploadUrl, videoFile, 'video/mp4'),
        uploadFile(presign.thumbnailUploadUrl, gifBlob, 'image/gif'),
      ]);
      const created = await apiFetch<SampleVideo>('/admin/assets/sample-videos', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          videoR2Key: presign.videoR2Key,
          thumbnailR2Key: presign.thumbnailR2Key,
          prompt: prompt.trim(),
          sortOrder,
        }),
      });
      toast({ title: 'Sample video uploaded' });
      onDone(created);
    } catch (error) {
      toast({
        kind: 'error',
        title: 'Upload failed',
        body: error instanceof Error ? error.message : 'Failed',
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <EditDrawer
      onClose={onClose}
      title="Add sample video"
      width="min(640px, calc(100vw - 40px))"
      saving={uploading}
      onSave={() => {
        if (step === 1) {
          if (!videoFile || !gifBlob || generatingGif) return;
          setStep(2);
        } else {
          void submit();
        }
      }}
      saveLabel={step === 1 ? 'Next' : 'Create'}
      saveDisabled={step === 1 ? !videoFile || !gifBlob || generatingGif : !canSubmit || uploading}
    >
      {step === 1 ? (
        <>
          <div className="field">
            <label>Sample video file (.mp4)</label>
            <input
              type="file"
              accept="video/mp4"
              onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
            />
            <span className="hint">
              A looping preview GIF is generated automatically from this clip — no separate poster
              image needed.
            </span>
          </div>

          {videoFile && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: 14,
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--surface2, #1a1a1a)',
              }}
            >
              <div
                style={{
                  width: 160,
                  aspectRatio: '9 / 16',
                  borderRadius: 6,
                  overflow: 'hidden',
                  background: 'var(--subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {gifPreviewUrl ? (
                  // biome-ignore lint/performance/noImgElement: animated GIF preview, blob URL
                  <img
                    src={gifPreviewUrl}
                    alt="Generated preview"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <Icon.Image />
                )}
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                {generatingGif && <p style={{ margin: 0 }}>Generating preview GIF…</p>}
                {gifError && <p style={{ margin: 0, color: 'var(--danger)' }}>{gifError}</p>}
                {!generatingGif && !gifError && gifPreviewUrl && (
                  <p style={{ margin: 0 }}>Preview GIF ready.</p>
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn ghost"
            onClick={() => setStep(1)}
            disabled={uploading}
            style={{ alignSelf: 'flex-start' }}
          >
            Back
          </button>
          <div className="field">
            <label>Title</label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
            />
          </div>
          <div className="field">
            <label>PixVerse prompt</label>
            <textarea
              className="input"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={5000}
              rows={4}
            />
          </div>
          <div className="field">
            <label>Sort order</label>
            <input
              className="input"
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value))}
              style={{ width: 100 }}
            />
          </div>
        </>
      )}
    </EditDrawer>
  );
}
