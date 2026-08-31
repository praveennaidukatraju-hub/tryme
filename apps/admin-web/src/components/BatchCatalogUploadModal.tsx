import { useRef, useState } from 'react';
import { apiFetch, UPLOAD_NETWORK_ERROR, uploadErrorMessage } from '../lib/data';
import { makeThumbnail } from '../lib/thumbnail';
import type { CatalogItem } from '../types';
import { EditDrawer } from './EditDrawer';
import { Icon } from './Icons';

interface PresignResult {
  uploadUrl: string;
  r2Key: string;
  thumbnailUploadUrl: string;
  thumbnailKey: string;
}

type FileStatus = 'pending' | 'uploading' | 'done' | 'error';

interface FileEntry {
  file: File;
  preview: string;
  label: string;
  status: FileStatus;
  error?: string;
}

interface Props {
  typeSlug: 'lower' | 'shoe';
  onDone: (added: CatalogItem[]) => void;
  onClose: () => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
  categoryId?: number;
  lockedGenderSlug?: string;
  defaultGenderSlug?: string;
}

async function uploadFile(url: string, file: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(uploadErrorMessage(xhr.status)));
    xhr.onerror = () => reject(new Error(UPLOAD_NETWORK_ERROR));
    xhr.send(file);
  });
}

export function BatchCatalogUploadModal({
  typeSlug,
  onDone,
  onClose,
  toast,
  categoryId,
  lockedGenderSlug,
  defaultGenderSlug = 'men',
}: Props) {
  const [genderSlug, setGenderSlug] = useState(lockedGenderSlug ?? defaultGenderSlug ?? 'men');
  const [sortStart, setSortStart] = useState(0);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = running;

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    setEntries(
      files.map((f) => ({
        file: f,
        preview: URL.createObjectURL(f),
        label: f.name.replace(/\.[^.]+$/, ''),
        status: 'pending',
      })),
    );
    setDoneCount(0);
  };

  const updateEntry = (idx: number, patch: Partial<FileEntry>) =>
    setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));

  const removeEntry = (idx: number) => {
    setEntries((prev) => {
      URL.revokeObjectURL(prev[idx].preview);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleUpload = async () => {
    if (entries.length === 0) return;
    setRunning(true);
    setDoneCount(0);
    const added: CatalogItem[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.status === 'done') {
        setDoneCount((n) => n + 1);
        continue;
      }
      updateEntry(i, { status: 'uploading', error: undefined });
      try {
        const presign = await apiFetch<PresignResult>('/admin/catalog/items/presign', {
          method: 'POST',
          body: JSON.stringify({
            typeSlug,
            label: entry.label.trim(),
            contentType: entry.file.type,
          }),
        });
        await uploadFile(presign.uploadUrl, entry.file);
        await uploadFile(presign.thumbnailUploadUrl, await makeThumbnail(entry.file));
        const row = await apiFetch<CatalogItem>('/admin/catalog/items/confirm', {
          method: 'POST',
          body: JSON.stringify({
            typeSlug,
            label: entry.label.trim(),
            r2Key: presign.r2Key,
            thumbnailKey: presign.thumbnailKey,
            sortOrder: sortStart + i,
            genderSlug,
            ...(categoryId !== undefined ? { categoryId } : {}),
          }),
        });
        added.push(row);
        updateEntry(i, { status: 'done' });
        setDoneCount((n) => n + 1);
      } catch (e) {
        updateEntry(i, {
          status: 'error',
          error: e instanceof Error ? e.message : 'Upload failed',
        });
      }
    }

    setRunning(false);
    if (added.length > 0) {
      toast({ title: `${added.length} item${added.length !== 1 ? 's' : ''} uploaded` });
      onDone(added);
    }
  };

  const allDone = entries.length > 0 && entries.every((e) => e.status === 'done');
  const hasErrors = entries.some((e) => e.status === 'error');
  const allLabeled = entries.every((e) => e.label.trim());
  const pendingCount = entries.filter((e) => e.status !== 'done').length;

  const typeLabel = typeSlug === 'lower' ? 'lower garment' : 'shoe';

  return (
    <EditDrawer
      onClose={onClose}
      title={`Batch upload ${typeLabel}s`}
      width="min(640px, calc(100vw - 40px))"
      saving={running}
      onSave={() => void handleUpload()}
      saveLabel={`Upload ${pendingCount || entries.length || ''} item${pendingCount !== 1 ? 's' : ''}`}
      saveDisabled={entries.length === 0 || allDone || !allLabeled}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Shared settings */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 10 }}>
          <div className="field">
            <label>Gender (applied to all items)</label>
            {lockedGenderSlug ? (
              <span className="badge dot" style={{ marginTop: 6, display: 'inline-block' }}>
                {lockedGenderSlug}
              </span>
            ) : (
              <select
                className="select"
                value={genderSlug}
                disabled={busy}
                onChange={(e) => setGenderSlug(e.target.value)}
              >
                <option value="men">Men</option>
                <option value="women">Women</option>
                <option value="boys">Boys</option>
                <option value="girls">Girls</option>
              </select>
            )}
          </div>
          <div className="field">
            <label>Start sort order</label>
            <input
              className="input"
              type="number"
              min={0}
              value={sortStart}
              disabled={busy}
              onChange={(e) => setSortStart(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>
        </div>

        {/* File picker */}
        <div className="field">
          <label>Images — one file per item (label defaults to filename, edit per row)</label>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            onChange={handleFiles}
            style={{ fontSize: 13 }}
          />
        </div>

        {/* Progress bar */}
        {running && (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            Uploading {doneCount} / {entries.length}…
            <div className="bar-track" style={{ marginTop: 6 }}>
              <div
                className="bar-fill accent"
                style={{ width: `${entries.length ? (doneCount / entries.length) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}

        {/* File rows */}
        {entries.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '44px 1fr 56px 28px',
                gap: 8,
                padding: '0 4px',
                fontSize: 11,
                color: 'var(--muted)',
                fontWeight: 600,
              }}
            >
              <span>Preview</span>
              <span>Label</span>
              <span>Size</span>
              <span></span>
            </div>
            <div
              style={{
                maxHeight: 260,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {entries.map((entry, i) => (
                <div
                  key={`${entry.file.name}-${entry.file.size}-${entry.file.lastModified}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '44px 1fr 56px 28px',
                    gap: 8,
                    alignItems: 'center',
                    padding: '6px 4px',
                    borderRadius: 6,
                    background:
                      entry.status === 'done'
                        ? 'var(--success-soft)'
                        : entry.status === 'error'
                          ? 'var(--danger-soft)'
                          : entry.status === 'uploading'
                            ? 'var(--accent-soft, #f0f7ff)'
                            : 'var(--subtle)',
                    border: `1px solid ${
                      entry.status === 'done'
                        ? 'var(--success-border)'
                        : entry.status === 'error'
                          ? 'var(--danger-border)'
                          : entry.status === 'uploading'
                            ? 'var(--accent, #2563eb)'
                            : 'var(--border)'
                    }`,
                  }}
                >
                  {/* Thumbnail preview */}
                  <div
                    style={{
                      position: 'relative',
                      width: 36,
                      height: 44,
                      borderRadius: 4,
                      overflow: 'hidden',
                      flexShrink: 0,
                    }}
                  >
                    {/* biome-ignore lint/performance/noImgElement: thumbnail preview */}
                    <img
                      src={entry.preview}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    {entry.status === 'done' && (
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          background: 'rgba(0,0,0,0.35)',
                          display: 'grid',
                          placeItems: 'center',
                          color: 'white',
                          fontSize: 16,
                        }}
                      >
                        ✓
                      </div>
                    )}
                    {entry.status === 'uploading' && (
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          background: 'rgba(0,0,0,0.35)',
                          display: 'grid',
                          placeItems: 'center',
                          color: 'white',
                          fontSize: 12,
                        }}
                      >
                        ↑
                      </div>
                    )}
                    {entry.status === 'error' && (
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          background: 'rgba(0,0,0,0.5)',
                          display: 'grid',
                          placeItems: 'center',
                          color: 'white',
                          fontSize: 16,
                        }}
                      >
                        ✗
                      </div>
                    )}
                  </div>

                  {/* Label input */}
                  <div style={{ minWidth: 0 }}>
                    <input
                      className="input"
                      value={entry.label}
                      disabled={busy}
                      placeholder="e.g. Black jeans, White sneakers…"
                      onChange={(e) => updateEntry(i, { label: e.target.value })}
                      style={{ fontSize: 13, padding: '3px 8px', width: '100%' }}
                    />
                    {entry.error && (
                      <p style={{ fontSize: 11, color: 'var(--danger)', margin: '2px 0 0' }}>
                        {entry.error}
                      </p>
                    )}
                  </div>

                  {/* File size */}
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      whiteSpace: 'nowrap',
                      textAlign: 'right',
                    }}
                  >
                    {(entry.file.size / 1024).toFixed(0)} KB
                  </span>

                  {/* Remove button */}
                  <button
                    className="btn sm ghost"
                    disabled={busy}
                    onClick={() => removeEntry(i)}
                    title="Remove"
                    style={{ padding: '2px 4px' }}
                  >
                    <Icon.Close />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {allDone && (
          <div style={{ fontSize: 13, color: 'var(--success)', fontWeight: 600 }}>
            All {entries.length} items uploaded successfully.
          </div>
        )}
        {hasErrors && !running && (
          <div style={{ fontSize: 13, color: 'var(--danger)' }}>
            Some uploads failed. Fix errors above and click Upload again to retry failed items.
          </div>
        )}
      </div>
    </EditDrawer>
  );
}
