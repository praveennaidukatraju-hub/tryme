import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/data';
import { makeThumbnail } from '../lib/thumbnail';
import { EditDrawer } from './EditDrawer';
import { Switch } from './Switch';

export interface DemoItemEditData {
  id: string;
  label: string;
  sku: string | null;
  actualPrice: number;
  offerPrice: number;
  isActive: boolean;
  thumbnailUrl: string | null;
}

interface DemoItemModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  subcategoryId: string | null;
  initialData?: DemoItemEditData;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

/** Presigns, thumbnails where needed, and PUTs. Returns the resolved key. */
async function uploadDemoAsset(file: File, kind: 'image' | 'thumbnail'): Promise<string> {
  const body = kind === 'thumbnail' ? await makeThumbnail(file) : file;
  const contentType =
    file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg';
  const { uploadUrl, r2Key } = await apiFetch<{ uploadUrl: string; r2Key: string }>(
    '/admin/demo-catalog/presign',
    { method: 'POST', body: JSON.stringify({ kind, contentType, contentLength: body.size }) },
  );
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    body,
    headers: { 'Content-Type': contentType },
  });
  if (!res.ok) throw new Error('Image upload failed. Please try again.');
  return r2Key;
}

export function DemoItemModal({
  open,
  onClose,
  onSaved,
  subcategoryId,
  initialData,
  toast,
}: DemoItemModalProps) {
  const [label, setLabel] = useState('');
  const [sku, setSku] = useState('');
  const [actualPrice, setActualPrice] = useState('');
  const [offerPrice, setOfferPrice] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(initialData?.label ?? '');
    setSku(initialData?.sku ?? '');
    setActualPrice(initialData ? String(initialData.actualPrice) : '');
    setOfferPrice(initialData ? String(initialData.offerPrice) : '');
    setIsActive(initialData?.isActive ?? true);
    setFile(null);
    setPreview(null);
  }, [open, initialData]);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  if (!open) return null;

  const isEditing = !!initialData;
  const actualPriceNum = actualPrice ? Number(actualPrice) : 0;
  const offerPriceNum = offerPrice ? Number(offerPrice) : 0;
  const hasPriceError = offerPriceNum > actualPriceNum;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  };

  const handleSave = async () => {
    if (!label.trim() || hasPriceError || saving) return;
    if (!isEditing && !file) {
      toast({ kind: 'error', title: 'Choose an image for the demo product.' });
      return;
    }

    setSaving(true);
    try {
      if (isEditing && initialData) {
        await apiFetch(`/admin/demo-catalog/items/${initialData.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            label: label.trim(),
            sku: sku.trim() || undefined,
            actualPrice: actualPriceNum,
            offerPrice: offerPriceNum,
            isActive,
          }),
        });
      } else {
        if (!subcategoryId || !file) return;
        const [r2Key, thumbnailKey] = await Promise.all([
          uploadDemoAsset(file, 'image'),
          uploadDemoAsset(file, 'thumbnail'),
        ]);
        await apiFetch('/admin/demo-catalog/items', {
          method: 'POST',
          body: JSON.stringify({
            subcategoryId,
            label: label.trim(),
            sku: sku.trim() || undefined,
            actualPrice: actualPriceNum,
            offerPrice: offerPriceNum,
            r2Key,
            thumbnailKey,
          }),
        });
      }
      onSaved();
    } catch (err) {
      toast({
        kind: 'error',
        title: isEditing ? 'Could not update the demo product' : 'Could not add the demo product',
        body: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setSaving(false);
    }
  };

  const displayImageUrl = preview ?? initialData?.thumbnailUrl ?? null;

  return (
    <EditDrawer
      onClose={onClose}
      title={isEditing ? 'Edit demo product' : 'Add demo product'}
      width="min(480px, calc(100vw - 40px))"
      saving={saving}
      onSave={() => void handleSave()}
      saveLabel={saving ? 'Saving…' : 'Save'}
      saveDisabled={saving || !label.trim() || hasPriceError}
    >
      <div className="field">
        <label>Image</label>
        {isEditing ? (
          <div
            style={{
              height: 140,
              width: 110,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              overflow: 'hidden',
            }}
          >
            {displayImageUrl && (
              // biome-ignore lint/performance/noImgElement: presigned R2 preview
              <img
                src={displayImageUrl}
                alt={label}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            )}
          </div>
        ) : (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={saving}
              onChange={handleFileChange}
              style={{ fontSize: 13 }}
            />
            {preview && (
              // biome-ignore lint/performance/noImgElement: local file preview
              <img
                src={preview}
                alt="Preview"
                style={{
                  width: 110,
                  height: 140,
                  objectFit: 'cover',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  marginTop: 8,
                }}
              />
            )}
          </>
        )}
      </div>

      <div className="field">
        <label>Product name</label>
        <input
          className="input"
          required
          maxLength={200}
          value={label}
          disabled={saving}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Slim Fit Cotton Shirt"
        />
      </div>

      <div className="field">
        <label>SKU</label>
        <input
          className="input"
          maxLength={120}
          value={sku}
          disabled={saving}
          onChange={(e) => setSku(e.target.value)}
          placeholder="Optional"
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label>MRP (₹)</label>
          <input
            className="input"
            type="number"
            min={0}
            required
            value={actualPrice}
            disabled={saving}
            onChange={(e) => setActualPrice(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Offer price (₹)</label>
          <input
            className="input"
            type="number"
            min={0}
            required
            value={offerPrice}
            disabled={saving}
            onChange={(e) => setOfferPrice(e.target.value)}
            style={hasPriceError ? { borderColor: 'var(--danger)' } : undefined}
          />
        </div>
      </div>
      {hasPriceError && (
        <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>
          Offer price cannot be greater than MRP.
        </div>
      )}

      {isEditing && (
        <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Switch checked={isActive} onChange={setIsActive} disabled={saving} />
          <label style={{ marginBottom: 0 }}>Active</label>
        </div>
      )}
    </EditDrawer>
  );
}
