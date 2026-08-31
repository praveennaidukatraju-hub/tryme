import { useCallback, useEffect, useRef, useState } from 'react';
import { AssetThumb } from '../../components/AssetThumb';
import { EditDrawer } from '../../components/EditDrawer';
import { Icon } from '../../components/Icons';
import { SearchableSelect } from '../../components/SearchableSelect';
import { Switch } from '../../components/Switch';
import {
  apiErrorMessage,
  apiFetch,
  UPLOAD_NETWORK_ERROR,
  uploadErrorMessage,
} from '../../lib/data';
import type { SareeMannequinStyle, WorkflowOption } from '../../types';
import { useAssetsContext } from './AssetsContext';

interface PresignResult {
  r2Key: string;
  uploadUrl: string;
}

function putFile(url: string, file: File): Promise<void> {
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

function StyleModal({
  existing,
  singleInputWorkflows,
  twoInputWorkflows,
  onSaved,
  onClose,
  toast,
}: {
  existing: SareeMannequinStyle | null;
  singleInputWorkflows: WorkflowOption[];
  twoInputWorkflows: WorkflowOption[];
  onSaved: (style: SareeMannequinStyle) => void;
  onClose: () => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState(existing?.label ?? '');
  const [workflowTemplateId, setWorkflowTemplateId] = useState(
    existing?.mannequinWorkflowTemplateId ?? singleInputWorkflows[0]?.id ?? '',
  );
  const [twoInputWorkflowTemplateId, setTwoInputWorkflowTemplateId] = useState(
    existing?.mannequinTwoInputWorkflowTemplateId ?? '',
  );
  const [sortOrder, setSortOrder] = useState(existing?.sortOrder ?? 0);
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const save = async () => {
    if (!label.trim() || !workflowTemplateId) return;
    setSaving(true);
    try {
      let previewImageKey = existing?.previewImageKey ?? undefined;
      if (file) {
        const presign = await apiFetch<PresignResult>('/admin/assets/saree-styles/presign', {
          method: 'POST',
          body: JSON.stringify({ contentType: file.type }),
        });
        await putFile(presign.uploadUrl, file);
        previewImageKey = presign.r2Key;
      }
      const body = {
        label: label.trim(),
        previewImageKey,
        mannequinWorkflowTemplateId: workflowTemplateId,
        mannequinTwoInputWorkflowTemplateId: twoInputWorkflowTemplateId || undefined,
        sortOrder,
        isActive,
      };
      const saved = existing
        ? await apiFetch<SareeMannequinStyle>(`/admin/assets/saree-styles/${existing.id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        : await apiFetch<SareeMannequinStyle>('/admin/assets/saree-styles', {
            method: 'POST',
            body: JSON.stringify(body),
          });
      toast({ title: existing ? 'Style updated' : 'Style created' });
      onSaved(saved);
      onClose();
    } catch (e) {
      toast({
        kind: 'error',
        title: existing ? 'Failed to update style' : 'Failed to create style',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditDrawer
      onClose={onClose}
      title={existing ? 'Edit style' : 'New saree style'}
      width="min(460px, calc(100vw - 40px))"
      saving={saving}
      onSave={() => void save()}
      saveDisabled={!label.trim() || !workflowTemplateId}
      saveLabel={existing ? 'Save' : 'Create'}
    >
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
        Label
        <input
          className="input"
          value={label}
          disabled={saving}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Style 1"
        />
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {previewUrl ? (
          // biome-ignore lint/performance/noImgElement: admin panel
          <img
            src={previewUrl}
            alt=""
            style={{ width: 72, height: 92, objectFit: 'cover', borderRadius: 8 }}
          />
        ) : (
          <AssetThumb
            thumbnailUrl={existing?.previewImageUrl}
            fullUrl={existing?.previewImageUrl}
            label={label || 'Style'}
            w={72}
            h={92}
          />
        )}
        <button
          type="button"
          className="btn sm"
          disabled={saving}
          onClick={() => fileInputRef.current?.click()}
        >
          <Icon.Upload /> {existing?.previewImageKey || file ? 'Replace image' : 'Upload image'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: 'none' }}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
        Mannequin workflow
        <SearchableSelect
          options={singleInputWorkflows.map((workflow) => ({
            id: workflow.id,
            label: workflow.label,
          }))}
          value={workflowTemplateId}
          disabled={saving}
          onChange={setWorkflowTemplateId}
          placeholder="— search workflow —"
        />
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
        Two-Input Mannequin (Body + Pallu) Workflow
        <SearchableSelect
          options={twoInputWorkflows.map((workflow) => ({
            id: workflow.id,
            label: workflow.label,
          }))}
          value={twoInputWorkflowTemplateId}
          disabled={saving}
          emptyLabel="— none —"
          onChange={setTwoInputWorkflowTemplateId}
          placeholder="— search workflow —"
        />
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          Optional. When set, this style can also be used for the "Body & Pallu" two-image upload
          mode.
        </span>
      </label>

      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          Sort order
          <input
            type="number"
            className="input"
            style={{ width: 90 }}
            value={sortOrder}
            disabled={saving}
            onChange={(e) => setSortOrder(Number(e.target.value))}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          Active
          <Switch checked={isActive} onChange={setIsActive} />
        </label>
      </div>
    </EditDrawer>
  );
}

export function SareeStylesTab() {
  const { toast } = useAssetsContext();
  const [styles, setStyles] = useState<SareeMannequinStyle[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<SareeMannequinStyle | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [stylesRes, workflowResponse] = await Promise.all([
        apiFetch<{ items: SareeMannequinStyle[] }>('/admin/assets/saree-styles'),
        apiFetch<WorkflowOption[]>('/admin/workflows'),
      ]);
      setStyles(stylesRes.items);
      setWorkflows(
        workflowResponse.filter(
          (workflow) =>
            (workflow.workflowType === 'saree_step1' ||
              workflow.workflowType === 'saree_step1_two_input') &&
            workflow.isActive,
        ),
      );
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to load saree styles',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleActive = async (style: SareeMannequinStyle) => {
    const next = !style.isActive;
    setStyles((previous) =>
      previous.map((candidate) =>
        candidate.id === style.id ? { ...candidate, isActive: next } : candidate,
      ),
    );
    try {
      await apiFetch(`/admin/assets/saree-styles/${style.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: next }),
      });
    } catch (e) {
      setStyles((previous) =>
        previous.map((candidate) => (candidate.id === style.id ? style : candidate)),
      );
      toast({
        kind: 'error',
        title: 'Failed to update style',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Saree Mannequin Styles</h1>
          <p className="lede">
            Draping styles the merchant catalogue app lets merchants pick before generating — each
            one runs a different mannequin (step-1) workflow.
          </p>
        </div>
        <div className="head-tools">
          <button
            className="btn"
            onClick={() => {
              setEditing(null);
              setShowModal(true);
            }}
          >
            <Icon.Add /> New style
          </button>
        </div>
      </div>

      {loading ? (
        <p style={{ color: 'var(--muted)', marginTop: 24 }}>Loading…</p>
      ) : styles.length === 0 ? (
        <p style={{ color: 'var(--muted)', marginTop: 24 }}>No saree styles yet.</p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 12,
            marginTop: 12,
          }}
        >
          {styles.map((style) => (
            <div
              key={style.id}
              className="card"
              style={{ padding: 12, opacity: style.isActive ? 1 : 0.55 }}
            >
              <AssetThumb
                thumbnailUrl={style.previewImageUrl}
                fullUrl={style.previewImageUrl}
                label={style.label}
                w={160}
                h={200}
              />
              <p style={{ fontSize: 12, fontWeight: 600, marginTop: 8 }}>{style.label}</p>
              <p style={{ fontSize: 10, color: 'var(--muted)' }}>
                {workflows.find((workflow) => workflow.id === style.mannequinWorkflowTemplateId)
                  ?.label ?? '—'}
              </p>
              <p style={{ fontSize: 10, color: 'var(--muted)' }}>
                Two-input:{' '}
                {style.mannequinTwoInputWorkflowTemplateId
                  ? (workflows.find(
                      (workflow) => workflow.id === style.mannequinTwoInputWorkflowTemplateId,
                    )?.label ?? '—')
                  : '—'}
              </p>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 8,
                }}
              >
                <Switch checked={style.isActive} onChange={() => void toggleActive(style)} />
                <button
                  className="btn ghost"
                  style={{ fontSize: 10, padding: '3px 8px' }}
                  onClick={() => {
                    setEditing(style);
                    setShowModal(true);
                  }}
                >
                  <Icon.Edit /> Edit
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <StyleModal
          existing={editing}
          singleInputWorkflows={workflows.filter((w) => w.workflowType === 'saree_step1')}
          twoInputWorkflows={workflows.filter((w) => w.workflowType === 'saree_step1_two_input')}
          onSaved={(saved) => {
            setStyles((previous) => {
              const exists = previous.some((style) => style.id === saved.id);
              return exists
                ? previous.map((style) => (style.id === saved.id ? saved : style))
                : [...previous, saved];
            });
          }}
          onClose={() => setShowModal(false)}
          toast={toast}
        />
      )}
    </>
  );
}
