import { useEffect, useMemo, useRef, useState } from 'react';
import { AddFaceModal } from '../../components/AddFaceModal';
import { AssetThumb } from '../../components/AssetThumb';
import { EditFaceModal } from '../../components/EditFaceModal';
import { Icon } from '../../components/Icons';
import { Pager } from '../../components/Pager';
import { Switch } from '../../components/Switch';
import { CONTINENTS, continentLabel } from '../../lib/continents';
import { apiErrorMessage, apiFetch } from '../../lib/data';
import type { Continent, ModelFace } from '../../types';
import { useAssetsContext } from './AssetsContext';

const GENDER_TABS = [
  { k: 'all' as const, l: 'All' },
  { k: 'men' as const, l: 'Men' },
  { k: 'women' as const, l: 'Women' },
  { k: 'boys' as const, l: 'Boys' },
  { k: 'girls' as const, l: 'Girls' },
];

type ContinentFilter = 'all' | 'unassigned' | Continent;

const FACES_PAGE_SIZE = 75;

export function FacesTab() {
  const {
    genderFilter,
    setGenderFilter,
    faces,
    setFaces,
    loadFaces,
    loading,
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
      setSelectedFaceIds((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );
    }, 250);
  }

  function handleImageDoubleClick(r2Url: string | null) {
    if (r2Url) setPreviewUrl(r2Url);
  }

  const [selectedFaceIds, setSelectedFaceIds] = useState<string[]>([]);
  const [confirmBulkDeleteFaceIds, setConfirmBulkDeleteFaceIds] = useState<string[]>([]);
  const [deleteFaceConfirmText, setDeleteFaceConfirmText] = useState('');
  const [showFaceUpload, setShowFaceUpload] = useState(false);
  const [editingFace, setEditingFace] = useState<ModelFace | null>(null);
  const [confirmDeleteFace, setConfirmDeleteFace] = useState<ModelFace | null>(null);
  const [facesPage, setFacesPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [bulkSortStart, setBulkSortStart] = useState(0);
  const [bulkSortSaving, setBulkSortSaving] = useState(false);
  const [continentFilter, setContinentFilter] = useState<ContinentFilter>('all');
  const [bulkContinent, setBulkContinent] = useState<Continent | ''>('');
  const [bulkContinentSaving, setBulkContinentSaving] = useState(false);

  // Presets plus any continent an admin has already typed in — so custom
  // continents show up as filter tabs / dropdown options everywhere too.
  const knownContinents = useMemo(() => {
    const seen = new Set(CONTINENTS.map((c) => c.value));
    const extra = Array.from(
      new Set(faces.map((f) => f.continent).filter((c): c is string => !!c && !seen.has(c))),
    ).map((value) => ({ value, label: continentLabel(value) }));
    extra.sort((a, b) => a.label.localeCompare(b.label));
    return [...CONTINENTS, ...extra];
  }, [faces]);

  const CONTINENT_TABS = useMemo(
    () => [
      { k: 'all' as ContinentFilter, l: 'All continents' },
      ...knownContinents.map((c) => ({ k: c.value as ContinentFilter, l: c.label })),
      { k: 'unassigned' as ContinentFilter, l: 'Unassigned' },
    ],
    [knownContinents],
  );

  useEffect(() => {
    loadFaces();
  }, [loadFaces]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadFaces();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadFaces]);

  const toggleFace = async (id: string) => {
    const item = faces.find((f) => f.id === id);
    if (!item) return;
    const next = !item.isActive;
    setFaces((prev) => prev.map((f) => (f.id === id ? { ...f, isActive: next } : f)));
    try {
      await apiFetch(`/admin/assets/faces/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: next }),
      });
      toast({ title: `${item.label} ${item.isActive ? 'deactivated' : 'activated'}` });
    } catch (e) {
      setFaces((prev) => prev.map((f) => (f.id === id ? { ...f, isActive: item.isActive } : f)));
      toast({
        kind: 'error',
        title: 'Failed to update face',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  };

  const doBulkDeleteFaces = async () => {
    if (deleteFaceConfirmText !== 'move to recycle bin') return;
    const ids = confirmBulkDeleteFaceIds;
    setConfirmBulkDeleteFaceIds([]);
    setDeleteFaceConfirmText('');
    if (ids.length === 0) return;
    try {
      const res = await apiFetch<{ deleted: number }>('/admin/assets/faces', {
        method: 'DELETE',
        body: JSON.stringify({ ids }),
      });
      setFaces((prev) => prev.filter((f) => !ids.includes(f.id)));
      setSelectedFaceIds((prev) => prev.filter((id) => !ids.includes(id)));
      toast({ title: `${res.deleted} face${res.deleted !== 1 ? 's' : ''} moved to recycle bin` });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Bulk delete failed',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  };

  const doBulkSortOrder = async () => {
    if (selectedFaceIds.length === 0) return;
    setBulkSortSaving(true);
    const orderedSelected = filteredFaces
      .filter((f) => selectedFaceIds.includes(f.id))
      .map((f, i) => ({ id: f.id, sortOrder: bulkSortStart + i }));
    try {
      await Promise.all(
        orderedSelected.map(({ id, sortOrder }) =>
          apiFetch(`/admin/assets/faces/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ sortOrder }),
          }),
        ),
      );
      setFaces((prev) =>
        prev.map((f) => {
          const entry = orderedSelected.find((e) => e.id === f.id);
          return entry ? { ...f, sortOrder: entry.sortOrder } : f;
        }),
      );
      toast({
        title: `Sort order updated for ${orderedSelected.length} face${orderedSelected.length !== 1 ? 's' : ''}`,
      });
      setSelectedFaceIds([]);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to update sort order',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setBulkSortSaving(false);
    }
  };

  const doBulkSetContinent = async () => {
    if (selectedFaceIds.length === 0) return;
    setBulkContinentSaving(true);
    const value = bulkContinent || null;
    try {
      await Promise.all(
        selectedFaceIds.map((id) =>
          apiFetch(`/admin/assets/faces/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ continent: value }),
          }),
        ),
      );
      setFaces((prev) =>
        prev.map((f) => (selectedFaceIds.includes(f.id) ? { ...f, continent: value } : f)),
      );
      toast({
        title: `Continent set for ${selectedFaceIds.length} face${selectedFaceIds.length !== 1 ? 's' : ''}`,
      });
      setSelectedFaceIds([]);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to set continent',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setBulkContinentSaving(false);
    }
  };

  const filteredFaces = faces
    .filter((f) => genderFilter === 'all' || f.gender === genderFilter)
    .filter((f) => {
      if (continentFilter === 'all') return true;
      if (continentFilter === 'unassigned') return !f.continent;
      return f.continent === continentFilter;
    })
    .filter((f) => {
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      const continentTxt = f.continent ? `${f.continent} ${continentLabel(f.continent)}` : '';
      return (
        f.label?.toLowerCase().includes(q) ||
        f.id?.toLowerCase().includes(q) ||
        f.publicApiSlug?.toLowerCase().includes(q) ||
        continentTxt?.toLowerCase().includes(q) ||
        f.tags?.some((t) => t.toLowerCase().includes(q))
      );
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const facesTotalPages = Math.max(1, Math.ceil(filteredFaces.length / FACES_PAGE_SIZE));
  const facesClampedPage = Math.min(facesPage, facesTotalPages);
  const pagedFaces = filteredFaces.slice(
    (facesClampedPage - 1) * FACES_PAGE_SIZE,
    facesClampedPage * FACES_PAGE_SIZE,
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Model Faces</h1>
          <p className="lede">Model face images — select gender to filter.</p>
        </div>
        <div className="head-tools">
          <div className="search">
            <Icon.Search />
            <input
              placeholder="Search faces…"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setFacesPage(1);
              }}
            />
          </div>
          <button className="btn" onClick={() => setShowFaceUpload(true)}>
            <Icon.Add /> Add face
          </button>
        </div>
      </div>

      <div className="tabs" style={{ marginTop: -8 }}>
        {GENDER_TABS.map((t) => (
          <button
            key={t.k}
            className={`tab ${genderFilter === t.k ? 'active' : ''}`}
            onClick={() => {
              setGenderFilter(t.k);
              setFacesPage(1);
            }}
          >
            {t.l}
          </button>
        ))}
      </div>

      <div className="tabs">
        {CONTINENT_TABS.map((t) => (
          <button
            key={t.k}
            className={`tab ${continentFilter === t.k ? 'active' : ''}`}
            onClick={() => {
              setContinentFilter(t.k);
              setFacesPage(1);
            }}
          >
            {t.l}
          </button>
        ))}
      </div>

      {!loading && (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 4,
              marginBottom: 4,
              flexWrap: 'wrap',
            }}
          >
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
              {filteredFaces.length} face{filteredFaces.length !== 1 ? 's' : ''}
              {searchQuery.trim() && ` matching "${searchQuery.trim()}"`}
            </p>
            {searchQuery.trim() && (
              <button
                className="btn sm ghost"
                onClick={() => {
                  setSearchQuery('');
                  setFacesPage(1);
                }}
              >
                Clear search
              </button>
            )}
            {filteredFaces.length > 0 && (
              <button
                className="btn sm ghost"
                style={{ marginLeft: 'auto' }}
                onClick={() => {
                  const allSelected = filteredFaces.every((f) => selectedFaceIds.includes(f.id));
                  setSelectedFaceIds(allSelected ? [] : filteredFaces.map((f) => f.id));
                }}
              >
                {filteredFaces.every((f) => selectedFaceIds.includes(f.id))
                  ? 'Deselect all'
                  : 'Select all'}
              </button>
            )}
            {selectedFaceIds.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <select
                    className="select"
                    value={bulkContinent}
                    disabled={bulkContinentSaving}
                    onChange={(e) => setBulkContinent(e.target.value as Continent | '')}
                    style={{ fontSize: 12, height: 28, padding: '3px 6px' }}
                  >
                    <option value="">Unassigned</option>
                    {knownContinents.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn sm"
                    disabled={bulkContinentSaving}
                    onClick={() => void doBulkSetContinent()}
                  >
                    {bulkContinentSaving ? 'Saving…' : `Set continent (${selectedFaceIds.length})`}
                  </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    Sort from
                  </span>
                  <input
                    type="number"
                    className="input"
                    min={0}
                    step={1}
                    value={bulkSortStart}
                    disabled={bulkSortSaving}
                    onChange={(e) => setBulkSortStart(Number(e.target.value))}
                    style={{ width: 64, padding: '3px 6px', fontSize: 12, height: 28 }}
                  />
                  <button
                    className="btn sm"
                    disabled={bulkSortSaving}
                    onClick={() => void doBulkSortOrder()}
                  >
                    {bulkSortSaving ? 'Saving…' : `Apply (${selectedFaceIds.length})`}
                  </button>
                </div>
                <button
                  className="btn sm danger"
                  onClick={() => setConfirmBulkDeleteFaceIds([...selectedFaceIds])}
                >
                  <Icon.Trash /> Move to recycle bin ({selectedFaceIds.length})
                </button>
              </>
            )}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 14,
              marginTop: 10,
            }}
          >
            {pagedFaces.map((face) => (
              <div
                key={face.id}
                className="card"
                style={{
                  opacity: face.isActive ? 1 : 0.6,
                  padding: 14,
                  outline: selectedFaceIds.includes(face.id) ? '2px solid var(--pink)' : undefined,
                  cursor: 'pointer',
                }}
                onClick={() => handleImageClick(face.id)}
                onDoubleClick={() => handleImageDoubleClick(face.r2Url)}
              >
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={selectedFaceIds.includes(face.id)}
                    onChange={(e) =>
                      setSelectedFaceIds((prev) =>
                        e.target.checked ? [...prev, face.id] : prev.filter((id) => id !== face.id),
                      )
                    }
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      accentColor: 'var(--pink)',
                      cursor: 'pointer',
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  />
                  <AssetThumb
                    thumbnailUrl={face.thumbnailUrl}
                    fullUrl={face.r2Url}
                    label={face.label}
                    w={48}
                    h={64}
                    onPreview={setPreviewUrl}
                  />
                  <div style={{ marginTop: 4 }}>
                    <span className="semi">{face.label}</span>
                    <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <span className="badge dot accent">{face.gender}</span>
                      <span className="badge dot">
                        {face.continent ? continentLabel(face.continent) : 'Unassigned'}
                      </span>
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: 12,
                    paddingTop: 10,
                    borderTop: '1px solid var(--border)',
                  }}
                >
                  <div onClick={(e) => e.stopPropagation()}>
                    <Switch checked={face.isActive} onChange={() => toggleFace(face.id)} />
                  </div>
                  <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn sm ghost" onClick={() => setEditingFace(face)}>
                      <Icon.Edit />
                    </button>
                    <button className="btn sm ghost" onClick={() => setConfirmDeleteFace(face)}>
                      <Icon.Trash />
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {filteredFaces.length === 0 && (
              <div
                style={{
                  gridColumn: '1 / -1',
                  textAlign: 'center',
                  color: 'var(--muted)',
                  padding: '2rem',
                }}
              >
                {searchQuery.trim()
                  ? `No faces matching "${searchQuery.trim()}".`
                  : 'No faces found.'}
              </div>
            )}
          </div>
          {facesTotalPages > 1 && (
            <Pager
              page={facesClampedPage - 1}
              totalPages={facesTotalPages}
              onPage={(n) => setFacesPage(n + 1)}
              totalItems={filteredFaces.length}
              pageSize={FACES_PAGE_SIZE}
            />
          )}
        </>
      )}

      {/* ── Modals ── */}

      {confirmDeleteFace && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteFace(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Move to recycle bin</h3>
            </div>
            <div className="modal-body">
              <p>
                Move <strong>{confirmDeleteFace.label}</strong> to the recycle bin? You can restore
                it later.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmDeleteFace(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  const { id, label } = confirmDeleteFace;
                  setConfirmDeleteFace(null);
                  if (id.startsWith('face_demo_')) {
                    setFaces((prev) => prev.filter((f) => f.id !== id));
                    toast({ title: `${label} moved to recycle bin` });
                    return;
                  }
                  try {
                    await apiFetch(`/admin/assets/faces/${id}`, { method: 'DELETE' });
                    setFaces((prev) => prev.filter((f) => f.id !== id));
                    toast({ title: `${label} moved to recycle bin` });
                  } catch (e) {
                    toast({
                      kind: 'error',
                      title: 'Failed to delete face',
                      body: apiErrorMessage(e, 'Please try again.'),
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

      {confirmBulkDeleteFaceIds.length > 0 && (
        <div
          className="modal-overlay"
          onClick={() => {
            setConfirmBulkDeleteFaceIds([]);
            setDeleteFaceConfirmText('');
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>
                Move {confirmBulkDeleteFaceIds.length} face
                {confirmBulkDeleteFaceIds.length !== 1 ? 's' : ''} to recycle bin
              </h3>
            </div>
            <div className="modal-body">
              <p>
                Move{' '}
                <strong>
                  {confirmBulkDeleteFaceIds.length} selected face
                  {confirmBulkDeleteFaceIds.length !== 1 ? 's' : ''}
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
                  value={deleteFaceConfirmText}
                  onChange={(e) => setDeleteFaceConfirmText(e.target.value)}
                  placeholder="move to recycle bin"
                />
              </div>
            </div>
            <div className="modal-foot">
              <button
                className="btn ghost"
                onClick={() => {
                  setConfirmBulkDeleteFaceIds([]);
                  setDeleteFaceConfirmText('');
                }}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={doBulkDeleteFaces}
                disabled={deleteFaceConfirmText !== 'move to recycle bin'}
              >
                <Icon.Trash /> Move to recycle bin ({confirmBulkDeleteFaceIds.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {showFaceUpload && (
        <AddFaceModal
          knownContinents={knownContinents}
          onDone={(newFaces) => {
            setShowFaceUpload(false);
            setFaces((prev) => [...prev, ...newFaces]);
          }}
          onClose={() => setShowFaceUpload(false)}
          toast={toast}
        />
      )}

      {editingFace && (
        <EditFaceModal
          face={editingFace}
          knownContinents={knownContinents}
          onSaved={(updated) => {
            setFaces((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
            setEditingFace(null);
          }}
          onClose={() => setEditingFace(null)}
          toast={toast}
        />
      )}
    </>
  );
}
