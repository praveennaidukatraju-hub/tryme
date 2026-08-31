import { useRef, useState } from 'react';
import { apiErrorMessage, apiFetch, UPLOAD_NETWORK_ERROR, uploadErrorMessage } from '../lib/data';
import type { CatalogCategory, CategoryTag, ModelBackground } from '../types';
import { EditDrawer } from './EditDrawer';
import { Icon } from './Icons';
import { PublicApiSlugField } from './PublicApiSlugField';
import { SearchableSelect } from './SearchableSelect';

const SPECIAL_TAG_OPTIONS: { value: CategoryTag; label: string }[] = [
  { value: 'featured', label: 'Featured' },
  { value: 'trending', label: 'Trending' },
  { value: 'popular', label: 'Popular' },
];

interface Props {
  background: ModelBackground;
  categories: CatalogCategory[];
  onSaved: (updated: ModelBackground) => void;
  onClose: () => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export function EditBackgroundModal({ background, categories, onSaved, onClose, toast }: Props) {
  const [form, setForm] = useState({
    label: background.label,
    sortOrder: background.sortOrder,
    genderSlug: background.genderSlug ?? '',
    categoryId: background.categoryId,
    tagsInput: (background.tags ?? []).join(', '),
    specialTag: background.specialTag ?? ('' as CategoryTag | ''),
    publicApiSlug: background.publicApiSlug ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [replaceFile, setReplaceFile] = useState<File | null>(null);
  const [replacePreview, setReplacePreview] = useState<string | null>(null);
  const [replaceUploading, setReplaceUploading] = useState(false);
  const replaceRef = useRef<HTMLInputElement>(null);

  const handleSave = async () => {
    setSaving(true);
    try {
      const tags = form.tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const body: Record<string, unknown> = {
        label: form.label,
        sortOrder: form.sortOrder,
        genderSlug: form.genderSlug || null,
        categoryId: form.categoryId,
        tags,
        specialTag: form.specialTag || null,
        publicApiSlug: form.publicApiSlug,
      };
      await apiFetch(`/admin/assets/backgrounds/${background.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      const updated: ModelBackground = {
        ...background,
        label: form.label,
        sortOrder: form.sortOrder,
        genderSlug: form.genderSlug || null,
        categoryId: form.categoryId,
        tags,
        specialTag: form.specialTag || null,
      };
      onSaved(updated);
      toast({ title: `${form.label} updated` });
      onClose();
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to update background',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReplaceImage = async () => {
    if (!replaceFile) return;
    setReplaceUploading(true);
    try {
      const presign = await apiFetch<{
        uploadUrl: string;
        r2Key: string;
      }>('/admin/assets/backgrounds/presign', {
        method: 'POST',
        body: JSON.stringify({ contentType: replaceFile.type }),
      });
      await new Promise<void>((res, rej) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', presign.uploadUrl);
        xhr.setRequestHeader('Content-Type', replaceFile.type);
        xhr.onload = () =>
          xhr.status < 300 ? res() : rej(new Error(uploadErrorMessage(xhr.status)));
        xhr.onerror = () => rej(new Error(UPLOAD_NETWORK_ERROR));
        xhr.send(replaceFile);
      });
      // Server regenerates the thumbnail from the new image on PATCH, deriving the
      // same key the server computes (r2Key with the extension swapped).
      await apiFetch(`/admin/assets/backgrounds/${background.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ r2Key: presign.r2Key }),
      });
      onSaved({
        ...background,
        label: form.label,
        sortOrder: form.sortOrder,
        genderSlug: form.genderSlug || null,
        categoryId: form.categoryId,
        r2Key: presign.r2Key,
        thumbnailKey: presign.r2Key.replace(/\.jpg$/, '.thumb.jpg'),
      });
      setReplaceFile(null);
      setReplacePreview(null);
      toast({ title: 'Image replaced' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Image replace failed',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setReplaceUploading(false);
    }
  };

  return (
    <EditDrawer
      onClose={onClose}
      title="Edit background"
      width="min(640px, calc(100vw - 40px))"
      thumbnail={{ thumbnailUrl: background.thumbnailUrl }}
      saving={saving || replaceUploading}
      onSave={handleSave}
      saveDisabled={!form.label.trim()}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 14,
        }}
      >
        <div className="field">
          <label>Label</label>
          <input
            className="input"
            value={form.label}
            disabled={saving}
            placeholder="e.g. Studio White"
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>Sort order</label>
          <input
            className="input"
            type="number"
            min={0}
            value={form.sortOrder}
            disabled={saving}
            onChange={(e) => setForm((f) => ({ ...f, sortOrder: Number(e.target.value) }))}
          />
        </div>
        <PublicApiSlugField
          value={form.publicApiSlug}
          disabled={saving}
          kind="backdrop"
          onChange={(v) => setForm((f) => ({ ...f, publicApiSlug: v }))}
        />
        <div className="field">
          <label>Gender</label>
          <select
            className="select"
            value={form.genderSlug}
            disabled={saving}
            onChange={(e) => setForm((f) => ({ ...f, genderSlug: e.target.value }))}
          >
            <option value="">All genders</option>
            <option value="men">Men</option>
            <option value="women">Women</option>
            <option value="boys">Boys</option>
            <option value="girls">Girls</option>
          </select>
        </div>
        <div className="field">
          <label>Category</label>
          <SearchableSelect
            options={categories.map((c) => ({ id: String(c.id), label: c.label }))}
            value={form.categoryId != null ? String(form.categoryId) : ''}
            disabled={saving}
            placeholder="— search category —"
            emptyLabel="Uncategorized"
            onChange={(id) => setForm((f) => ({ ...f, categoryId: id ? Number(id) : null }))}
          />
        </div>
        <div className="field">
          <label>
            Tags <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            className="input"
            value={form.tagsInput}
            disabled={saving}
            placeholder="e.g. warm tone, sunset, indoor"
            onChange={(e) => setForm((f) => ({ ...f, tagsInput: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>
            Special tag <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span>
          </label>
          <select
            className="select"
            value={form.specialTag}
            disabled={saving}
            onChange={(e) =>
              setForm((f) => ({ ...f, specialTag: e.target.value as CategoryTag | '' }))
            }
          >
            <option value="">No tag</option>
            {SPECIAL_TAG_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
        Tags are comma-separated and independent of category — lets you group backgrounds across
        categories (e.g. all "warm tone" backgrounds).
      </p>
      <div className="field">
        <label>Replace image</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {(replacePreview ?? background.thumbnailUrl) && (
            // biome-ignore lint/performance/noImgElement: thumbnail preview
            <img
              src={replacePreview ?? (background.thumbnailUrl as string)}
              alt=""
              style={{
                width: 56,
                height: 56,
                objectFit: 'cover',
                borderRadius: 6,
                border: '1px solid var(--border)',
              }}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              ref={replaceRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setReplaceFile(file);
                setReplacePreview(URL.createObjectURL(file));
              }}
            />
            <button
              type="button"
              className="btn sm ghost"
              disabled={saving || replaceUploading}
              onClick={() => replaceRef.current?.click()}
            >
              <Icon.Image /> {replaceFile ? replaceFile.name : 'Pick new image'}
            </button>
            {replaceFile && (
              <button
                type="button"
                className="btn sm primary"
                disabled={replaceUploading}
                onClick={handleReplaceImage}
              >
                {replaceUploading ? 'Uploading…' : 'Upload & replace'}
              </button>
            )}
          </div>
        </div>
      </div>
    </EditDrawer>
  );
}
