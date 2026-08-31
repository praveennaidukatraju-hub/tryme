import { useEffect, useRef, useState } from 'react';
import { apiFetch, UPLOAD_NETWORK_ERROR, uploadErrorMessage } from '../lib/data';
import { makeThumbnail } from '../lib/thumbnail';
import type { CatalogueTemplate, GenderSlug, ModelBackground, ModelPoseAsset } from '../types';
import { EditDrawer } from './EditDrawer';
import { Icon } from './Icons';

async function putFile(url: string, file: Blob): Promise<void> {
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

interface LookRow {
  key: string; // stable React key — random per row, independent of the eventual saved id
  poseAssetId: string;
  backgroundId: string;
  // Sent on Save (PUT .../looks) to retag this row's pose in place, and also on
  // (re-)upload of a fresh pose image. `null` = not tagged (a legacy pose that
  // predates this feature, or a row the admin hasn't touched yet) — distinct from
  // 'full', never silently coerced to it, so an untagged pose doesn't look
  // already-correct when it's actually unresolved.
  shotType: 'full' | 'half' | 'closeup' | null;
}

/** Click-to-upload tile — no picking from existing assets, every look uploads fresh. */
function UploadTile({
  label,
  thumbnailUrl,
  previewUrl,
  disabled,
  loading = false,
  w = 72,
  h = 90,
  onClick,
}: {
  label: string;
  thumbnailUrl?: string | null;
  /** Local blob preview, for deferred (not-yet-uploaded) selections — takes priority. */
  previewUrl?: string | null;
  disabled: boolean;
  loading?: boolean;
  w?: number;
  h?: number;
  onClick: () => void;
}) {
  const src = previewUrl ?? thumbnailUrl ?? null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: w,
        height: h,
        borderRadius: 'var(--r-lg)',
        border: `1.5px dashed ${src ? 'transparent' : 'var(--border-strong, var(--border))'}`,
        background: src ? 'transparent' : 'var(--surface-2)',
        padding: 0,
        overflow: 'hidden',
        position: 'relative',
        cursor: disabled ? 'not-allowed' : 'pointer',
        flexShrink: 0,
      }}
    >
      {loading ? (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--muted)',
            textAlign: 'center',
          }}
        >
          Uploading…
        </div>
      ) : src ? (
        // biome-ignore lint/performance/noImgElement: admin panel thumbnail
        <img
          src={src}
          alt={label}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            color: 'var(--muted)',
          }}
        >
          <Icon.Add />
          <span style={{ fontSize: 10, fontWeight: 600 }}>{label}</span>
        </div>
      )}
      {src && !loading && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: '2px 0',
            fontSize: 9,
            fontWeight: 600,
            textAlign: 'center',
            color: '#fff',
            background: 'rgba(0,0,0,0.55)',
          }}
        >
          Change
        </div>
      )}
    </button>
  );
}

interface Props {
  template: CatalogueTemplate | null; // null = creating a new template
  defaultGenderSlug: GenderSlug;
  poseAssets: ModelPoseAsset[];
  backgrounds: ModelBackground[];
  onSaved: () => void;
  onClose: () => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export function EditCatalogueTemplateModal({
  template,
  defaultGenderSlug,
  poseAssets,
  backgrounds,
  onSaved,
  onClose,
  toast,
}: Props) {
  const isEditing = template !== null;
  const [label, setLabel] = useState(template?.label ?? '');
  const [genderSlug, setGenderSlug] = useState<GenderSlug>(
    template?.genderSlug ?? defaultGenderSlug,
  );
  const [sortOrder, setSortOrder] = useState(template?.sortOrder ?? 0);
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [looks, setLooks] = useState<LookRow[]>([]);
  const [looksLoaded, setLooksLoaded] = useState(!isEditing);
  const [saving, setSaving] = useState(false);
  const thumbInputRef = useRef<HTMLInputElement>(null);

  // Local, appendable copies — new pose/background rows uploaded from within
  // the looks builder are added here immediately so their thumbnails render
  // in the look tiles without waiting for the parent tab to refetch.
  const [localPoseAssets, setLocalPoseAssets] = useState(poseAssets);
  const [localBackgrounds, setLocalBackgrounds] = useState(backgrounds);
  useEffect(() => setLocalPoseAssets(poseAssets), [poseAssets]);
  useEffect(() => setLocalBackgrounds(backgrounds), [backgrounds]);

  // Which look row's pose tile is currently uploading, if any (disables that tile).
  const [uploadingPoseForRow, setUploadingPoseForRow] = useState<string | null>(null);
  const poseFileInputRef = useRef<HTMLInputElement>(null);
  const poseUploadRowKeyRef = useRef<string | null>(null);

  // Which look row's background tile is currently uploading, if any (disables that tile).
  const [uploadingBackgroundForRow, setUploadingBackgroundForRow] = useState<string | null>(null);
  const backgroundFileInputRef = useRef<HTMLInputElement>(null);
  const backgroundUploadRowKeyRef = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Existing looks load once per template; pose assets are already seeded before this effect runs.
  useEffect(() => {
    if (!isEditing || !template) return;
    apiFetch<{ items: { id: string; poseAssetId: string; backgroundId: string }[] }>(
      `/admin/assets/catalogue-templates/${template.id}/looks`,
    )
      .then((res) => {
        setLooks(
          (res.items ?? []).map((l) => ({
            key: l.id,
            poseAssetId: l.poseAssetId,
            backgroundId: l.backgroundId,
            shotType: localPoseAssets.find((p) => p.id === l.poseAssetId)?.shotType ?? null,
          })),
        );
      })
      .catch(() => setLooks([]))
      .finally(() => setLooksLoaded(true));
    // localPoseAssets is intentionally excluded — this effect should only re-run when
    // isEditing/template change, reading whatever localPoseAssets holds at that point
    // (already seeded from the poseAssets prop before this effect can fire).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, template]);

  const poseAssetById = new Map(localPoseAssets.map((p) => [p.id, p]));
  const backgroundById = new Map(localBackgrounds.map((b) => [b.id, b]));

  function addLookRow() {
    setLooks((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        poseAssetId: '',
        backgroundId: '',
        shotType: 'full',
      },
    ]);
  }

  function updateLookRow(key: string, patch: Partial<LookRow>) {
    setLooks((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLookRow(key: string) {
    setLooks((prev) => prev.filter((l) => l.key !== key));
  }

  function openPoseUpload(rowKey: string) {
    poseUploadRowKeyRef.current = rowKey;
    poseFileInputRef.current?.click();
  }

  async function handlePoseFileSelected(file: File) {
    const rowKey = poseUploadRowKeyRef.current;
    if (!rowKey) return;
    // Snapshot now, before any await — this is what "shot type at the moment this
    // upload started" means, and it must not be recomputed after the network calls
    // below, since the admin can still edit this row's selector while they're in
    // flight (the selector is disabled only for the row currently uploading, which is
    // this one, but that guard is enforced by the render, not by this closure).
    const rowShotType = looks.find((l) => l.key === rowKey)?.shotType ?? null;
    setUploadingPoseForRow(rowKey);
    try {
      const presign = await apiFetch<{
        r2Key: string;
        uploadUrl: string;
        thumbnailKey: string;
        thumbnailUploadUrl: string;
      }>('/admin/assets/pose-assets/presign', {
        method: 'POST',
        body: JSON.stringify({ contentType: file.type }),
      });
      await Promise.all([
        putFile(presign.uploadUrl, file),
        makeThumbnail(file).then((t) => putFile(presign.thumbnailUploadUrl, t)),
      ]);
      const created = await apiFetch<ModelPoseAsset>('/admin/assets/pose-assets', {
        method: 'POST',
        body: JSON.stringify({
          label: file.name.replace(/\.[^.]+$/, ''),
          r2Key: presign.r2Key,
          thumbnailKey: presign.thumbnailKey,
          genderSlug,
          scope: 'template',
          // shotType is optional server-side — omit it entirely rather than sending
          // null, since the API's Zod schema validates it as an enum, not nullable.
          ...(rowShotType ? { shotType: rowShotType } : {}),
        }),
      });
      setLocalPoseAssets((prev) => [...prev, created]);
      updateLookRow(rowKey, { poseAssetId: created.id });
    } catch (err: unknown) {
      toast({
        kind: 'error',
        title: 'Pose upload failed',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploadingPoseForRow(null);
      poseUploadRowKeyRef.current = null;
    }
  }

  function openBackgroundUpload(rowKey: string) {
    backgroundUploadRowKeyRef.current = rowKey;
    backgroundFileInputRef.current?.click();
  }

  async function handleBackgroundFileSelected(file: File) {
    const rowKey = backgroundUploadRowKeyRef.current;
    if (!rowKey) return;
    setUploadingBackgroundForRow(rowKey);
    try {
      const presign = await apiFetch<{ r2Key: string; uploadUrl: string }>(
        '/admin/assets/backgrounds/presign',
        { method: 'POST', body: JSON.stringify({ contentType: file.type }) },
      );
      await putFile(presign.uploadUrl, file);
      const created = await apiFetch<ModelBackground>('/admin/assets/backgrounds/confirm', {
        method: 'POST',
        body: JSON.stringify({
          label: file.name.replace(/\.[^.]+$/, ''),
          r2Key: presign.r2Key,
          sortOrder: 0,
          genderSlug,
          scope: 'template',
        }),
      });
      setLocalBackgrounds((prev) => [...prev, created]);
      updateLookRow(rowKey, { backgroundId: created.id });
    } catch (err: unknown) {
      toast({
        kind: 'error',
        title: 'Background upload failed',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploadingBackgroundForRow(null);
      backgroundUploadRowKeyRef.current = null;
    }
  }

  const uploadInFlight = uploadingPoseForRow !== null || uploadingBackgroundForRow !== null;

  const handleSave = async () => {
    if (!label.trim()) return;
    if (uploadInFlight) {
      toast({
        kind: 'error',
        title: 'Still uploading',
        body: 'Wait for the pose/background upload to finish before saving.',
      });
      return;
    }
    const dedupe = new Set(looks.map((l) => `${l.poseAssetId}::${l.backgroundId}`));
    if (dedupe.size !== looks.length) {
      toast({
        kind: 'error',
        title: 'Duplicate look',
        body: 'Remove the duplicate pose+background pair.',
      });
      return;
    }
    setSaving(true);
    try {
      let thumbnailKey: string | undefined;
      if (thumbnailFile) {
        const presign = await apiFetch<{ uploadUrl: string; thumbnailKey: string }>(
          '/admin/assets/catalogue-templates/thumbnail/presign',
          { method: 'POST', body: JSON.stringify({ contentType: thumbnailFile.type }) },
        );
        await putFile(presign.uploadUrl, await makeThumbnail(thumbnailFile));
        thumbnailKey = presign.thumbnailKey;
      }

      let templateId: string;
      if (isEditing && template) {
        templateId = template.id;
        await apiFetch(`/admin/assets/catalogue-templates/${templateId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            label: label.trim(),
            sortOrder,
            ...(thumbnailKey ? { thumbnailKey } : {}),
          }),
        });
      } else {
        const created = await apiFetch<{ id: string }>('/admin/assets/catalogue-templates', {
          method: 'POST',
          body: JSON.stringify({
            genderSlug,
            label: label.trim(),
            sortOrder,
            ...(thumbnailKey ? { thumbnailKey } : {}),
          }),
        });
        templateId = created.id;
      }

      await apiFetch(`/admin/assets/catalogue-templates/${templateId}/looks`, {
        method: 'PUT',
        body: JSON.stringify({
          looks: looks
            .filter((l) => l.poseAssetId && l.backgroundId)
            .map((l) => ({
              poseAssetId: l.poseAssetId,
              backgroundId: l.backgroundId,
              ...(l.shotType ? { shotType: l.shotType } : {}),
            })),
        }),
      });

      toast({ title: `${label.trim()} saved` });
      onSaved();
      onClose();
    } catch (err: unknown) {
      toast({
        kind: 'error',
        title: 'Failed to save template',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const validLooks = looks.filter((l) => l.poseAssetId && l.backgroundId);
  const coverPreviewUrl = thumbnailFile ? URL.createObjectURL(thumbnailFile) : undefined;

  return (
    <>
      <EditDrawer
        onClose={onClose}
        title={isEditing ? 'Edit Catalogue Template' : 'New Catalogue Template'}
        width="min(720px, calc(100vw - 60px))"
        saving={saving}
        onSave={() => void handleSave()}
        saveDisabled={!label.trim() || uploadInFlight}
        saveLabel={uploadInFlight ? 'Uploading…' : 'Save template'}
        sections={[
          {
            title: 'Template Info',
            children: (
              <div style={{ display: 'flex', gap: 16 }}>
                <UploadTile
                  label="Cover"
                  previewUrl={coverPreviewUrl}
                  thumbnailUrl={!thumbnailFile ? template?.thumbnailUrl : undefined}
                  disabled={saving}
                  w={96}
                  h={120}
                  onClick={() => thumbInputRef.current?.click()}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
                  <div className="field">
                    <label>Label</label>
                    <input
                      className="input"
                      value={label}
                      disabled={saving}
                      placeholder="e.g. Autumn Collection"
                      onChange={(e) => setLabel(e.target.value)}
                    />
                  </div>
                  <div className="field-row">
                    <div className="field">
                      <label>
                        Gender
                        {isEditing && (
                          <span style={{ fontWeight: 400, color: 'var(--muted)' }}> (locked)</span>
                        )}
                      </label>
                      {isEditing ? (
                        <span className="badge dot accent" style={{ marginTop: 2 }}>
                          {genderSlug}
                        </span>
                      ) : (
                        <select
                          className="select"
                          value={genderSlug}
                          disabled={saving}
                          onChange={(e) => setGenderSlug(e.target.value as GenderSlug)}
                        >
                          <option value="men">Men</option>
                          <option value="women">Women</option>
                          <option value="boys">Boys</option>
                          <option value="girls">Girls</option>
                        </select>
                      )}
                    </div>
                    <div className="field">
                      <label>Sort order</label>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        step={1}
                        value={sortOrder}
                        disabled={saving}
                        onChange={(e) => setSortOrder(Number(e.target.value))}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ),
          },
          {
            title: 'Looks',
            flush: true,
            children: (
              <>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '14px 18px',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <span className="sub">{validLooks.length} ready</span>
                  <button
                    type="button"
                    className="btn sm ghost"
                    style={{ marginLeft: 'auto' }}
                    disabled={saving}
                    onClick={addLookRow}
                  >
                    <Icon.Add /> Add look
                  </button>
                </div>
                {!looksLoaded ? (
                  <div className="empty">Loading looks…</div>
                ) : looks.length === 0 ? (
                  <div className="empty">
                    No looks yet. Each look uploads a fresh pose + background photo.
                  </div>
                ) : (
                  looks.map((row, i) => (
                    <div
                      key={row.key}
                      style={{
                        display: 'flex',
                        gap: 12,
                        alignItems: 'center',
                        padding: '14px 18px',
                        borderTop: i > 0 ? '1px solid var(--border)' : undefined,
                      }}
                    >
                      <UploadTile
                        label="Pose"
                        thumbnailUrl={poseAssetById.get(row.poseAssetId)?.thumbnailUrl}
                        disabled={saving || uploadingPoseForRow === row.key}
                        loading={uploadingPoseForRow === row.key}
                        onClick={() => openPoseUpload(row.key)}
                      />
                      <UploadTile
                        label="Background"
                        thumbnailUrl={backgroundById.get(row.backgroundId)?.thumbnailUrl}
                        disabled={saving || uploadingBackgroundForRow === row.key}
                        loading={uploadingBackgroundForRow === row.key}
                        onClick={() => openBackgroundUpload(row.key)}
                      />
                      <div className="field" style={{ margin: 0, width: 120 }}>
                        <label style={{ fontSize: 10 }}>Shot type</label>
                        <select
                          className="select"
                          style={{ fontSize: 12, padding: '3px 6px', height: 30 }}
                          value={row.shotType ?? ''}
                          disabled={saving || uploadingPoseForRow === row.key}
                          title={
                            uploadingPoseForRow === row.key
                              ? 'Wait for the current upload to finish before changing this'
                              : 'Saved when you click "Save template" below'
                          }
                          onChange={(e) =>
                            updateLookRow(row.key, {
                              shotType: (e.target.value || null) as LookRow['shotType'],
                            })
                          }
                        >
                          <option value="">— not tagged —</option>
                          <option value="full">Full pose</option>
                          <option value="half">Half pose</option>
                          <option value="closeup">Closeup</option>
                        </select>
                      </div>
                      <button
                        type="button"
                        className="iconbtn"
                        disabled={saving}
                        onClick={() => removeLookRow(row.key)}
                        title="Remove look"
                      >
                        <Icon.Trash />
                      </button>
                    </div>
                  ))
                )}
              </>
            ),
          },
        ]}
      />

      <input
        ref={thumbInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) setThumbnailFile(file);
        }}
      />

      <input
        ref={poseFileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void handlePoseFileSelected(file);
        }}
      />

      <input
        ref={backgroundFileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void handleBackgroundFileSelected(file);
        }}
      />
    </>
  );
}
