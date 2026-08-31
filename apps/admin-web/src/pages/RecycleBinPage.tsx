import { useCallback, useEffect, useState } from 'react';
import { Pager } from '../components/Pager';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage, apiFetch } from '../lib/data';
import type { ModelBackground, ModelFace, ModelPoseAsset } from '../types';

const PAGE_SIZE = 50;

type RbTab = 'faces' | 'backgrounds' | 'poseAssets';

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

function Thumb({ thumbnailUrl, label }: { thumbnailUrl: string | null; label: string }) {
  const src = thumbnailUrl;
  if (src) {
    return (
      // biome-ignore lint/performance/noImgElement: thumbnail in recycle bin table
      <img
        src={src}
        alt={label}
        loading="lazy"
        style={{ width: 36, height: 36, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }}
      />
    );
  }
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: 4,
        background: 'var(--subtle)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--muted)',
      }}
    >
      {label.slice(0, 2).toUpperCase()}
    </div>
  );
}

export default function RecycleBinPage({ toast }: Props) {
  const { hasPermission } = useAuth();
  const canHardDelete = hasPermission('assets.delete');
  const [loading, setLoading] = useState(false);
  const [faces, setFaces] = useState<ModelFace[]>([]);
  const [backgrounds, setBackgrounds] = useState<ModelBackground[]>([]);
  const [poseAssets, setPoseAssets] = useState<ModelPoseAsset[]>([]);
  const [tab, setTab] = useState<RbTab>('faces');
  const [selectedFaceIds, setSelectedFaceIds] = useState<string[]>([]);
  const [selectedBgIds, setSelectedBgIds] = useState<string[]>([]);
  const [selectedPaIds, setSelectedPaIds] = useState<string[]>([]);
  const [permDel, setPermDel] = useState<{
    type: 'face' | 'background' | 'poseAsset';
    ids: string[];
  } | null>(null);
  const [permDelText, setPermDelText] = useState('');
  const [working, setWorking] = useState(false);
  const [facePage, setFacePage] = useState(0);
  const [bgPage, setBgPage] = useState(0);
  const [paPage, setPaPage] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{
        faces: ModelFace[];
        backgrounds: ModelBackground[];
        poseAssets: ModelPoseAsset[];
      }>('/admin/assets/recycle-bin');
      setFaces(res.faces);
      setBackgrounds(res.backgrounds);
      setPoseAssets(res.poseAssets);
      setSelectedFaceIds([]);
      setSelectedBgIds([]);
      setSelectedPaIds([]);
      setFacePage(0);
      setBgPage(0);
      setPaPage(0);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to load recycle bin',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function restore(type: 'face' | 'background' | 'poseAsset', ids: string[], label: string) {
    setWorking(true);
    try {
      await apiFetch('/admin/assets/recycle-bin/restore', {
        method: 'POST',
        body: JSON.stringify({ type, ids }),
      });
      toast({ title: `${label} restored` });
      void load();
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Restore failed',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setWorking(false);
    }
  }

  const selectedIds =
    tab === 'faces' ? selectedFaceIds : tab === 'backgrounds' ? selectedBgIds : selectedPaIds;
  const currentType = tab === 'faces' ? 'face' : tab === 'backgrounds' ? 'background' : 'poseAsset';
  const currentItems = tab === 'faces' ? faces : tab === 'backgrounds' ? backgrounds : poseAssets;
  const pagedFaces = faces.slice(facePage * PAGE_SIZE, (facePage + 1) * PAGE_SIZE);
  const pagedBgs = backgrounds.slice(bgPage * PAGE_SIZE, (bgPage + 1) * PAGE_SIZE);
  const pagedPas = poseAssets.slice(paPage * PAGE_SIZE, (paPage + 1) * PAGE_SIZE);

  function pluralLabel(type: 'face' | 'background' | 'poseAsset', n: number) {
    if (type === 'face') return n === 1 ? 'face' : 'faces';
    if (type === 'background') return n === 1 ? 'background' : 'backgrounds';
    return n === 1 ? 'pose asset' : 'pose assets';
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Recycle bin</h1>
          <p className="lede">
            Soft-deleted assets. Restore to bring back; permanently delete to remove R2 files.
          </p>
        </div>
        <div className="head-tools">
          <button className="btn ghost" onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="tabs">
        {(
          [
            { k: 'faces', l: `Faces (${faces.length})` },
            { k: 'backgrounds', l: `Backgrounds (${backgrounds.length})` },
            { k: 'poseAssets', l: `Pose assets (${poseAssets.length})` },
          ] as { k: RbTab; l: string }[]
        ).map((t) => (
          <button
            key={t.k}
            className={`tab ${tab === t.k ? 'active' : ''}`}
            onClick={() => {
              setTab(t.k);
              setFacePage(0);
              setBgPage(0);
              setPaPage(0);
            }}
          >
            {t.l}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>Loading…</div>
      ) : currentItems.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '3rem' }}>
          No deleted {pluralLabel(currentType, 2)}
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              padding: '10px 0',
              marginBottom: 4,
              flexWrap: 'wrap',
            }}
          >
            {/* Select page button */}
            {(() => {
              const pagedIds =
                tab === 'faces'
                  ? pagedFaces.map((f) => f.id)
                  : tab === 'backgrounds'
                    ? pagedBgs.map((b) => b.id)
                    : pagedPas.map((p) => p.id);
              const pageSelected =
                pagedIds.length > 0 && pagedIds.every((id) => selectedIds.includes(id));
              return (
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    if (tab === 'faces')
                      setSelectedFaceIds((prev) =>
                        pageSelected
                          ? prev.filter((id) => !pagedIds.includes(id))
                          : [...new Set([...prev, ...pagedIds])],
                      );
                    else if (tab === 'backgrounds')
                      setSelectedBgIds((prev) =>
                        pageSelected
                          ? prev.filter((id) => !pagedIds.includes(id))
                          : [...new Set([...prev, ...pagedIds])],
                      );
                    else
                      setSelectedPaIds((prev) =>
                        pageSelected
                          ? prev.filter((id) => !pagedIds.includes(id))
                          : [...new Set([...prev, ...pagedIds])],
                      );
                  }}
                >
                  {pageSelected ? 'Deselect page' : 'Select page'}
                </button>
              );
            })()}
            {/* Select all button */}
            {(() => {
              const allIds = currentItems.map((i) => i.id);
              const allSelected =
                allIds.length > 0 && allIds.every((id) => selectedIds.includes(id));
              return (
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    if (tab === 'faces') setSelectedFaceIds(allSelected ? [] : allIds);
                    else if (tab === 'backgrounds') setSelectedBgIds(allSelected ? [] : allIds);
                    else setSelectedPaIds(allSelected ? [] : allIds);
                  }}
                >
                  {allSelected ? 'Deselect all' : `Select all ${allIds.length}`}
                </button>
              );
            })()}
            {selectedIds.length > 0 && (
              <>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                  {selectedIds.length} selected
                </span>
                <button
                  className="btn sm ghost"
                  disabled={working}
                  onClick={() =>
                    void restore(
                      currentType,
                      selectedIds,
                      `${selectedIds.length} ${pluralLabel(currentType, selectedIds.length)}`,
                    )
                  }
                >
                  Restore {selectedIds.length}
                </button>
                {canHardDelete && (
                  <button
                    className="btn sm danger"
                    disabled={working}
                    onClick={() => {
                      setPermDel({ type: currentType, ids: selectedIds });
                      setPermDelText('');
                    }}
                  >
                    Permanently delete {selectedIds.length}
                  </button>
                )}
              </>
            )}
          </div>

          <div className="table-wrap">
            {tab === 'faces' && (
              <>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }} />
                      <th>Face</th>
                      <th>Gender</th>
                      <th>Deleted</th>
                      <th style={{ width: 90 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {pagedFaces.map((f) => (
                      <tr key={f.id}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedFaceIds.includes(f.id)}
                            onChange={(e) =>
                              setSelectedFaceIds((prev) =>
                                e.target.checked ? [...prev, f.id] : prev.filter((x) => x !== f.id),
                              )
                            }
                          />
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Thumb thumbnailUrl={f.thumbnailUrl} label={f.label} />
                            <span>{f.label}</span>
                          </div>
                        </td>
                        <td style={{ color: 'var(--muted)' }}>{f.gender}</td>
                        <td style={{ color: 'var(--muted)', fontSize: 12 }}>
                          {f.deletedAt ? new Date(f.deletedAt).toLocaleDateString() : '—'}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              className="btn sm ghost"
                              disabled={working}
                              onClick={() => void restore('face', [f.id], f.label)}
                            >
                              Restore
                            </button>
                            {canHardDelete && (
                              <button
                                className="btn sm danger"
                                disabled={working}
                                onClick={() => {
                                  setPermDel({ type: 'face', ids: [f.id] });
                                  setPermDelText('');
                                }}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {Math.ceil(faces.length / PAGE_SIZE) > 1 && (
                  <Pager
                    page={facePage}
                    totalPages={Math.ceil(faces.length / PAGE_SIZE)}
                    onPage={setFacePage}
                    totalItems={faces.length}
                    pageSize={PAGE_SIZE}
                  />
                )}
              </>
            )}

            {tab === 'backgrounds' && (
              <>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }} />
                      <th>Background</th>
                      <th>Gender</th>
                      <th>Deleted</th>
                      <th style={{ width: 90 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {pagedBgs.map((b) => (
                      <tr key={b.id}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedBgIds.includes(b.id)}
                            onChange={(e) =>
                              setSelectedBgIds((prev) =>
                                e.target.checked ? [...prev, b.id] : prev.filter((x) => x !== b.id),
                              )
                            }
                          />
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Thumb thumbnailUrl={b.thumbnailUrl} label={b.label} />
                            <span>{b.label}</span>
                          </div>
                        </td>
                        <td style={{ color: 'var(--muted)' }}>{b.genderSlug ?? 'all'}</td>
                        <td style={{ color: 'var(--muted)', fontSize: 12 }}>
                          {b.deletedAt ? new Date(b.deletedAt).toLocaleDateString() : '—'}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              className="btn sm ghost"
                              disabled={working}
                              onClick={() => void restore('background', [b.id], b.label)}
                            >
                              Restore
                            </button>
                            {canHardDelete && (
                              <button
                                className="btn sm danger"
                                disabled={working}
                                onClick={() => {
                                  setPermDel({ type: 'background', ids: [b.id] });
                                  setPermDelText('');
                                }}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {Math.ceil(backgrounds.length / PAGE_SIZE) > 1 && (
                  <Pager
                    page={bgPage}
                    totalPages={Math.ceil(backgrounds.length / PAGE_SIZE)}
                    onPage={setBgPage}
                    totalItems={backgrounds.length}
                    pageSize={PAGE_SIZE}
                  />
                )}
              </>
            )}

            {tab === 'poseAssets' && (
              <>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }} />
                      <th>Pose asset</th>
                      <th>Gender</th>
                      <th>Variant</th>
                      <th>Deleted</th>
                      <th style={{ width: 90 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {pagedPas.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedPaIds.includes(p.id)}
                            onChange={(e) =>
                              setSelectedPaIds((prev) =>
                                e.target.checked ? [...prev, p.id] : prev.filter((x) => x !== p.id),
                              )
                            }
                          />
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Thumb thumbnailUrl={p.thumbnailUrl} label={p.label} />
                            <span>{p.displayName ?? p.label}</span>
                          </div>
                        </td>
                        <td style={{ color: 'var(--muted)' }}>{p.genderSlug ?? '—'}</td>
                        <td style={{ color: 'var(--muted)' }}>{p.poseVariant ?? '—'}</td>
                        <td style={{ color: 'var(--muted)', fontSize: 12 }}>
                          {p.deletedAt ? new Date(p.deletedAt).toLocaleDateString() : '—'}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              className="btn sm ghost"
                              disabled={working}
                              onClick={() =>
                                void restore('poseAsset', [p.id], p.displayName ?? p.label)
                              }
                            >
                              Restore
                            </button>
                            {canHardDelete && (
                              <button
                                className="btn sm danger"
                                disabled={working}
                                onClick={() => {
                                  setPermDel({ type: 'poseAsset', ids: [p.id] });
                                  setPermDelText('');
                                }}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {Math.ceil(poseAssets.length / PAGE_SIZE) > 1 && (
                  <Pager
                    page={paPage}
                    totalPages={Math.ceil(poseAssets.length / PAGE_SIZE)}
                    onPage={setPaPage}
                    totalItems={poseAssets.length}
                    pageSize={PAGE_SIZE}
                  />
                )}
              </>
            )}
          </div>
        </>
      )}

      {permDel && (
        <div
          className="modal-overlay"
          onClick={() => {
            setPermDel(null);
            setPermDelText('');
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Permanently delete</h3>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: 12 }}>
                Permanently delete{' '}
                <strong>
                  {permDel.ids.length} {pluralLabel(permDel.type, permDel.ids.length)}
                </strong>{' '}
                and their R2 files. Cannot be undone.
              </p>
              <p style={{ marginBottom: 8, fontSize: 13, color: 'var(--muted)' }}>
                Type the following to confirm:
              </p>
              <div
                style={{
                  fontFamily: 'monospace',
                  fontSize: 13,
                  fontWeight: 700,
                  color: 'var(--danger)',
                  background: 'rgba(var(--danger-rgb, 220,53,69), 0.08)',
                  border: '1px solid var(--danger)',
                  borderRadius: 6,
                  padding: '8px 12px',
                  marginBottom: 12,
                  userSelect: 'all',
                  letterSpacing: '0.01em',
                }}
              >
                permanently delete {permDel.ids.length}{' '}
                {pluralLabel(permDel.type, permDel.ids.length)} and remove from storage
              </div>
              <input
                className="input"
                value={permDelText}
                onChange={(e) => setPermDelText(e.target.value)}
                placeholder="Type the phrase above"
                style={{ width: '100%' }}
              />
            </div>
            <div className="modal-foot">
              <button
                className="btn ghost"
                onClick={() => {
                  setPermDel(null);
                  setPermDelText('');
                }}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                disabled={
                  working ||
                  permDelText !==
                    `permanently delete ${permDel.ids.length} ${pluralLabel(permDel.type, permDel.ids.length)} and remove from storage`
                }
                onClick={async () => {
                  if (!permDel) return;
                  setWorking(true);
                  try {
                    await apiFetch('/admin/assets/recycle-bin', {
                      method: 'DELETE',
                      body: JSON.stringify(permDel),
                    });
                    toast({ title: `${permDel.ids.length} permanently deleted` });
                    setPermDel(null);
                    setPermDelText('');
                    void load();
                  } catch (e) {
                    toast({
                      kind: 'error',
                      title: 'Delete failed',
                      body: apiErrorMessage(e, 'Please try again.'),
                    });
                  } finally {
                    setWorking(false);
                  }
                }}
              >
                {working ? 'Deleting…' : 'Permanently delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
