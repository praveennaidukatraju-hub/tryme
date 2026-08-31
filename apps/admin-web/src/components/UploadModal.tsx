import { useEffect, useState } from 'react';
import { apiFetch, UPLOAD_NETWORK_ERROR, uploadErrorMessage } from '../lib/data';
import { makeThumbnail } from '../lib/thumbnail';
import { EditDrawer } from './EditDrawer';
import { Switch } from './Switch';

export type FieldDef =
  | { type: 'text'; name: string; label: string; required?: boolean; placeholder?: string }
  | { type: 'select'; name: string; label: string; options: { value: string; label: string }[] }
  | {
      type: 'number';
      name: string;
      label: string;
      min?: number;
      defaultValue?: number;
      placeholder?: string;
    }
  | { type: 'toggle'; name: string; label: string };

interface PresignResult {
  uploadUrl: string;
  r2Key: string;
  thumbnailUploadUrl: string;
  thumbnailKey: string;
  [key: string]: string; // extra fields (e.g. faceSideUploadUrl, faceSideR2Key)
}

export interface SecondaryUpload {
  label: string;
  uploadUrlKey: string; // key in presign response containing the PUT URL
  r2KeyField: string; // key in presign response to pass to confirm body
  required?: boolean;
}

interface UploadModalProps {
  title: string;
  presignPath: string;
  presignExtra?: Record<string, unknown>;
  confirmPath: string;
  confirmExtra?: Record<string, unknown>;
  fields: FieldDef[];
  secondaryUpload?: SecondaryUpload;
  onDone: (row: unknown) => void;
  onClose: () => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

function uploadWithProgress(
  url: string,
  file: Blob,
  onProgress: (p: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(uploadErrorMessage(xhr.status)));
    xhr.onerror = () => reject(new Error(UPLOAD_NETWORK_ERROR));
    xhr.send(file);
  });
}

export function UploadModal({
  title,
  presignPath,
  presignExtra,
  confirmPath,
  confirmExtra,
  fields,
  secondaryUpload,
  onDone,
  onClose,
  toast,
}: UploadModalProps) {
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => {
    const init: Record<string, string | number | boolean> = {};
    for (const f of fields) {
      if (f.type === 'toggle') init[f.name] = false;
      else if (f.type === 'number') init[f.name] = f.defaultValue ?? 0;
      else if (f.type === 'select') init[f.name] = f.options[0]?.value ?? '';
      else init[f.name] = '';
    }
    return init;
  });
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [secondaryFile, setSecondaryFile] = useState<File | null>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'confirming'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const busy = status !== 'idle';

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(f ? URL.createObjectURL(f) : null);
  };

  const handleSubmit = async () => {
    if (!file) {
      setError('Select an image file');
      return;
    }
    if (secondaryUpload?.required && !secondaryFile) {
      setError(`${secondaryUpload.label} is required`);
      return;
    }
    for (const f of fields) {
      if (f.type === 'text' && f.required && !(values[f.name] as string).trim()) {
        setError(`${f.label} is required`);
        return;
      }
    }
    setError(null);
    setStatus('uploading');
    setProgress(0);

    // Progress budget: main=50%, thumb=20%, secondary=20%, confirm=10%
    const hasSecondary = !!secondaryUpload && !!secondaryFile;
    const mainBudget = hasSecondary ? 50 : 65;
    const thumbBudget = hasSecondary ? 20 : 25;

    try {
      const presignRes = await apiFetch<PresignResult>(presignPath, {
        method: 'POST',
        body: JSON.stringify({ contentType: file.type, ...values, ...presignExtra }),
      });
      await uploadWithProgress(presignRes.uploadUrl, file, (p) =>
        setProgress(Math.round(p * mainBudget)),
      );
      const thumb = await makeThumbnail(file);
      await uploadWithProgress(presignRes.thumbnailUploadUrl, thumb, (p) =>
        setProgress(mainBudget + Math.round(p * thumbBudget)),
      );

      const confirmBody: Record<string, unknown> = {
        ...values,
        ...confirmExtra,
        r2Key: presignRes.r2Key,
        thumbnailKey: presignRes.thumbnailKey,
      };

      if (secondaryUpload && secondaryFile) {
        const secondaryUploadUrl = presignRes[secondaryUpload.uploadUrlKey];
        if (secondaryUploadUrl) {
          await uploadWithProgress(secondaryUploadUrl, secondaryFile, (p) =>
            setProgress(mainBudget + thumbBudget + Math.round(p * 20)),
          );
        }
        confirmBody[secondaryUpload.r2KeyField] = presignRes[secondaryUpload.r2KeyField];
      }

      setStatus('confirming');
      setProgress(92);
      const row = await apiFetch(confirmPath, {
        method: 'POST',
        body: JSON.stringify(confirmBody),
      });
      setProgress(100);
      toast({ title: `${title} added` });
      onDone(row);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
      setStatus('idle');
      setProgress(0);
    }
  };

  return (
    <EditDrawer
      onClose={onClose}
      title={title}
      width="min(520px, calc(100vw - 80px))"
      saving={busy}
      onSave={() => void handleSubmit()}
      saveLabel="Upload"
      saveDisabled={!file}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && (
          <div
            style={{
              color: 'var(--danger)',
              fontSize: 13,
              padding: '8px 12px',
              borderRadius: 6,
              background: 'var(--danger-soft)',
              border: '1px solid var(--danger-border)',
            }}
          >
            {error}
          </div>
        )}

        {/* Primary file picker */}
        <div className="field">
          <label>Display Image</label>
          {preview && (
            // biome-ignore lint/performance/noImgElement: preview of uploaded image
            <img
              src={preview}
              alt="preview"
              style={{
                width: 72,
                height: 96,
                objectFit: 'cover',
                borderRadius: 6,
                border: '1px solid var(--border)',
                marginBottom: 8,
                display: 'block',
              }}
            />
          )}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            onChange={handleFileChange}
            style={{ fontSize: 13 }}
          />
        </div>

        {/* Optional secondary file picker (e.g. ComfyUI-specific image) */}
        {secondaryUpload && (
          <div className="field">
            <label>
              {secondaryUpload.label}
              {!secondaryUpload.required && (
                <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 4 }}>
                  (optional — can be set later)
                </span>
              )}
            </label>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy}
              onChange={(e) => setSecondaryFile(e.target.files?.[0] ?? null)}
              style={{ fontSize: 13 }}
            />
          </div>
        )}

        {/* Dynamic fields */}
        {fields.map((f) => (
          <div key={f.name} className="field">
            <label>{f.label}</label>
            {f.type === 'text' && (
              <input
                className="input"
                value={values[f.name] as string}
                disabled={busy}
                placeholder={f.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              />
            )}
            {f.type === 'select' && (
              <select
                className="select"
                value={values[f.name] as string}
                disabled={busy}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              >
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            {f.type === 'number' && (
              <input
                className="input"
                type="number"
                value={values[f.name] as number}
                disabled={busy}
                min={f.min}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: Number(e.target.value) }))}
                style={{ width: 100 }}
              />
            )}
            {f.type === 'toggle' && (
              <Switch
                checked={values[f.name] as boolean}
                onChange={() => {
                  if (busy) return;
                  setValues((v) => ({ ...v, [f.name]: !v[f.name] }));
                }}
              />
            )}
          </div>
        ))}

        {/* Progress bar */}
        {busy && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {status === 'uploading' ? `Uploading… ${progress}%` : 'Saving…'}
            </div>
            <div className="bar-track">
              <div className="bar-fill accent" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
      </div>
    </EditDrawer>
  );
}
