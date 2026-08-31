import { useCallback, useEffect, useRef, useState } from 'react';
import { EditDrawer } from '../components/EditDrawer';
import { Icon } from '../components/Icons';
import { SearchableSelect } from '../components/SearchableSelect';
import { apiErrorMessage, apiFetch, UPLOAD_NETWORK_ERROR, uploadErrorMessage } from '../lib/data';
import { makeThumbnail } from '../lib/thumbnail';
import type { TryonCategory, WorkflowOption } from '../types';

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

function toSnakeSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

interface TryonSettings {
  personSampleUrl: string | null;
  garmentSampleUrl: string | null;
}

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
  onNav: (_page: string, _filter?: { page: string; filter?: string }) => void;
}

export default function TryonPage({ toast }: Props) {
  const [categories, setCategories] = useState<TryonCategory[]>([]);
  const [tryonWorkflows, setTryonWorkflows] = useState<WorkflowOption[]>([]);
  const [loading, setLoading] = useState(true);

  // Global settings
  const [settings, setSettings] = useState<TryonSettings>({
    personSampleUrl: null,
    garmentSampleUrl: null,
  });
  const [showSamplesModal, setShowSamplesModal] = useState(false);
  const [uploadingPerson, setUploadingPerson] = useState(false);
  const [uploadingGarment, setUploadingGarment] = useState(false);
  const personInputRef = useRef<HTMLInputElement>(null);
  const garmentInputRef = useRef<HTMLInputElement>(null);

  // Category modal state
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formWorkflowId, setFormWorkflowId] = useState('');
  const [formSortOrder, setFormSortOrder] = useState(0);
  const [formIsActive, setFormIsActive] = useState(true);
  const [formSaving, setFormSaving] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);

  // Delete category confirm
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirming, setDeleteConfirming] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [cats, wfs, s] = await Promise.all([
        apiFetch<TryonCategory[]>('/admin/tryon-categories'),
        apiFetch<WorkflowOption[]>('/admin/workflows'),
        apiFetch<TryonSettings>('/admin/tryon-settings'),
      ]);
      setCategories(cats);
      setTryonWorkflows(wfs.filter((w) => w.workflowType === 'tryon'));
      setSettings(s);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to load tryon categories',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const openCreate = () => {
    setFormName('');
    setFormSlug('');
    setFormWorkflowId(tryonWorkflows[0]?.id ?? '');
    setFormSortOrder(categories.length);
    setFormIsActive(true);
    setSlugEdited(false);
    setEditingCategoryId(null);
    setModalMode('create');
  };

  const openEdit = (cat: TryonCategory) => {
    setFormName(cat.name);
    setFormSlug(cat.slug);
    setFormWorkflowId(cat.workflowTemplateId ?? '');
    setFormSortOrder(cat.sortOrder);
    setFormIsActive(cat.isActive);
    setSlugEdited(true);
    setEditingCategoryId(cat.id);
    setModalMode('edit');
  };

  const closeModal = () => {
    if (formSaving) return;
    setModalMode(null);
    setEditingCategoryId(null);
  };

  const handleNameChange = (value: string) => {
    setFormName(value);
    if (!slugEdited) {
      setFormSlug(toSnakeSlug(value));
    }
  };

  const handleSaveCategory = async () => {
    if (!formName.trim() || !formSlug.trim()) return;
    setFormSaving(true);
    try {
      if (modalMode === 'create') {
        const created = await apiFetch<TryonCategory>('/admin/tryon-categories', {
          method: 'POST',
          body: JSON.stringify({
            name: formName.trim(),
            slug: formSlug.trim(),
            workflowTemplateId: formWorkflowId || null,
            sortOrder: formSortOrder,
            isActive: formIsActive,
          }),
        });
        setCategories((prev) => [...prev, { ...created, samples: [] }]);
        toast({ title: `Category "${created.name}" created` });
        setModalMode(null);
        setEditingCategoryId(null);
      } else if (modalMode === 'edit' && editingCategoryId) {
        const updated = await apiFetch<TryonCategory>(
          `/admin/tryon-categories/${editingCategoryId}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              name: formName.trim(),
              workflowTemplateId: formWorkflowId || null,
              sortOrder: formSortOrder,
              isActive: formIsActive,
            }),
          },
        );
        setCategories((prev) =>
          prev.map((c) => (c.id === updated.id ? { ...updated, samples: c.samples } : c)),
        );
        toast({ title: `Category "${updated.name}" updated` });
        setModalMode(null);
        setEditingCategoryId(null);
      }
    } catch (e) {
      toast({
        kind: 'error',
        title: modalMode === 'create' ? 'Failed to create category' : 'Failed to update category',
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setFormSaving(false);
    }
  };

  const handleDeleteCategory = async (id: string) => {
    setDeleteConfirming(true);
    try {
      await apiFetch(`/admin/tryon-categories/${id}`, { method: 'DELETE' });
      setCategories((prev) => prev.filter((c) => c.id !== id));
      toast({ title: 'Category deleted' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to delete category',
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDeletingId(null);
      setDeleteConfirming(false);
    }
  };

  const handleSampleUpload = async (type: 'person' | 'garment', file: File) => {
    type === 'person' ? setUploadingPerson(true) : setUploadingGarment(true);
    try {
      const presign = await apiFetch<{
        r2Key: string;
        uploadUrl: string;
        thumbnailKey: string;
        thumbnailUploadUrl: string;
      }>('/admin/tryon-settings/presign', {
        method: 'POST',
        body: JSON.stringify({ type, contentType: file.type }),
      });

      const thumb = await makeThumbnail(file, 800);
      await Promise.all([
        putFile(presign.uploadUrl, file),
        putFile(presign.thumbnailUploadUrl, thumb),
      ]);

      await apiFetch('/admin/tryon-settings', {
        method: 'PATCH',
        body: JSON.stringify(
          type === 'person'
            ? { personSampleKey: presign.r2Key, personSampleThumbKey: presign.thumbnailKey }
            : { garmentSampleKey: presign.r2Key, garmentSampleThumbKey: presign.thumbnailKey },
        ),
      });

      // Reload settings to get fresh presigned URLs
      const updated = await apiFetch<TryonSettings>('/admin/tryon-settings');
      setSettings(updated);
      toast({ title: `${type === 'person' ? 'Person' : 'Garment'} sample updated` });
    } catch (e) {
      toast({
        kind: 'error',
        title: `Failed to upload ${type} sample`,
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      type === 'person' ? setUploadingPerson(false) : setUploadingGarment(false);
    }
  };

  const deletingCategory = deletingId ? categories.find((c) => c.id === deletingId) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div className="page-head">
        <div>
          <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>Tryon Categories</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Manage garment type categories for try-on.
          </p>
        </div>
        <div className="head-tools">
          <button className="btn ghost" onClick={() => setShowSamplesModal(true)}>
            <Icon.Image /> Edit sample images
          </button>
          <button className="btn primary" onClick={openCreate}>
            <Icon.Plus /> Add category
          </button>
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <div
          style={{ color: 'var(--muted)', fontSize: 13, padding: '32px 0', textAlign: 'center' }}
        >
          Loading…
        </div>
      ) : categories.length === 0 ? (
        <div
          style={{
            border: '1px dashed var(--border)',
            borderRadius: 8,
            padding: '48px 24px',
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          <p style={{ marginTop: 12 }}>
            No tryon categories yet. Add your first category to get started.
          </p>
          <button className="btn primary" style={{ marginTop: 12 }} onClick={openCreate}>
            <Icon.Plus /> Add category
          </button>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 16,
          }}
        >
          {categories.map((cat) => {
            const wfLabel = tryonWorkflows.find((w) => w.id === cat.workflowTemplateId)?.label;
            return (
              <div
                key={cat.id}
                className="card"
                style={{
                  padding: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  opacity: cat.isActive ? 1 : 0.6,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 14,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {cat.name}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: '2px 7px',
                      borderRadius: 10,
                      background: cat.isActive
                        ? 'var(--success-soft, rgba(76,175,80,0.12))'
                        : 'var(--bg-2)',
                      color: cat.isActive ? 'var(--success, #4caf50)' : 'var(--muted)',
                      flexShrink: 0,
                    }}
                  >
                    {cat.isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>

                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--muted)',
                    display: 'flex',
                    gap: 8,
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >
                  <span>#{cat.sortOrder}</span>
                  <code
                    style={{
                      fontSize: 10,
                      background: 'var(--bg-2)',
                      padding: '1px 5px',
                      borderRadius: 3,
                    }}
                  >
                    {cat.slug}
                  </code>
                  {wfLabel && (
                    <span style={{ color: 'var(--accent, #6366f1)', fontSize: 11 }}>{wfLabel}</span>
                  )}
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <button className="btn sm ghost" onClick={() => openEdit(cat)}>
                    <Icon.Edit /> Edit
                  </button>
                  <button
                    className="btn sm ghost"
                    style={{ color: 'var(--danger)', marginLeft: 'auto' }}
                    onClick={() => setDeletingId(cat.id)}
                    title="Delete category"
                  >
                    <Icon.Trash />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Global sample images modal */}
      {showSamplesModal && (
        <EditDrawer
          onClose={() => setShowSamplesModal(false)}
          title="Sample images"
          width="min(480px, calc(100vw - 40px))"
          saving={uploadingPerson || uploadingGarment}
          onSave={() => setShowSamplesModal(false)}
          saveLabel="Close"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
              These 2 images are shown as reference examples in the try-on upload UI — one for the
              person photo, one for the garment photo.
            </p>

            {(['person', 'garment'] as const).map((type) => {
              const url = type === 'person' ? settings.personSampleUrl : settings.garmentSampleUrl;
              const uploading = type === 'person' ? uploadingPerson : uploadingGarment;
              const inputRef = type === 'person' ? personInputRef : garmentInputRef;
              return (
                <div key={type} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                  {/* Preview */}
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
                    {url ? (
                      // biome-ignore lint/performance/noImgElement: admin panel thumbnail
                      <img
                        src={url}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    ) : (
                      <Icon.Image />
                    )}
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>
                      {type} sample
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {url ? 'Image uploaded' : 'No image yet'}
                    </div>
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 12px',
                        border: '1.5px dashed var(--border)',
                        borderRadius: 7,
                        cursor: uploading ? 'not-allowed' : 'pointer',
                        opacity: uploading ? 0.6 : 1,
                        background: 'var(--surface-2)',
                        fontSize: 12,
                        color: 'var(--muted)',
                        userSelect: 'none',
                        width: 'fit-content',
                      }}
                    >
                      <Icon.Image />
                      {uploading ? 'Uploading…' : url ? 'Replace image' : 'Upload image'}
                      <input
                        ref={inputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        disabled={uploading}
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handleSampleUpload(type, file);
                          if (inputRef.current) inputRef.current.value = '';
                        }}
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </EditDrawer>
      )}

      {/* Create / Edit modal */}
      {modalMode && (
        <EditDrawer
          onClose={closeModal}
          title={
            modalMode === 'create'
              ? 'Add category'
              : `Edit: ${categories.find((c) => c.id === editingCategoryId)?.name ?? ''}`
          }
          width="min(480px, calc(100vw - 40px))"
          saving={formSaving}
          onSave={() => void handleSaveCategory()}
          saveLabel={formSaving ? 'Saving…' : modalMode === 'create' ? 'Create' : 'Save'}
          saveDisabled={formSaving || !formName.trim() || !formSlug.trim()}
        >
          {/* Name */}
          <div className="field">
            <label>Name</label>
            <input
              className="input"
              value={formName}
              disabled={formSaving}
              placeholder="e.g. Upper Body"
              onChange={(e) => handleNameChange(e.target.value)}
            />
          </div>

          {/* Slug */}
          <div className="field">
            <label>
              Slug{' '}
              <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>
                (auto-derived, editable)
              </span>
            </label>
            <input
              className="input"
              value={formSlug}
              disabled={formSaving || modalMode === 'edit'}
              placeholder="snake_case"
              onChange={(e) => {
                setSlugEdited(true);
                setFormSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'));
              }}
            />
          </div>

          {/* Workflow */}
          <div className="field">
            <label>Workflow template</label>
            <SearchableSelect
              options={tryonWorkflows.map((wf) => ({
                id: wf.id,
                label: `${wf.label}${!wf.isActive ? ' (inactive)' : ''}`,
              }))}
              value={formWorkflowId}
              disabled={formSaving}
              emptyLabel="— none —"
              placeholder="— search workflow —"
              onChange={setFormWorkflowId}
            />
          </div>

          {/* Sort order */}
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
              value={formSortOrder}
              disabled={formSaving}
              onChange={(e) => setFormSortOrder(Number(e.target.value))}
              style={{ width: 120 }}
            />
          </div>

          {/* Active */}
          <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <input
              type="checkbox"
              id="cat-is-active"
              checked={formIsActive}
              disabled={formSaving}
              onChange={(e) => setFormIsActive(e.target.checked)}
              style={{
                accentColor: 'var(--pink, #ec4899)',
                width: 16,
                height: 16,
                flexShrink: 0,
              }}
            />
            <label htmlFor="cat-is-active" style={{ margin: 0, cursor: 'pointer' }}>
              Active
            </label>
          </div>
        </EditDrawer>
      )}

      {/* Delete confirmation modal */}
      {deletingId && deletingCategory && (
        <div
          className="modal-overlay"
          onClick={deleteConfirming ? undefined : () => setDeletingId(null)}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(400px, calc(100vw - 40px))' }}
          >
            <div className="modal-head">
              <h3>Delete category</h3>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0 }}>
                Delete <strong>"{deletingCategory.name}"</strong>? This cannot be undone.
              </p>
            </div>
            <div className="modal-foot">
              <button
                className="btn ghost"
                onClick={() => setDeletingId(null)}
                disabled={deleteConfirming}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                disabled={deleteConfirming}
                onClick={() => void handleDeleteCategory(deletingId)}
              >
                {deleteConfirming ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
