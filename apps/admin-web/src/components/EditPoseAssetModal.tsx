import { useRef, useState } from 'react';
import { apiFetch, UPLOAD_NETWORK_ERROR, uploadErrorMessage } from '../lib/data';
import { makeThumbnail } from '../lib/thumbnail';
import type { GenderSlug, ModelPoseAsset, WorkflowOption } from '../types';
import { EditDrawer } from './EditDrawer';
import { Icon } from './Icons';
import { PublicApiSlugField } from './PublicApiSlugField';
import { SearchableSelect } from './SearchableSelect';

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

function ImagePicker({
  id,
  label,
  currentUrl,
  file,
  disabled,
  onChange,
  onClear,
}: {
  id: string;
  label: string;
  currentUrl?: string | null;
  file: File | null;
  disabled: boolean;
  onChange: (f: File | null) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrl = file ? URL.createObjectURL(file) : null;
  const displayUrl = file ? previewUrl : currentUrl;

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 12px',
          border: `1.5px dashed ${file ? 'var(--success-border)' : 'var(--border-strong, var(--border))'}`,
          borderRadius: 8,
          background: file ? 'var(--success-soft)' : 'var(--surface-2)',
          transition: 'border-color 120ms',
        }}
      >
        {displayUrl ? (
          // biome-ignore lint/performance/noImgElement: admin panel thumbnail
          <img
            src={displayUrl}
            alt=""
            style={{
              width: 48,
              height: 60,
              objectFit: 'cover',
              borderRadius: 5,
              flexShrink: 0,
              border: '1px solid var(--border)',
            }}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div
            style={{
              width: 48,
              height: 60,
              borderRadius: 5,
              background: 'var(--subtle)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--muted)',
              flexShrink: 0,
            }}
          >
            <Icon.Image />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {file ? (
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--ink-1)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {file.name}
            </div>
          ) : currentUrl ? (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Current image</div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>No image set</div>
          )}
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            {file
              ? `${(file.size / 1024).toFixed(0)} KB · will replace on save`
              : 'JPEG, PNG or WebP'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {file && (
            <button
              type="button"
              className="btn sm ghost"
              disabled={disabled}
              onClick={() => {
                onClear();
                if (inputRef.current) inputRef.current.value = '';
              }}
              style={{ fontSize: 11 }}
            >
              ✕ Clear
            </button>
          )}
          <label
            htmlFor={id}
            className="btn sm ghost"
            style={{
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontSize: 12,
              opacity: disabled ? 0.6 : 1,
            }}
          >
            {file ? 'Change' : 'Choose'}
          </label>
        </div>
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={disabled}
          style={{ display: 'none' }}
          onChange={(e) => onChange(e.target.files?.[0] ?? null)}
        />
      </div>
    </div>
  );
}

interface Props {
  asset: ModelPoseAsset;
  workflows: WorkflowOption[];
  onSaved: (updated: ModelPoseAsset) => void;
  onClose: () => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export function EditPoseAssetModal({ asset, workflows, onSaved, onClose, toast }: Props) {
  const [label] = useState(asset.label);
  const [displayName, setDisplayName] = useState(asset.displayName ?? '');
  const [genderSlug, setGenderSlug] = useState<GenderSlug>(
    (asset.genderSlug ?? 'men') as GenderSlug,
  );
  const [workflowTemplateId, setWorkflowTemplateId] = useState(asset.workflowTemplateId ?? '');
  const [prompt, setPrompt] = useState(
    asset.promptGarmentPhase ??
      workflows.find((w) => w.id === asset.workflowTemplateId)?.defaultGarmentPhasePrompt ??
      '',
  );
  const [sortOrder, setSortOrder] = useState(asset.sortOrder ?? 0);
  const [publicApiSlug, setPublicApiSlug] = useState(asset.publicApiSlug ?? '');
  const [poseFile, setPoseFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {
        displayName: displayName.trim() || null,
        genderSlug,
        workflowTemplateId: workflowTemplateId || null,
        promptGarmentPhase: prompt.trim() || null,
        sortOrder,
        publicApiSlug,
      };

      if (poseFile) {
        const presign = await apiFetch<{
          r2Key: string;
          uploadUrl: string;
          thumbnailKey: string;
          thumbnailUploadUrl: string;
        }>(`/admin/assets/pose-assets/${asset.id}/presign-pose`, {
          method: 'POST',
          body: JSON.stringify({ contentType: poseFile.type }),
        });
        await Promise.all([
          putFile(presign.uploadUrl, poseFile),
          makeThumbnail(poseFile).then((t) => putFile(presign.thumbnailUploadUrl, t)),
        ]);
        patch.r2Key = presign.r2Key;
        patch.thumbnailKey = presign.thumbnailKey;
      }

      const updated = await apiFetch<ModelPoseAsset>(`/admin/assets/pose-assets/${asset.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });

      onSaved(updated);
      toast({ title: `${label.trim()} updated` });
      onClose();
    } catch (err: unknown) {
      toast({
        kind: 'error',
        title: 'Failed to update pose asset',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditDrawer
      onClose={onClose}
      title="Edit pose asset"
      width="min(480px, calc(100vw - 40px))"
      thumbnail={{ thumbnailUrl: asset.thumbnailUrl, fullUrl: asset.r2Url }}
      saving={saving}
      onSave={handleSave}
      saveDisabled={!label.trim()}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="field">
          <label>
            Label{' '}
            <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>
              (dedup key — do not rename)
            </span>
          </label>
          <input
            className="input"
            value={label}
            disabled
            readOnly
            style={{ opacity: 0.6, cursor: 'not-allowed' }}
          />
        </div>

        <div className="field">
          <label>
            Display name{' '}
            <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            className="input"
            value={displayName}
            disabled={saving}
            placeholder="e.g. Standing front view"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div className="field">
          <label>
            Sort order{' '}
            <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>
              (lower = first)
            </span>
          </label>
          <input
            className="input"
            type="number"
            min={0}
            step={1}
            value={sortOrder}
            disabled={saving}
            onChange={(e) => setSortOrder(Number(e.target.value))}
            style={{ width: 120 }}
          />
        </div>

        <PublicApiSlugField
          value={publicApiSlug}
          disabled={saving}
          kind="pose"
          onChange={setPublicApiSlug}
        />

        <div className="field">
          <label>Category</label>
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
        </div>

        <div className="field">
          <label>Workflow template</label>
          <SearchableSelect
            options={workflows.map((wf) => ({
              id: wf.id,
              label: `${wf.label}${wf.lowerNodeId ? ' · lower' : ''}${wf.shoeNodeId ? ' · shoes' : ''}${!wf.isActive ? ' (inactive)' : ''}`,
            }))}
            value={workflowTemplateId}
            disabled={saving}
            emptyLabel="— none —"
            placeholder="— search workflow —"
            onChange={(newId) => {
              setWorkflowTemplateId(newId);
              // Always follow the newly selected workflow's default prompt — admin can
              // still hand-edit the textarea below before saving if they want an override.
              setPrompt(workflows.find((w) => w.id === newId)?.defaultGarmentPhasePrompt ?? '');
            }}
          />
        </div>

        <ImagePicker
          id="epa-pose-img"
          label="Pose image"
          currentUrl={asset.thumbnailUrl}
          file={poseFile}
          disabled={saving}
          onChange={setPoseFile}
          onClear={() => setPoseFile(null)}
        />

        <div className="field">
          <label>Positive prompt</label>
          <textarea
            className="input"
            value={prompt}
            disabled={saving}
            rows={4}
            onChange={(e) => setPrompt(e.target.value)}
            style={{ fontSize: 12, fontFamily: 'monospace', resize: 'vertical' }}
          />
        </div>
      </div>
    </EditDrawer>
  );
}
