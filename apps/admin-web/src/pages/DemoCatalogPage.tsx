import { useCallback, useEffect, useState } from 'react';
import type { DemoItemEditData } from '../components/DemoItemModal';
import { DemoItemModal } from '../components/DemoItemModal';
import { DemoSetModal } from '../components/DemoSetModal';
import type { DemoSubcategoryEditData } from '../components/DemoSubcategoryModal';
import { DemoSubcategoryModal } from '../components/DemoSubcategoryModal';
import { Icon } from '../components/Icons';
import { apiErrorMessage, apiFetch } from '../lib/data';

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
  onNav: (page: string, filter?: { page: string; filter?: string }) => void;
}

interface DemoSet {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  subcategoryCount: number;
  productCount: number;
  assignedMerchantCount: number;
}

interface DemoSubcategory {
  id: string;
  category: string;
  name: string;
  garmentSubcategoryId: string;
  productCount: number;
}

interface DemoItem {
  id: string;
  label: string;
  sku: string | null;
  actualPrice: number;
  offerPrice: number;
  isActive: boolean;
  thumbnailUrl: string | null;
}

interface GarmentType {
  id: string;
  label: string;
  genderSlug: string;
}

type Category = 'men' | 'women' | 'boys' | 'girls';
const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'men', label: 'Men' },
  { id: 'women', label: 'Women' },
  { id: 'boys', label: 'Boys' },
  { id: 'girls', label: 'Girls' },
];

/**
 * Only one demo set is ever used in practice — a single universal set spanning
 * all genders — so this page skips straight to its subcategories instead of
 * showing a sets list. `sets[0]` is that set (auto-selected on load); the
 * bootstrap-create form below only appears the first time, when it doesn't
 * exist yet.
 */
export default function DemoCatalogPage({ toast }: Props) {
  const [sets, setSets] = useState<DemoSet[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<Category>('men');
  const [subcategories, setSubcategories] = useState<DemoSubcategory[]>([]);
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null);
  const [items, setItems] = useState<DemoItem[]>([]);
  const [garmentTypes, setGarmentTypes] = useState<GarmentType[]>([]);
  const [loading, setLoading] = useState(false);

  // Modals
  const [setModalOpen, setSetModalOpen] = useState(false);

  const [subModalOpen, setSubModalOpen] = useState(false);
  const [editingSub, setEditingSub] = useState<DemoSubcategoryEditData | undefined>(undefined);
  const [deleteSub, setDeleteSubTarget] = useState<DemoSubcategory | undefined>(undefined);

  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<DemoItemEditData | undefined>(undefined);
  const [deleteItem, setDeleteItemTarget] = useState<DemoItem | undefined>(undefined);

  const [busy, setBusy] = useState(false);

  const notifyError = useCallback(
    (title: string, err: unknown) => {
      toast({ kind: 'error', title, body: apiErrorMessage(err, 'Please try again.') });
    },
    [toast],
  );

  const loadSets = useCallback(async () => {
    try {
      const res = await apiFetch<{ items: DemoSet[] }>('/admin/demo-catalog/sets');
      setSets(res.items);
    } catch (err) {
      notifyError('Could not load demo data', err);
    }
  }, [notifyError]);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      loadSets(),
      apiFetch<{ items: GarmentType[] }>('/admin/assets/garment-types').then((r) =>
        setGarmentTypes(r.items),
      ),
    ])
      .catch((err) => notifyError('Could not load pickers', err))
      .finally(() => setLoading(false));
  }, [loadSets, notifyError]);

  const theSet = sets[0] ?? null;
  const selectedSetId = theSet?.id ?? null;

  const loadSubcategories = useCallback(
    async (setId: string) => {
      try {
        const res = await apiFetch<{ items: DemoSubcategory[] }>(
          `/admin/demo-catalog/sets/${setId}/subcategories`,
        );
        setSubcategories(res.items);
      } catch (err) {
        notifyError('Could not load demo data', err);
      }
    },
    [notifyError],
  );

  useEffect(() => {
    if (!selectedSetId) {
      setSubcategories([]);
      setSelectedSubId(null);
      return;
    }
    void loadSubcategories(selectedSetId);
  }, [selectedSetId, loadSubcategories]);

  const loadItems = useCallback(
    async (subcategoryId: string) => {
      try {
        const res = await apiFetch<{ items: DemoItem[] }>(
          `/admin/demo-catalog/items?subcategoryId=${subcategoryId}`,
        );
        setItems(res.items);
      } catch (err) {
        notifyError('Could not load demo products', err);
      }
    },
    [notifyError],
  );

  useEffect(() => {
    if (!selectedSubId) {
      setItems([]);
      return;
    }
    void loadItems(selectedSubId);
  }, [selectedSubId, loadItems]);

  const selectedSub = subcategories.find((s) => s.id === selectedSubId) ?? null;
  const visibleSubs = subcategories.filter((s) => s.category === selectedCategory);
  const categoryGarmentTypes = garmentTypes.filter((g) => g.genderSlug === selectedCategory);

  // --- Bootstrap: create the one universal set ---
  const handleCreateSet = async (name: string, description: string) => {
    setBusy(true);
    try {
      await apiFetch('/admin/demo-catalog/sets', {
        method: 'POST',
        body: JSON.stringify({ name, description: description || undefined }),
      });
      await loadSets();
      setSetModalOpen(false);
      toast({ title: 'Demo data set up' });
    } catch (err) {
      notifyError('Could not set up demo data', err);
    } finally {
      setBusy(false);
    }
  };

  // --- Subcategory handlers ---
  const openAddSubcategory = () => {
    setEditingSub(undefined);
    setSubModalOpen(true);
  };

  const handleSaveSubcategory = async (name: string, garmentSubcategoryId: string) => {
    if (!selectedSetId) return;
    setBusy(true);
    try {
      if (editingSub) {
        await apiFetch(`/admin/demo-catalog/subcategories/${editingSub.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, garmentSubcategoryId }),
        });
      } else {
        await apiFetch('/admin/demo-catalog/subcategories', {
          method: 'POST',
          body: JSON.stringify({
            setId: selectedSetId,
            category: selectedCategory,
            name,
            garmentSubcategoryId,
          }),
        });
      }
      await Promise.all([loadSubcategories(selectedSetId), loadSets()]);
      setSubModalOpen(false);
      setEditingSub(undefined);
      toast({ title: editingSub ? 'Subcategory updated' : 'Subcategory created' });
    } catch (err) {
      notifyError('Could not save the subcategory', err);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteSub = async () => {
    if (!deleteSub || !selectedSetId) return;
    setBusy(true);
    try {
      await apiFetch(`/admin/demo-catalog/subcategories/${deleteSub.id}`, { method: 'DELETE' });
      if (selectedSubId === deleteSub.id) setSelectedSubId(null);
      setDeleteSubTarget(undefined);
      await Promise.all([loadSubcategories(selectedSetId), loadSets()]);
      toast({ title: 'Subcategory deleted' });
    } catch (err) {
      notifyError('Could not delete the subcategory', err);
    } finally {
      setBusy(false);
    }
  };

  // --- Item handlers ---
  const openAddItem = () => {
    setEditingItem(undefined);
    setItemModalOpen(true);
  };

  const handleItemSaved = async () => {
    if (!selectedSubId || !selectedSetId) return;
    await Promise.all([loadItems(selectedSubId), loadSubcategories(selectedSetId), loadSets()]);
    setItemModalOpen(false);
    setEditingItem(undefined);
    toast({ title: editingItem ? 'Demo product updated' : 'Demo product added' });
  };

  const handleDeleteItem = async () => {
    if (!deleteItem || !selectedSubId || !selectedSetId) return;
    setBusy(true);
    try {
      await apiFetch(`/admin/demo-catalog/items/${deleteItem.id}`, { method: 'DELETE' });
      setDeleteItemTarget(undefined);
      await Promise.all([loadItems(selectedSubId), loadSubcategories(selectedSetId), loadSets()]);
      toast({ title: 'Demo product deleted' });
    } catch (err) {
      notifyError('Could not delete the demo product', err);
    } finally {
      setBusy(false);
    }
  };

  // --- Views ---

  if (loading) {
    return (
      <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>Loading…</div>
    );
  }

  // Bootstrap: no universal set exists yet
  if (!theSet) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Kiosk Demo Data</h1>
            <p className="lede">
              Admin-authored demo products shown to merchants on the Android app.
            </p>
          </div>
        </div>
        <div className="empty">
          <div className="ico">
            <Icon.Catalog />
          </div>
          <h3 style={{ margin: '0 0 4px' }}>Demo data isn't set up yet</h3>
          <p style={{ margin: '0 0 16px' }}>Create the demo data set to start adding products.</p>
          <button className="btn primary" onClick={() => setSetModalOpen(true)}>
            <Icon.Add /> Set up demo data
          </button>
        </div>
        <DemoSetModal
          open={setModalOpen}
          onClose={() => setSetModalOpen(false)}
          onSave={handleCreateSet}
          isSaving={busy}
        />
      </>
    );
  }

  // Products inside a subcategory
  if (selectedSub) {
    const garmentTypeLabel =
      garmentTypes.find((g) => g.id === selectedSub.garmentSubcategoryId)?.label ?? 'Unknown';

    return (
      <>
        <div className="page-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn sm ghost" onClick={() => setSelectedSubId(null)}>
              <Icon.Back />
            </button>
            <div>
              <h1>{selectedSub.name}</h1>
              <p className="lede">{garmentTypeLabel}</p>
            </div>
          </div>
          <div className="head-tools">
            <button className="btn primary" onClick={openAddItem}>
              <Icon.Add /> Add product
            </button>
          </div>
        </div>

        {items.length === 0 ? (
          <div className="empty">
            <div className="ico">
              <Icon.Image />
            </div>
            <h3 style={{ margin: '0 0 4px' }}>No products yet</h3>
            <p style={{ margin: '0 0 16px' }}>Add your first product to this subcategory.</p>
            <button className="btn primary" onClick={openAddItem}>
              <Icon.Add /> Add product
            </button>
          </div>
        ) : (
          <div className="cat-grid">
            {items.map((item) => (
              <div key={item.id} className="cat-card" style={{ cursor: 'default' }}>
                <div className="corner-r" style={{ display: 'flex', gap: 4, zIndex: 2 }}>
                  <button
                    type="button"
                    className="btn sm ghost"
                    style={{ background: 'var(--surface)' }}
                    onClick={() => {
                      setEditingItem({
                        id: item.id,
                        label: item.label,
                        sku: item.sku,
                        actualPrice: item.actualPrice,
                        offerPrice: item.offerPrice,
                        isActive: item.isActive,
                        thumbnailUrl: item.thumbnailUrl,
                      });
                      setItemModalOpen(true);
                    }}
                    title="Edit"
                  >
                    <Icon.Edit />
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    style={{ background: 'var(--surface)' }}
                    onClick={() => setDeleteItemTarget(item)}
                    title="Delete"
                  >
                    <Icon.Trash />
                  </button>
                </div>
                <div className="cat-thumb">
                  {item.thumbnailUrl ? (
                    // biome-ignore lint/performance/noImgElement: presigned R2 thumbnail
                    <img
                      src={item.thumbnailUrl}
                      alt={item.label}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <div
                      style={{
                        width: '100%',
                        height: '100%',
                        display: 'grid',
                        placeItems: 'center',
                        color: 'var(--muted-2)',
                      }}
                    >
                      <Icon.Image />
                    </div>
                  )}
                  {!item.isActive && <div className="inactive-overlay" />}
                </div>
                <div className="info">
                  <div className="label">{item.label}</div>
                  <div className="meta">
                    <span className="mono">{item.sku ?? '—'}</span>
                  </div>
                  <div className="meta" style={{ marginTop: 2 }}>
                    <span style={{ fontWeight: 600, color: 'var(--ink)' }}>₹{item.offerPrice}</span>
                    {item.offerPrice < item.actualPrice && (
                      <span style={{ textDecoration: 'line-through' }}>₹{item.actualPrice}</span>
                    )}
                  </div>
                  {!item.isActive && <span className="badge danger">Inactive</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        <DemoItemModal
          open={itemModalOpen}
          onClose={() => {
            setItemModalOpen(false);
            setEditingItem(undefined);
          }}
          onSaved={handleItemSaved}
          subcategoryId={selectedSubId}
          initialData={editingItem}
          toast={toast}
        />

        {deleteItem && (
          <div className="modal-overlay" onClick={() => setDeleteItemTarget(undefined)}>
            <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h3>Delete demo product</h3>
              </div>
              <div className="modal-body">
                <p>
                  Delete <strong>{deleteItem.label}</strong>? This cannot be undone.
                </p>
              </div>
              <div className="modal-foot">
                <button className="btn ghost" onClick={() => setDeleteItemTarget(undefined)}>
                  Cancel
                </button>
                <button className="btn danger" disabled={busy} onClick={handleDeleteItem}>
                  <Icon.Trash /> Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // Subcategories in the universal set
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Kiosk Demo Data</h1>
          <p className="lede">
            Admin-authored demo products. Merchants see them on the Android app but cannot edit or
            delete them.
          </p>
        </div>
        <div className="head-tools">
          <button className="btn primary" onClick={openAddSubcategory}>
            <Icon.Add /> Add subcategory
          </button>
        </div>
      </div>

      <div className="tabs">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            className={`tab ${selectedCategory === cat.id ? 'active' : ''}`}
            onClick={() => setSelectedCategory(cat.id)}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {visibleSubs.length === 0 ? (
        <div className="empty">
          <div className="ico">
            <Icon.Catalog />
          </div>
          <h3 style={{ margin: '0 0 4px' }}>No subcategories yet</h3>
          <p style={{ margin: '0 0 16px' }}>Create your first subcategory to start organizing.</p>
          <button className="btn primary" onClick={openAddSubcategory}>
            <Icon.Add /> Add subcategory
          </button>
        </div>
      ) : (
        <div className="cat-grid">
          {visibleSubs.map((sub) => {
            const garmentTypeLabel =
              garmentTypes.find((g) => g.id === sub.garmentSubcategoryId)?.label ?? 'Unknown';
            return (
              // biome-ignore lint/a11y/useSemanticElements: contains nested interactive edit/delete <button>s — a real <button> here would be invalid HTML (no nesting)
              <div
                key={sub.id}
                className="cat-card"
                onClick={() => setSelectedSubId(sub.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedSubId(sub.id);
                  }
                }}
              >
                <div className="corner-r" style={{ display: 'flex', gap: 4, zIndex: 2 }}>
                  <button
                    type="button"
                    className="btn sm ghost"
                    style={{ background: 'var(--surface)' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingSub({
                        id: sub.id,
                        name: sub.name,
                        garmentSubcategoryId: sub.garmentSubcategoryId,
                      });
                      setSubModalOpen(true);
                    }}
                    title="Edit"
                  >
                    <Icon.Edit />
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    style={{ background: 'var(--surface)' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteSubTarget(sub);
                    }}
                    title="Delete"
                  >
                    <Icon.Trash />
                  </button>
                </div>
                <div className="cat-thumb" style={{ display: 'grid', placeItems: 'center' }}>
                  <Icon.Catalog style={{ width: 32, height: 32, color: 'var(--muted-2)' }} />
                </div>
                <div className="info">
                  <div className="label">{sub.name}</div>
                  <div className="meta">
                    <span className="badge">{garmentTypeLabel}</span>
                    <span className="sep">•</span>
                    <span>{sub.productCount} products</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <DemoSubcategoryModal
        open={subModalOpen}
        onClose={() => {
          setSubModalOpen(false);
          setEditingSub(undefined);
        }}
        onSave={handleSaveSubcategory}
        initialData={editingSub}
        category={selectedCategory}
        garmentTypes={categoryGarmentTypes}
        isSaving={busy}
      />

      {deleteSub && (
        <div className="modal-overlay" onClick={() => setDeleteSubTarget(undefined)}>
          <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Delete subcategory</h3>
            </div>
            <div className="modal-body">
              <p>
                Delete <strong>{deleteSub.name}</strong>? All {deleteSub.productCount} product(s)
                inside it will also be deleted.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setDeleteSubTarget(undefined)}>
                Cancel
              </button>
              <button className="btn danger" disabled={busy} onClick={handleDeleteSub}>
                <Icon.Trash /> Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
