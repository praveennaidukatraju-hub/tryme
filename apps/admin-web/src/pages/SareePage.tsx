import { useCallback, useEffect, useRef, useState } from 'react';
import { EditDrawer } from '../components/EditDrawer';
import { Icon } from '../components/Icons';
import { SearchableSelect } from '../components/SearchableSelect';
import { useAuth } from '../context/AuthContext';
import { apiFetch, UPLOAD_NETWORK_ERROR, uploadErrorMessage } from '../lib/data';
import { makeThumbnail } from '../lib/thumbnail';
import type { WorkflowOption } from '../types';

// Local types — these mirror the @tryme/types saree schemas but are inlined
// here to avoid a runtime dependency on the types package from the admin SPA.
interface AdminSareeWorkflow {
  id: string;
  slug: string;
  label: string;
  isActive: boolean;
  jsonContent: Record<string, unknown>;
  detected: {
    modelImageNode: string | null;
    sareeImageNode: string | null;
    outputNode: string | null;
    positivePromptNode: string | null;
    negativePromptNode: string | null;
    defaultPositivePrompt: string;
    defaultNegativePrompt: string;
  };
}

interface AdminSareeSettings {
  modelImageKey: string | null;
  modelImageThumbKey: string | null;
  modelImageUrl: string | null;
  modelImageThumbUrl: string | null;
  sampleSareeImageKey: string | null;
  sampleSareeImageThumbKey: string | null;
  sampleSareeImageUrl: string | null;
  sampleSareeImageThumbUrl: string | null;
  workflowTemplateId: string | null;
  isConfigured: boolean;
}

interface AdminSareeWorker {
  id: string;
  label: string;
  url: string;
  isActive: boolean;
  allowedJobTypes: string[];
  status: string | null;
}

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

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
  onNav: (_page: string, _filter?: { page: string; filter?: string }) => void;
}

function toKebabSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default function SareePage({ toast, onNav }: Props) {
  const { token: _token } = useAuth();
  const [workflow, setWorkflow] = useState<AdminSareeWorkflow | null>(null);
  const [loadingWorkflow, setLoadingWorkflow] = useState(true);
  const [settings, setSettings] = useState<AdminSareeSettings | null>(null);
  const [workers, setWorkers] = useState<AdminSareeWorker[]>([]);

  const [wfModal, setWfModal] = useState(false);
  const [wfLabel, setWfLabel] = useState('');
  const [wfSlug, setWfSlug] = useState('');
  const [wfFile, setWfFile] = useState<File | null>(null);
  const [wfSaving, setWfSaving] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploadingModel, setUploadingModel] = useState(false);
  const modelInputRef = useRef<HTMLInputElement>(null);

  const [uploadingSample, setUploadingSample] = useState(false);
  const sampleInputRef = useRef<HTMLInputElement>(null);

  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [savingWorkflowId, setSavingWorkflowId] = useState(false);

  const loadData = useCallback(async () => {
    setLoadingWorkflow(true);
    try {
      const [wf, st, ws] = await Promise.allSettled([
        apiFetch<AdminSareeWorkflow>('/admin/saree-workflows/active'),
        apiFetch<AdminSareeSettings>('/admin/saree-settings'),
        apiFetch<AdminSareeWorker[]>('/admin/saree-workers'),
      ]);
      if (wf.status === 'fulfilled') setWorkflow(wf.value);
      else setWorkflow(null);
      if (st.status === 'fulfilled') setSettings(st.value);
      else setSettings(null);
      if (ws.status === 'fulfilled') setWorkers(ws.value);
      else setWorkers([]);
      void apiFetch<WorkflowOption[]>('/admin/workflows')
        .then((wfs) => setWorkflows(wfs.filter((w) => w.workflowType === 'tryon')))
        .catch(() => {});
    } finally {
      setLoadingWorkflow(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const openWfModal = () => {
    setWfLabel('');
    setWfSlug('');
    setWfFile(null);
    setSlugEdited(false);
    setWfModal(true);
  };

  const handleWfLabelChange = (value: string) => {
    setWfLabel(value);
    if (!slugEdited) setWfSlug(toKebabSlug(value));
  };

  const handleUploadWorkflow = async () => {
    if (!wfFile || !wfLabel.trim() || !wfSlug.trim()) return;
    setWfSaving(true);
    try {
      const text = await wfFile.text();
      const jsonContent = JSON.parse(text) as Record<string, unknown>;
      const created = await apiFetch<AdminSareeWorkflow>('/admin/saree-workflows', {
        method: 'POST',
        body: JSON.stringify({ label: wfLabel.trim(), slug: wfSlug.trim(), jsonContent }),
      });
      setWorkflow(created);
      toast({ title: 'Saree workflow uploaded' });
      setWfModal(false);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to upload workflow',
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setWfSaving(false);
    }
  };

  const handleDeactivateWorkflow = async () => {
    if (!workflow) return;
    try {
      await apiFetch(`/admin/saree-workflows/${workflow.id}`, { method: 'DELETE' });
      setWorkflow(null);
      toast({ title: 'Saree workflow deactivated' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to deactivate workflow',
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleModelUpload = async (file: File) => {
    setUploadingModel(true);
    try {
      const presign = await apiFetch<{
        r2Key: string;
        uploadUrl: string;
        thumbnailKey: string;
        thumbnailUploadUrl: string;
      }>('/admin/saree-settings/presign', {
        method: 'POST',
        body: JSON.stringify({ contentType: file.type }),
      });
      const thumb = await makeThumbnail(file, 800);
      await Promise.all([
        putFile(presign.uploadUrl, file),
        putFile(presign.thumbnailUploadUrl, thumb),
      ]);
      await apiFetch('/admin/saree-settings', {
        method: 'PATCH',
        body: JSON.stringify({
          modelImageKey: presign.r2Key,
          modelImageThumbKey: presign.thumbnailKey,
        }),
      });
      const updated = await apiFetch<AdminSareeSettings>('/admin/saree-settings');
      setSettings(updated);
      toast({ title: 'Model image updated' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to upload model image',
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setUploadingModel(false);
    }
  };

  const handleRemoveModel = async () => {
    try {
      await apiFetch('/admin/saree-settings', {
        method: 'PATCH',
        body: JSON.stringify({ modelImageKey: null, modelImageThumbKey: null }),
      });
      const updated = await apiFetch<AdminSareeSettings>('/admin/saree-settings');
      setSettings(updated);
      toast({ title: 'Model image removed' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to remove model image',
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleSampleUpload = async (file: File) => {
    setUploadingSample(true);
    try {
      const presign = await apiFetch<{
        r2Key: string;
        uploadUrl: string;
        thumbnailKey: string;
        thumbnailUploadUrl: string;
      }>('/admin/saree-settings/presign', {
        method: 'POST',
        body: JSON.stringify({ contentType: file.type, purpose: 'sample' }),
      });
      const thumb = await makeThumbnail(file, 800);
      await Promise.all([
        putFile(presign.uploadUrl, file),
        putFile(presign.thumbnailUploadUrl, thumb),
      ]);
      await apiFetch('/admin/saree-settings', {
        method: 'PATCH',
        body: JSON.stringify({
          sampleSareeImageKey: presign.r2Key,
          sampleSareeImageThumbKey: presign.thumbnailKey,
        }),
      });
      const updated = await apiFetch<AdminSareeSettings>('/admin/saree-settings');
      setSettings(updated);
      toast({ title: 'Sample saree image updated' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to upload sample saree image',
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setUploadingSample(false);
    }
  };

  const handleRemoveSample = async () => {
    try {
      await apiFetch('/admin/saree-settings', {
        method: 'PATCH',
        body: JSON.stringify({ sampleSareeImageKey: null, sampleSareeImageThumbKey: null }),
      });
      const updated = await apiFetch<AdminSareeSettings>('/admin/saree-settings');
      setSettings(updated);
      toast({ title: 'Sample saree image removed' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to remove sample saree image',
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleWorkflowChange = async (workflowTemplateId: string) => {
    setSavingWorkflowId(true);
    try {
      await apiFetch('/admin/saree-settings', {
        method: 'PATCH',
        body: JSON.stringify({ workflowTemplateId: workflowTemplateId || null }),
      });
      setSettings((prev) =>
        prev ? { ...prev, workflowTemplateId: workflowTemplateId || null } : null,
      );
      toast({ title: workflowTemplateId ? 'Tryon workflow saved' : 'Tryon workflow cleared' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to save workflow',
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSavingWorkflowId(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>Saree Try-On</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Temporary feature — upload the ComfyUI workflow and the static model image.
          </p>
        </div>
      </div>

      <div
        className="card"
        style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>1. ComfyUI Workflow</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {workflow && (
              <button className="btn ghost" onClick={handleDeactivateWorkflow}>
                Deactivate
              </button>
            )}
            <button className="btn primary" onClick={openWfModal}>
              <Icon.Plus /> {workflow ? 'Replace workflow' : 'Upload workflow'}
            </button>
          </div>
        </div>

        {loadingWorkflow ? (
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>Loading…</div>
        ) : workflow ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 12,
              color: 'var(--muted)',
            }}
          >
            <div>
              <strong style={{ color: 'var(--text)' }}>{workflow.label}</strong>{' '}
              <code style={{ background: 'var(--bg-2)', padding: '1px 5px', borderRadius: 3 }}>
                {workflow.slug}
              </code>{' '}
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '2px 7px',
                  borderRadius: 10,
                  background: 'rgba(76,175,80,0.12)',
                  color: '#4caf50',
                }}
              >
                Active
              </span>
            </div>
            <div>
              Model: <code>{workflow.detected.modelImageNode ?? '—'}</code> · Saree:{' '}
              <code>{workflow.detected.sareeImageNode ?? '—'}</code> · Output:{' '}
              <code>{workflow.detected.outputNode ?? '—'}</code> · Prompts:{' '}
              <code>{workflow.detected.positivePromptNode ?? '—'}</code> /{' '}
              <code>{workflow.detected.negativePromptNode ?? '—'}</code>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>No active workflow.</div>
        )}
      </div>

      <div
        className="card"
        style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>2. Tryon Workflow Mapping</span>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--muted)' }}>
          Select which tryon workflow to use for saree catalogue generation. This maps the saree
          garment type to a specific tryon workflow template, just like garment types in Assets.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ maxWidth: 400, width: '100%' }}>
            <SearchableSelect
              options={workflows.map((w) => ({
                id: w.id,
                label: `${w.label}${!w.isActive ? ' (inactive)' : ''}`,
              }))}
              value={settings?.workflowTemplateId ?? ''}
              disabled={savingWorkflowId}
              emptyLabel="— none —"
              placeholder="— search workflow —"
              onChange={(id) => void handleWorkflowChange(id)}
            />
          </div>
          {savingWorkflowId && <span style={{ fontSize: 11, color: 'var(--muted)' }}>Saving…</span>}
        </div>
      </div>

      <div
        className="card"
        style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>3. Model Image</span>
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div
            style={{
              width: 100,
              height: 100,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--bg-2)',
              flexShrink: 0,
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {(settings?.modelImageThumbUrl ?? settings?.modelImageUrl) ? (
              // biome-ignore lint/performance/noImgElement: admin thumbnail
              <img
                src={settings.modelImageThumbUrl ?? settings.modelImageUrl ?? ''}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <Icon.Image />
            )}
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Static model person</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {settings?.isConfigured
                ? 'Image uploaded — used as the model for every saree job.'
                : 'No image yet — saree try-on is disabled for users until you upload one.'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  border: '1.5px dashed var(--border)',
                  borderRadius: 7,
                  cursor: uploadingModel ? 'not-allowed' : 'pointer',
                  opacity: uploadingModel ? 0.6 : 1,
                  background: 'var(--surface-2)',
                  fontSize: 12,
                  color: 'var(--muted)',
                  userSelect: 'none',
                }}
              >
                <Icon.Image />
                {uploadingModel
                  ? 'Uploading…'
                  : settings?.isConfigured
                    ? 'Replace image'
                    : 'Upload image'}
                <input
                  ref={modelInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={uploadingModel}
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleModelUpload(file);
                    if (modelInputRef.current) modelInputRef.current.value = '';
                  }}
                />
              </label>
              {settings?.isConfigured && (
                <button
                  className="btn sm ghost"
                  style={{ color: 'var(--danger)' }}
                  onClick={handleRemoveModel}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div
        className="card"
        style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>4. Sample Saree Image</span>
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div
            style={{
              width: 100,
              height: 100,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--bg-2)',
              flexShrink: 0,
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {(settings?.sampleSareeImageThumbUrl ?? settings?.sampleSareeImageUrl) ? (
              // biome-ignore lint/performance/noImgElement: admin thumbnail
              <img
                src={settings.sampleSareeImageThumbUrl ?? settings.sampleSareeImageUrl ?? ''}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <Icon.Image />
            )}
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Example flat-saree photo</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {settings?.sampleSareeImageKey
                ? 'Shown to users on hover over the saree upload zone — guides them on the expected input.'
                : 'Optional. Upload a sample so users can see what a good input looks like before they upload.'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  border: '1.5px dashed var(--border)',
                  borderRadius: 7,
                  cursor: uploadingSample ? 'not-allowed' : 'pointer',
                  opacity: uploadingSample ? 0.6 : 1,
                  background: 'var(--surface-2)',
                  fontSize: 12,
                  color: 'var(--muted)',
                  userSelect: 'none',
                }}
              >
                <Icon.Image />
                {uploadingSample
                  ? 'Uploading…'
                  : settings?.sampleSareeImageKey
                    ? 'Replace image'
                    : 'Upload image'}
                <input
                  ref={sampleInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={uploadingSample}
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleSampleUpload(file);
                    if (sampleInputRef.current) sampleInputRef.current.value = '';
                  }}
                />
              </label>
              {settings?.sampleSareeImageKey && (
                <button
                  className="btn sm ghost"
                  style={{ color: 'var(--danger)' }}
                  onClick={handleRemoveSample}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div
        className="card"
        style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>5. Worker Selection</span>
          <button className="btn ghost sm" onClick={() => onNav('workers')}>
            Edit workers →
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--muted)' }}>
          Workers self-declare which job types they accept. Saree jobs route to workers with{' '}
          <code>saree</code> in their <code>allowedJobTypes</code>. To enable a worker for saree,
          add <code>saree</code> on the Workers page.
        </p>
        {workers.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>No workers registered.</div>
        ) : (
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                  <th style={{ padding: '6px 8px' }}>Label</th>
                  <th style={{ padding: '6px 8px' }}>URL</th>
                  <th style={{ padding: '6px 8px' }}>Active</th>
                  <th style={{ padding: '6px 8px' }}>Job types</th>
                  <th style={{ padding: '6px 8px' }}>Saree-capable</th>
                </tr>
              </thead>
              <tbody>
                {workers.map((w) => {
                  const capable = w.allowedJobTypes.includes('saree');
                  return (
                    <tr key={w.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 8px' }}>{w.label || w.id}</td>
                      <td style={{ padding: '6px 8px' }}>
                        <code style={{ fontSize: 10 }}>{w.url}</code>
                      </td>
                      <td style={{ padding: '6px 8px' }}>{w.isActive ? 'Yes' : 'No'}</td>
                      <td style={{ padding: '6px 8px' }}>
                        {(w.allowedJobTypes ?? []).join(', ') || '(any)'}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        {capable ? (
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              padding: '2px 7px',
                              borderRadius: 10,
                              background: 'rgba(76,175,80,0.12)',
                              color: '#4caf50',
                            }}
                          >
                            Yes
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, color: 'var(--muted)' }}>No</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {wfModal && (
        <EditDrawer
          onClose={() => setWfModal(false)}
          title="Upload saree workflow JSON"
          width="min(520px, calc(100vw - 40px))"
          saving={wfSaving}
          onSave={() => void handleUploadWorkflow()}
          saveLabel="Upload"
          saveDisabled={!wfFile || !wfLabel.trim() || !wfSlug.trim()}
        >
          <div className="field">
            <label>Label</label>
            <input
              className="input"
              value={wfLabel}
              disabled={wfSaving}
              placeholder="e.g. Saree default"
              onChange={(e) => handleWfLabelChange(e.target.value)}
            />
          </div>
          <div className="field">
            <label>
              Slug{' '}
              <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>
                (auto-derived, editable)
              </span>
            </label>
            <input
              className="input"
              value={wfSlug}
              disabled={wfSaving}
              placeholder="kebab-case"
              onChange={(e) => {
                setSlugEdited(true);
                setWfSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
              }}
            />
          </div>
          <div className="field">
            <label>ComfyUI JSON file</label>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                border: '1.5px dashed var(--border)',
                borderRadius: 7,
                cursor: wfSaving ? 'not-allowed' : 'pointer',
                background: 'var(--surface-2)',
                fontSize: 12,
                color: 'var(--muted)',
                userSelect: 'none',
                width: 'fit-content',
              }}
            >
              <Icon.Workflow />
              {wfFile ? wfFile.name : 'Choose .json file'}
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                disabled={wfSaving}
                style={{ display: 'none' }}
                onChange={(e) => setWfFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>
        </EditDrawer>
      )}
    </div>
  );
}
