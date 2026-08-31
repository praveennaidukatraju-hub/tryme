import { useCallback, useEffect, useState } from 'react';
import { EditDrawer } from '../components/EditDrawer';
import { Icon } from '../components/Icons';
import { SearchableSelect } from '../components/SearchableSelect';
import { apiErrorMessage, apiFetch } from '../lib/data';
import type { WorkflowOption } from '../types';

// Mirrors packages/types/src/dev.ts DevTryonCategoryRow — inlined here to avoid
// a runtime dependency on the types package from the admin SPA (same convention
// as SareePage.tsx's local AdminSaree* interfaces).
interface DevTryonCategory {
  id: string;
  name: string;
  slug: string;
  workflowTemplateId: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface DevSareeConfig {
  workflowTemplateId: string | null;
  isActive: boolean;
  updatedAt: string | null;
}

interface BackfillCounts {
  modelFaces: number;
  modelBackgrounds: number;
  modelPoseAssets: number;
  catalogItems: number;
  garmentSubcategories: number;
}

interface BackfillResponse {
  ok: true;
  counts: BackfillCounts;
  total: number;
  version: number;
}

const BACKFILL_COUNT_LABELS: Record<keyof BackfillCounts, string> = {
  modelFaces: 'faces',
  modelBackgrounds: 'backgrounds',
  modelPoseAssets: 'poses',
  catalogItems: 'catalog items',
  garmentSubcategories: 'garment types',
};

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
  onNav: (_page: string, _filter?: { page: string; filter?: string }) => void;
}

// Dev-API category slugs are hyphenated (see slugRule in packages/types/src/dev.ts),
// unlike internal tryon_categories, which use snake_case.
function toKebabSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default function DevApiPage({ toast }: Props) {
  const [categories, setCategories] = useState<DevTryonCategory[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [loading, setLoading] = useState(true);

  // Saree mannequin (dev API) config
  const [sareeConfig, setSareeConfig] = useState<DevSareeConfig>({
    workflowTemplateId: null,
    isActive: false,
    updatedAt: null,
  });
  const [savingSareeConfig, setSavingSareeConfig] = useState(false);

  // Public catalog: one-time bulk opt-in for existing assets + manual cache trigger.
  const [backfilling, setBackfilling] = useState(false);
  const [rebuildingCache, setRebuildingCache] = useState(false);
  const [confirmingBackfill, setConfirmingBackfill] = useState(false);

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

  // Dev tryon categories point at 'tryon' workflows, same as internal tryon_categories.
  const tryonWorkflows = workflows.filter((w) => w.workflowType === 'tryon');
  // The saree-mannequin (step 1) config points at 'saree_step1' workflows, same as
  // garment_subcategories.mannequinWorkflowTemplateId / saree mannequin styles.
  const sareeWorkflows = workflows.filter((w) => w.workflowType === 'saree_step1');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [cats, wfs, config] = await Promise.all([
        apiFetch<DevTryonCategory[]>('/admin/dev-api/tryon-categories'),
        apiFetch<WorkflowOption[]>('/admin/workflows'),
        apiFetch<DevSareeConfig>('/admin/dev-api/saree-config'),
      ]);
      setCategories(cats);
      setWorkflows(wfs);
      setSareeConfig(config);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to load Dev API config',
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

  const openEdit = (cat: DevTryonCategory) => {
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
      setFormSlug(toKebabSlug(value));
    }
  };

  const handleSaveCategory = async () => {
    if (!formName.trim() || !formSlug.trim()) return;
    setFormSaving(true);
    try {
      if (modalMode === 'create') {
        const created = await apiFetch<DevTryonCategory>('/admin/dev-api/tryon-categories', {
          method: 'POST',
          body: JSON.stringify({
            name: formName.trim(),
            slug: formSlug.trim(),
            workflowTemplateId: formWorkflowId || null,
            sortOrder: formSortOrder,
            isActive: formIsActive,
          }),
        });
        setCategories((prev) => [...prev, created]);
        toast({ title: `Category "${created.name}" created` });
        setModalMode(null);
        setEditingCategoryId(null);
      } else if (modalMode === 'edit' && editingCategoryId) {
        const updated = await apiFetch<DevTryonCategory>(
          `/admin/dev-api/tryon-categories/${editingCategoryId}`,
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
        setCategories((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
        toast({ title: `Category "${updated.name}" updated` });
        setModalMode(null);
        setEditingCategoryId(null);
      }
    } catch (e) {
      // Surface the real backend message (e.g. 409 duplicate slug) — never a generic toast.
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
      await apiFetch(`/admin/dev-api/tryon-categories/${id}`, { method: 'DELETE' });
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

  const updateSareeConfig = async (
    patch: Partial<Pick<DevSareeConfig, 'workflowTemplateId' | 'isActive'>>,
  ) => {
    const next = { ...sareeConfig, ...patch };
    setSavingSareeConfig(true);
    try {
      const updated = await apiFetch<DevSareeConfig>('/admin/dev-api/saree-config', {
        method: 'PATCH',
        body: JSON.stringify({
          workflowTemplateId: next.workflowTemplateId,
          isActive: next.isActive,
        }),
      });
      setSareeConfig(updated);
      toast({ title: 'Saree mannequin config saved' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to save saree mannequin config',
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSavingSareeConfig(false);
    }
  };

  const handleRebuildCache = async () => {
    setRebuildingCache(true);
    try {
      await apiFetch('/admin/dev-api/catalog/rebuild-cache', { method: 'POST' });
      toast({ title: 'Public catalog cache invalidated' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to rebuild cache',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setRebuildingCache(false);
    }
  };

  const handleBackfillSlugs = async () => {
    setConfirmingBackfill(false);
    setBackfilling(true);
    try {
      const res = await apiFetch<BackfillResponse>('/admin/dev-api/catalog/backfill-slugs', {
        method: 'POST',
      });
      if (res.total === 0) {
        toast({ title: 'Nothing to publish', body: 'Every eligible asset already has a slug.' });
      } else {
        const breakdown = (Object.keys(BACKFILL_COUNT_LABELS) as (keyof BackfillCounts)[])
          .filter((k) => res.counts[k] > 0)
          .map((k) => `${res.counts[k]} ${BACKFILL_COUNT_LABELS[k]}`)
          .join(', ');
        toast({ title: `Published ${res.total} assets`, body: breakdown });
      }
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Backfill failed',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setBackfilling(false);
    }
  };

  const deletingCategory = deletingId ? categories.find((c) => c.id === deletingId) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>Dev API</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Controls the public developer API surface (<code>/v1/dev/*</code>) exposed to
            third-party API callers. This catalog is independent of the internal Try-on categories —
            renaming or deactivating an internal category never changes what the Dev API exposes.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn primary" onClick={openCreate}>
            <Icon.Plus /> Add category
          </button>
        </div>
      </div>

      {/* Categories grid */}
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
            No dev API categories yet. Add your first category to get started.
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

      {/* Public catalog (dev API asset publishing) card */}
      <div
        className="card"
        style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>Public Catalog</span>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--muted)' }}>
          Faces, backgrounds, poses, lower garments, shoes and garment types are hidden from{' '}
          <code>/v1/dev/catalog/*</code> until they carry a slug (set per-asset via "Public API
          slug" in each editor, or filled in bulk below). Backfill only touches active assets that
          don't have a slug yet — it never renames or removes an existing one.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            className="btn primary"
            disabled={backfilling}
            onClick={() => setConfirmingBackfill(true)}
          >
            {backfilling ? 'Publishing…' : 'Backfill public slugs'}
          </button>
          <button className="btn ghost" disabled={rebuildingCache} onClick={handleRebuildCache}>
            {rebuildingCache ? 'Rebuilding…' : 'Rebuild cache'}
          </button>
        </div>
      </div>

      {/* Backfill confirm modal */}
      {confirmingBackfill && (
        <div
          className="modal-overlay"
          onClick={backfilling ? undefined : () => setConfirmingBackfill(false)}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(440px, calc(100vw - 40px))' }}
          >
            <div className="modal-head">
              <h3>Backfill public slugs</h3>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0 }}>
                This publishes every currently active, unpublished asset to{' '}
                <code>/v1/dev/catalog/*</code> under an auto-generated slug — potentially hundreds
                of rows at once. Assets that already have a slug are left untouched. Continue?
              </p>
            </div>
            <div className="modal-foot">
              <button
                className="btn ghost"
                onClick={() => setConfirmingBackfill(false)}
                disabled={backfilling}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={backfilling}
                onClick={() => void handleBackfillSlugs()}
              >
                {backfilling ? 'Publishing…' : 'Publish all'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Saree Mannequin (Dev API) config card */}
      <div
        className="card"
        style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Saree Mannequin (Dev API)</span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: '2px 7px',
              borderRadius: 10,
              background: sareeConfig.isActive
                ? 'var(--success-soft, rgba(76,175,80,0.12))'
                : 'var(--bg-2)',
              color: sareeConfig.isActive ? 'var(--success, #4caf50)' : 'var(--muted)',
            }}
          >
            {sareeConfig.isActive ? 'Active' : 'Inactive'}
          </span>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--muted)' }}>
          Workflow used by the public <code>/v1/dev/saree-mannequin</code> endpoint. Independent of
          the internal saree mannequin styles configured in Assets.
        </p>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 240px', maxWidth: 400, minWidth: 0 }}>
            <SearchableSelect
              options={sareeWorkflows.map((w) => ({
                id: w.id,
                label: `${w.label}${!w.isActive ? ' (inactive)' : ''}`,
              }))}
              value={sareeConfig.workflowTemplateId ?? ''}
              disabled={savingSareeConfig}
              emptyLabel="— none —"
              placeholder="— search workflow —"
              onChange={(id) => void updateSareeConfig({ workflowTemplateId: id || null })}
            />
          </div>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              cursor: savingSareeConfig ? 'not-allowed' : 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={sareeConfig.isActive}
              disabled={savingSareeConfig}
              onChange={(e) => void updateSareeConfig({ isActive: e.target.checked })}
              style={{
                accentColor: 'var(--pink, #ec4899)',
                width: 16,
                height: 16,
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 13, fontWeight: 500 }}>Active</span>
          </label>
          {savingSareeConfig && (
            <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>Saving…</span>
          )}
        </div>
      </div>

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
              placeholder="kebab-case"
              onChange={(e) => {
                setSlugEdited(true);
                setFormSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
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
              id="dev-cat-is-active"
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
            <label htmlFor="dev-cat-is-active" style={{ margin: 0, cursor: 'pointer' }}>
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
