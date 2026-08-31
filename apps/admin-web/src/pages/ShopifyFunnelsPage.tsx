import { useCallback, useEffect, useState } from 'react';
import { ConfirmModal } from '../components/ConfirmModal';
import { EditDrawer } from '../components/EditDrawer';
import { Icon } from '../components/Icons';
import { SearchableSelect } from '../components/SearchableSelect';
import { ApiError, apiErrorMessage, apiFetch } from '../lib/data';

interface WorkflowOption {
  id: string;
  label: string;
}

interface FunnelTemplate {
  id: string;
  slug: string;
  label: string;
  workflowTemplateId: string;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
}

interface Props {
  toast: (opts: { kind?: 'error'; title: string; body?: string }) => void;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default function ShopifyFunnelsPage({ toast }: Props) {
  const [items, setItems] = useState<FunnelTemplate[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [hasDefault, setHasDefault] = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [slug, setSlug] = useState('');
  const [label, setLabel] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [workflowTemplateId, setWorkflowTemplateId] = useState('');
  const [sortOrder, setSortOrder] = useState(0);
  const [creating, setCreating] = useState(false);

  const [editingItem, setEditingItem] = useState<FunnelTemplate | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editWorkflowTemplateId, setEditWorkflowTemplateId] = useState('');
  const [editSortOrder, setEditSortOrder] = useState(0);
  const [editSaving, setEditSaving] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<FunnelTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [reassignSource, setReassignSource] = useState<FunnelTemplate | null>(null);
  const [reassignTargetId, setReassignTargetId] = useState('');
  const [reassigning, setReassigning] = useState(false);
  // true when opened via a blocked delete (reassign, then delete the source);
  // false when opened via the standalone "Move products" action (reassign only).
  const [reassignThenDelete, setReassignThenDelete] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ items: FunnelTemplate[]; hasDefault: boolean }>('/admin/shopify/funnel-templates'),
      apiFetch<WorkflowOption[]>('/admin/workflows'),
    ])
      .then(([f, w]) => {
        setItems(f.items);
        setHasDefault(f.hasDefault);
        setWorkflows(w);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function resetCreateForm() {
    setSlug('');
    setLabel('');
    setSlugTouched(false);
    setWorkflowTemplateId('');
    setSortOrder(0);
  }

  async function create() {
    if (!slug || !label || !workflowTemplateId) return;
    setCreating(true);
    try {
      await apiFetch('/admin/shopify/funnel-templates', {
        method: 'POST',
        body: JSON.stringify({ slug, label, workflowTemplateId, sortOrder }),
      });
      toast({ title: 'Funnel template created' });
      resetCreateForm();
      setShowCreate(false);
      load();
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Failed to create funnel template',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(item: FunnelTemplate) {
    setTogglingId(item.id);
    try {
      await apiFetch(`/admin/shopify/funnel-templates/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !item.isActive }),
      });
      load();
    } finally {
      setTogglingId(null);
    }
  }

  async function makeDefault(item: FunnelTemplate) {
    setTogglingId(item.id);
    try {
      await apiFetch(`/admin/shopify/funnel-templates/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isDefault: true }),
      });
      load();
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Could not set default',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setTogglingId(null);
    }
  }

  function openEdit(item: FunnelTemplate) {
    setEditingItem(item);
    setEditLabel(item.label);
    setEditWorkflowTemplateId(item.workflowTemplateId);
    setEditSortOrder(item.sortOrder);
  }

  async function saveEdit() {
    if (!editingItem || !editLabel || !editWorkflowTemplateId) return;
    setEditSaving(true);
    try {
      await apiFetch(`/admin/shopify/funnel-templates/${editingItem.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          label: editLabel,
          workflowTemplateId: editWorkflowTemplateId,
          sortOrder: editSortOrder,
        }),
      });
      toast({ title: 'Funnel template updated' });
      setEditingItem(null);
      load();
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await apiFetch(`/admin/shopify/funnel-templates/${confirmDelete.id}`, { method: 'DELETE' });
      toast({ title: `${confirmDelete.label} deleted` });
      load();
      setConfirmDelete(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Products are still assigned — offer to move them to another funnel
        // template first instead of just reporting the block.
        setReassignSource(confirmDelete);
        setReassignTargetId('');
        setReassignThenDelete(true);
        setConfirmDelete(null);
      } else {
        toast({
          kind: 'error',
          title: 'Failed to delete funnel template',
          body: apiErrorMessage(err, 'Please try again.'),
        });
        setConfirmDelete(null);
      }
    } finally {
      setDeleting(false);
    }
  }

  function openMove(item: FunnelTemplate) {
    setReassignSource(item);
    setReassignTargetId('');
    setReassignThenDelete(false);
  }

  async function handleReassignAndDelete() {
    if (!reassignSource || !reassignTargetId) return;
    setReassigning(true);
    try {
      const { reassigned } = await apiFetch<{ ok: boolean; reassigned: number }>(
        `/admin/shopify/funnel-templates/${reassignSource.id}/reassign`,
        { method: 'POST', body: JSON.stringify({ targetId: reassignTargetId }) },
      );
      if (reassignThenDelete) {
        await apiFetch(`/admin/shopify/funnel-templates/${reassignSource.id}`, {
          method: 'DELETE',
        });
        toast({
          title: `${reassignSource.label} deleted`,
          body: `${reassigned} product(s) moved to the selected funnel template.`,
        });
      } else {
        toast({
          title: 'Products moved',
          body: `${reassigned} product(s) moved to the selected funnel template.`,
        });
      }
      setReassignSource(null);
      load();
    } catch (err) {
      toast({
        kind: 'error',
        title: reassignThenDelete ? 'Failed to reassign and delete' : 'Failed to move products',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setReassigning(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div className="page-head">
        <div>
          <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>Shopify</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Global, admin-owned labels merchants assign their Shopify products to. Each maps to one
            workflow template.
          </p>
        </div>
        <div className="head-tools">
          <button type="button" className="btn primary" onClick={() => setShowCreate(true)}>
            <Icon.Plus /> New funnel template
          </button>
        </div>
      </div>

      {!loading && !hasDefault && (
        <div className="banner" style={{ marginBottom: 16 }}>
          <div className="ic">
            <Icon.Warning />
          </div>
          <div>
            <b>No default funnel template.</b> Every Shopify try-on is refused until one template
            here is set as the default.
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div
          style={{ color: 'var(--muted)', fontSize: 13, padding: '32px 0', textAlign: 'center' }}
        >
          Loading…
        </div>
      ) : items.length === 0 ? (
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
          <Icon.Workflow />
          <p style={{ marginTop: 12 }}>No funnel templates yet. Add one to get started.</p>
          <button
            type="button"
            className="btn primary"
            style={{ marginTop: 12 }}
            onClick={() => setShowCreate(true)}
          >
            <Icon.Plus /> New funnel template
          </button>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Slug</th>
                <th>Workflow</th>
                <th style={{ textAlign: 'right' }}>Default</th>
                <th style={{ textAlign: 'right' }}>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td style={{ fontWeight: 500 }}>{item.label}</td>
                  <td>
                    <code
                      style={{
                        fontSize: 12,
                        background: 'var(--bg-2)',
                        padding: '2px 6px',
                        borderRadius: 4,
                      }}
                    >
                      {item.slug}
                    </code>
                  </td>
                  <td>{workflows.find((w) => w.id === item.workflowTemplateId)?.label ?? '?'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {item.isDefault ? (
                      <span style={{ fontWeight: 600 }}>Default</span>
                    ) : (
                      <button
                        type="button"
                        className="btn sm ghost"
                        disabled={togglingId === item.id || !item.isActive}
                        title={
                          item.isActive
                            ? 'Route every Shopify product through this workflow'
                            : 'Activate this template before making it the default'
                        }
                        onClick={() => makeDefault(item)}
                      >
                        {togglingId === item.id ? '…' : 'Set default'}
                      </button>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      type="button"
                      className="btn sm ghost"
                      disabled={togglingId === item.id}
                      onClick={() => toggleActive(item)}
                    >
                      {togglingId === item.id ? '…' : item.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => openEdit(item)}
                      title="Edit label, workflow, or sort order"
                    >
                      <Icon.Edit /> Edit
                    </button>{' '}
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => openMove(item)}
                      title="Move this template's assigned products to another funnel template"
                    >
                      <Icon.Replace /> Move
                    </button>{' '}
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => setConfirmDelete(item)}
                      title="Delete this funnel template"
                    >
                      <Icon.Trash /> Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <EditDrawer
          onClose={() => setShowCreate(false)}
          title="New funnel template"
          width="min(420px, calc(100vw - 40px))"
          saving={creating}
          onSave={create}
          saveLabel={creating ? 'Creating…' : 'Create'}
          saveDisabled={creating || !slug || !label || !workflowTemplateId}
        >
          <div className="field">
            <label>Label</label>
            <input
              className="input"
              value={label}
              disabled={creating}
              onChange={(e) => {
                const value = e.target.value;
                setLabel(value);
                if (!slugTouched) setSlug(slugify(value));
              }}
            />
          </div>
          <div className="field">
            <label>Slug</label>
            <input
              className="input"
              value={slug}
              disabled={creating}
              placeholder="kebab-case"
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(slugify(e.target.value));
              }}
            />
          </div>
          <div className="field">
            <label>Workflow</label>
            <SearchableSelect
              options={workflows}
              value={workflowTemplateId}
              disabled={creating}
              onChange={setWorkflowTemplateId}
              placeholder="— search workflow —"
              emptyLabel="Select a workflow"
            />
          </div>
          <div className="field">
            <label>Sort order</label>
            <input
              className="input"
              type="number"
              value={sortOrder}
              disabled={creating}
              onChange={(e) => setSortOrder(Number(e.target.value))}
            />
          </div>
        </EditDrawer>
      )}

      {/* Edit modal */}
      {editingItem && (
        <EditDrawer
          onClose={() => setEditingItem(null)}
          title="Edit funnel template"
          subtitle={editingItem.slug}
          width="min(420px, calc(100vw - 40px))"
          saving={editSaving}
          onSave={saveEdit}
          saveLabel={editSaving ? 'Saving…' : 'Save'}
          saveDisabled={editSaving || !editLabel || !editWorkflowTemplateId}
        >
          <div className="field">
            <label>Slug</label>
            <input className="input" value={editingItem.slug} disabled />
          </div>
          <div className="field">
            <label>Label</label>
            <input
              className="input"
              value={editLabel}
              disabled={editSaving}
              onChange={(e) => setEditLabel(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Workflow</label>
            <SearchableSelect
              options={workflows}
              value={editWorkflowTemplateId}
              disabled={editSaving}
              onChange={setEditWorkflowTemplateId}
              placeholder="— search workflow —"
              emptyLabel="Select a workflow"
            />
          </div>
          <div className="field">
            <label>Sort order</label>
            <input
              className="input"
              type="number"
              value={editSortOrder}
              disabled={editSaving}
              onChange={(e) => setEditSortOrder(Number(e.target.value))}
            />
          </div>
        </EditDrawer>
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete funnel template"
          body={`Are you sure you want to delete "${confirmDelete.label}"? This cannot be undone.`}
          what={`slug: ${confirmDelete.slug}`}
          danger
          confirmLabel={deleting ? 'Deleting…' : 'Delete'}
          onConfirm={handleDelete}
          onClose={() => setConfirmDelete(null)}
        />
      )}

      {reassignSource && (
        <div
          className="modal-overlay"
          onClick={reassigning ? undefined : () => setReassignSource(null)}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(420px, calc(100vw - 40px))' }}
          >
            <div className="modal-head">
              <h3>{reassignThenDelete ? 'Move products & delete' : 'Move products'}</h3>
              <button
                className="btn sm ghost"
                onClick={() => setReassignSource(null)}
                disabled={reassigning}
                style={{ marginLeft: 'auto' }}
              >
                <Icon.Close />
              </button>
            </div>
            <div
              className="modal-body"
              style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
            >
              <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
                {reassignThenDelete ? (
                  <>
                    "{reassignSource.label}" still has products assigned to it. Pick another funnel
                    template to move them to — they'll be reassigned, then "{reassignSource.label}"
                    will be deleted.
                  </>
                ) : (
                  <>
                    Pick another funnel template to move "{reassignSource.label}"'s assigned
                    products to. "{reassignSource.label}" itself won't be deleted.
                  </>
                )}
              </p>
              <div className="field">
                <label>Move products to</label>
                <SearchableSelect
                  options={items.filter((i) => i.id !== reassignSource.id)}
                  value={reassignTargetId}
                  disabled={reassigning}
                  onChange={setReassignTargetId}
                  placeholder="— search funnel template —"
                  emptyLabel="Select a funnel template"
                />
              </div>
            </div>
            <div className="modal-foot">
              <button
                className="btn ghost"
                onClick={() => setReassignSource(null)}
                disabled={reassigning}
              >
                Cancel
              </button>
              <button
                className={reassignThenDelete ? 'btn danger' : 'btn primary'}
                disabled={reassigning || !reassignTargetId}
                onClick={handleReassignAndDelete}
              >
                {reassigning ? 'Moving…' : reassignThenDelete ? 'Move & delete' : 'Move'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
