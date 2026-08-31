import { useCallback, useEffect, useRef, useState } from 'react';
import { AssetThumb } from '../../components/AssetThumb';
import { EditPoseAssetModal } from '../../components/EditPoseAssetModal';
import { Icon } from '../../components/Icons';
import { Pager } from '../../components/Pager';
import { PoseUploadModal } from '../../components/PoseUploadModal';
import { SearchableSelect } from '../../components/SearchableSelect';
import { Switch } from '../../components/Switch';
import { apiErrorMessage, apiFetch, getToken } from '../../lib/data';
import type { GenderSlug, ModelPoseAsset, WorkflowOption } from '../../types';
import { useAssetsContext } from './AssetsContext';

const GENDER_TABS = [
  { k: 'all' as const, l: 'All' },
  { k: 'men' as const, l: 'Men' },
  { k: 'women' as const, l: 'Women' },
  { k: 'boys' as const, l: 'Boys' },
  { k: 'girls' as const, l: 'Girls' },
];

const PA_PAGE_SIZE = 50;

export function PoseAssetsTab() {
  const {
    genderFilter,
    setGenderFilter,
    workflows,
    setWorkflows,
    loading,
    setLoading,
    setPreviewUrl,
    toast,
  } = useAssetsContext();

  const [poseAssets, setPoseAssets] = useState<ModelPoseAsset[]>([]);
  const [paSearch, setPaSearch] = useState('');
  const [paFilterWorkflow, setPaFilterWorkflow] = useState('');
  const [paFilterPose, setPaFilterPose] = useState('');
  const [paSortKey, setPaSortKey] = useState<'label' | 'sortOrder' | 'createdAt'>('sortOrder');
  const [paSortDir, setPaSortDir] = useState<'asc' | 'desc'>('asc');
  const [paPage, setPaPage] = useState(1);
  const [selectedPoseAssetIds, setSelectedPoseAssetIds] = useState<string[]>([]);
  const [confirmBulkDeletePoseAssetIds, setConfirmBulkDeletePoseAssetIds] = useState<string[]>([]);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [confirmDeletePoseAssetId, setConfirmDeletePoseAssetId] = useState<string | null>(null);
  const [showPoseAssetUpload, setShowPoseAssetUpload] = useState(false);
  const [editingPoseAsset, setEditingPoseAsset] = useState<ModelPoseAsset | null>(null);

  // Bulk rename state
  const [showBulkRename, setShowBulkRename] = useState(false);
  const [bulkRenameDisplayName, setBulkRenameDisplayName] = useState('');
  const [bulkRenaming, setBulkRenaming] = useState(false);

  // Bulk workflow state
  const [showBulkWorkflow, setShowBulkWorkflow] = useState(false);
  const [bulkWorkflowId, setBulkWorkflowId] = useState('');
  const [bulkWorkflowSaving, setBulkWorkflowSaving] = useState(false);

  // Bulk sort order state
  const [bulkSortStart, setBulkSortStart] = useState(0);
  const [bulkSortSaving, setBulkSortSaving] = useState(false);

  // Bulk import state
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [bulkImportGender, setBulkImportGender] = useState<GenderSlug>('men');
  const [bulkImportWorkflowId, setBulkImportWorkflowId] = useState('');
  const [bulkImportFile, setBulkImportFile] = useState<File | null>(null);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkImportProgress, setBulkImportProgress] = useState(0);
  const [bulkImportPhase, setBulkImportPhase] = useState<'uploading' | 'processing'>('uploading');
  const [bulkImportCounts, setBulkImportCounts] = useState<{
    phase: string;
    done: number;
    total: number;
  } | null>(null);
  const bulkImportXhrRef = useRef<XMLHttpRequest | null>(null);
  const singleClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleImageClick(id: string) {
    if (singleClickTimerRef.current) {
      // Second click of a double-click — cancel timer, let onDoubleClick handle it
      clearTimeout(singleClickTimerRef.current);
      singleClickTimerRef.current = null;
      return;
    }
    singleClickTimerRef.current = setTimeout(() => {
      singleClickTimerRef.current = null;
      setSelectedPoseAssetIds((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );
    }, 250);
  }

  function handleImageDoubleClick(r2Url: string | null) {
    if (r2Url) setPreviewUrl(r2Url);
  }

  const loadPoseAssets = useCallback(async () => {
    setLoading(true);
    try {
      const [assetsRes, wfRes] = await Promise.all([
        apiFetch<{ items: ModelPoseAsset[] }>('/admin/assets/pose-assets'),
        apiFetch<WorkflowOption[]>('/admin/workflows'),
      ]);
      setPoseAssets(assetsRes.items);
      setWorkflows(wfRes);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to load pose assets',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setLoading(false);
    }
  }, [toast, setLoading, setWorkflows]);

  useEffect(() => {
    void loadPoseAssets();
  }, [loadPoseAssets]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadPoseAssets();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadPoseAssets]);

  const toggleActive = async (id: string) => {
    const item = poseAssets.find((a) => a.id === id);
    if (!item) return;
    const next = !item.isActive;
    setPoseAssets((prev) => prev.map((a) => (a.id === id ? { ...a, isActive: next } : a)));
    try {
      await apiFetch(`/admin/assets/pose-assets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: next }),
      });
      toast({ title: `${item.displayName ?? item.label} ${next ? 'activated' : 'deactivated'}` });
    } catch (e) {
      setPoseAssets((prev) =>
        prev.map((a) => (a.id === id ? { ...a, isActive: item.isActive } : a)),
      );
      toast({
        kind: 'error',
        title: 'Failed to update pose asset',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  };

  const dosBulkRename = async () => {
    const name = bulkRenameDisplayName.trim();
    if (!name || selectedPoseAssetIds.length === 0) return;
    setBulkRenaming(true);
    try {
      await apiFetch('/admin/assets/pose-assets/bulk-rename', {
        method: 'PATCH',
        body: JSON.stringify({ ids: selectedPoseAssetIds, displayName: name }),
      });
      setPoseAssets((prev) =>
        prev.map((a) => (selectedPoseAssetIds.includes(a.id) ? { ...a, displayName: name } : a)),
      );
      toast({
        title: `${selectedPoseAssetIds.length} pose asset${selectedPoseAssetIds.length !== 1 ? 's' : ''} renamed`,
      });
      setShowBulkRename(false);
      setSelectedPoseAssetIds([]);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Bulk rename failed',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
    setBulkRenaming(false);
  };

  const doBulkWorkflow = async () => {
    if (!bulkWorkflowId || selectedPoseAssetIds.length === 0) return;
    setBulkWorkflowSaving(true);
    try {
      await apiFetch('/admin/assets/pose-assets/bulk-workflow', {
        method: 'PATCH',
        body: JSON.stringify({ ids: selectedPoseAssetIds, workflowTemplateId: bulkWorkflowId }),
      });
      setPoseAssets((prev) =>
        prev.map((a) =>
          selectedPoseAssetIds.includes(a.id) ? { ...a, workflowTemplateId: bulkWorkflowId } : a,
        ),
      );
      toast({
        title: `Workflow updated for ${selectedPoseAssetIds.length} pose asset${selectedPoseAssetIds.length !== 1 ? 's' : ''}`,
      });
      setShowBulkWorkflow(false);
      setSelectedPoseAssetIds([]);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Bulk workflow update failed',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setBulkWorkflowSaving(false);
    }
  };

  const doBulkSortOrder = async () => {
    if (selectedPoseAssetIds.length === 0) return;
    setBulkSortSaving(true);
    // Assign sequential numbers in current display order
    const orderedSelected = filteredPoseAssets
      .filter((a) => selectedPoseAssetIds.includes(a.id))
      .map((a, i) => ({ id: a.id, sortOrder: bulkSortStart + i }));
    try {
      await Promise.all(
        orderedSelected.map(({ id, sortOrder }) =>
          apiFetch(`/admin/assets/pose-assets/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ sortOrder }),
          }),
        ),
      );
      setPoseAssets((prev) =>
        prev.map((a) => {
          const entry = orderedSelected.find((e) => e.id === a.id);
          return entry ? { ...a, sortOrder: entry.sortOrder } : a;
        }),
      );
      toast({
        title: `Sort order updated for ${orderedSelected.length} pose${orderedSelected.length !== 1 ? 's' : ''}`,
      });
      setSelectedPoseAssetIds([]);
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

  const doBulkDeletePoseAssets = async () => {
    if (deleteConfirmText !== 'move to recycle bin') return;
    const ids = confirmBulkDeletePoseAssetIds;
    setConfirmBulkDeletePoseAssetIds([]);
    setDeleteConfirmText('');
    if (ids.length === 0) return;
    try {
      const res = await apiFetch<{ deleted: number }>('/admin/assets/pose-assets', {
        method: 'DELETE',
        body: JSON.stringify({ ids }),
      });
      setPoseAssets((prev) => prev.filter((a) => !ids.includes(a.id)));
      setSelectedPoseAssetIds((prev) => prev.filter((id) => !ids.includes(id)));
      toast({
        title: `${res.deleted} pose asset${res.deleted !== 1 ? 's' : ''} moved to recycle bin`,
      });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Bulk delete failed',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  };

  // Derived data
  const filteredPoseAssets = poseAssets
    .filter((a) => {
      if (genderFilter !== 'all' && a.genderSlug !== genderFilter) return false;
      if (paFilterWorkflow && a.workflowTemplateId !== paFilterWorkflow) return false;
      if (paFilterPose && a.poseVariant !== paFilterPose) return false;
      if (paSearch) {
        const q = paSearch.toLowerCase();
        if (
          !a.label.toLowerCase().includes(q) &&
          !(a.displayName?.toLowerCase().includes(q) ?? false)
        )
          return false;
      }
      return true;
    })
    .sort((a, b) => {
      let cmp = 0;
      if (paSortKey === 'label') cmp = a.label.localeCompare(b.label);
      else if (paSortKey === 'sortOrder') cmp = a.sortOrder - b.sortOrder;
      else cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      return paSortDir === 'asc' ? cmp : -cmp;
    });

  const paTotalPages = Math.max(1, Math.ceil(filteredPoseAssets.length / PA_PAGE_SIZE));
  const paClampedPage = Math.min(paPage, paTotalPages);
  const pagedPoseAssets = filteredPoseAssets.slice(
    (paClampedPage - 1) * PA_PAGE_SIZE,
    paClampedPage * PA_PAGE_SIZE,
  );

  const genderSlicedAssets = poseAssets.filter(
    (a) => genderFilter === 'all' || a.genderSlug === genderFilter,
  );
  const paWorkflowOptions = workflows.filter((w) =>
    genderSlicedAssets.some((a) => a.workflowTemplateId === w.id),
  );
  const paPoseVariants = Array.from(
    new Set(genderSlicedAssets.map((a) => a.poseVariant).filter(Boolean) as string[]),
  ).sort();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pose Assets</h1>
          <p className="lede">
            Pose image assets. Filtered by gender — active poses are shown to users in studio.
          </p>
        </div>
        <div className="head-tools">
          <button className="btn ghost" onClick={() => setShowPoseAssetUpload(true)}>
            <Icon.Add /> Upload pose
          </button>
          <button
            className="btn"
            onClick={() => {
              setBulkImportGender('men');
              setBulkImportWorkflowId(workflows[0]?.id ?? '');
              setBulkImportFile(null);
              setShowBulkImport(true);
            }}
          >
            <Icon.Upload /> Bulk import ZIP
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
              setPaFilterWorkflow('');
              setPaFilterPose('');
              setPaSearch('');
            }}
          >
            {t.l}
          </button>
        ))}
      </div>

      {!loading && (
        <>
          {/* Filter bar */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              marginTop: 8,
              marginBottom: 4,
              flexWrap: 'wrap',
            }}
          >
            <input
              className="input"
              style={{ minWidth: 160, maxWidth: 220 }}
              placeholder="Search label…"
              value={paSearch}
              onChange={(e) => setPaSearch(e.target.value)}
            />
            <div style={{ minWidth: 140, width: 'auto' }}>
              <SearchableSelect
                options={paWorkflowOptions}
                value={paFilterWorkflow}
                onChange={setPaFilterWorkflow}
                emptyLabel="All workflows"
                placeholder="All workflows"
              />
            </div>
            <div style={{ minWidth: 130, width: 'auto' }}>
              <SearchableSelect
                options={paPoseVariants.map((v) => ({ id: v, label: v }))}
                value={paFilterPose}
                onChange={setPaFilterPose}
                emptyLabel="All poses"
                placeholder="All poses"
              />
            </div>
            <select
              className="select"
              style={{ minWidth: 110, width: 'auto' }}
              value={paSortKey}
              onChange={(e) => setPaSortKey(e.target.value as 'label' | 'sortOrder' | 'createdAt')}
            >
              <option value="sortOrder">Sort order</option>
              <option value="label">Name</option>
              <option value="createdAt">Date added</option>
            </select>
            <button
              className="btn sm ghost"
              title={paSortDir === 'asc' ? 'Ascending' : 'Descending'}
              onClick={() => setPaSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
            >
              {paSortDir === 'asc' ? '↑' : '↓'}
            </button>
            {(paSearch || paFilterWorkflow || paFilterPose) && (
              <button
                className="btn sm ghost"
                onClick={() => {
                  setPaSearch('');
                  setPaFilterWorkflow('');
                  setPaFilterPose('');
                }}
              >
                Clear
              </button>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 4,
              flexWrap: 'wrap',
            }}
          >
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
              {filteredPoseAssets.length} asset{filteredPoseAssets.length !== 1 ? 's' : ''}
              {paTotalPages > 1 && ` · page ${paClampedPage}/${paTotalPages}`}
              {genderFilter !== 'all' && ` · ${poseAssets.length} total`}
            </p>
            {filteredPoseAssets.length > 0 && (
              <button
                className="btn sm ghost"
                style={{ marginLeft: 'auto' }}
                onClick={() => {
                  const allIds = filteredPoseAssets.map((a) => a.id);
                  const allSelected = allIds.every((id) => selectedPoseAssetIds.includes(id));
                  setSelectedPoseAssetIds(allSelected ? [] : allIds);
                }}
              >
                {filteredPoseAssets.length > 0 &&
                filteredPoseAssets.every((a) => selectedPoseAssetIds.includes(a.id))
                  ? 'Deselect all'
                  : 'Select all'}
              </button>
            )}
            {selectedPoseAssetIds.length > 0 && (
              <>
                <button
                  className="btn sm"
                  onClick={() => {
                    setBulkRenameDisplayName('');
                    setShowBulkRename(true);
                  }}
                >
                  <Icon.Edit /> Rename ({selectedPoseAssetIds.length})
                </button>
                <button
                  className="btn sm"
                  onClick={() => {
                    setBulkWorkflowId(workflows[0]?.id ?? '');
                    setShowBulkWorkflow(true);
                  }}
                >
                  <Icon.Workflow /> Workflow ({selectedPoseAssetIds.length})
                </button>
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
                    {bulkSortSaving ? 'Saving…' : `Apply (${selectedPoseAssetIds.length})`}
                  </button>
                </div>
                <button
                  className="btn sm danger"
                  onClick={() => setConfirmBulkDeletePoseAssetIds([...selectedPoseAssetIds])}
                >
                  <Icon.Trash /> Move to recycle bin ({selectedPoseAssetIds.length})
                </button>
              </>
            )}
          </div>

          {filteredPoseAssets.length === 0 ? (
            <p style={{ color: 'var(--muted)', marginTop: 24 }}>No pose assets for this gender.</p>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                gap: 12,
                marginTop: 12,
              }}
            >
              {pagedPoseAssets.map((a) => (
                <div
                  key={a.id}
                  className="card"
                  style={{
                    padding: 0,
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    outline: selectedPoseAssetIds.includes(a.id)
                      ? '2px solid var(--pink)'
                      : undefined,
                    opacity: a.isActive ? 1 : 0.55,
                  }}
                >
                  <div
                    style={{
                      background: 'var(--surface2, #1a1a1a)',
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'center',
                      aspectRatio: '3/4',
                      cursor: 'pointer',
                      position: 'relative',
                    }}
                    onClick={() => handleImageClick(a.id)}
                    onDoubleClick={() => handleImageDoubleClick(a.r2Url)}
                  >
                    <AssetThumb
                      thumbnailUrl={a.thumbnailUrl}
                      fullUrl={a.r2Url}
                      label={a.label}
                      cursor="pointer"
                      w={160}
                      h={210}
                    />
                    <input
                      type="checkbox"
                      checked={selectedPoseAssetIds.includes(a.id)}
                      onChange={(e) =>
                        setSelectedPoseAssetIds((prev) =>
                          e.target.checked ? [...prev, a.id] : prev.filter((id) => id !== a.id),
                        )
                      }
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: 'absolute',
                        top: 6,
                        left: 6,
                        width: 15,
                        height: 15,
                        cursor: 'pointer',
                        accentColor: 'var(--pink)',
                      }}
                    />
                  </div>
                  <div style={{ padding: '8px 8px 10px' }}>
                    <p
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={a.displayName ?? a.label}
                    >
                      {a.displayName ?? a.label}
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 4 }}>
                      {a.genderSlug && (
                        <span className="badge dot accent" style={{ fontSize: 10 }}>
                          {a.genderSlug}
                        </span>
                      )}
                      {a.workflowTemplateId && (
                        <span
                          className="badge dot accent"
                          style={{ fontSize: 10 }}
                          title="Workflow"
                        >
                          {workflows.find((w) => w.id === a.workflowTemplateId)?.label ?? '?'}
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginTop: 8,
                      }}
                    >
                      <Switch checked={a.isActive} onChange={() => void toggleActive(a.id)} />
                      <button
                        className="btn ghost"
                        style={{ fontSize: 10, padding: '3px 8px' }}
                        onClick={() => setEditingPoseAsset(a)}
                      >
                        <Icon.Edit /> Edit
                      </button>
                    </div>
                    <button
                      className="btn danger"
                      style={{ width: '100%', marginTop: 4, fontSize: 11, padding: '3px 0' }}
                      onClick={() => setConfirmDeletePoseAssetId(a.id)}
                    >
                      <Icon.Trash /> Move to recycle bin
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {paTotalPages > 1 && (
            <Pager
              page={paClampedPage - 1}
              totalPages={paTotalPages}
              onPage={(n) => setPaPage(n + 1)}
              totalItems={filteredPoseAssets.length}
              pageSize={PA_PAGE_SIZE}
            />
          )}
        </>
      )}

      {/* ── Modals ── */}

      {confirmDeletePoseAssetId && (
        <div className="modal-overlay" onClick={() => setConfirmDeletePoseAssetId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Move to recycle bin</h3>
            </div>
            <div className="modal-body">
              <p>Move this pose asset to the recycle bin? You can restore it later.</p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmDeletePoseAssetId(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  const id = confirmDeletePoseAssetId;
                  setConfirmDeletePoseAssetId(null);
                  try {
                    await apiFetch(`/admin/assets/pose-assets/${id}?force=true`, {
                      method: 'DELETE',
                    });
                    setPoseAssets((prev) => prev.filter((a) => a.id !== id));
                    toast({ title: 'Pose asset moved to recycle bin' });
                  } catch (e) {
                    toast({ kind: 'error', title: 'Delete failed', body: (e as Error).message });
                  }
                }}
              >
                <Icon.Trash /> Move to recycle bin
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmBulkDeletePoseAssetIds.length > 0 && (
        <div className="modal-overlay" onClick={() => setConfirmBulkDeletePoseAssetIds([])}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Move {confirmBulkDeletePoseAssetIds.length} pose assets to recycle bin</h3>
            </div>
            <div className="modal-body">
              <p>
                Move <strong>{confirmBulkDeletePoseAssetIds.length} selected pose assets</strong> to
                the recycle bin? You can restore them later.
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
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder="move to recycle bin"
                />
              </div>
            </div>
            <div className="modal-foot">
              <button
                className="btn ghost"
                onClick={() => {
                  setConfirmBulkDeletePoseAssetIds([]);
                  setDeleteConfirmText('');
                }}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={doBulkDeletePoseAssets}
                disabled={deleteConfirmText !== 'move to recycle bin'}
              >
                <Icon.Trash /> Move to recycle bin ({confirmBulkDeletePoseAssetIds.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk workflow change */}
      {showBulkWorkflow && (
        <div
          className="modal-overlay"
          onClick={() => !bulkWorkflowSaving && setShowBulkWorkflow(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="modal-head">
              <h3>
                Change workflow for {selectedPoseAssetIds.length} pose asset
                {selectedPoseAssetIds.length !== 1 ? 's' : ''}
              </h3>
            </div>
            <div
              className="modal-body"
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                Workflow template
                <SearchableSelect
                  options={workflows}
                  value={bulkWorkflowId}
                  disabled={bulkWorkflowSaving}
                  onChange={setBulkWorkflowId}
                  placeholder="— search workflow —"
                />
              </label>
            </div>
            <div className="modal-foot">
              <button
                className="btn ghost"
                disabled={bulkWorkflowSaving}
                onClick={() => setShowBulkWorkflow(false)}
              >
                Cancel
              </button>
              <button
                className="btn"
                disabled={bulkWorkflowSaving || !bulkWorkflowId}
                onClick={() => void doBulkWorkflow()}
              >
                {bulkWorkflowSaving
                  ? 'Saving…'
                  : `Apply to ${selectedPoseAssetIds.length} pose${selectedPoseAssetIds.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk rename display name */}
      {showBulkRename && (
        <div className="modal-overlay" onClick={() => !bulkRenaming && setShowBulkRename(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="modal-head">
              <h3>
                Rename {selectedPoseAssetIds.length} pose asset
                {selectedPoseAssetIds.length !== 1 ? 's' : ''}
              </h3>
              <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                Sets the display name on all selected assets.
              </p>
            </div>
            <div
              className="modal-body"
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                Display name
                <input
                  className="input"
                  type="text"
                  placeholder="e.g. Standing Front"
                  value={bulkRenameDisplayName}
                  disabled={bulkRenaming}
                  onChange={(e) => setBulkRenameDisplayName(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter' && bulkRenameDisplayName.trim() && !bulkRenaming) {
                      e.preventDefault();
                      await dosBulkRename();
                    }
                  }}
                />
              </label>
            </div>
            <div className="modal-foot">
              <button
                className="btn ghost"
                disabled={bulkRenaming}
                onClick={() => setShowBulkRename(false)}
              >
                Cancel
              </button>
              <button
                className="btn"
                disabled={bulkRenaming || !bulkRenameDisplayName.trim()}
                onClick={dosBulkRename}
              >
                {bulkRenaming ? 'Renaming…' : `Rename ${selectedPoseAssetIds.length}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk import ZIP */}
      {showBulkImport && (
        <div
          className="modal-overlay"
          onClick={() =>
            !(bulkImporting && bulkImportPhase === 'processing') && setShowBulkImport(false)
          }
        >
          <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Bulk import ZIP</h3>
            </div>
            <div
              className="modal-body"
              style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
            >
              <div>
                <label style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>
                  ZIP file
                </label>
                <input
                  type="file"
                  accept=".zip"
                  style={{ width: '100%' }}
                  onChange={(e) => setBulkImportFile(e.target.files?.[0] ?? null)}
                />
                {bulkImportFile && (
                  <p style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>
                    {bulkImportFile.name} ({(bulkImportFile.size / 1024 / 1024).toFixed(1)} MB)
                  </p>
                )}
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>Gender</label>
                <select
                  className="input"
                  value={bulkImportGender}
                  onChange={(e) => setBulkImportGender(e.target.value as GenderSlug)}
                  disabled={bulkImporting}
                >
                  <option value="men">Men</option>
                  <option value="women">Women</option>
                  <option value="boys">Boys</option>
                  <option value="girls">Girls</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>
                  Workflow template
                </label>
                <SearchableSelect
                  options={workflows}
                  value={bulkImportWorkflowId}
                  onChange={setBulkImportWorkflowId}
                  disabled={bulkImporting}
                  placeholder="— search workflow —"
                />
              </div>
              <p style={{ fontSize: 12, color: 'var(--muted)' }}>
                ZIP must contain <code>poses/</code> folder with pose images. Filenames become the
                dedup label.
              </p>
              {bulkImporting && (
                <div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 12,
                      marginBottom: 4,
                      color: 'var(--muted)',
                    }}
                  >
                    <span>
                      {bulkImportPhase === 'uploading'
                        ? 'Uploading…'
                        : bulkImportCounts
                          ? `Processing ${bulkImportCounts.phase} (${bulkImportCounts.done}/${bulkImportCounts.total})…`
                          : 'Processing ZIP…'}
                    </span>
                    <span>{bulkImportProgress}%</span>
                  </div>
                  <div
                    style={{
                      height: 6,
                      background: 'var(--border)',
                      borderRadius: 3,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${bulkImportProgress}%`,
                        background: 'var(--accent, #6366f1)',
                        borderRadius: 3,
                        transition: 'width 0.2s ease',
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button
                className="btn ghost"
                disabled={bulkImporting && bulkImportPhase === 'processing'}
                onClick={() => {
                  if (bulkImportXhrRef.current) {
                    bulkImportXhrRef.current.abort();
                    bulkImportXhrRef.current = null;
                  }
                  setShowBulkImport(false);
                }}
              >
                Cancel
              </button>
              <button
                className="btn"
                disabled={bulkImporting || !bulkImportFile || !bulkImportWorkflowId}
                onClick={() => {
                  if (!bulkImportFile || !bulkImportWorkflowId) return;
                  setBulkImporting(true);
                  setBulkImportProgress(0);
                  setBulkImportPhase('uploading');
                  setBulkImportCounts(null);
                  const fd = new FormData();
                  fd.append('workflowTemplateId', bulkImportWorkflowId);
                  fd.append('genderSlug', bulkImportGender);
                  fd.append('zip', bulkImportFile);
                  const tok = getToken();
                  const xhr = new XMLHttpRequest();
                  bulkImportXhrRef.current = xhr;
                  xhr.open('POST', '/admin/assets/bulk-import');
                  if (tok) xhr.setRequestHeader('Authorization', `Bearer ${tok}`);
                  xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable)
                      setBulkImportProgress(Math.round((e.loaded / e.total) * 100));
                  };
                  xhr.upload.onload = () => {
                    setBulkImportPhase('processing');
                    setBulkImportProgress(0);
                  };
                  let lastLen = 0;
                  xhr.onprogress = () => {
                    const newText = xhr.responseText.slice(lastLen);
                    lastLen = xhr.responseText.length;
                    for (const line of newText.split('\n').filter(Boolean)) {
                      try {
                        const msg = JSON.parse(line) as {
                          phase?: string;
                          done?: number;
                          total?: number;
                        };
                        if (msg.phase && msg.done !== undefined && msg.total !== undefined) {
                          setBulkImportCounts({
                            phase: msg.phase,
                            done: msg.done,
                            total: msg.total,
                          });
                          setBulkImportProgress(Math.round((msg.done / msg.total) * 100));
                        }
                      } catch {
                        /* partial line — ignore */
                      }
                    }
                  };
                  xhr.onload = async () => {
                    bulkImportXhrRef.current = null;
                    setBulkImporting(false);
                    setBulkImportPhase('uploading');
                    setBulkImportCounts(null);
                    if (xhr.status >= 200 && xhr.status < 300) {
                      const lines = xhr.responseText.split('\n').filter(Boolean);
                      const result = JSON.parse(lines[lines.length - 1] ?? '{}') as {
                        done?: boolean;
                        created: { faces: number; backgrounds: number; poses: number };
                        errors: string[];
                      };
                      setShowBulkImport(false);
                      setBulkImportFile(null);
                      setBulkImportProgress(0);
                      const { faces: fCount, backgrounds: bCount, poses: pCount } = result.created;
                      toast({
                        title: `Imported ${fCount} faces, ${bCount} backgrounds, ${pCount} poses`,
                        body:
                          fCount + bCount + pCount === 0
                            ? 'All items already exist — nothing new to import.'
                            : undefined,
                      });
                      if (result.errors.length > 0) {
                        console.error('Bulk import errors:', result.errors);
                        toast({
                          kind: 'error',
                          title: `${result.errors.length} item(s) failed`,
                          body: result.errors[0],
                        });
                      }
                      await loadPoseAssets();
                    } else {
                      const err = JSON.parse(xhr.responseText) as { error?: { message?: string } };
                      toast({
                        kind: 'error',
                        title: 'Bulk import failed',
                        body: err.error?.message ?? xhr.statusText,
                      });
                    }
                  };
                  xhr.onerror = () => {
                    bulkImportXhrRef.current = null;
                    setBulkImporting(false);
                    setBulkImportPhase('uploading');
                    setBulkImportCounts(null);
                    toast({ kind: 'error', title: 'Bulk import failed', body: 'Network error' });
                  };
                  xhr.onabort = () => {
                    bulkImportXhrRef.current = null;
                    setBulkImporting(false);
                    setBulkImportPhase('uploading');
                    setBulkImportProgress(0);
                    setBulkImportCounts(null);
                  };
                  xhr.send(fd);
                }}
              >
                {bulkImporting ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPoseAssetUpload && (
        <PoseUploadModal
          garmentTypeGenderSlug={genderFilter !== 'all' ? genderFilter : 'men'}
          onDone={() => {
            setShowPoseAssetUpload(false);
            void loadPoseAssets();
          }}
          onClose={() => setShowPoseAssetUpload(false)}
          toast={toast}
        />
      )}

      {editingPoseAsset && (
        <EditPoseAssetModal
          asset={editingPoseAsset}
          workflows={workflows}
          onSaved={(updated) => {
            setPoseAssets((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
          }}
          onClose={() => setEditingPoseAsset(null)}
          toast={toast}
        />
      )}
    </>
  );
}
