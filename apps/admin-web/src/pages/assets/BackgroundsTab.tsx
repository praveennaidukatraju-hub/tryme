import { useCallback, useEffect, useRef, useState } from 'react';
import { AssetThumb } from '../../components/AssetThumb';
import { BackgroundUploadModal } from '../../components/BackgroundUploadModal';
import { EditBackgroundModal } from '../../components/EditBackgroundModal';
import { EditDrawer } from '../../components/EditDrawer';
import { Icon } from '../../components/Icons';
import { SearchableSelect } from '../../components/SearchableSelect';
import { Switch } from '../../components/Switch';
import { apiErrorMessage, apiFetch } from '../../lib/data';
import { makeThumbnail } from '../../lib/thumbnail';
import type { CatalogCategory, CategoryTag, GenderSlug, ModelBackground } from '../../types';
import { useAssetsContext } from './AssetsContext';

const SPECIAL_TAG_OPTIONS: { value: CategoryTag; label: string }[] = [
  { value: 'featured', label: 'Featured' },
  { value: 'trending', label: 'Trending' },
  { value: 'popular', label: 'Popular' },
];

const GENDER_TABS = [
  { k: 'all' as const, l: 'All' },
  { k: 'men' as const, l: 'Men' },
  { k: 'women' as const, l: 'Women' },
  { k: 'boys' as const, l: 'Boys' },
  { k: 'girls' as const, l: 'Girls' },
];

type BgView =
  | { kind: 'list' }
  | { kind: 'category'; cat: CatalogCategory }
  | { kind: 'uncategorized' };

export function BackgroundsTab() {
  const {
    genderFilter,
    setGenderFilter,
    setAllBackgrounds,
    loading,
    setLoading,
    setPreviewUrl,
    toast,
  } = useAssetsContext();

  const singleClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleImageClick(id: string) {
    if (singleClickTimerRef.current) {
      clearTimeout(singleClickTimerRef.current);
      singleClickTimerRef.current = null;
      return;
    }
    singleClickTimerRef.current = setTimeout(() => {
      singleClickTimerRef.current = null;
      setSelectedBgIds((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );
    }, 250);
  }

  function handleImageDoubleClick(r2Url: string | null) {
    if (r2Url) setPreviewUrl(r2Url);
  }

  const [bgView, setBgView] = useState<BgView>({ kind: 'list' });
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [backgroundTypeId, setBackgroundTypeId] = useState<number | null>(null);
  const [uncategorizedCount, setUncategorizedCount] = useState(0);

  const [backgrounds, setBackgrounds] = useState<ModelBackground[]>([]);
  const [selectedBgIds, setSelectedBgIds] = useState<string[]>([]);
  const [confirmBulkDeleteBgIds, setConfirmBulkDeleteBgIds] = useState<string[]>([]);
  const [deleteBgConfirmText, setDeleteBgConfirmText] = useState('');
  const [showBgUpload, setShowBgUpload] = useState(false);
  const [editingBackground, setEditingBackground] = useState<ModelBackground | null>(null);
  const [confirmDeleteBg, setConfirmDeleteBg] = useState<ModelBackground | null>(null);
  const [showBulkCategory, setShowBulkCategory] = useState(false);
  const [bulkCategoryId, setBulkCategoryId] = useState<number | null>(null);
  const [bulkCategorySaving, setBulkCategorySaving] = useState(false);
  const [showBulkGender, setShowBulkGender] = useState(false);
  const [bulkGenderSlug, setBulkGenderSlug] = useState<GenderSlug | ''>('');
  const [bulkGenderSaving, setBulkGenderSaving] = useState(false);

  // Category modals
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [catForm, setCatForm] = useState<{
    label: string;
    slug: string;
    genderSlug: GenderSlug | '';
    sortOrder: number;
  }>({ label: '', slug: '', genderSlug: '', sortOrder: 0 });
  const [catImageFile, setCatImageFile] = useState<File | null>(null);
  const [catSaving, setCatSaving] = useState(false);
  const [editingCategory, setEditingCategory] = useState<CatalogCategory | null>(null);
  const [editCatLabel, setEditCatLabel] = useState('');
  const [editCatImageFile, setEditCatImageFile] = useState<File | null>(null);
  const [editCatSaving, setEditCatSaving] = useState(false);
  const [confirmDeleteCategory, setConfirmDeleteCategory] = useState<CatalogCategory | null>(null);

  const loadCategoriesAndType = useCallback(async () => {
    try {
      const [cats, types] = await Promise.all([
        apiFetch<CatalogCategory[]>('/admin/catalog/categories'),
        apiFetch<{ id: number; slug: string; label: string }[]>('/admin/catalog/types'),
      ]);
      setCategories(cats.filter((c) => c.typeSlug === 'background'));
      setBackgroundTypeId(types.find((t) => t.slug === 'background')?.id ?? null);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to load background categories',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  }, [toast]);

  // Full unfiltered-by-category list, kept in shared context for other tabs (badges, filters).
  const loadAllBackgrounds = useCallback(
    async (genderSlug?: string) => {
      try {
        const qs = genderSlug ? `?genderSlug=${genderSlug}` : '';
        const res = await apiFetch<{ items: ModelBackground[] }>(`/admin/assets/backgrounds${qs}`);
        if (!genderSlug) setAllBackgrounds(res.items);
      } catch {
        // non-fatal — only affects cross-tab badges
      }
    },
    [setAllBackgrounds],
  );

  const loadUncategorizedCount = useCallback(async (genderSlug?: string) => {
    try {
      const params = new URLSearchParams({ uncategorized: 'true' });
      if (genderSlug) params.set('genderSlug', genderSlug);
      const res = await apiFetch<{ items: ModelBackground[] }>(
        `/admin/assets/backgrounds?${params.toString()}`,
      );
      setUncategorizedCount(res.items.length);
    } catch {
      // non-fatal
    }
  }, []);

  const loadViewBackgrounds = useCallback(
    async (genderSlug?: string, categoryId?: number, uncategorized?: boolean) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (genderSlug) params.set('genderSlug', genderSlug);
        if (categoryId !== undefined) params.set('categoryId', String(categoryId));
        if (uncategorized) params.set('uncategorized', 'true');
        const qs = params.toString() ? `?${params.toString()}` : '';
        const res = await apiFetch<{ items: ModelBackground[] }>(`/admin/assets/backgrounds${qs}`);
        setBackgrounds(res.items);
      } catch (e) {
        toast({
          kind: 'error',
          title: 'Failed to load backgrounds',
          body: apiErrorMessage(e, 'Please try again.'),
        });
      } finally {
        setLoading(false);
      }
    },
    [toast, setLoading],
  );

  useEffect(() => {
    setBgView({ kind: 'list' });
    setSelectedBgIds([]);
    void loadCategoriesAndType();
  }, [loadCategoriesAndType]);

  useEffect(() => {
    const g = genderFilter === 'all' ? undefined : genderFilter;
    void loadAllBackgrounds(g);
    void loadUncategorizedCount(g);
    if (bgView.kind === 'category') void loadViewBackgrounds(g, bgView.cat.id);
    else if (bgView.kind === 'uncategorized') void loadViewBackgrounds(g, undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genderFilter, bgView, loadAllBackgrounds, loadUncategorizedCount, loadViewBackgrounds]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadCategoriesAndType();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadCategoriesAndType]);

  const toggleBg = async (id: string) => {
    const item = backgrounds.find((b) => b.id === id);
    if (!item) return;
    const next = !item.isActive;
    setBackgrounds((prev) => prev.map((b) => (b.id === id ? { ...b, isActive: next } : b)));
    try {
      await apiFetch(`/admin/assets/backgrounds/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: next }),
      });
      toast({ title: `${item.label} ${item.isActive ? 'deactivated' : 'activated'}` });
    } catch (e) {
      setBackgrounds((prev) =>
        prev.map((b) => (b.id === id ? { ...b, isActive: item.isActive } : b)),
      );
      toast({
        kind: 'error',
        title: 'Failed to update background',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  };

  const setAmazonWhiteBg = async (id: string) => {
    const prev = backgrounds.find((b) => b.isWhiteBg);
    setBackgrounds((prevBg) => prevBg.map((b) => ({ ...b, isWhiteBg: b.id === id })));
    try {
      await apiFetch(`/admin/assets/backgrounds/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isWhiteBg: true }),
      });
      const item = backgrounds.find((b) => b.id === id);
      toast({ title: `${item?.label ?? 'Background'} set as Amazon white background` });
    } catch (e) {
      setBackgrounds((prevBg) =>
        prevBg.map((b) => ({ ...b, isWhiteBg: prev != null && prev.id === b.id })),
      );
      toast({
        kind: 'error',
        title: 'Failed to set Amazon white background',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  };

  const doBulkDeleteBackgrounds = async () => {
    if (deleteBgConfirmText !== 'move to recycle bin') return;
    const ids = confirmBulkDeleteBgIds;
    setConfirmBulkDeleteBgIds([]);
    setDeleteBgConfirmText('');
    if (ids.length === 0) return;
    try {
      const res = await apiFetch<{ deleted: number }>('/admin/assets/backgrounds', {
        method: 'DELETE',
        body: JSON.stringify({ ids }),
      });
      setBackgrounds((prev) => prev.filter((b) => !ids.includes(b.id)));
      setSelectedBgIds((prev) => prev.filter((id) => !ids.includes(id)));
      toast({
        title: `${res.deleted} background${res.deleted !== 1 ? 's' : ''} moved to recycle bin`,
      });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Bulk delete failed',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  };

  const applyBulkCategory = async () => {
    const ids = [...selectedBgIds];
    setBulkCategorySaving(true);
    try {
      await apiFetch('/admin/assets/backgrounds/bulk', {
        method: 'PATCH',
        body: JSON.stringify({ ids, categoryId: bulkCategoryId }),
      });
      setBackgrounds((prev) =>
        prev
          .map((b) => (ids.includes(b.id) ? { ...b, categoryId: bulkCategoryId } : b))
          .filter((b) => {
            if (bgView.kind === 'category') return b.categoryId === bgView.cat.id;
            if (bgView.kind === 'uncategorized') return b.categoryId === null;
            return true;
          }),
      );
      setAllBackgrounds((prev) =>
        prev.map((b) => (ids.includes(b.id) ? { ...b, categoryId: bulkCategoryId } : b)),
      );
      setSelectedBgIds([]);
      setShowBulkCategory(false);
      toast({ title: `${ids.length} background${ids.length !== 1 ? 's' : ''} moved` });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Bulk category change failed',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setBulkCategorySaving(false);
    }
  };

  const applyBulkGender = async () => {
    const ids = [...selectedBgIds];
    const genderSlug = bulkGenderSlug || null;
    setBulkGenderSaving(true);
    try {
      await apiFetch('/admin/assets/backgrounds/bulk', {
        method: 'PATCH',
        body: JSON.stringify({ ids, genderSlug }),
      });
      setBackgrounds((prev) => prev.map((b) => (ids.includes(b.id) ? { ...b, genderSlug } : b)));
      setAllBackgrounds((prev) => prev.map((b) => (ids.includes(b.id) ? { ...b, genderSlug } : b)));
      setSelectedBgIds([]);
      setShowBulkGender(false);
      toast({ title: `${ids.length} background${ids.length !== 1 ? 's' : ''} updated` });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Bulk gender change failed',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setBulkGenderSaving(false);
    }
  };

  const viewTitle =
    bgView.kind === 'category'
      ? bgView.cat.label
      : bgView.kind === 'uncategorized'
        ? 'Uncategorized'
        : 'Backgrounds';

  return (
    <>
      <div className="page-head">
        <div>
          {bgView.kind !== 'list' && (
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
                  setBgView({ kind: 'list' });
                  setSelectedBgIds([]);
                  setBackgrounds([]);
                }}
                style={{ padding: '2px 8px', fontSize: 13 }}
              >
                Backgrounds
              </button>
              <Icon.Chevron />
              <span>{viewTitle}</span>
            </div>
          )}
          <h1>{viewTitle}</h1>
          <p className="lede">
            {bgView.kind === 'list'
              ? 'Categories of backgrounds. Click to manage images inside each category.'
              : 'Global backgrounds sent to ComfyUI for all garment types.'}
          </p>
        </div>
        <div className="head-tools">
          {bgView.kind === 'list' && (
            <button
              className="btn"
              onClick={() => {
                setCatForm({ label: '', slug: '', genderSlug: '', sortOrder: 0 });
                setShowAddCategory(true);
              }}
            >
              <Icon.Add /> Add category
            </button>
          )}
          {bgView.kind !== 'list' && (
            <button className="btn" onClick={() => setShowBgUpload(true)}>
              <Icon.Add /> Add background
            </button>
          )}
        </div>
      </div>

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

      {/* ── Category list ── */}
      {bgView.kind === 'list' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 14,
            marginTop: 8,
          }}
        >
          {categories
            .filter((c) => genderFilter === 'all' || c.genderSlug === genderFilter)
            .map((cat) => (
              <div
                key={cat.id}
                className="card"
                style={{ padding: 14, cursor: 'pointer', opacity: cat.isActive ? 1 : 0.55 }}
                onClick={() => {
                  setBgView({ kind: 'category', cat });
                  setSelectedBgIds([]);
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
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}
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
                      setCategories((prev) =>
                        prev.map((c) => (c.id === cat.id ? { ...c, isActive: next } : c)),
                      );
                      try {
                        await apiFetch(`/admin/catalog/categories/${cat.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ isActive: next }),
                        });
                      } catch (e) {
                        setCategories((prev) =>
                          prev.map((c) => (c.id === cat.id ? { ...c, isActive: cat.isActive } : c)),
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

          {/* Pinned pseudo-category for pre-existing / unassigned backgrounds */}
          <div
            className="card"
            style={{ padding: 14, cursor: 'pointer' }}
            onClick={() => {
              setBgView({ kind: 'uncategorized' });
              setSelectedBgIds([]);
            }}
          >
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
              <span className="semi" style={{ fontSize: 14 }}>
                Uncategorized
              </span>
              <span className="badge dot">{uncategorizedCount}</span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 10px' }}>
              Backgrounds not yet assigned to a category
            </p>
          </div>

          {categories.filter((c) => genderFilter === 'all' || c.genderSlug === genderFilter)
            .length === 0 && (
            <p style={{ color: 'var(--muted)', fontSize: 13, gridColumn: '1/-1' }}>
              No categories yet besides &ldquo;Uncategorized&rdquo;. Click &ldquo;Add
              category&rdquo; to create one.
            </p>
          )}
        </div>
      )}

      {/* ── Items inside category / uncategorized ── */}
      {bgView.kind !== 'list' && !loading && (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 4,
              marginBottom: 8,
              flexWrap: 'wrap',
            }}
          >
            <button
              className="btn sm ghost"
              onClick={() => {
                setBgView({ kind: 'list' });
                setSelectedBgIds([]);
                setBackgrounds([]);
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <Icon.Back />
            </button>
            <div style={{ width: 1, height: 16, background: 'var(--border)', marginRight: 2 }} />
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
              {backgrounds.length} background{backgrounds.length !== 1 ? 's' : ''}
            </p>
            {backgrounds.length > 0 && (
              <button
                className="btn sm ghost"
                style={{ marginLeft: 'auto' }}
                onClick={() => {
                  const allSelected = backgrounds.every((b) => selectedBgIds.includes(b.id));
                  setSelectedBgIds(allSelected ? [] : backgrounds.map((b) => b.id));
                }}
              >
                {backgrounds.every((b) => selectedBgIds.includes(b.id))
                  ? 'Deselect all'
                  : 'Select all'}
              </button>
            )}
            {selectedBgIds.length > 0 && (
              <>
                <button
                  className="btn sm"
                  onClick={() => {
                    setBulkCategoryId(null);
                    setShowBulkCategory(true);
                  }}
                >
                  Change category ({selectedBgIds.length})
                </button>
                <button
                  className="btn sm"
                  onClick={() => {
                    setBulkGenderSlug('');
                    setShowBulkGender(true);
                  }}
                >
                  Change gender ({selectedBgIds.length})
                </button>
                <button
                  className="btn sm danger"
                  onClick={() => setConfirmBulkDeleteBgIds([...selectedBgIds])}
                >
                  <Icon.Trash /> Move to recycle bin ({selectedBgIds.length})
                </button>
              </>
            )}
          </div>
          {backgrounds.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>No backgrounds yet.</p>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                gap: 12,
              }}
            >
              {backgrounds.map((bg) => (
                <div
                  key={bg.id}
                  className="card"
                  style={{
                    padding: 10,
                    opacity: bg.isActive ? 1 : 0.55,
                    outline: selectedBgIds.includes(bg.id) ? '2px solid var(--pink)' : undefined,
                    cursor: 'pointer',
                  }}
                  onClick={() => handleImageClick(bg.id)}
                  onDoubleClick={() => handleImageDoubleClick(bg.r2Url)}
                >
                  <div style={{ position: 'relative' }}>
                    <AssetThumb
                      thumbnailUrl={bg.thumbnailUrl}
                      fullUrl={bg.r2Url}
                      label={bg.label}
                      w={130}
                      h={130}
                      onPreview={setPreviewUrl}
                    />
                    <input
                      type="checkbox"
                      checked={selectedBgIds.includes(bg.id)}
                      onChange={() => {}}
                      style={{ position: 'absolute', top: 4, left: 4, accentColor: 'var(--pink)' }}
                      onClick={(e) => e.stopPropagation()}
                    />
                    {bg.isWhiteBg && (
                      <span
                        className="badge"
                        style={{
                          position: 'absolute',
                          top: 4,
                          right: 4,
                          background: 'var(--success)',
                          color: '#fff',
                        }}
                      >
                        &#9733; White BG
                      </span>
                    )}
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <span className="semi" style={{ fontSize: 12, display: 'block' }}>
                      {bg.label}
                    </span>
                    <span className="badge dot" style={{ marginTop: 4, display: 'inline-block' }}>
                      {bg.genderSlug ?? 'all'}
                    </span>
                    {bg.specialTag && (
                      <span
                        className="badge"
                        style={{
                          marginTop: 4,
                          marginLeft: 4,
                          display: 'inline-block',
                          background: 'var(--accent-soft, #f0f7ff)',
                        }}
                      >
                        {SPECIAL_TAG_OPTIONS.find((t) => t.value === bg.specialTag)?.label ??
                          bg.specialTag}
                      </span>
                    )}
                    <button
                      className={`btn sm ${bg.isWhiteBg ? 'primary' : 'ghost'}`}
                      style={{ width: '100%', marginTop: 6 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setAmazonWhiteBg(bg.id);
                      }}
                      title={
                        bg.isWhiteBg
                          ? 'Amazon white background (selected)'
                          : 'Set as Amazon white background'
                      }
                    >
                      {bg.isWhiteBg ? 'White BG' : 'Set White BG'}
                    </button>
                    <div
                      style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'center' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Switch checked={bg.isActive} onChange={() => toggleBg(bg.id)} />
                      <button
                        className="btn sm ghost"
                        style={{ marginLeft: 'auto', padding: '2px 4px' }}
                        onClick={() => setEditingBackground(bg)}
                      >
                        <Icon.Edit />
                      </button>
                      <button
                        className="btn sm ghost"
                        style={{ padding: '2px 4px' }}
                        onClick={() => setConfirmDeleteBg(bg)}
                      >
                        <Icon.Trash />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Modals ── */}

      {confirmDeleteBg && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteBg(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Move to recycle bin</h3>
            </div>
            <div className="modal-body">
              <p>
                Move <strong>{confirmDeleteBg.label}</strong> to the recycle bin? You can restore it
                later.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmDeleteBg(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  const { id, label } = confirmDeleteBg;
                  setConfirmDeleteBg(null);
                  if (id.startsWith('bg_demo_')) {
                    setBackgrounds((prev) => prev.filter((b) => b.id !== id));
                    setAllBackgrounds((prev) => prev.filter((b) => b.id !== id));
                    toast({ title: `${label} moved to recycle bin` });
                    return;
                  }
                  try {
                    await apiFetch(`/admin/assets/backgrounds/${id}`, { method: 'DELETE' });
                    setBackgrounds((prev) => prev.filter((b) => b.id !== id));
                    setAllBackgrounds((prev) => prev.filter((b) => b.id !== id));
                    toast({ title: `${label} moved to recycle bin` });
                  } catch (err) {
                    toast({
                      kind: 'error',
                      title: 'Background could not be moved to the recycle bin',
                      body: apiErrorMessage(err, 'Please try again.'),
                    });
                  }
                }}
              >
                <Icon.Trash /> Move to recycle bin
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmBulkDeleteBgIds.length > 0 && (
        <div
          className="modal-overlay"
          onClick={() => {
            setConfirmBulkDeleteBgIds([]);
            setDeleteBgConfirmText('');
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>
                Move {confirmBulkDeleteBgIds.length} background
                {confirmBulkDeleteBgIds.length !== 1 ? 's' : ''} to recycle bin
              </h3>
            </div>
            <div className="modal-body">
              <p>
                Move{' '}
                <strong>
                  {confirmBulkDeleteBgIds.length} selected background
                  {confirmBulkDeleteBgIds.length !== 1 ? 's' : ''}
                </strong>{' '}
                to the recycle bin? You can restore them later.
              </p>
              <div className="field" style={{ marginTop: 16 }}>
                <label style={{ fontSize: 13 }}>
                  Type{' '}
                  <strong style={{ fontFamily: 'monospace', color: 'var(--danger)' }}>
                    move to recycle bin
                  </strong>{' '}
                  to confirm
                </label>
                <input
                  className="input"
                  type="text"
                  value={deleteBgConfirmText}
                  onChange={(e) => setDeleteBgConfirmText(e.target.value)}
                  placeholder="move to recycle bin"
                />
              </div>
            </div>
            <div className="modal-foot">
              <button
                className="btn ghost"
                onClick={() => {
                  setConfirmBulkDeleteBgIds([]);
                  setDeleteBgConfirmText('');
                }}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={doBulkDeleteBackgrounds}
                disabled={deleteBgConfirmText !== 'move to recycle bin'}
              >
                <Icon.Trash /> Move to recycle bin ({confirmBulkDeleteBgIds.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {showBulkCategory && (
        <div
          className="modal-overlay"
          onClick={bulkCategorySaving ? undefined : () => setShowBulkCategory(false)}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(380px, calc(100vw - 40px))' }}
          >
            <div className="modal-head">
              <h3>
                Change category for {selectedBgIds.length} background
                {selectedBgIds.length !== 1 ? 's' : ''}
              </h3>
              <button
                className="btn sm ghost"
                onClick={() => setShowBulkCategory(false)}
                disabled={bulkCategorySaving}
                style={{ marginLeft: 'auto' }}
              >
                <Icon.Close />
              </button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>Category</label>
                <SearchableSelect
                  options={categories.map((c) => ({ id: String(c.id), label: c.label }))}
                  value={bulkCategoryId != null ? String(bulkCategoryId) : ''}
                  disabled={bulkCategorySaving}
                  placeholder="— search category —"
                  emptyLabel="Uncategorized"
                  onChange={(id) => setBulkCategoryId(id ? Number(id) : null)}
                />
              </div>
            </div>
            <div className="modal-foot">
              <button
                className="btn ghost"
                onClick={() => setShowBulkCategory(false)}
                disabled={bulkCategorySaving}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={applyBulkCategory}
                disabled={bulkCategorySaving}
              >
                {bulkCategorySaving ? 'Saving…' : `Apply to ${selectedBgIds.length}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {showBulkGender && (
        <div
          className="modal-overlay"
          onClick={bulkGenderSaving ? undefined : () => setShowBulkGender(false)}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(380px, calc(100vw - 40px))' }}
          >
            <div className="modal-head">
              <h3>
                Change gender for {selectedBgIds.length} background
                {selectedBgIds.length !== 1 ? 's' : ''}
              </h3>
              <button
                className="btn sm ghost"
                onClick={() => setShowBulkGender(false)}
                disabled={bulkGenderSaving}
                style={{ marginLeft: 'auto' }}
              >
                <Icon.Close />
              </button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>Gender</label>
                <select
                  className="select"
                  value={bulkGenderSlug}
                  disabled={bulkGenderSaving}
                  onChange={(e) => setBulkGenderSlug(e.target.value as GenderSlug | '')}
                >
                  <option value="">All Gender</option>
                  <option value="men">Men</option>
                  <option value="women">Women</option>
                  <option value="girls">Girls</option>
                  <option value="boys">Boys</option>
                </select>
              </div>
            </div>
            <div className="modal-foot">
              <button
                className="btn ghost"
                onClick={() => setShowBulkGender(false)}
                disabled={bulkGenderSaving}
              >
                Cancel
              </button>
              <button className="btn primary" onClick={applyBulkGender} disabled={bulkGenderSaving}>
                {bulkGenderSaving ? 'Saving…' : `Apply to ${selectedBgIds.length}`}
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
                Delete category <strong>{confirmDeleteCategory.label}</strong>? Backgrounds inside
                will not be deleted but will become uncategorized.
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
                    setCategories((prev) => prev.filter((c) => c.id !== cat.id));
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

      {showBgUpload && (
        <BackgroundUploadModal
          defaultGenderSlug={genderFilter === 'all' ? '' : genderFilter}
          categoryId={bgView.kind === 'category' ? bgView.cat.id : null}
          lockedGenderSlug={bgView.kind === 'category' ? (bgView.cat.genderSlug ?? null) : null}
          onDone={(rows) => {
            setBackgrounds((prev) => [...prev, ...rows]);
            setAllBackgrounds((prev) => [...prev, ...rows]);
          }}
          onClose={() => setShowBgUpload(false)}
          toast={toast}
        />
      )}

      {editingBackground && (
        <EditBackgroundModal
          background={editingBackground}
          categories={categories}
          onSaved={(updated) => {
            setBackgrounds((prev) =>
              prev
                .map((b) => (b.id === updated.id ? updated : b))
                // If moved out of the category/bucket currently being viewed, drop it from view.
                .filter((b) => {
                  if (bgView.kind === 'category') return b.categoryId === bgView.cat.id;
                  if (bgView.kind === 'uncategorized') return b.categoryId === null;
                  return true;
                }),
            );
            setAllBackgrounds((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
            setEditingBackground(null);
          }}
          onClose={() => setEditingBackground(null)}
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
          title="Add background category"
          width="min(420px, calc(100vw - 40px))"
          saving={catSaving}
          saveDisabled={!catForm.label.trim() || !catForm.slug.trim()}
          saveLabel="Create category"
          onSave={async () => {
            if (!backgroundTypeId) {
              toast({ kind: 'error', title: 'Background catalog type not found' });
              return;
            }
            setCatSaving(true);
            try {
              let thumbnailKey: string | undefined;
              if (catImageFile) {
                const presign = await apiFetch<{ uploadUrl: string; thumbnailKey: string }>(
                  '/admin/catalog/categories/presign',
                  { method: 'POST', body: JSON.stringify({ typeSlug: 'background' }) },
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
                  typeId: backgroundTypeId,
                  parentId: null,
                  slug: catForm.slug,
                  label: catForm.label,
                  genderSlug: catForm.genderSlug || undefined,
                  sortOrder: catForm.sortOrder,
                  ...(thumbnailKey ? { thumbnailKey } : {}),
                }),
              });
              setCategories((prev) => [...prev, cat]);
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
        >
          <div className="field">
            <label>Label</label>
            <input
              className="input"
              value={catForm.label}
              placeholder="e.g. Outdoor"
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
              placeholder="e.g. outdoor"
              onChange={(e) => setCatForm((f) => ({ ...f, slug: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Gender</label>
            <select
              className="select"
              value={catForm.genderSlug}
              onChange={(e) =>
                setCatForm((f) => ({ ...f, genderSlug: e.target.value as GenderSlug | '' }))
              }
            >
              <option value="">All Gender</option>
              <option value="men">Men</option>
              <option value="women">Women</option>
              <option value="girls">Girls</option>
              <option value="boys">Boys</option>
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
              Display image{' '}
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
          saveDisabled={!editCatLabel.trim()}
          saveLabel="Save"
          onSave={async () => {
            setEditCatSaving(true);
            try {
              let thumbnailKey: string | null | undefined;
              if (editCatImageFile) {
                const presign = await apiFetch<{ uploadUrl: string; thumbnailKey: string }>(
                  '/admin/catalog/categories/presign',
                  { method: 'POST', body: JSON.stringify({ typeSlug: 'background' }) },
                );
                const thumb = await makeThumbnail(editCatImageFile);
                await fetch(presign.uploadUrl, {
                  method: 'PUT',
                  headers: { 'Content-Type': thumb.type },
                  body: thumb,
                });
                thumbnailKey = presign.thumbnailKey;
              }
              const patch: Record<string, unknown> = {
                label: editCatLabel.trim(),
              };
              if (thumbnailKey !== undefined) patch.thumbnailKey = thumbnailKey;
              await apiFetch(`/admin/catalog/categories/${editingCategory.id}`, {
                method: 'PATCH',
                body: JSON.stringify(patch),
              });
              const newThumbUrl =
                thumbnailKey && editCatImageFile
                  ? URL.createObjectURL(editCatImageFile)
                  : editingCategory.thumbnailUrl;
              setCategories((prev) =>
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
              if (bgView.kind === 'category' && bgView.cat.id === editingCategory.id) {
                setBgView({
                  kind: 'category',
                  cat: { ...bgView.cat, label: editCatLabel.trim() },
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
              Display image{' '}
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
    </>
  );
}
