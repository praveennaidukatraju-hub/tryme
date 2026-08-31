import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { AssetThumb } from '../../components/AssetThumb';
import { EditDrawer } from '../../components/EditDrawer';
import { EditGarmentTypeModal } from '../../components/EditGarmentTypeModal';
import { Icon } from '../../components/Icons';
import { SearchableSelect } from '../../components/SearchableSelect';
import { Switch } from '../../components/Switch';
import { apiErrorMessage, apiFetch } from '../../lib/data';
import { makeThumbnail } from '../../lib/thumbnail';
import type {
  GarmentType,
  GenderSlug,
  MappedTemplateLook,
  MappedTemplatePoseWorkflow,
  PoseGarmentConfig,
  ShotTypeWorkflow,
  TemplateGarmentTypeMapping,
  TryonCategory,
  WorkflowOption,
} from '../../types';
import { useAssetsContext } from './AssetsContext';

type SubView = { kind: 'list' } | { kind: 'configs'; sub: GarmentType };
type ConfirmDeleteGT = { type: 'garment-type'; id: string; label: string };

const GENDER_TABS = [
  { k: 'all' as const, l: 'All' },
  { k: 'men' as const, l: 'Men' },
  { k: 'women' as const, l: 'Women' },
  { k: 'boys' as const, l: 'Boys' },
  { k: 'girls' as const, l: 'Girls' },
];

const SECTION_BADGE_SIZE = 24;
const SECTION_BADGE_GAP = 10;

function SectionHeader({
  n,
  title,
  description,
  right,
}: {
  n: number;
  title: string;
  description: string;
  right?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: SECTION_BADGE_GAP }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: SECTION_BADGE_SIZE,
              height: SECTION_BADGE_SIZE,
              borderRadius: '50%',
              background: 'var(--pink)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {n}
          </span>
          <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
        </div>
        <p
          style={{
            margin: '6px 0 0',
            paddingLeft: SECTION_BADGE_SIZE + SECTION_BADGE_GAP,
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          {description}
        </p>
      </div>
      {right}
    </div>
  );
}

export function GarmentTypesTab() {
  const {
    genderFilter,
    setGenderFilter,
    garmentTypes,
    setGarmentTypes,
    loadGarmentTypes,
    workflows,
    setWorkflows,
    catalogItems,
    loading,
    toast,
  } = useAssetsContext();

  const [subView, setSubView] = useState<SubView>({ kind: 'list' });
  const [poseConfigs, setPoseConfigs] = useState<PoseGarmentConfig[]>([]);
  const [configsLoading, setConfigsLoading] = useState(false);
  const [savingConfigId, setSavingConfigId] = useState<string | null>(null);
  const [savingDefaultPose, setSavingDefaultPose] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDeleteGT | null>(null);
  const [tryonCategories, setTryonCategories] = useState<TryonCategory[]>([]);
  const [expandedGarmentTypeId, setExpandedGarmentTypeId] = useState<string | null>(null);

  // Suggested "append at the end" position for a new garment type of this
  // gender - just a starting point shown in the field; picking a lower number
  // still works and pushes existing ones down (server-side auto-shift).
  const nextSortOrderFor = useCallback(
    (gender: GenderSlug) =>
      garmentTypes.reduce(
        (max, g) => (g.genderSlug === gender ? Math.max(max, g.sortOrder) : max),
        0,
      ) + 1,
    [garmentTypes],
  );

  // Add garment type modal
  const [showSubcatModal, setShowSubcatModal] = useState(false);
  const [subcatForm, setSubcatForm] = useState({
    slug: '',
    label: '',
    genderSlug: 'men' as GenderSlug,
    requiresLowerUpload: false,
    requiresThirdUpload: false,
    sortOrder: 0,
  });
  const [subcatSaving, setSubcatSaving] = useState(false);
  const [subcatImageFile, setSubcatImageFile] = useState<File | null>(null);

  // Edit garment type modal
  const [editingSubcat, setEditingSubcat] = useState<GarmentType | null>(null);

  const loadPoseConfigs = useCallback(
    async (garmentTypeId: string) => {
      setConfigsLoading(true);
      try {
        const res = await apiFetch<{ items: PoseGarmentConfig[] }>(
          `/admin/assets/garment-types/${garmentTypeId}/pose-configs`,
        );
        setPoseConfigs(res.items);
      } catch (e) {
        toast({
          kind: 'error',
          title: 'Failed to load pose configs',
          body: apiErrorMessage(e, 'Please try again.'),
        });
      } finally {
        setConfigsLoading(false);
      }
    },
    [toast],
  );

  const refetchWorkflows = useCallback(() => {
    // Always refetch, regardless of subView — the "Edit garment type" modal
    // (with its saree-step-1/step-2 dropdowns) opens directly from the list
    // view, so workflows must be fresh there too, not just inside "configs".
    void apiFetch<WorkflowOption[]>('/admin/workflows')
      .then(setWorkflows)
      .catch(() => {});
  }, [setWorkflows]);

  useEffect(() => {
    if (subView.kind === 'list') {
      void loadGarmentTypes();
    } else {
      void loadPoseConfigs(subView.sub.id);
    }
    refetchWorkflows();
  }, [subView, loadGarmentTypes, loadPoseConfigs, refetchWorkflows]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (subView.kind === 'list') {
        void loadGarmentTypes();
      } else {
        void loadPoseConfigs(subView.sub.id);
      }
      refetchWorkflows();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [subView, loadGarmentTypes, loadPoseConfigs, refetchWorkflows]);

  useEffect(() => {
    apiFetch<TryonCategory[]>('/admin/tryon-categories')
      .then(setTryonCategories)
      .catch(() => {});
  }, []);

  const saveConfig = async (
    garmentTypeId: string,
    poseAssetId: string,
    patch: {
      workflowTemplateId: string | null;
      promptGarmentPhase: string | null;
      promptFacePhase: string | null;
      isActive: boolean | null;
    },
  ) => {
    setSavingConfigId(poseAssetId);
    try {
      await apiFetch(`/admin/assets/garment-types/${garmentTypeId}/pose-configs/${poseAssetId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setPoseConfigs((prev) =>
        prev.map((p) =>
          p.id === poseAssetId
            ? {
                ...p,
                isActive: patch.isActive ?? p.globalIsActive,
                config:
                  patch.workflowTemplateId ||
                  patch.promptGarmentPhase ||
                  patch.promptFacePhase ||
                  patch.isActive !== null
                    ? patch
                    : null,
              }
            : p,
        ),
      );
      toast({ title: 'Config saved' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to save config',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setSavingConfigId(null);
    }
  };

  const saveDefaultPose = async (garmentTypeId: string, poseAssetId: string | null) => {
    setSavingDefaultPose(true);
    try {
      await apiFetch(`/admin/assets/garment-types/${garmentTypeId}`, {
        method: 'PATCH',
        body: JSON.stringify({ defaultPoseId: poseAssetId }),
      });
      setGarmentTypes((prev) =>
        prev.map((s) => (s.id === garmentTypeId ? { ...s, defaultPoseId: poseAssetId } : s)),
      );
      setSubView((prev) =>
        prev.kind === 'configs' && prev.sub.id === garmentTypeId
          ? { kind: 'configs', sub: { ...prev.sub, defaultPoseId: poseAssetId } }
          : prev,
      );
      toast({ title: 'Default pose updated' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to update default pose',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setSavingDefaultPose(false);
    }
  };

  // Toggling "active" here scopes to this garment type only — it writes a
  // pose_garment_configs override, not the pose asset's global isActive flag
  // (that one lives on the Pose Assets tab and applies to every garment type).
  const togglePoseActive = async (
    garmentTypeId: string,
    poseAssetId: string,
    isActive: boolean,
  ) => {
    const prevItem = poseConfigs.find((p) => p.id === poseAssetId);
    const patch = {
      workflowTemplateId: prevItem?.config?.workflowTemplateId ?? null,
      promptGarmentPhase: prevItem?.config?.promptGarmentPhase ?? null,
      promptFacePhase: prevItem?.config?.promptFacePhase ?? null,
      isActive,
    };
    setPoseConfigs((prev) =>
      prev.map((p) => (p.id === poseAssetId ? { ...p, isActive, config: patch } : p)),
    );
    try {
      await apiFetch(`/admin/assets/garment-types/${garmentTypeId}/pose-configs/${poseAssetId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    } catch (e) {
      setPoseConfigs((prev) => prev.map((p) => (p.id === poseAssetId && prevItem ? prevItem : p)));
      toast({
        kind: 'error',
        title: 'Failed to update pose',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    const { id, label } = confirmDelete;
    setConfirmDelete(null);

    if (id.startsWith('gt_demo_')) {
      setGarmentTypes((prev) => prev.filter((s) => s.id !== id));
      toast({ title: `${label} deleted` });
      return;
    }

    try {
      await apiFetch(`/admin/assets/garment-types/${id}`, { method: 'DELETE' });
      setGarmentTypes((prev) => prev.filter((s) => s.id !== id));
      toast({ title: `${label} deleted` });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to delete garment type',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  };

  const filteredGarmentTypes = garmentTypes.filter(
    (s) => genderFilter === 'all' || s.genderSlug === genderFilter,
  );

  return (
    <>
      <div className="page-head">
        <div>
          {subView.kind === 'configs' && (
            <button
              className="btn sm ghost"
              onClick={() => setSubView({ kind: 'list' })}
              style={{ padding: '2px 8px', fontSize: 13, marginBottom: 10 }}
            >
              <Icon.ArrowLeft /> Back to Garment Types
            </button>
          )}
          <h1>{subView.kind === 'configs' ? `${subView.sub.label} — Setup` : 'Garment Types'}</h1>
          <p className="lede">
            {subView.kind === 'configs'
              ? `Choose the catalogue templates offered for ${subView.sub.label}, then configure its workflow per pose.`
              : 'Garment types used to classify uploads.'}
          </p>
        </div>
        {subView.kind === 'list' && (
          <div className="head-tools">
            <button
              className="btn"
              onClick={() => {
                setSubcatForm({
                  slug: '',
                  label: '',
                  genderSlug: 'men',
                  requiresLowerUpload: false,
                  requiresThirdUpload: false,
                  sortOrder: nextSortOrderFor('men'),
                });
                setShowSubcatModal(true);
              }}
            >
              <Icon.Add /> Add garment type
            </button>
          </div>
        )}
      </div>

      {/* Pose configs subview */}
      {subView.kind === 'configs' && (
        <>
          <ShotTypeWorkflowsPanel sub={subView.sub} workflows={workflows} toast={toast} />

          <div
            style={{
              marginTop: 32,
              paddingTop: 24,
              borderTop: '1px solid var(--border)',
            }}
          >
            <GarmentTemplateMappingPanel sub={subView.sub} workflows={workflows} toast={toast} />
          </div>

          <div
            style={{
              marginTop: 32,
              paddingTop: 24,
              borderTop: '1px solid var(--border)',
            }}
          >
            <SectionHeader
              n={3}
              title="Custom look poses"
              description="Configure standalone poses used by Create your own look. Template workflows are configured inside each mapped template above."
            />
          </div>

          <PoseConfigsPanel
            sub={subView.sub}
            items={poseConfigs}
            loading={configsLoading}
            savingId={savingConfigId}
            workflows={workflows}
            onSave={saveConfig}
            onToggleActive={(poseAssetId, isActive) =>
              togglePoseActive(subView.sub.id, poseAssetId, isActive)
            }
            onSaveDefaultPose={saveDefaultPose}
            savingDefaultPose={savingDefaultPose}
          />
        </>
      )}

      {subView.kind === 'list' && !loading && (
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
          <div className="desktop-only table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Garment Type</th>
                  <th>Gender</th>
                  <th>Default Lower</th>
                  <th>Default Shoe</th>
                  <th>Tryon Category</th>
                  <th>Active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredGarmentTypes.map((sub) => (
                  <tr
                    key={sub.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSubView({ kind: 'configs', sub })}
                  >
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <AssetThumb
                          thumbnailUrl={sub.thumbnailUrl}
                          label={sub.label}
                          w={40}
                          h={40}
                        />
                        <div>
                          <span className="semi">{sub.label}</span>
                          <span className="sub mono" style={{ display: 'block' }}>
                            {sub.slug}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="badge dot accent">{sub.genderSlug}</span>
                    </td>
                    <td>
                      {(() => {
                        const item = catalogItems.find((c) => c.id === sub.defaultLowerCatalogId);
                        return item ? (
                          <div
                            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                            title={item.label}
                          >
                            <AssetThumb
                              thumbnailUrl={item.thumbnailUrl}
                              label={item.label}
                              w={32}
                              h={32}
                            />
                            <span
                              style={{
                                fontSize: 12,
                                color: 'var(--muted)',
                                maxWidth: 100,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {item.label}
                            </span>
                          </div>
                        ) : (
                          <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>
                        );
                      })()}
                    </td>
                    <td>
                      {(() => {
                        const item = catalogItems.find((c) => c.id === sub.defaultShoeCatalogId);
                        return item ? (
                          <div
                            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                            title={item.label}
                          >
                            <AssetThumb
                              thumbnailUrl={item.thumbnailUrl}
                              label={item.label}
                              w={32}
                              h={32}
                            />
                            <span
                              style={{
                                fontSize: 12,
                                color: 'var(--muted)',
                                maxWidth: 100,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {item.label}
                            </span>
                          </div>
                        ) : (
                          <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>
                        );
                      })()}
                    </td>
                    <td>
                      {(() => {
                        const cat = tryonCategories.find((c) => c.id === sub.tryonCategoryId);
                        return cat ? (
                          <span className="badge dot accent">{cat.name}</span>
                        ) : (
                          <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>
                        );
                      })()}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={sub.isActive}
                        onChange={async () => {
                          const next = !sub.isActive;
                          setGarmentTypes((prev) =>
                            prev.map((s) => (s.id === sub.id ? { ...s, isActive: next } : s)),
                          );
                          try {
                            await apiFetch(`/admin/assets/garment-types/${sub.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ isActive: next }),
                            });
                            toast({
                              title: `${sub.label} ${sub.isActive ? 'deactivated' : 'activated'}`,
                            });
                          } catch (e) {
                            setGarmentTypes((prev) =>
                              prev.map((s) =>
                                s.id === sub.id ? { ...s, isActive: sub.isActive } : s,
                              ),
                            );
                            toast({
                              kind: 'error',
                              title: 'Failed to update garment type',
                              body: apiErrorMessage(e, 'Please try again.'),
                            });
                          }
                        }}
                      />
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn sm ghost" onClick={() => setEditingSubcat(sub)}>
                          <Icon.Edit />
                        </button>
                        <button
                          className="btn sm ghost"
                          onClick={() =>
                            setConfirmDelete({ type: 'garment-type', id: sub.id, label: sub.label })
                          }
                        >
                          <Icon.Trash />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredGarmentTypes.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      style={{ textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}
                    >
                      No garment types found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile/Tablet Card List */}
          <div className="mobile-only">
            {filteredGarmentTypes.map((sub) => {
              const isExpanded = expandedGarmentTypeId === sub.id;
              const lowerItem = catalogItems.find((c) => c.id === sub.defaultLowerCatalogId);
              const shoeItem = catalogItems.find((c) => c.id === sub.defaultShoeCatalogId);
              const cat = tryonCategories.find((c) => c.id === sub.tryonCategoryId);

              return (
                <div
                  key={sub.id}
                  className="card"
                  style={{
                    padding: 0,
                    overflow: 'hidden',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    background: 'var(--surface)',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setExpandedGarmentTypeId(isExpanded ? null : sub.id)}
                    style={{
                      padding: '14px 16px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                      userSelect: 'none',
                      background: 'none',
                      border: 'none',
                      width: '100%',
                      textAlign: 'left',
                      color: 'inherit',
                      fontFamily: 'inherit',
                      fontSize: 'inherit',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      <AssetThumb thumbnailUrl={sub.thumbnailUrl} label={sub.label} w={32} h={32} />
                      <span
                        className="semi"
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: 15,
                          color: 'var(--ink)',
                          fontWeight: 600,
                        }}
                      >
                        {sub.label}
                      </span>
                    </div>
                    <span
                      style={{
                        color: 'var(--muted-2)',
                        transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s',
                        display: 'inline-flex',
                        marginLeft: 8,
                      }}
                    >
                      <Icon.Chevron />
                    </span>
                  </button>

                  {isExpanded && (
                    <div
                      style={{
                        padding: '16px',
                        borderTop: '1px solid var(--border)',
                        background: 'var(--surface-2)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                        fontSize: 13,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <span style={{ color: 'var(--muted)', fontWeight: 500 }}>Gender</span>
                        <span className="badge dot accent">{sub.genderSlug}</span>
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <span style={{ color: 'var(--muted)', fontWeight: 500 }}>
                          Tryon Category
                        </span>
                        <span className="sub">{cat ? cat.name : '—'}</span>
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <span style={{ color: 'var(--muted)', fontWeight: 500 }}>
                          Default Lower
                        </span>
                        <span className="sub">{lowerItem ? lowerItem.label : '—'}</span>
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <span style={{ color: 'var(--muted)', fontWeight: 500 }}>Default Shoe</span>
                        <span className="sub">{shoeItem ? shoeItem.label : '—'}</span>
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <span style={{ color: 'var(--muted)', fontWeight: 500 }}>Active</span>
                        <Switch
                          checked={sub.isActive}
                          onChange={async () => {
                            const next = !sub.isActive;
                            setGarmentTypes((prev) =>
                              prev.map((s) => (s.id === sub.id ? { ...s, isActive: next } : s)),
                            );
                            try {
                              await apiFetch(`/admin/assets/garment-types/${sub.id}`, {
                                method: 'PATCH',
                                body: JSON.stringify({ isActive: next }),
                              });
                              toast({
                                title: `${sub.label} ${sub.isActive ? 'deactivated' : 'activated'}`,
                              });
                            } catch (e) {
                              setGarmentTypes((prev) =>
                                prev.map((s) =>
                                  s.id === sub.id ? { ...s, isActive: sub.isActive } : s,
                                ),
                              );
                              toast({
                                kind: 'error',
                                title: 'Failed to update garment type',
                                body: apiErrorMessage(e, 'Please try again.'),
                              });
                            }
                          }}
                        />
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'flex-end',
                          gap: 8,
                          marginTop: 6,
                          borderTop: '1px solid var(--border)',
                          paddingTop: 10,
                        }}
                      >
                        <button
                          className="btn sm ghost"
                          onClick={() => setSubView({ kind: 'configs', sub })}
                        >
                          Setup Poses
                        </button>
                        <button className="btn sm ghost" onClick={() => setEditingSubcat(sub)}>
                          <Icon.Edit /> Edit
                        </button>
                        <button
                          className="btn sm ghost danger"
                          onClick={() =>
                            setConfirmDelete({ type: 'garment-type', id: sub.id, label: sub.label })
                          }
                        >
                          <Icon.Trash /> Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {filteredGarmentTypes.length === 0 && (
              <div
                style={{
                  textAlign: 'center',
                  color: 'var(--muted)',
                  padding: '2.5rem',
                  border: '1.5px dashed var(--border)',
                  borderRadius: 8,
                }}
              >
                No garment types found.
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Modals ── */}

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Delete garment type</h3>
            </div>
            <div className="modal-body">
              <p>
                Delete <strong>{confirmDelete.label}</strong>? This cannot be undone.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button className="btn danger" onClick={doDelete}>
                <Icon.Trash /> Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add garment type */}
      {showSubcatModal && (
        <EditDrawer
          onClose={() => {
            setShowSubcatModal(false);
            setSubcatImageFile(null);
          }}
          title="Add garment type"
          width="min(560px, calc(100vw - 60px))"
          saving={subcatSaving}
          saveDisabled={!subcatForm.label.trim() || !subcatForm.slug.trim()}
          saveLabel={subcatSaving ? 'Creating…' : 'Create'}
          onSave={async () => {
            setSubcatSaving(true);
            try {
              let thumbnailKey: string | undefined;
              if (subcatImageFile) {
                const presign = await apiFetch<{ uploadUrl: string; thumbnailKey: string }>(
                  '/admin/assets/garment-types/presign',
                  {
                    method: 'POST',
                    body: JSON.stringify({ contentType: subcatImageFile.type }),
                  },
                );
                const thumb = await makeThumbnail(subcatImageFile);
                await fetch(presign.uploadUrl, {
                  method: 'PUT',
                  headers: { 'Content-Type': thumb.type },
                  body: thumb,
                });
                thumbnailKey = presign.thumbnailKey;
              }
              const row = await apiFetch<GarmentType>('/admin/assets/garment-types', {
                method: 'POST',
                body: JSON.stringify({ ...subcatForm, thumbnailKey }),
              });
              // A collision at the chosen sortOrder shifts other rows of this
              // gender server-side - refetch instead of patching just this one.
              await loadGarmentTypes();
              toast({ title: `${row.label} created` });
              setShowSubcatModal(false);
              setSubcatImageFile(null);
            } catch (e) {
              toast({
                kind: 'error',
                title: 'Failed to create garment type',
                body: apiErrorMessage(e, 'Please try again.'),
              });
            } finally {
              setSubcatSaving(false);
            }
          }}
        >
          <div className="field">
            <label>Label</label>
            <input
              className="input"
              placeholder="Full Sleeve Shirt"
              value={subcatForm.label}
              disabled={subcatSaving}
              onChange={(e) => setSubcatForm((f) => ({ ...f, label: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Slug</label>
            <input
              className="input"
              placeholder="fullsleeveshirt"
              value={subcatForm.slug}
              disabled={subcatSaving}
              onChange={(e) =>
                setSubcatForm((f) => ({
                  ...f,
                  slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
                }))
              }
            />
          </div>
          <div className="field">
            <label>Gender</label>
            <select
              className="select"
              value={subcatForm.genderSlug}
              disabled={subcatSaving}
              onChange={(e) => {
                const genderSlug = e.target.value as GenderSlug;
                setSubcatForm((f) => ({
                  ...f,
                  genderSlug,
                  sortOrder: nextSortOrderFor(genderSlug),
                }));
              }}
            >
              <option value="men">Men</option>
              <option value="women">Women</option>
              <option value="boys">Boys</option>
              <option value="girls">Girls</option>
            </select>
          </div>
          <div className="field">
            <label>
              Sort order{' '}
              <span style={{ color: 'var(--muted)', fontWeight: 400 }}>
                (1 shows first; picking a taken position pushes the rest down)
              </span>
            </label>
            <input
              className="input"
              type="number"
              step={1}
              value={subcatForm.sortOrder}
              disabled={subcatSaving}
              onChange={(e) => setSubcatForm((f) => ({ ...f, sortOrder: Number(e.target.value) }))}
            />
          </div>
          <div className="field">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={subcatForm.requiresLowerUpload}
                disabled={subcatSaving}
                onChange={(e) =>
                  setSubcatForm((f) => ({ ...f, requiresLowerUpload: e.target.checked }))
                }
              />
              Requires lower garment upload
              <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
                (user uploads bottom wear separately)
              </span>
            </label>
          </div>
          <div className="field">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={subcatForm.requiresThirdUpload}
                disabled={subcatSaving}
                onChange={(e) =>
                  setSubcatForm((f) => ({ ...f, requiresThirdUpload: e.target.checked }))
                }
              />
              Requires 3rd garment upload
              <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
                (user uploads a third garment image separately)
              </span>
            </label>
          </div>
          <div className="field">
            <label>
              Thumbnail image{' '}
              <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {subcatImageFile ? (
                // biome-ignore lint/performance/noImgElement: admin panel
                <img
                  src={URL.createObjectURL(subcatImageFile)}
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
                {subcatImageFile ? 'Change image' : 'Upload image'}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setSubcatImageFile(f);
                  }}
                />
              </label>
              {subcatImageFile && (
                <button className="btn sm ghost" onClick={() => setSubcatImageFile(null)}>
                  <Icon.Close />
                </button>
              )}
            </div>
          </div>
        </EditDrawer>
      )}

      {/* Edit garment type */}
      {editingSubcat && (
        <EditGarmentTypeModal
          garmentType={editingSubcat}
          catalogItems={catalogItems}
          tryonCategories={tryonCategories}
          workflows={workflows}
          onSaved={() => {
            // A sortOrder change shifts other rows of this gender server-side -
            // refetch instead of patching just the edited row.
            void loadGarmentTypes();
          }}
          onClose={() => setEditingSubcat(null)}
          toast={toast}
        />
      )}
    </>
  );
}

// ── PoseConfigsPanel ──────────────────────────────────────────────────────────

const SHOT_TYPE_LABELS: Record<ShotTypeWorkflow['shotType'], string> = {
  full: 'Full pose',
  half: 'Half pose',
  closeup: 'Closeup',
};

interface ShotTypeWorkflowsPanelProps {
  sub: GarmentType;
  workflows: WorkflowOption[];
  toast: (opts: { kind?: 'error'; title: string; body?: string }) => void;
}

function ShotTypeWorkflowsPanel({ sub, workflows, toast }: ShotTypeWorkflowsPanelProps) {
  const [items, setItems] = useState<ShotTypeWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingShotType, setSavingShotType] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: ShotTypeWorkflow[] }>(
        `/admin/assets/garment-types/${sub.id}/shot-type-workflows`,
      );
      setItems(res.items);
    } catch (error) {
      toast({
        kind: 'error',
        title: 'Failed to load shot-type defaults',
        body: (error as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }, [sub.id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const setDefault = async (
    shotType: ShotTypeWorkflow['shotType'],
    workflowTemplateId: string | null,
  ) => {
    setSavingShotType(shotType);
    try {
      const res = await apiFetch<{ ok: true; resolvedCount: number }>(
        `/admin/assets/garment-types/${sub.id}/shot-type-workflows/${shotType}`,
        { method: 'PATCH', body: JSON.stringify({ workflowTemplateId }) },
      );
      setItems((prev) =>
        prev.map((i) => (i.shotType === shotType ? { ...i, workflowTemplateId } : i)),
      );
      toast({
        title: workflowTemplateId
          ? `${SHOT_TYPE_LABELS[shotType]} default saved`
          : `${SHOT_TYPE_LABELS[shotType]} default cleared`,
        body: res.resolvedCount > 0 ? `Applied to ${res.resolvedCount} poses` : undefined,
      });
    } catch (error) {
      toast({
        kind: 'error',
        title: 'Failed to save shot-type default',
        body: (error as Error).message,
      });
    } finally {
      setSavingShotType(null);
    }
  };

  return (
    <section style={{ marginTop: 12 }}>
      <SectionHeader
        n={1}
        title="Shot-type default workflows"
        description={`Set once per shot type — applies to every pose tagged with it, across every template mapped to ${sub.label}, now and in the future.`}
      />
      {loading ? (
        <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--muted)' }}>
          Loading…
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10, marginTop: 14, maxWidth: 420 }}>
          {items.map((item) => (
            <div key={item.shotType} className="field" style={{ margin: 0 }}>
              <label>{SHOT_TYPE_LABELS[item.shotType]}</label>
              <SearchableSelect
                options={workflows.map((w) => ({ id: w.id, label: w.label }))}
                value={item.workflowTemplateId ?? ''}
                disabled={savingShotType === item.shotType}
                onChange={(val) => void setDefault(item.shotType, val || null)}
                emptyLabel="— none —"
                placeholder="— search workflow —"
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface GarmentTemplateMappingPanelProps {
  sub: GarmentType;
  workflows: WorkflowOption[];
  toast: (opts: { kind?: 'error'; title: string; body?: string }) => void;
}

function GarmentTemplateMappingPanel({ sub, workflows, toast }: GarmentTemplateMappingPanelProps) {
  const [items, setItems] = useState<TemplateGarmentTypeMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([]);
  const [batchSaving, setBatchSaving] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<TemplateGarmentTypeMapping | null>(null);

  const load = useCallback(async () => {
    setSelectedTemplateIds([]);
    setLoading(true);
    try {
      const res = await apiFetch<{ items: TemplateGarmentTypeMapping[] }>(
        `/admin/assets/garment-types/${sub.id}/templates`,
      );
      setItems(res.items);
    } catch (error) {
      toast({
        kind: 'error',
        title: 'Failed to load catalogue templates',
        body: (error as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }, [sub.id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleMapped = async (templateId: string, mapped: boolean) => {
    const previous = items;
    setSavingId(templateId);
    setItems((current) =>
      current.map((item) => (item.id === templateId ? { ...item, mapped } : item)),
    );
    try {
      const response = await apiFetch<{ ok: true; mappingId: string | null }>(
        `/admin/assets/garment-types/${sub.id}/templates/${templateId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ mapped }),
        },
      );
      setItems((current) =>
        current.map((item) =>
          item.id === templateId ? { ...item, mapped, mappingId: response.mappingId } : item,
        ),
      );
    } catch (error) {
      setItems(previous);
      toast({
        kind: 'error',
        title: 'Failed to update template mapping',
        body: (error as Error).message,
      });
    } finally {
      setSavingId(null);
    }
  };

  const selectedItems = items.filter((item) => selectedTemplateIds.includes(item.id));
  const allTemplatesSelected =
    items.length > 0 && items.every((item) => selectedTemplateIds.includes(item.id));
  const selectedAllMapped = selectedItems.length > 0 && selectedItems.every((item) => item.mapped);

  const toggleTemplateSelection = (templateId: string) => {
    setSelectedTemplateIds((current) =>
      current.includes(templateId)
        ? current.filter((id) => id !== templateId)
        : [...current, templateId],
    );
  };

  const setSelectedMapped = async (mapped: boolean) => {
    const templates = selectedItems.filter((item) => item.mapped !== mapped);
    if (templates.length === 0) return;

    setBatchSaving(true);
    try {
      for (const template of templates) {
        const response = await apiFetch<{ ok: true; mappingId: string | null }>(
          `/admin/assets/garment-types/${sub.id}/templates/${template.id}`,
          { method: 'PATCH', body: JSON.stringify({ mapped }) },
        );
        setItems((current) =>
          current.map((item) =>
            item.id === template.id ? { ...item, mapped, mappingId: response.mappingId } : item,
          ),
        );
      }
      setSelectedTemplateIds([]);
    } catch (error) {
      void load();
      toast({
        kind: 'error',
        title: `Failed to ${mapped ? 'enable' : 'disable'} selected templates`,
        body: (error as Error).message,
      });
    } finally {
      setBatchSaving(false);
    }
  };
  return (
    <section>
      <SectionHeader
        n={2}
        title="Catalogue templates"
        description={`Select the ${sub.genderSlug} templates users can choose for ${sub.label}.`}
        right={
          !loading && (
            <span className="badge">
              {items.filter((item) => item.mapped).length} of {items.length} mapped
            </span>
          )
        }
      />
      {!loading && items.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 14,
            marginTop: 12,
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={allTemplatesSelected}
              disabled={batchSaving}
              onChange={() =>
                setSelectedTemplateIds(allTemplatesSelected ? [] : items.map((item) => item.id))
              }
              style={{ accentColor: 'var(--pink)' }}
            />
            <span style={{ fontSize: 12, fontWeight: 600 }}>Select all</span>
          </label>
          {selectedItems.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                {selectedItems.length} selected
              </span>
              <span style={{ fontSize: 12 }}>
                {selectedAllMapped ? 'Enabled' : 'Enable selected'}
              </span>
              <Switch
                checked={selectedAllMapped}
                onChange={() => void setSelectedMapped(!selectedAllMapped)}
              />
            </div>
          )}
        </div>
      )}
      {loading ? (
        <div style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--muted)' }}>
          Loading…
        </div>
      ) : items.length === 0 ? (
        <div
          className="card"
          style={{ marginTop: 14, padding: '2.5rem', textAlign: 'center', color: 'var(--muted)' }}
        >
          No global catalogue templates exist for {sub.genderSlug}.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
            gap: 12,
            marginTop: 14,
          }}
        >
          {items.map((item) => (
            <div
              key={item.id}
              className="card"
              onClick={() => {
                if (!batchSaving) toggleTemplateSelection(item.id);
              }}
              style={{
                padding: 0,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
                cursor: batchSaving ? 'default' : 'pointer',
                outline: selectedTemplateIds.includes(item.id)
                  ? '2px solid var(--pink)'
                  : item.mapped
                    ? '2px solid var(--pink)'
                    : undefined,
                opacity: savingId === item.id || batchSaving ? 0.7 : 1,
              }}
            >
              <label
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  zIndex: 1,
                  display: 'flex',
                  width: 26,
                  height: 26,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 5,
                  background: 'transparent',
                  cursor: batchSaving ? 'default' : 'pointer',
                }}
                onClick={(event) => event.stopPropagation()}
                title={`Select ${item.label}`}
              >
                <input
                  type="checkbox"
                  checked={selectedTemplateIds.includes(item.id)}
                  disabled={batchSaving}
                  onChange={() => toggleTemplateSelection(item.id)}
                  aria-label={`Select ${item.label}`}
                  style={{ accentColor: 'var(--pink)' }}
                />
              </label>
              <div
                style={{
                  background: 'var(--surface2, #1a1a1a)',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  aspectRatio: '3/4',
                }}
              >
                {item.thumbnailUrl ? (
                  // biome-ignore lint/performance/noImgElement: admin panel
                  <img
                    src={item.thumbnailUrl}
                    alt={item.label}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <Icon.Image />
                )}
              </div>
              <div style={{ padding: '9px 10px 10px' }}>
                <p
                  title={item.label}
                  style={{
                    margin: 0,
                    fontSize: 12,
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.label}
                </p>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: 9,
                  }}
                >
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {item.mapped ? `${item.poseAssetIds.length} poses` : 'Not offered'}
                  </span>
                  <div onClick={(event) => event.stopPropagation()}>
                    <Switch
                      checked={item.mapped}
                      onChange={() => void toggleMapped(item.id, !item.mapped)}
                    />
                  </div>
                </div>
                {item.mapped && item.mappingId && (
                  <button
                    className="btn sm"
                    style={{ width: '100%', marginTop: 9, justifyContent: 'center' }}
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditingTemplate(item);
                    }}
                  >
                    <Icon.Edit /> Configure workflows
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {editingTemplate?.mappingId && (
        <MappedTemplateWorkflowModal
          mapping={editingTemplate}
          garmentTypeLabel={sub.label}
          workflows={workflows}
          toast={toast}
          onClose={() => setEditingTemplate(null)}
        />
      )}
    </section>
  );
}

interface MappedTemplateWorkflowModalProps {
  mapping: TemplateGarmentTypeMapping;
  garmentTypeLabel: string;
  workflows: WorkflowOption[];
  toast: (opts: { kind?: 'error'; title: string; body?: string }) => void;
  onClose: () => void;
}

function MappedTemplateWorkflowModal({
  mapping,
  garmentTypeLabel,
  workflows,
  toast,
  onClose,
}: MappedTemplateWorkflowModalProps) {
  const [items, setItems] = useState<MappedTemplatePoseWorkflow[]>([]);
  const [looks, setLooks] = useState<MappedTemplateLook[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savingLookId, setSavingLookId] = useState<string | null>(null);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState('');

  useEffect(() => {
    setLoading(true);
    void Promise.all([
      apiFetch<{ items: MappedTemplatePoseWorkflow[] }>(
        `/admin/assets/catalogue-template-mappings/${mapping.mappingId}/poses`,
      ),
      apiFetch<{ items: MappedTemplateLook[] }>(
        `/admin/assets/catalogue-template-mappings/${mapping.mappingId}/looks`,
      ),
    ])
      .then(([posesResponse, looksResponse]) => {
        setItems(posesResponse.items);
        setLooks(looksResponse.items);
      })
      .catch((error) =>
        toast({
          kind: 'error',
          title: 'Failed to load template configuration',
          body: (error as Error).message,
        }),
      )
      .finally(() => setLoading(false));
  }, [mapping.mappingId, toast]);
  const setWorkflow = async (poseAssetId: string, workflowTemplateId: string | null) => {
    const previous = items;
    const currentItem = items.find((i) => i.id === poseAssetId);
    const workflowChanged = currentItem?.workflowTemplateId !== workflowTemplateId;
    // A workflow change (or clear) invalidates any saved prompt override - it was
    // written for a different workflow's prompt/node structure. Clear it instead of
    // letting it silently carry over, mirroring PoseConfigsPanel's existing
    // workflow-change convention.
    const promptGarmentPhase = workflowChanged ? null : (currentItem?.promptGarmentPhase ?? null);
    setSavingId(poseAssetId);
    setItems((current) =>
      current.map((item) =>
        item.id === poseAssetId
          ? {
              ...item,
              workflowTemplateId,
              promptGarmentPhase,
              source: workflowTemplateId ? 'manual' : item.source,
            }
          : item,
      ),
    );
    if (workflowChanged && editingPromptId === poseAssetId) closePromptEditor();
    try {
      const res = await apiFetch<{
        workflowTemplateId: string | null;
        source: 'auto' | 'manual' | null;
      }>(`/admin/assets/catalogue-template-mappings/${mapping.mappingId}/poses/${poseAssetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ workflowTemplateId, promptGarmentPhase }),
      });
      // The response reflects the row's actual resulting state, not an echo of the
      // request — clearing can immediately fall back to a live category default (a
      // different, non-null workflow), which the optimistic update above has no way
      // to predict. Sync from it so the modal never shows a stale "Workflow
      // required" after a clear that just repopulated a workflow, and never shows a
      // stale "auto" badge after an explicit pick.
      setItems((current) =>
        current.map((item) =>
          item.id === poseAssetId
            ? { ...item, workflowTemplateId: res.workflowTemplateId, source: res.source }
            : item,
        ),
      );
      toast({ title: res.workflowTemplateId ? 'Pose workflow saved' : 'Pose workflow cleared' });
    } catch (error) {
      setItems(previous);
      toast({
        kind: 'error',
        title: 'Failed to save pose workflow',
        body: (error as Error).message,
      });
    } finally {
      setSavingId(null);
    }
  };

  const openPromptEditor = (item: MappedTemplatePoseWorkflow) => {
    const assignedWorkflow = workflows.find((w) => w.id === item.workflowTemplateId);
    setPromptDraft(item.promptGarmentPhase ?? assignedWorkflow?.defaultGarmentPhasePrompt ?? '');
    setEditingPromptId(item.id);
  };

  const closePromptEditor = () => {
    setEditingPromptId(null);
    setPromptDraft('');
  };

  const savePrompt = async (poseAssetId: string) => {
    const item = items.find((i) => i.id === poseAssetId);
    if (!item?.workflowTemplateId) return;
    const previous = items;
    setSavingId(poseAssetId);
    const promptGarmentPhase = promptDraft || null;
    setItems((current) =>
      current.map((i) =>
        i.id === poseAssetId ? { ...i, promptGarmentPhase, source: 'manual' } : i,
      ),
    );
    try {
      const res = await apiFetch<{
        workflowTemplateId: string | null;
        source: 'auto' | 'manual' | null;
      }>(`/admin/assets/catalogue-template-mappings/${mapping.mappingId}/poses/${poseAssetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ workflowTemplateId: item.workflowTemplateId, promptGarmentPhase }),
      });
      setItems((current) =>
        current.map((i) =>
          i.id === poseAssetId
            ? { ...i, workflowTemplateId: res.workflowTemplateId, source: res.source }
            : i,
        ),
      );
      toast({ title: promptGarmentPhase ? 'Prompt saved' : 'Prompt override cleared' });
      closePromptEditor();
    } catch (error) {
      setItems(previous);
      toast({
        kind: 'error',
        title: 'Failed to save prompt',
        body: (error as Error).message,
      });
    } finally {
      setSavingId(null);
    }
  };

  const setLookEnabled = async (lookId: string, isEnabled: boolean) => {
    const previous = looks;
    setSavingLookId(lookId);
    setLooks((current) =>
      current.map((look) => (look.id === lookId ? { ...look, isEnabled } : look)),
    );
    try {
      await apiFetch<{ ok: true; isEnabled: boolean }>(
        `/admin/assets/catalogue-template-mappings/${mapping.mappingId}/looks/${lookId}`,
        { method: 'PATCH', body: JSON.stringify({ isEnabled }) },
      );
    } catch (error) {
      setLooks(previous);
      toast({
        kind: 'error',
        title: 'Failed to update look visibility',
        body: (error as Error).message,
      });
    } finally {
      setSavingLookId(null);
    }
  };
  const looksByPoseId = new Map<string, MappedTemplateLook[]>();
  for (const look of looks) {
    const poseLooks = looksByPoseId.get(look.poseAssetId) ?? [];
    poseLooks.push(look);
    looksByPoseId.set(look.poseAssetId, poseLooks);
  }
  const configuredCount = items.filter((item) => item.workflowTemplateId).length;
  return (
    <EditDrawer
      onClose={onClose}
      title={mapping.label}
      subtitle={`${garmentTypeLabel} / ${configuredCount} of ${items.length} poses ready`}
      width="min(820px, calc(100vw - 64px))"
      saving={!!savingId || !!savingLookId}
      onSave={onClose}
      saveLabel="Done"
    >
      {loading ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted)' }}>
          Loading poses...
        </div>
      ) : items.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted)' }}>
          Add looks to the global template before configuring workflows.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {items.map((item) => (
            <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                className="card"
                style={{
                  padding: 10,
                  display: 'grid',
                  gridTemplateColumns: '58px minmax(140px, 1fr) minmax(220px, 1.4fr) auto',
                  alignItems: 'center',
                  gap: 12,
                  outline: item.workflowTemplateId ? '1px solid var(--pink)' : undefined,
                  opacity: savingId === item.id ? 0.65 : 1,
                }}
              >
                {/* biome-ignore lint/performance/noImgElement: admin panel */}
                <img
                  src={item.thumbnailUrl}
                  alt={item.displayName ?? item.label}
                  style={{ width: 58, height: 68, borderRadius: 8, objectFit: 'cover' }}
                />
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 650 }}>
                    {item.displayName ?? item.label}
                  </p>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                    <span
                      className={`badge ${item.workflowTemplateId ? 'dot accent' : ''}`}
                      style={{ fontSize: 9 }}
                    >
                      {item.workflowTemplateId ? 'Ready' : 'Workflow required'}
                    </span>
                    {item.workflowTemplateId && item.source === 'auto' && (
                      <span
                        className="badge"
                        style={{ fontSize: 9, opacity: 0.7 }}
                        title="Filled from this garment type's shot-type default — picking a workflow here overrides it"
                      >
                        auto
                      </span>
                    )}
                    {item.promptGarmentPhase && (
                      <span className="badge dot" style={{ fontSize: 9 }}>
                        Custom prompt
                      </span>
                    )}
                  </div>
                </div>
                <SearchableSelect
                  options={workflows.map((w) => ({ id: w.id, label: w.label }))}
                  value={item.workflowTemplateId ?? ''}
                  disabled={savingId === item.id}
                  onChange={(val) => void setWorkflow(item.id, val || null)}
                  emptyLabel="Select workflow..."
                  placeholder="— search workflow —"
                  ariaLabel={`Workflow for ${item.displayName ?? item.label}`}
                />
                <div style={{ display: 'grid', justifyItems: 'end', gap: 7 }}>
                  <button
                    className="btn sm ghost"
                    disabled={!item.workflowTemplateId || savingId === item.id}
                    onClick={() =>
                      editingPromptId === item.id ? closePromptEditor() : openPromptEditor(item)
                    }
                  >
                    <Icon.MessageSquare /> Prompt
                  </button>
                  {(looksByPoseId.get(item.id) ?? []).map((look) => (
                    <div
                      key={look.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                      title={`Visible for ${garmentTypeLabel}: ${look.backgroundLabel}`}
                    >
                      <span style={{ color: 'var(--muted)', fontSize: 10 }}>
                        {look.isEnabled ? 'Visible' : 'Hidden'}
                      </span>
                      <Switch
                        checked={look.isEnabled}
                        onChange={() => void setLookEnabled(look.id, !look.isEnabled)}
                      />
                    </div>
                  ))}
                </div>
              </div>
              {editingPromptId === item.id && (
                <div className="card" style={{ padding: 10 }}>
                  <div className="field">
                    <label>Garment-phase prompt override</label>
                    <textarea
                      className="input"
                      rows={6}
                      placeholder="Inherited from workflow default"
                      value={promptDraft}
                      disabled={savingId === item.id}
                      onChange={(e) => setPromptDraft(e.target.value)}
                      style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                    />
                    <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
                      Used only for this pose within this template/garment-type mapping. Leave blank
                      to use the assigned workflow's own default prompt.
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'flex-end',
                      gap: 8,
                      marginTop: 10,
                    }}
                  >
                    <button
                      className="btn sm ghost"
                      disabled={savingId === item.id}
                      onClick={closePromptEditor}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn sm primary"
                      disabled={savingId === item.id}
                      onClick={() => void savePrompt(item.id)}
                    >
                      {savingId === item.id ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </EditDrawer>
  );
}

const effectiveWorkflowId = (item: PoseGarmentConfig) =>
  item.config?.workflowTemplateId ?? item.defaultWorkflowTemplateId;

interface PoseConfigsPanelProps {
  sub: GarmentType;
  items: PoseGarmentConfig[];
  loading: boolean;
  savingId: string | null;
  workflows: WorkflowOption[];
  onSave: (
    garmentTypeId: string,
    poseAssetId: string,
    patch: {
      workflowTemplateId: string | null;
      promptGarmentPhase: string | null;
      promptFacePhase: string | null;
      isActive: boolean | null;
    },
  ) => Promise<void>;
  onToggleActive: (poseAssetId: string, isActive: boolean) => Promise<void>;
  onSaveDefaultPose: (garmentTypeId: string, poseAssetId: string | null) => Promise<void>;
  savingDefaultPose: boolean;
}

function PoseConfigsPanel({
  sub,
  items,
  loading,
  savingId,
  workflows,
  onSave,
  onToggleActive,
  onSaveDefaultPose,
  savingDefaultPose,
}: PoseConfigsPanelProps) {
  const [editing, setEditing] = useState<PoseGarmentConfig | null>(null);
  const [editWorkflow, setEditWorkflow] = useState('');
  const [editGarmentPrompt, setEditGarmentPrompt] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkWorkflow, setBulkWorkflow] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);
  // '' = all workflows, 'none' = poses with no workflow assigned (override or default), else a workflow id
  const [workflowFilter, setWorkflowFilter] = useState('');

  const filteredItems = useMemo(() => {
    if (!workflowFilter) return items;
    if (workflowFilter === 'none') return items.filter((i) => !effectiveWorkflowId(i));
    return items.filter((i) => effectiveWorkflowId(i) === workflowFilter);
  }, [items, workflowFilter]);

  // Only offer workflows actually in use on this page's poses, not every workflow in the system.
  const usedWorkflowIds = useMemo(
    () => [...new Set(items.map(effectiveWorkflowId).filter((id): id is string => !!id))],
    [items],
  );
  const usedWorkflowOptions = useMemo(
    () => usedWorkflowIds.map((id) => workflows.find((w) => w.id === id)).filter((w) => !!w),
    [usedWorkflowIds, workflows],
  );
  const hasUnassignedPose = items.some((i) => !effectiveWorkflowId(i));

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const selectAll = () => setSelectedIds(filteredItems.map((i) => i.id));
  const clearSelection = () => setSelectedIds([]);

  const applyBulkWorkflow = async () => {
    if (!bulkWorkflow || selectedIds.length === 0) return;
    setBulkSaving(true);
    try {
      // Follow the selected workflow's own default prompt — same convention as the
      // pose-asset-level bulk-workflow route — so applying a workflow in bulk doesn't
      // leave a stale prompt (or a mismatched one inherited from whatever was there before).
      const wf = workflows.find((w) => w.id === bulkWorkflow);
      await Promise.all(
        selectedIds.map((id) => {
          const item = items.find((i) => i.id === id);
          return onSave(sub.id, id, {
            workflowTemplateId: bulkWorkflow,
            promptGarmentPhase: wf?.defaultGarmentPhasePrompt || null,
            promptFacePhase: null,
            isActive: item?.config?.isActive ?? null,
          });
        }),
      );
      clearSelection();
      setBulkWorkflow('');
    } finally {
      setBulkSaving(false);
    }
  };

  const applyBulkActive = async (active: boolean) => {
    if (selectedIds.length === 0) return;
    setBulkSaving(true);
    try {
      // Same path the per-card Switch uses — preserves any workflow/prompt override
      // instead of wiping it the way "Clear override" does.
      await Promise.all(selectedIds.map((id) => onToggleActive(id, active)));
      clearSelection();
    } finally {
      setBulkSaving(false);
    }
  };

  const applyBulkClearOverride = async () => {
    if (selectedIds.length === 0) return;
    setBulkSaving(true);
    try {
      await Promise.all(
        selectedIds.map((id) =>
          onSave(sub.id, id, {
            workflowTemplateId: null,
            promptGarmentPhase: null,
            promptFacePhase: null,
            isActive: null,
          }),
        ),
      );
      clearSelection();
      setBulkWorkflow('');
    } finally {
      setBulkSaving(false);
    }
  };

  const openEdit = (item: PoseGarmentConfig) => {
    setEditing(item);
    setEditWorkflow(item.config?.workflowTemplateId ?? '');
    // Pre-fill with override if set, else inherit pose default so user edits from it
    setEditGarmentPrompt(item.config?.promptGarmentPhase ?? item.defaultPromptGarmentPhase ?? '');
  };

  const closeEdit = () => {
    setEditing(null);
    setEditWorkflow('');
    setEditGarmentPrompt('');
  };

  const doSave = async () => {
    if (!editing) return;
    await onSave(sub.id, editing.id, {
      workflowTemplateId: editWorkflow || null,
      promptGarmentPhase: editGarmentPrompt || null,
      promptFacePhase: null,
      // This modal only edits workflow/prompt — preserve whatever active override
      // (if any) is already set via the card's Switch, rather than clearing it.
      isActive: editing.config?.isActive ?? null,
    });
    closeEdit();
  };

  if (loading) {
    return (
      <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
    );
  }

  if (items.length === 0) {
    return (
      <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted)' }}>
        No active poses for {sub.genderSlug}.
      </div>
    );
  }

  return (
    <>
      {/* Bulk action bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 12,
          marginBottom: 4,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <select
            className="select"
            style={{ fontSize: 12, padding: '3px 8px', height: 30 }}
            value={workflowFilter}
            onChange={(e) => {
              setWorkflowFilter(e.target.value);
              clearSelection();
            }}
          >
            <option value="">Filter: all workflows</option>
            {hasUnassignedPose && <option value="none">No workflow assigned</option>}
            {usedWorkflowOptions.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
          <button
            className="btn sm ghost"
            onClick={
              selectedIds.length === filteredItems.length && filteredItems.length > 0
                ? clearSelection
                : selectAll
            }
          >
            {selectedIds.length === filteredItems.length && filteredItems.length > 0
              ? 'Deselect all'
              : 'Select all'}
          </button>
          {selectedIds.length > 0 && (
            <>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {selectedIds.length} selected
              </span>
              <SearchableSelect
                options={workflows.map((w) => ({ id: w.id, label: w.label }))}
                value={bulkWorkflow}
                disabled={bulkSaving}
                onChange={(val) => setBulkWorkflow(val)}
                emptyLabel="Pick workflow…"
                placeholder="— search workflow —"
                style={{ fontSize: 12, padding: '3px 8px', height: 30 }}
              />
              <button
                className="btn sm primary"
                disabled={!bulkWorkflow || bulkSaving}
                onClick={() => void applyBulkWorkflow()}
              >
                {bulkSaving ? 'Applying…' : 'Apply workflow'}
              </button>
              <button
                className="btn sm ghost"
                disabled={bulkSaving}
                onClick={() => void applyBulkActive(false)}
              >
                {bulkSaving ? 'Disabling…' : 'Bulk disable'}
              </button>
              <button
                className="btn sm ghost"
                disabled={bulkSaving}
                onClick={() => void applyBulkActive(true)}
              >
                {bulkSaving ? 'Enabling…' : 'Bulk enable'}
              </button>
              <button
                className="btn sm ghost"
                disabled={bulkSaving}
                onClick={() => void applyBulkClearOverride()}
              >
                {bulkSaving ? 'Clearing…' : 'Clear override'}
              </button>
              <button className="btn sm ghost" onClick={clearSelection} disabled={bulkSaving}>
                Clear
              </button>
            </>
          )}
        </div>
      </div>

      <div className="field" style={{ maxWidth: 360, margin: '12px 0' }}>
        <label>Default pose (merchant catalogue generation)</label>
        <SearchableSelect
          options={items
            .filter((i) => i.isActive)
            .map((i) => ({ id: i.id, label: i.displayName ?? i.label }))}
          value={sub.defaultPoseId ?? ''}
          disabled={savingDefaultPose}
          onChange={(val) => void onSaveDefaultPose(sub.id, val || null)}
          emptyLabel="— none (generation disabled for this type) —"
          placeholder="— search pose —"
        />
        <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
          Used when a merchant uploads a flat garment for this type — the pose (and its workflow) is
          fixed so every generated image is try-on-suitable.
        </span>
      </div>

      {filteredItems.length === 0 && (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>
          No poses match this filter.
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 12,
          marginTop: 8,
        }}
      >
        {filteredItems.map((item) => {
          const overrideWorkflow = item.config?.workflowTemplateId
            ? workflows.find((w) => w.id === item.config?.workflowTemplateId)?.label
            : null;
          const defaultWorkflow = item.defaultWorkflowTemplateId
            ? workflows.find((w) => w.id === item.defaultWorkflowTemplateId)?.label
            : null;
          const hasWorkflowOverride = !!item.config?.workflowTemplateId;
          const hasPromptOverride = !!item.config?.promptGarmentPhase;
          const hasActiveOverride =
            item.config?.isActive !== null && item.config?.isActive !== undefined;
          const hasOverride = hasWorkflowOverride || hasPromptOverride || hasActiveOverride;

          return (
            <div
              key={item.id}
              className="card"
              style={{
                padding: 0,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                outline: selectedIds.includes(item.id)
                  ? '2px solid var(--accent)'
                  : hasOverride
                    ? '2px solid var(--pink)'
                    : undefined,
                opacity: item.isActive ? 1 : 0.55,
              }}
            >
              <div
                style={{
                  background: 'var(--surface2, #1a1a1a)',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  aspectRatio: '3/4',
                  position: 'relative',
                }}
              >
                <AssetThumb thumbnailUrl={item.thumbnailUrl} label={item.label} w={160} h={210} />
                <input
                  type="checkbox"
                  checked={selectedIds.includes(item.id)}
                  onChange={() => toggleSelect(item.id)}
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
                  title={item.displayName ?? item.label}
                >
                  {item.displayName ?? item.label}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 4 }}>
                  {overrideWorkflow ? (
                    <span
                      className="badge dot accent"
                      style={{ fontSize: 10 }}
                      title="Override workflow"
                    >
                      {overrideWorkflow}
                    </span>
                  ) : defaultWorkflow ? (
                    <span
                      className="badge"
                      style={{ fontSize: 10, opacity: 0.6 }}
                      title="Default workflow"
                    >
                      {defaultWorkflow}
                    </span>
                  ) : null}
                  {hasPromptOverride && (
                    <span
                      className="badge dot"
                      style={{ fontSize: 10, background: 'var(--pink)', color: '#fff' }}
                      title="Override positive prompt"
                    >
                      prompt overridden
                    </span>
                  )}
                  {hasActiveOverride && (
                    <span
                      className="badge dot"
                      style={{ fontSize: 10, background: 'var(--pink)', color: '#fff' }}
                      title={`This pose is ${item.config?.isActive ? 'force-enabled' : 'disabled'} for ${sub.label} only — the global toggle on the Pose Assets tab is unaffected`}
                    >
                      {item.config?.isActive ? 'enabled here only' : 'disabled here only'}
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
                  <Switch
                    checked={item.isActive}
                    onChange={() => void onToggleActive(item.id, !item.isActive)}
                  />
                  <button
                    className="btn ghost"
                    style={{ fontSize: 10, padding: '3px 8px' }}
                    onClick={() => openEdit(item)}
                  >
                    <Icon.Edit /> Set workflow
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Edit override modal */}
      {editing && (
        <EditDrawer
          onClose={closeEdit}
          title={`${sub.label} — ${editing.displayName ?? editing.label}`}
          width="min(720px, calc(100vw - 80px))"
          saving={savingId === editing.id}
          onSave={() => void doSave()}
          saveLabel="Save"
        >
          <div className="field">
            <label>Workflow override</label>
            <SearchableSelect
              options={workflows.map((w) => ({ id: w.id, label: w.label }))}
              value={editWorkflow}
              disabled={savingId === editing.id}
              onChange={(newId) => {
                setEditWorkflow(newId);
                // Always follow the newly selected workflow's own default prompt — same
                // convention as the pose-asset-level edit modal — so switching workflows
                // here doesn't keep sending the previous workflow's prompt text. Admin can
                // still hand-edit the textarea below before saving to customize further.
                const wf = newId ? workflows.find((w) => w.id === newId) : null;
                setEditGarmentPrompt(
                  wf?.defaultGarmentPhasePrompt ?? editing.defaultPromptGarmentPhase ?? '',
                );
              }}
              emptyLabel={`Use default (${
                editing.defaultWorkflowTemplateId
                  ? (workflows.find((w) => w.id === editing.defaultWorkflowTemplateId)?.label ??
                    '?')
                  : 'none'
              })`}
              placeholder="— search workflow —"
            />
            <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
              Changing this updates the prompt below to that workflow's own default — edit it after
              to customize further.
            </span>
          </div>
          <div className="field">
            <label>Positive prompt</label>
            <textarea
              className="input"
              rows={10}
              placeholder="Inherited from pose"
              value={editGarmentPrompt}
              disabled={savingId === editing.id}
              onChange={(e) => setEditGarmentPrompt(e.target.value)}
              style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
            />
          </div>
          {editing.config && (
            <button
              className="btn ghost"
              disabled={savingId === editing.id}
              style={{ alignSelf: 'flex-start' }}
              onClick={() =>
                void onSave(sub.id, editing.id, {
                  workflowTemplateId: null,
                  promptGarmentPhase: null,
                  promptFacePhase: null,
                  isActive: null,
                }).then(closeEdit)
              }
            >
              Clear override
            </button>
          )}
        </EditDrawer>
      )}
    </>
  );
}
