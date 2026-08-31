import { useCallback, useEffect, useRef, useState } from 'react';
import { AssetThumb } from '../../components/AssetThumb';
import { BatchCatalogUploadModal } from '../../components/BatchCatalogUploadModal';
import { EditDrawer } from '../../components/EditDrawer';
import { Icon } from '../../components/Icons';
import { Switch } from '../../components/Switch';
import {
  apiErrorMessage,
  apiFetch,
  UPLOAD_NETWORK_ERROR,
  uploadErrorMessage,
} from '../../lib/data';
import { makeThumbnail } from '../../lib/thumbnail';
import type { CatalogCategory, CatalogItem, GenderSlug } from '../../types';
import { useAssetsContext } from './AssetsContext';

const GENDER_TABS = [
  { k: 'all' as const, l: 'All' },
  { k: 'men' as const, l: 'Men' },
  { k: 'women' as const, l: 'Women' },
  { k: 'boys' as const, l: 'Boys' },
  { k: 'girls' as const, l: 'Girls' },
];

export function CatalogTab() {
  const {
    activeTab,
    genderFilter,
    setGenderFilter,
    garmentTypes,
    loading,
    setLoading,
    setPreviewUrl,
    toast,
  } = useAssetsContext();

  const typeSlug = activeTab === 'shoe' ? 'shoe' : 'lower';

  const singleClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleImageClick(id: string) {
    if (singleClickTimerRef.current) {
      clearTimeout(singleClickTimerRef.current);
      singleClickTimerRef.current = null;
      return;
    }
    singleClickTimerRef.current = setTimeout(() => {
      singleClickTimerRef.current = null;
      setSelectedCatalogItemIds((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );
    }, 250);
  }

  function handleImageDoubleClick(r2Url: string | null) {
    if (r2Url) setPreviewUrl(r2Url);
  }

  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [catalogCategories, setCatalogCategories] = useState<CatalogCategory[]>([]);
  const [catalogTypeIds, setCatalogTypeIds] = useState<Record<string, number>>({});
  const [lowerCatView, setLowerCatView] = useState<
    { kind: 'list' } | { kind: 'category'; cat: CatalogCategory }
  >({ kind: 'list' });
  const [selectedCatalogItemIds, setSelectedCatalogItemIds] = useState<string[]>([]);

  // Modals
  const [showCatalogUpload, setShowCatalogUpload] = useState(false);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [catForm, setCatForm] = useState<{
    label: string;
    slug: string;
    genderSlug: GenderSlug;
    sortOrder: number;
  }>({ label: '', slug: '', genderSlug: 'men', sortOrder: 0 });
  const [catImageFile, setCatImageFile] = useState<File | null>(null);
  const [catSaving, setCatSaving] = useState(false);
  const [editingCategory, setEditingCategory] = useState<CatalogCategory | null>(null);
  const [editCatLabel, setEditCatLabel] = useState('');
  const [editCatImageFile, setEditCatImageFile] = useState<File | null>(null);
  const [editCatSaving, setEditCatSaving] = useState(false);
  const [editingCatalogItem, setEditingCatalogItem] = useState<CatalogItem | null>(null);
  const [editCatalogLabel, setEditCatalogLabel] = useState('');
  const [editCatalogGender, setEditCatalogGender] = useState<string>('men');
  const [editCatalogSubcatIds, setEditCatalogSubcatIds] = useState<string[]>([]);
  const [editCatalogSaving, setEditCatalogSaving] = useState(false);
  const [catalogReplaceFile, setCatalogReplaceFile] = useState<File | null>(null);
  const [catalogReplacePreview, setCatalogReplacePreview] = useState<string | null>(null);
  const [catalogReplaceUploading, setCatalogReplaceUploading] = useState(false);
  const catalogReplaceRef = useRef<HTMLInputElement>(null);
  const [confirmDeleteCatalog, setConfirmDeleteCatalog] = useState<string | null>(null);
  const [confirmDeleteCategory, setConfirmDeleteCategory] = useState<CatalogCategory | null>(null);
  const [showBulkMapCatalog, setShowBulkMapCatalog] = useState(false);
  const [bulkMapCatalogSubcatIds, setBulkMapCatalogSubcatIds] = useState<Set<string>>(new Set());
  const [bulkMappingCatalog, setBulkMappingCatalog] = useState(false);
  const [bulkUnmappingCatalog, setBulkUnmappingCatalog] = useState(false);
  const [confirmUnmapCatalogIds, setConfirmUnmapCatalogIds] = useState<string[]>([]);
  const [confirmBulkDeleteCatalogIds, setConfirmBulkDeleteCatalogIds] = useState<string[]>([]);

  const loadCatalogCategoriesAndTypes = useCallback(async () => {
    try {
      const [cats, types] = await Promise.all([
        apiFetch<CatalogCategory[]>('/admin/catalog/categories'),
        apiFetch<{ id: number; slug: string; label: string }[]>('/admin/catalog/types'),
      ]);
      setCatalogCategories(cats.filter((c) => c.typeSlug === typeSlug));
      setCatalogTypeIds(Object.fromEntries(types.map((t) => [t.slug, t.id])));
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to load categories',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  }, [typeSlug, toast]);

  const loadCatalog = useCallback(
    async (genderSlug?: string, categoryId?: number) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (genderSlug) params.set('genderSlug', genderSlug);
        if (categoryId !== undefined) params.set('categoryId', String(categoryId));
        const qs = params.toString() ? `?${params.toString()}` : '';
        const items = await apiFetch<CatalogItem[]>(`/admin/catalog/items${qs}`);
        setCatalogItems(items);
      } catch (e) {
        toast({
          kind: 'error',
          title: 'Failed to load catalog',
          body: apiErrorMessage(e, 'Please try again.'),
        });
      } finally {
        setLoading(false);
      }
    },
    [toast, setLoading],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: setLowerCatView/setSelectedCatalogItemIds are stable React setters
  useEffect(() => {
    setLowerCatView({ kind: 'list' });
    setSelectedCatalogItemIds([]);
    void loadCatalogCategoriesAndTypes();
  }, [activeTab, loadCatalogCategoriesAndTypes]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadCatalogCategoriesAndTypes();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadCatalogCategoriesAndTypes]);

  const tabLabel = activeTab === 'shoe' ? 'Shoes' : 'Lower garments';
  const pageTitle = lowerCatView.kind === 'category' ? lowerCatView.cat.label : tabLabel;

  return (
    <>
      <div className="page-head">
        <div>
          {lowerCatView.kind === 'category' && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 6,
                fontSize: 13,
                color: 'var(--muted)',
              }}
            >
              <button
                className="btn sm ghost"
                onClick={() => {
                  setLowerCatView({ kind: 'list' });
                  setSelectedCatalogItemIds([]);
                  setCatalogItems([]);
                }}
                style={{ padding: '2px 8px', fontSize: 13 }}
              >
                {tabLabel}
              </button>
              <Icon.Chevron />
              <span>{lowerCatView.cat.label}</span>
            </div>
          )}
          <h1>{pageTitle}</h1>
          <p className="lede">
            {lowerCatView.kind === 'list'
              ? 'Categories of lower garments / shoes. Click to manage items inside each category.'
              : `${lowerCatView.cat.genderSlug ?? 'all'} · batch upload items, then map to garment types.`}
          </p>
        </div>
        <div className="head-tools">
          {lowerCatView.kind === 'list' && (
            <button
              className="btn"
              onClick={() => {
                setCatForm({ label: '', slug: '', genderSlug: 'men', sortOrder: 0 });
                setShowAddCategory(true);
              }}
            >
              <Icon.Add /> Add {activeTab === 'lower' ? 'lower' : 'shoe'} category
            </button>
          )}
          {lowerCatView.kind === 'category' && (
            <button className="btn" onClick={() => setShowCatalogUpload(true)}>
              <Icon.Upload /> Batch upload
            </button>
          )}
        </div>
      </div>

      {/* ── Category list ── */}
      {!loading && lowerCatView.kind === 'list' && (
        <>
          <div className="tabs" style={{ marginTop: -8 }}>
            {GENDER_TABS.map((t) => (
              <button
                key={t.k}
                className={`tab ${genderFilter === t.k ? 'active' : ''}`}
                onClick={() => setGenderFilter(t.k)}
              >
                {t.l}
              </button>
            ))}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 14,
              marginTop: 8,
            }}
          >
            {catalogCategories.filter(
              (c) => genderFilter === 'all' || c.genderSlug === genderFilter,
            ).length === 0 && (
              <p style={{ color: 'var(--muted)', fontSize: 13, gridColumn: '1/-1' }}>
                No categories yet. Click &ldquo;Add {activeTab === 'lower' ? 'lower' : 'shoe'}{' '}
                category&rdquo; to create one.
              </p>
            )}
            {catalogCategories
              .filter((c) => genderFilter === 'all' || c.genderSlug === genderFilter)
              .map((cat) => (
                <div
                  key={cat.id}
                  className="card"
                  style={{ padding: 14, cursor: 'pointer', opacity: cat.isActive ? 1 : 0.55 }}
                  onClick={() => {
                    setLowerCatView({ kind: 'category', cat });
                    setSelectedCatalogItemIds([]);
                    setCatalogItems([]);
                    void loadCatalog(undefined, cat.id);
                  }}
                >
                  {cat.thumbnailUrl ? (
                    // biome-ignore lint/performance/noImgElement: admin panel
                    <img
                      src={cat.thumbnailUrl}
                      alt={cat.label}
                      loading="lazy"
                      style={{
                        width: '100%',
                        aspectRatio: '3 / 4',
                        objectFit: 'cover',
                        borderRadius: 6,
                        display: 'block',
                        marginBottom: 10,
                      }}
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: '100%',
                        aspectRatio: '3 / 4',
                        borderRadius: 6,
                        background: 'var(--subtle)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginBottom: 10,
                      }}
                    >
                      <Icon.Image />
                    </div>
                  )}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'start',
                    }}
                  >
                    <span className="semi" style={{ fontSize: 14 }}>
                      {cat.label}
                    </span>
                    <span className="badge dot">{cat.genderSlug ?? 'all'}</span>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 10px' }}>
                    slug: {cat.slug}
                  </p>
                  <div
                    style={{ display: 'flex', gap: 6, alignItems: 'center' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Switch
                      checked={cat.isActive}
                      onChange={async () => {
                        const next = !cat.isActive;
                        setCatalogCategories((prev) =>
                          prev.map((c) => (c.id === cat.id ? { ...c, isActive: next } : c)),
                        );
                        try {
                          await apiFetch(`/admin/catalog/categories/${cat.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ isActive: next }),
                          });
                        } catch (e) {
                          setCatalogCategories((prev) =>
                            prev.map((c) =>
                              c.id === cat.id ? { ...c, isActive: cat.isActive } : c,
                            ),
                          );
                          toast({
                            kind: 'error',
                            title: 'Failed to update',
                            body: apiErrorMessage(e, 'Please try again.'),
                          });
                        }
                      }}
                    />
                    <button
                      className="btn sm ghost"
                      style={{ marginLeft: 'auto' }}
                      onClick={() => {
                        setEditingCategory(cat);
                        setEditCatLabel(cat.label);
                      }}
                    >
                      <Icon.Edit />
                    </button>
                    <button className="btn sm ghost" onClick={() => setConfirmDeleteCategory(cat)}>
                      <Icon.Trash />
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </>
      )}

      {/* ── Items inside category ── */}
      {!loading && lowerCatView.kind === 'category' && (
        <>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              marginBottom: 10,
              flexWrap: 'wrap',
            }}
          >
            <button
              className="btn sm ghost"
              onClick={() => {
                setLowerCatView({ kind: 'list' });
                setSelectedCatalogItemIds([]);
                setCatalogItems([]);
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <Icon.Back />
            </button>
            <div style={{ width: 1, height: 16, background: 'var(--border)', marginRight: 2 }} />
            <button
              className="btn sm ghost"
              onClick={() => {
                const allIds = catalogItems.map((c) => c.id);
                const allSel = allIds.every((id) => selectedCatalogItemIds.includes(id));
                setSelectedCatalogItemIds(allSel ? [] : allIds);
              }}
            >
              {catalogItems.length > 0 &&
              catalogItems.every((c) => selectedCatalogItemIds.includes(c.id))
                ? 'Deselect all'
                : 'Select all'}
            </button>
            {selectedCatalogItemIds.length > 0 && (
              <>
                <button
                  className="btn sm"
                  onClick={() => {
                    setBulkMapCatalogSubcatIds(new Set());
                    setShowBulkMapCatalog(true);
                  }}
                >
                  Map to garment types ({selectedCatalogItemIds.length})
                </button>
                <button
                  className="btn sm ghost"
                  disabled={bulkUnmappingCatalog}
                  onClick={() => setConfirmUnmapCatalogIds([...selectedCatalogItemIds])}
                >
                  Unmap from all
                </button>
                <button
                  className="btn sm danger"
                  onClick={() => setConfirmBulkDeleteCatalogIds([...selectedCatalogItemIds])}
                >
                  <Icon.Trash /> Delete ({selectedCatalogItemIds.length})
                </button>
              </>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>
              {catalogItems.length} item{catalogItems.length !== 1 ? 's' : ''}
            </span>
          </div>

          {catalogItems.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>
              No items yet. Click &ldquo;Batch upload&rdquo; to add images.
            </p>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                gap: 10,
              }}
            >
              {catalogItems.map((c) => (
                <div
                  key={c.id}
                  className="card"
                  style={{
                    padding: 10,
                    opacity: c.isActive ? 1 : 0.55,
                    outline: selectedCatalogItemIds.includes(c.id)
                      ? '2px solid var(--pink)'
                      : undefined,
                    cursor: 'pointer',
                  }}
                  onClick={() => handleImageClick(c.id)}
                  onDoubleClick={() => handleImageDoubleClick(c.r2Url)}
                >
                  <div style={{ position: 'relative' }}>
                    <AssetThumb
                      thumbnailUrl={c.thumbnailUrl}
                      fullUrl={c.r2Url}
                      label={c.label}
                      w={120}
                      h={120}
                      onPreview={setPreviewUrl}
                    />
                    <input
                      type="checkbox"
                      checked={selectedCatalogItemIds.includes(c.id)}
                      onChange={() => {}}
                      style={{ position: 'absolute', top: 4, left: 4, accentColor: 'var(--pink)' }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <span className="semi" style={{ fontSize: 12, display: 'block' }}>
                      {c.label}
                    </span>
                    <div
                      style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'center' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Switch
                        checked={c.isActive}
                        onChange={async () => {
                          const next = !c.isActive;
                          setCatalogItems((prev) =>
                            prev.map((x) => (x.id === c.id ? { ...x, isActive: next } : x)),
                          );
                          try {
                            await apiFetch(`/admin/catalog/items/${c.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ isActive: next }),
                            });
                          } catch (e) {
                            setCatalogItems((prev) =>
                              prev.map((x) => (x.id === c.id ? { ...x, isActive: c.isActive } : x)),
                            );
                            toast({
                              kind: 'error',
                              title: 'Failed',
                              body: apiErrorMessage(e, 'Please try again.'),
                            });
                          }
                        }}
                      />
                      <button
                        className="btn sm ghost"
                        style={{ marginLeft: 'auto', padding: '2px 4px' }}
                        onClick={() => {
                          setEditingCatalogItem(c);
                          setEditCatalogLabel(c.label);
                          setEditCatalogGender(c.genderSlug ?? 'men');
                          setEditCatalogSubcatIds(c.subcategoryIds ?? []);
                          setCatalogReplaceFile(null);
                          setCatalogReplacePreview(null);
                        }}
                      >
                        <Icon.Edit />
                      </button>
                      <button
                        className="btn sm ghost"
                        style={{ padding: '2px 4px' }}
                        onClick={() => setConfirmDeleteCatalog(c.id)}
                      >
                        <Icon.Trash />
                      </button>
                    </div>
                    {(c.subcategoryIds ?? []).length > 0 && (
                      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
                        {c.subcategoryIds.length} garment type
                        {c.subcategoryIds.length !== 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Modals ── */}

      {confirmDeleteCatalog && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteCatalog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Delete catalog item</h3>
            </div>
            <div className="modal-body">
              <p>
                Delete{' '}
                <strong>
                  {catalogItems.find((c) => c.id === confirmDeleteCatalog)?.label ??
                    confirmDeleteCatalog}
                </strong>
                ? This cannot be undone.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmDeleteCatalog(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  const id = confirmDeleteCatalog;
                  setConfirmDeleteCatalog(null);
                  try {
                    await apiFetch(`/admin/catalog/items/${id}`, { method: 'DELETE' });
                    setCatalogItems((prev) => prev.filter((c) => c.id !== id));
                    toast({ title: 'Item deleted' });
                  } catch (e) {
                    toast({
                      kind: 'error',
                      title: 'Failed to delete item',
                      body: apiErrorMessage(e, 'Please try again.'),
                    });
                  }
                }}
              >
                <Icon.Trash /> Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteCategory && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteCategory(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Delete category</h3>
            </div>
            <div className="modal-body">
              <p>
                Delete category <strong>{confirmDeleteCategory.label}</strong>? Items inside will
                not be deleted but will lose their category association.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmDeleteCategory(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  const cat = confirmDeleteCategory;
                  setConfirmDeleteCategory(null);
                  try {
                    await apiFetch(`/admin/catalog/categories/${cat.id}`, { method: 'DELETE' });
                    setCatalogCategories((prev) => prev.filter((c) => c.id !== cat.id));
                    toast({ title: `${cat.label} deleted` });
                  } catch (e) {
                    toast({
                      kind: 'error',
                      title: e instanceof Error ? e.message : 'Delete failed',
                    });
                  }
                }}
              >
                <Icon.Trash /> Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmUnmapCatalogIds.length > 0 && (
        <div className="modal-overlay" onClick={() => setConfirmUnmapCatalogIds([])}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Unmap from all garment types</h3>
            </div>
            <div className="modal-body">
              <p>
                Remove garment type mappings from <strong>{confirmUnmapCatalogIds.length}</strong>{' '}
                selected item{confirmUnmapCatalogIds.length !== 1 ? 's' : ''}? The items will remain
                in the catalogue but will not be assigned to any garment type.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmUnmapCatalogIds([])}>
                Cancel
              </button>
              <button
                className="btn"
                disabled={bulkUnmappingCatalog}
                onClick={async () => {
                  const ids = confirmUnmapCatalogIds;
                  setConfirmUnmapCatalogIds([]);
                  setBulkUnmappingCatalog(true);
                  try {
                    await apiFetch('/admin/catalog/items/bulk-subcategories', {
                      method: 'PATCH',
                      body: JSON.stringify({ ids, subcategoryIds: [] }),
                    });
                    setCatalogItems((prev) =>
                      prev.map((c) => (ids.includes(c.id) ? { ...c, subcategoryIds: [] } : c)),
                    );
                    toast({
                      title: `Unmapped ${ids.length} item${ids.length !== 1 ? 's' : ''} from all garment types`,
                    });
                  } catch (e) {
                    toast({
                      kind: 'error',
                      title: 'Unmap failed',
                      body: apiErrorMessage(e, 'Please try again.'),
                    });
                  } finally {
                    setBulkUnmappingCatalog(false);
                  }
                }}
              >
                Unmap {confirmUnmapCatalogIds.length}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmBulkDeleteCatalogIds.length > 0 && (
        <div className="modal-overlay" onClick={() => setConfirmBulkDeleteCatalogIds([])}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Delete items</h3>
            </div>
            <div className="modal-body">
              <p>
                Delete <strong>{confirmBulkDeleteCatalogIds.length}</strong> selected item
                {confirmBulkDeleteCatalogIds.length !== 1 ? 's' : ''}? This cannot be undone.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmBulkDeleteCatalogIds([])}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  const ids = confirmBulkDeleteCatalogIds;
                  setConfirmBulkDeleteCatalogIds([]);
                  try {
                    await Promise.all(
                      ids.map((id) => apiFetch(`/admin/catalog/items/${id}`, { method: 'DELETE' })),
                    );
                    setCatalogItems((prev) => prev.filter((c) => !ids.includes(c.id)));
                    setSelectedCatalogItemIds([]);
                    toast({ title: `${ids.length} item${ids.length !== 1 ? 's' : ''} deleted` });
                  } catch (e) {
                    toast({
                      kind: 'error',
                      title: 'Delete failed',
                      body: apiErrorMessage(e, 'Please try again.'),
                    });
                  }
                }}
              >
                <Icon.Trash /> Delete {confirmBulkDeleteCatalogIds.length}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCatalogUpload && (
        <BatchCatalogUploadModal
          typeSlug={typeSlug}
          categoryId={lowerCatView.kind === 'category' ? lowerCatView.cat.id : undefined}
          lockedGenderSlug={
            lowerCatView.kind === 'category'
              ? (lowerCatView.cat.genderSlug ?? undefined)
              : undefined
          }
          defaultGenderSlug={genderFilter === 'all' ? 'men' : genderFilter}
          onDone={(added) => {
            setShowCatalogUpload(false);
            setCatalogItems((prev) => [...prev, ...(added as unknown as CatalogItem[])]);
          }}
          onClose={() => setShowCatalogUpload(false)}
          toast={toast}
        />
      )}

      {/* Add category modal */}
      {showAddCategory && (
        <EditDrawer
          onClose={() => {
            setShowAddCategory(false);
            setCatImageFile(null);
          }}
          title={`Add ${activeTab === 'lower' ? 'lower garment' : 'shoe'} category`}
          width="min(420px, calc(100vw - 40px))"
          saving={catSaving}
          onSave={async () => {
            const typeId = catalogTypeIds[activeTab];
            if (!typeId) {
              toast({ kind: 'error', title: 'Catalog type not found — check DB seeds' });
              return;
            }
            setCatSaving(true);
            try {
              let thumbnailKey: string | undefined;
              if (catImageFile) {
                const presign = await apiFetch<{ uploadUrl: string; thumbnailKey: string }>(
                  '/admin/catalog/categories/presign',
                  { method: 'POST', body: JSON.stringify({ typeSlug: activeTab }) },
                );
                const thumb = await makeThumbnail(catImageFile);
                await fetch(presign.uploadUrl, {
                  method: 'PUT',
                  headers: { 'Content-Type': thumb.type },
                  body: thumb,
                });
                thumbnailKey = presign.thumbnailKey;
              }
              const cat = await apiFetch<CatalogCategory>('/admin/catalog/categories', {
                method: 'POST',
                body: JSON.stringify({
                  typeId,
                  parentId: null,
                  slug: catForm.slug,
                  label: catForm.label,
                  genderSlug: catForm.genderSlug,
                  sortOrder: catForm.sortOrder,
                  ...(thumbnailKey ? { thumbnailKey } : {}),
                }),
              });
              setCatalogCategories((prev) => [...prev, cat]);
              setShowAddCategory(false);
              setCatImageFile(null);
              toast({ title: `Category "${cat.label}" created` });
            } catch (e) {
              toast({
                kind: 'error',
                title: e instanceof Error ? e.message : 'Create failed',
              });
            } finally {
              setCatSaving(false);
            }
          }}
          saveLabel="Create category"
          saveDisabled={catSaving || !catForm.label.trim() || !catForm.slug.trim()}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="field">
              <label>Label</label>
              <input
                className="input"
                value={catForm.label}
                placeholder="e.g. Jeans"
                onChange={(e) => {
                  const label = e.target.value;
                  setCatForm((f) => ({
                    ...f,
                    label,
                    slug: label
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-|-$/g, ''),
                  }));
                }}
              />
            </div>
            <div className="field">
              <label>Slug</label>
              <input
                className="input"
                value={catForm.slug}
                placeholder="e.g. jeans"
                onChange={(e) => setCatForm((f) => ({ ...f, slug: e.target.value }))}
              />
            </div>
            <div className="field">
              <label>Gender</label>
              <select
                className="select"
                value={catForm.genderSlug}
                onChange={(e) =>
                  setCatForm((f) => ({ ...f, genderSlug: e.target.value as GenderSlug }))
                }
              >
                <option value="men">Men</option>
                <option value="women">Women</option>
                <option value="boys">Boys</option>
                <option value="girls">Girls</option>
              </select>
            </div>
            <div className="field">
              <label>Sort order</label>
              <input
                className="input"
                type="number"
                min={0}
                value={catForm.sortOrder}
                onChange={(e) => setCatForm((f) => ({ ...f, sortOrder: Number(e.target.value) }))}
                style={{ width: 100 }}
              />
            </div>
            <div className="field">
              <label>
                Thumbnail image{' '}
                <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span>
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {catImageFile ? (
                  // biome-ignore lint/performance/noImgElement: admin panel
                  <img
                    src={URL.createObjectURL(catImageFile)}
                    alt="preview"
                    style={{
                      width: 48,
                      height: 48,
                      objectFit: 'cover',
                      borderRadius: 6,
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: 6,
                      background: 'var(--subtle)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Icon.Image />
                  </div>
                )}
                <label className="btn sm ghost" style={{ cursor: 'pointer' }}>
                  {catImageFile ? 'Change image' : 'Upload image'}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) setCatImageFile(f);
                    }}
                  />
                </label>
                {catImageFile && (
                  <button className="btn sm ghost" onClick={() => setCatImageFile(null)}>
                    <Icon.Close />
                  </button>
                )}
              </div>
            </div>
          </div>
        </EditDrawer>
      )}

      {/* Edit category modal */}
      {editingCategory && (
        <EditDrawer
          onClose={() => {
            setEditingCategory(null);
            setEditCatImageFile(null);
          }}
          title="Edit category"
          width="min(380px, calc(100vw - 40px))"
          saving={editCatSaving}
          onSave={async () => {
            setEditCatSaving(true);
            try {
              let thumbnailKey: string | null | undefined;
              if (editCatImageFile) {
                const presign = await apiFetch<{ uploadUrl: string; thumbnailKey: string }>(
                  '/admin/catalog/categories/presign',
                  {
                    method: 'POST',
                    body: JSON.stringify({ typeSlug: editingCategory.typeSlug }),
                  },
                );
                const thumb = await makeThumbnail(editCatImageFile);
                await fetch(presign.uploadUrl, {
                  method: 'PUT',
                  headers: { 'Content-Type': thumb.type },
                  body: thumb,
                });
                thumbnailKey = presign.thumbnailKey;
              }
              const patch: Record<string, unknown> = { label: editCatLabel.trim() };
              if (thumbnailKey !== undefined) patch.thumbnailKey = thumbnailKey;
              await apiFetch(`/admin/catalog/categories/${editingCategory.id}`, {
                method: 'PATCH',
                body: JSON.stringify(patch),
              });
              const newThumbUrl =
                thumbnailKey && editCatImageFile
                  ? URL.createObjectURL(editCatImageFile)
                  : editingCategory.thumbnailUrl;
              setCatalogCategories((prev) =>
                prev.map((c) =>
                  c.id === editingCategory.id
                    ? {
                        ...c,
                        label: editCatLabel.trim(),
                        ...(thumbnailKey !== undefined
                          ? { thumbnailKey, thumbnailUrl: newThumbUrl }
                          : {}),
                      }
                    : c,
                ),
              );
              if (lowerCatView.kind === 'category' && lowerCatView.cat.id === editingCategory.id) {
                setLowerCatView({
                  kind: 'category',
                  cat: { ...lowerCatView.cat, label: editCatLabel.trim() },
                });
              }
              setEditingCategory(null);
              setEditCatImageFile(null);
              toast({ title: 'Category updated' });
            } catch (e) {
              toast({
                kind: 'error',
                title: 'Update failed',
                body: apiErrorMessage(e, 'Please try again.'),
              });
            } finally {
              setEditCatSaving(false);
            }
          }}
          saveLabel="Save"
          saveDisabled={editCatSaving || !editCatLabel.trim()}
        >
          <div className="field">
            <label>Label</label>
            <input
              className="input"
              value={editCatLabel}
              onChange={(e) => setEditCatLabel(e.target.value)}
              disabled={editCatSaving}
            />
          </div>
          <div className="field">
            <label>
              Thumbnail image{' '}
              <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {editCatImageFile ? (
                // biome-ignore lint/performance/noImgElement: admin panel
                <img
                  src={URL.createObjectURL(editCatImageFile)}
                  alt="preview"
                  style={{
                    width: 48,
                    height: 48,
                    objectFit: 'cover',
                    borderRadius: 6,
                    flexShrink: 0,
                  }}
                />
              ) : editingCategory.thumbnailUrl ? (
                // biome-ignore lint/performance/noImgElement: admin panel
                <img
                  src={editingCategory.thumbnailUrl}
                  alt="current"
                  style={{
                    width: 48,
                    height: 48,
                    objectFit: 'cover',
                    borderRadius: 6,
                    flexShrink: 0,
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 6,
                    background: 'var(--subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Icon.Image />
                </div>
              )}
              <label className="btn sm ghost" style={{ cursor: 'pointer' }}>
                {editCatImageFile || editingCategory.thumbnailUrl ? 'Change image' : 'Upload image'}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setEditCatImageFile(f);
                  }}
                />
              </label>
              {(editCatImageFile || editingCategory.thumbnailUrl) && (
                <button className="btn sm ghost" onClick={() => setEditCatImageFile(null)}>
                  <Icon.Close />
                </button>
              )}
            </div>
          </div>
        </EditDrawer>
      )}

      {/* Edit catalog item modal */}
      {editingCatalogItem && (
        <EditDrawer
          onClose={() => setEditingCatalogItem(null)}
          title="Edit catalog item"
          width="min(440px, calc(100vw - 40px))"
          thumbnail={{ thumbnailUrl: editingCatalogItem.thumbnailUrl }}
          saving={editCatalogSaving}
          onSave={async () => {
            setEditCatalogSaving(true);
            try {
              await apiFetch(`/admin/catalog/items/${editingCatalogItem.id}`, {
                method: 'PATCH',
                body: JSON.stringify({
                  label: editCatalogLabel.trim() || editingCatalogItem.label,
                  genderSlug: editCatalogGender,
                  subcategoryIds: editCatalogSubcatIds,
                }),
              });
              setCatalogItems((prev) =>
                prev.map((x) =>
                  x.id === editingCatalogItem.id
                    ? {
                        ...x,
                        label: editCatalogLabel.trim() || x.label,
                        genderSlug: editCatalogGender,
                        subcategoryIds: editCatalogSubcatIds,
                      }
                    : x,
                ),
              );
              toast({ title: `${editingCatalogItem.label} updated` });
              setEditingCatalogItem(null);
            } catch (e) {
              toast({
                kind: 'error',
                title: 'Failed to update item',
                body: apiErrorMessage(e, 'Please try again.'),
              });
            } finally {
              setEditCatalogSaving(false);
            }
          }}
          saveLabel="Save"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="field">
              <label>Label</label>
              <input
                className="input"
                value={editCatalogLabel}
                disabled={editCatalogSaving}
                onChange={(e) => setEditCatalogLabel(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Gender</label>
              <select
                className="select"
                value={editCatalogGender}
                disabled={editCatalogSaving}
                onChange={(e) => setEditCatalogGender(e.target.value)}
              >
                <option value="men">Men</option>
                <option value="women">Women</option>
                <option value="boys">Boys</option>
                <option value="girls">Girls</option>
              </select>
            </div>
            {(() => {
              const matchingSubs = garmentTypes.filter((g) => g.genderSlug === editCatalogGender);
              return (
                <div className="field">
                  <label>
                    Garment types this item applies to
                    <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>
                      ({editCatalogSubcatIds.length} selected)
                    </span>
                  </label>
                  {matchingSubs.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      No garment types for {editCatalogGender}.
                    </div>
                  ) : (
                    <div
                      style={{
                        padding: '8px 12px',
                        background: 'var(--subtle)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        maxHeight: 160,
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                      }}
                    >
                      {matchingSubs.map((gt) => (
                        <label
                          key={gt.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '4px 0',
                            cursor: editCatalogSaving ? 'default' : 'pointer',
                            fontSize: 12.5,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={editCatalogSubcatIds.includes(gt.id)}
                            disabled={editCatalogSaving}
                            onChange={(e) =>
                              setEditCatalogSubcatIds((prev) =>
                                e.target.checked
                                  ? [...prev, gt.id]
                                  : prev.filter((id) => id !== gt.id),
                              )
                            }
                          />
                          <span>{gt.label}</span>
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{gt.slug}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
            <div className="field">
              <label>Replace image</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {(catalogReplacePreview ?? editingCatalogItem.thumbnailUrl) && (
                  // biome-ignore lint/performance/noImgElement: admin panel
                  <img
                    src={catalogReplacePreview ?? (editingCatalogItem.thumbnailUrl as string)}
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input
                    ref={catalogReplaceRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setCatalogReplaceFile(file);
                      setCatalogReplacePreview(URL.createObjectURL(file));
                    }}
                  />
                  <button
                    type="button"
                    className="btn sm ghost"
                    disabled={editCatalogSaving || catalogReplaceUploading}
                    onClick={() => catalogReplaceRef.current?.click()}
                  >
                    <Icon.Image /> {catalogReplaceFile ? catalogReplaceFile.name : 'Pick new image'}
                  </button>
                  {catalogReplaceFile && (
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={catalogReplaceUploading}
                      onClick={async () => {
                        if (!editingCatalogItem || !catalogReplaceFile) return;
                        setCatalogReplaceUploading(true);
                        try {
                          const presign = await apiFetch<{
                            uploadUrl: string;
                            r2Key: string;
                            thumbnailUploadUrl: string;
                            thumbnailKey: string;
                          }>('/admin/catalog/items/presign', {
                            method: 'POST',
                            body: JSON.stringify({
                              typeSlug: editingCatalogItem.type,
                              contentType: catalogReplaceFile.type,
                            }),
                          });
                          const catThumb = await makeThumbnail(catalogReplaceFile);
                          await Promise.all([
                            new Promise<void>((res, rej) => {
                              const xhr = new XMLHttpRequest();
                              xhr.open('PUT', presign.uploadUrl);
                              xhr.setRequestHeader('Content-Type', catalogReplaceFile.type);
                              xhr.onload = () =>
                                xhr.status < 300
                                  ? res()
                                  : rej(new Error(uploadErrorMessage(xhr.status)));
                              xhr.onerror = () => rej(new Error(UPLOAD_NETWORK_ERROR));
                              xhr.send(catalogReplaceFile);
                            }),
                            new Promise<void>((res, rej) => {
                              const xhr = new XMLHttpRequest();
                              xhr.open('PUT', presign.thumbnailUploadUrl);
                              xhr.setRequestHeader('Content-Type', catThumb.type);
                              xhr.onload = () =>
                                xhr.status < 300
                                  ? res()
                                  : rej(new Error(uploadErrorMessage(xhr.status)));
                              xhr.onerror = () => rej(new Error(UPLOAD_NETWORK_ERROR));
                              xhr.send(catThumb);
                            }),
                          ]);
                          await apiFetch(`/admin/catalog/items/${editingCatalogItem.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({
                              r2Key: presign.r2Key,
                              thumbnailKey: presign.thumbnailKey,
                              isActive: true,
                            }),
                          });
                          setCatalogItems((prev) =>
                            prev.map((x) =>
                              x.id === editingCatalogItem.id
                                ? {
                                    ...x,
                                    r2Key: presign.r2Key,
                                    thumbnailKey: presign.thumbnailKey,
                                    isActive: true,
                                  }
                                : x,
                            ),
                          );
                          setEditingCatalogItem((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  r2Key: presign.r2Key,
                                  thumbnailKey: presign.thumbnailKey,
                                  isActive: true,
                                }
                              : prev,
                          );
                          setCatalogReplaceFile(null);
                          setCatalogReplacePreview(null);
                          toast({ title: 'Image replaced' });
                        } catch (e) {
                          toast({
                            kind: 'error',
                            title: 'Image replace failed',
                            body: apiErrorMessage(e, 'Please try again.'),
                          });
                        } finally {
                          setCatalogReplaceUploading(false);
                        }
                      }}
                    >
                      {catalogReplaceUploading ? 'Uploading…' : 'Upload & replace'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </EditDrawer>
      )}

      {/* Bulk map catalog items to garment types */}
      {showBulkMapCatalog && lowerCatView.kind === 'category' && (
        <div
          className="modal-overlay"
          onClick={bulkMappingCatalog ? undefined : () => setShowBulkMapCatalog(false)}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(480px, calc(100vw - 40px))' }}
          >
            <div className="modal-head">
              <h3>
                Map {selectedCatalogItemIds.length} item
                {selectedCatalogItemIds.length !== 1 ? 's' : ''} to garment types
              </h3>
              <button
                className="btn sm ghost"
                onClick={() => setShowBulkMapCatalog(false)}
                disabled={bulkMappingCatalog}
                style={{ marginLeft: 'auto' }}
              >
                <Icon.Close />
              </button>
            </div>
            <div
              className="modal-body"
              style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
            >
              <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
                Replaces existing mappings on all selected items.
              </p>
              <div
                style={{
                  padding: '8px 12px',
                  background: 'var(--subtle)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  maxHeight: 240,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                {garmentTypes
                  .filter(
                    (g) =>
                      !lowerCatView.cat.genderSlug || g.genderSlug === lowerCatView.cat.genderSlug,
                  )
                  .map((gt) => (
                    <label
                      key={gt.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 0',
                        cursor: bulkMappingCatalog ? 'default' : 'pointer',
                        fontSize: 12.5,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={bulkMapCatalogSubcatIds.has(gt.id)}
                        disabled={bulkMappingCatalog}
                        onChange={(e) =>
                          setBulkMapCatalogSubcatIds((prev) => {
                            const next = new Set(prev);
                            e.target.checked ? next.add(gt.id) : next.delete(gt.id);
                            return next;
                          })
                        }
                      />
                      <span>{gt.label}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{gt.slug}</span>
                    </label>
                  ))}
                {garmentTypes.filter(
                  (g) =>
                    !lowerCatView.cat.genderSlug || g.genderSlug === lowerCatView.cat.genderSlug,
                ).length === 0 && (
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                    No garment types for {lowerCatView.cat.genderSlug ?? 'this gender'} yet.
                  </p>
                )}
              </div>
            </div>
            <div className="modal-foot">
              <button
                className="btn ghost"
                onClick={() => setShowBulkMapCatalog(false)}
                disabled={bulkMappingCatalog}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={bulkMappingCatalog}
                onClick={async () => {
                  setBulkMappingCatalog(true);
                  try {
                    const subcategoryIds = [...bulkMapCatalogSubcatIds];
                    await apiFetch('/admin/catalog/items/bulk-subcategories', {
                      method: 'PATCH',
                      body: JSON.stringify({ ids: selectedCatalogItemIds, subcategoryIds }),
                    });
                    setCatalogItems((prev) =>
                      prev.map((c) =>
                        selectedCatalogItemIds.includes(c.id) ? { ...c, subcategoryIds } : c,
                      ),
                    );
                    setShowBulkMapCatalog(false);
                    toast({
                      title: `Mapped ${selectedCatalogItemIds.length} items to ${subcategoryIds.length} garment type${subcategoryIds.length !== 1 ? 's' : ''}`,
                    });
                  } catch (e) {
                    toast({
                      kind: 'error',
                      title: 'Mapping failed',
                      body: apiErrorMessage(e, 'Please try again.'),
                    });
                  } finally {
                    setBulkMappingCatalog(false);
                  }
                }}
              >
                Apply to {selectedCatalogItemIds.length}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
