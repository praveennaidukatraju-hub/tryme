import { useEffect, useMemo, useState } from 'react';
import { apiErrorMessage, apiFetch } from '../lib/data';
import { makeThumbnail } from '../lib/thumbnail';
import type {
  CatalogCategory,
  CatalogItem,
  GarmentType,
  TryonCategory,
  WorkflowOption,
} from '../types';
import { AssetThumb } from './AssetThumb';
import { EditDrawer } from './EditDrawer';
import { Icon } from './Icons';
import { PublicApiSlugField } from './PublicApiSlugField';
import { SearchableSelect } from './SearchableSelect';
import { Switch } from './Switch';

interface Props {
  garmentType: GarmentType;
  catalogItems: CatalogItem[];
  tryonCategories: TryonCategory[];
  workflows: WorkflowOption[];
  onSaved: (patch: Record<string, unknown>) => void;
  onClose: () => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

function UploadBox({
  label,
  hint,
  previewUrl,
  onPick,
  onRemove,
  disabled,
  size = 72,
}: {
  label: string;
  hint?: string;
  previewUrl: string | null;
  onPick: (f: File) => void;
  onRemove?: () => void;
  disabled: boolean;
  size?: number;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      {previewUrl ? (
        // biome-ignore lint/performance/noImgElement: admin panel
        <img
          src={previewUrl}
          alt=""
          style={{
            width: size,
            height: size,
            objectFit: 'cover',
            borderRadius: 10,
            border: '1px solid var(--border)',
            flexShrink: 0,
          }}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <div
          style={{
            width: size,
            height: size,
            borderRadius: 10,
            background: 'var(--surface-2)',
            border: '1.5px dashed var(--border-strong)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--muted)',
            flexShrink: 0,
          }}
        >
          <Icon.Image />
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <label className="btn sm" style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}>
            {previewUrl ? 'Replace' : 'Upload'} {label}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: 'none' }}
              disabled={disabled}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPick(f);
              }}
            />
          </label>
          {previewUrl && onRemove && (
            <button type="button" className="btn sm ghost" disabled={disabled} onClick={onRemove}>
              Remove
            </button>
          )}
        </div>
        {hint && <span className="hint">{hint}</span>}
      </div>
    </div>
  );
}

function PickerTile({
  selected,
  label,
  onClick,
  children,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <div
        style={{
          position: 'relative',
          borderRadius: 8,
          overflow: 'hidden',
          outline: selected ? '2px solid var(--accent)' : '1px solid var(--border)',
          outlineOffset: selected ? -2 : -1,
          boxShadow: selected ? '0 0 0 3px var(--accent-soft)' : undefined,
          transition: 'outline-color 100ms ease, box-shadow 100ms ease',
        }}
      >
        {children}
        {selected && (
          <div
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: 'var(--accent)',
              color: 'oklch(0.16 0.04 55)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon.Check />
          </div>
        )}
      </div>
      <span
        style={{
          fontSize: 11,
          color: selected ? 'var(--ink)' : 'var(--muted)',
          fontWeight: selected ? 500 : 400,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </button>
  );
}

function ItemPicker({
  type,
  gender,
  items,
  categories,
  selectedId,
  onSelect,
}: {
  type: 'lower' | 'shoe';
  gender: string;
  items: CatalogItem[];
  categories: CatalogCategory[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<number | 'all'>('all');

  const scoped = useMemo(
    () =>
      items.filter(
        (c) => c.type === type && c.isActive && (!c.genderSlug || c.genderSlug === gender),
      ),
    [items, type, gender],
  );
  const relevantCategories = useMemo(
    () =>
      categories
        .filter(
          (c) => c.typeSlug === type && c.isActive && (!c.genderSlug || c.genderSlug === gender),
        )
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [categories, type, gender],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scoped.filter(
      (c) =>
        (categoryFilter === 'all' || c.categoryId === categoryFilter) &&
        (!q || c.label.toLowerCase().includes(q)),
    );
  }, [scoped, categoryFilter, search]);

  const selectedItem = scoped.find((c) => c.id === selectedId);

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <div className="search" style={{ width: 180 }}>
          <Icon.Search />
          <input
            placeholder="Search items…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {relevantCategories.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`badge ${categoryFilter === 'all' ? 'accent' : ''}`}
              style={{ cursor: 'pointer', border: 'none' }}
              onClick={() => setCategoryFilter('all')}
            >
              All
            </button>
            {relevantCategories.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`badge ${categoryFilter === c.id ? 'accent' : ''}`}
                style={{ cursor: 'pointer', border: 'none' }}
                onClick={() => setCategoryFilter(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted)' }}>
          {selectedItem ? `Selected: ${selectedItem.label}` : 'None selected'}
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
          gap: 10,
          padding: 16,
          maxHeight: 300,
          overflowY: 'auto',
        }}
      >
        <PickerTile selected={selectedId === ''} label="None" onClick={() => onSelect('')}>
          <div
            style={{
              width: 88,
              height: 88,
              borderRadius: 8,
              background: 'var(--surface-2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--muted)',
              fontSize: 20,
            }}
          >
            —
          </div>
        </PickerTile>
        {filtered.map((c) => (
          <PickerTile
            key={c.id}
            selected={selectedId === c.id}
            label={c.label}
            onClick={() => onSelect(c.id === selectedId ? '' : c.id)}
          >
            <AssetThumb thumbnailUrl={c.thumbnailUrl} label={c.label} w={88} h={88} />
          </PickerTile>
        ))}
        {filtered.length === 0 && (
          <div
            style={{
              gridColumn: '1 / -1',
              padding: '20px 0',
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 13,
            }}
          >
            No items match.
          </div>
        )}
      </div>
    </div>
  );
}

export function EditGarmentTypeModal({
  garmentType,
  catalogItems,
  tryonCategories,
  workflows,
  onSaved,
  onClose,
  toast,
}: Props) {
  const [label, setLabel] = useState(garmentType.label);
  const [sortOrder, setSortOrder] = useState(garmentType.sortOrder);
  const [requiresLowerUpload, setRequiresLowerUpload] = useState(garmentType.requiresLowerUpload);
  const [upperUploadLabel, setUpperUploadLabel] = useState(garmentType.upperUploadLabel ?? '');
  const [lowerUploadLabel, setLowerUploadLabel] = useState(garmentType.lowerUploadLabel ?? '');
  const [requiresThirdUpload, setRequiresThirdUpload] = useState(
    garmentType.requiresThirdUpload ?? false,
  );
  const [thirdUploadLabel, setThirdUploadLabel] = useState(garmentType.thirdUploadLabel ?? '');
  const [defaultLowerId, setDefaultLowerId] = useState(garmentType.defaultLowerCatalogId ?? '');
  const [defaultShoeId, setDefaultShoeId] = useState(garmentType.defaultShoeCatalogId ?? '');
  const [tryonCategoryId, setTryonCategoryId] = useState(garmentType.tryonCategoryId ?? '');
  const [requiresMannequinStep, setRequiresMannequinStep] = useState(
    garmentType.requiresMannequinStep ?? false,
  );
  const [mannequinWorkflowTemplateId, setMannequinWorkflowTemplateId] = useState(
    garmentType.mannequinWorkflowTemplateId ?? '',
  );
  const [sareeStep2WorkflowTemplateId, setSareeStep2WorkflowTemplateId] = useState(
    garmentType.sareeStep2WorkflowTemplateId ?? '',
  );
  const [mannequinTwoInputWorkflowTemplateId, setMannequinTwoInputWorkflowTemplateId] = useState(
    garmentType.mannequinTwoInputWorkflowTemplateId ?? '',
  );
  const [twoInputTryonWorkflowTemplateId, setTwoInputTryonWorkflowTemplateId] = useState(
    garmentType.twoInputTryonWorkflowTemplateId ?? '',
  );
  const [publicApiSlug, setPublicApiSlug] = useState(garmentType.publicApiSlug ?? '');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [instructionFile, setInstructionFile] = useState<File | null>(null);
  const [removeInstructionImage, setRemoveInstructionImage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState<CatalogCategory[]>([]);

  useEffect(() => {
    apiFetch<CatalogCategory[]>('/admin/catalog/categories')
      .then(setCategories)
      .catch(() => {});
  }, []);

  const imagePreview = imageFile
    ? URL.createObjectURL(imageFile)
    : (garmentType.thumbnailUrl ?? null);
  const instructionPreview = instructionFile
    ? URL.createObjectURL(instructionFile)
    : removeInstructionImage
      ? null
      : (garmentType.instructionImageUrl ?? null);

  const dirty =
    !!imageFile ||
    !!instructionFile ||
    removeInstructionImage ||
    label.trim() !== garmentType.label.trim() ||
    sortOrder !== garmentType.sortOrder ||
    requiresLowerUpload !== garmentType.requiresLowerUpload ||
    upperUploadLabel !== (garmentType.upperUploadLabel ?? '') ||
    lowerUploadLabel !== (garmentType.lowerUploadLabel ?? '') ||
    requiresThirdUpload !== (garmentType.requiresThirdUpload ?? false) ||
    thirdUploadLabel !== (garmentType.thirdUploadLabel ?? '') ||
    defaultLowerId !== (garmentType.defaultLowerCatalogId ?? '') ||
    defaultShoeId !== (garmentType.defaultShoeCatalogId ?? '') ||
    tryonCategoryId !== (garmentType.tryonCategoryId ?? '') ||
    requiresMannequinStep !== (garmentType.requiresMannequinStep ?? false) ||
    mannequinWorkflowTemplateId !== (garmentType.mannequinWorkflowTemplateId ?? '') ||
    sareeStep2WorkflowTemplateId !== (garmentType.sareeStep2WorkflowTemplateId ?? '') ||
    mannequinTwoInputWorkflowTemplateId !==
      (garmentType.mannequinTwoInputWorkflowTemplateId ?? '') ||
    twoInputTryonWorkflowTemplateId !== (garmentType.twoInputTryonWorkflowTemplateId ?? '');

  const save = async () => {
    setSaving(true);
    try {
      const patchBody: Record<string, unknown> = {};
      if (imageFile) {
        const presign = await apiFetch<{ uploadUrl: string; thumbnailKey: string }>(
          '/admin/assets/garment-types/presign',
          { method: 'POST', body: JSON.stringify({ contentType: imageFile.type }) },
        );
        const thumb = await makeThumbnail(imageFile);
        await fetch(presign.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': thumb.type },
          body: thumb,
        });
        patchBody.thumbnailKey = presign.thumbnailKey;
      }
      if (instructionFile) {
        const presign = await apiFetch<{ uploadUrl: string; instructionImageKey: string }>(
          '/admin/assets/garment-types/instruction/presign',
          { method: 'POST', body: JSON.stringify({ contentType: instructionFile.type }) },
        );
        await fetch(presign.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': instructionFile.type },
          body: instructionFile,
        });
        patchBody.instructionImageKey = presign.instructionImageKey;
      } else if (removeInstructionImage) {
        patchBody.instructionImageKey = null;
      }
      if (label.trim() !== garmentType.label.trim()) patchBody.label = label.trim();
      if (publicApiSlug !== (garmentType.publicApiSlug ?? ''))
        patchBody.publicApiSlug = publicApiSlug;
      if (sortOrder !== garmentType.sortOrder) patchBody.sortOrder = sortOrder;
      if (requiresLowerUpload !== garmentType.requiresLowerUpload) {
        patchBody.requiresLowerUpload = requiresLowerUpload;
      }
      if (upperUploadLabel !== (garmentType.upperUploadLabel ?? '')) {
        patchBody.upperUploadLabel = upperUploadLabel.trim() || null;
      }
      if (lowerUploadLabel !== (garmentType.lowerUploadLabel ?? '')) {
        patchBody.lowerUploadLabel = lowerUploadLabel.trim() || null;
      }
      if (requiresThirdUpload !== (garmentType.requiresThirdUpload ?? false)) {
        patchBody.requiresThirdUpload = requiresThirdUpload;
      }
      if (thirdUploadLabel !== (garmentType.thirdUploadLabel ?? '')) {
        patchBody.thirdUploadLabel = thirdUploadLabel.trim() || null;
      }
      if (defaultLowerId !== (garmentType.defaultLowerCatalogId ?? '')) {
        patchBody.defaultLowerCatalogId = defaultLowerId || null;
      }
      if (defaultShoeId !== (garmentType.defaultShoeCatalogId ?? '')) {
        patchBody.defaultShoeCatalogId = defaultShoeId || null;
      }
      if (tryonCategoryId !== (garmentType.tryonCategoryId ?? '')) {
        patchBody.tryonCategoryId = tryonCategoryId || null;
      }
      if (requiresMannequinStep !== (garmentType.requiresMannequinStep ?? false)) {
        patchBody.requiresMannequinStep = requiresMannequinStep;
      }
      if (mannequinWorkflowTemplateId !== (garmentType.mannequinWorkflowTemplateId ?? '')) {
        patchBody.mannequinWorkflowTemplateId = mannequinWorkflowTemplateId || null;
      }
      if (sareeStep2WorkflowTemplateId !== (garmentType.sareeStep2WorkflowTemplateId ?? '')) {
        patchBody.sareeStep2WorkflowTemplateId = sareeStep2WorkflowTemplateId || null;
      }
      if (
        mannequinTwoInputWorkflowTemplateId !==
        (garmentType.mannequinTwoInputWorkflowTemplateId ?? '')
      ) {
        patchBody.mannequinTwoInputWorkflowTemplateId = mannequinTwoInputWorkflowTemplateId || null;
      }
      if (twoInputTryonWorkflowTemplateId !== (garmentType.twoInputTryonWorkflowTemplateId ?? '')) {
        patchBody.twoInputTryonWorkflowTemplateId = twoInputTryonWorkflowTemplateId || null;
      }

      if (Object.keys(patchBody).length > 0) {
        await apiFetch(`/admin/assets/garment-types/${garmentType.id}`, {
          method: 'PATCH',
          body: JSON.stringify(patchBody),
        });
        onSaved(patchBody);
      }
      toast({ title: `${(patchBody.label as string) ?? garmentType.label} updated` });
      onClose();
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to save',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditDrawer
      onClose={onClose}
      title="Edit Garment Type"
      subtitle={garmentType.slug}
      tags={[{ label: garmentType.genderSlug, tone: 'dot-accent' }]}
      thumbnail={{ thumbnailUrl: garmentType.thumbnailUrl }}
      width="min(780px, calc(100vw - 60px))"
      saving={saving}
      onSave={() => void save()}
      saveDisabled={!dirty || !label.trim()}
      sections={[
        {
          title: 'Basic Info',
          children: (
            <>
              <UploadBox
                label="thumbnail"
                previewUrl={imagePreview}
                onPick={setImageFile}
                disabled={saving}
              />
              <div className="field">
                <label>Label</label>
                <input
                  className="input"
                  value={label}
                  disabled={saving}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
              <PublicApiSlugField
                value={publicApiSlug}
                disabled={saving}
                kind="shirt"
                onChange={setPublicApiSlug}
              />
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
                  value={sortOrder}
                  disabled={saving}
                  onChange={(e) => setSortOrder(Number(e.target.value))}
                />
              </div>
              <div className="setting-row" style={{ padding: 0, border: 0 }}>
                <div>
                  <div className="setting-lbl">Requires lower garment upload</div>
                  <div className="setting-desc">
                    User uploads bottom wear separately instead of picking from the catalog.
                  </div>
                </div>
                <Switch
                  checked={requiresLowerUpload}
                  onChange={setRequiresLowerUpload}
                  disabled={saving}
                />
              </div>
              {requiresLowerUpload && (
                <>
                  <div className="field">
                    <label>Top garment upload label</label>
                    <input
                      className="input"
                      placeholder="e.g. Upload Top (defaults to garment name)"
                      value={upperUploadLabel}
                      disabled={saving}
                      onChange={(e) => setUpperUploadLabel(e.target.value)}
                    />
                    <span className="hint">
                      Shown in studio as the title of the top-wear upload box. Leave blank to use
                      the garment type name.
                    </span>
                  </div>
                  <div className="field">
                    <label>Bottom garment upload label</label>
                    <input
                      className="input"
                      placeholder="e.g. Upload Bottom / Pyjama / Trousers"
                      value={lowerUploadLabel}
                      disabled={saving}
                      onChange={(e) => setLowerUploadLabel(e.target.value)}
                    />
                    <span className="hint">
                      Shown in studio as the title of the bottom-wear upload box.
                    </span>
                  </div>
                </>
              )}
              <div className="setting-row" style={{ padding: 0, border: 0 }}>
                <div>
                  <div className="setting-lbl">Requires 3rd Upload (e.g. Scarf/Dupatta)</div>
                  <div className="setting-desc">Customers must upload a third image.</div>
                </div>
                <Switch
                  checked={requiresThirdUpload}
                  onChange={setRequiresThirdUpload}
                  disabled={saving}
                />
              </div>
              {requiresThirdUpload && (
                <div className="field">
                  <label>3rd Upload Field Label</label>
                  <input
                    className="input"
                    placeholder="e.g. Scarf Image"
                    value={thirdUploadLabel}
                    disabled={saving}
                    onChange={(e) => setThirdUploadLabel(e.target.value)}
                  />
                  <span className="hint">
                    Shown in studio as the title of the third garment upload box.
                  </span>
                </div>
              )}
              <div className="field">
                <label>Tryon Category</label>
                <SearchableSelect
                  options={tryonCategories.map((c) => ({ id: c.id, label: c.name }))}
                  value={tryonCategoryId}
                  disabled={saving}
                  emptyLabel="— none —"
                  placeholder="— search category —"
                  onChange={setTryonCategoryId}
                />
                <span className="hint">
                  Maps this garment type to a tryon workflow for the "Browse from Catalog" picker on
                  the tryon page.
                </span>
              </div>
            </>
          ),
        },
        {
          title: 'Two-Step Generation',
          children: (
            <>
              <div className="setting-row" style={{ padding: 0, border: 0 }}>
                <div>
                  <div className="setting-lbl">Two-step generation (mannequin + drape)</div>
                  <div className="setting-desc">
                    Runs a one-time, free "mannequin" generation before the normal per-pose jobs,
                    reusing its output as the garment input for every pose. Used by Flat Saree.
                  </div>
                </div>
                <Switch
                  checked={requiresMannequinStep}
                  onChange={setRequiresMannequinStep}
                  disabled={saving}
                />
              </div>
              {requiresMannequinStep && (
                <>
                  <div className="field">
                    <label>Mannequin (Step 1) Workflow</label>
                    <SearchableSelect
                      options={workflows
                        .filter((w) => w.workflowType === 'saree_step1' && w.isActive)
                        .map((w) => ({ id: w.id, label: `${w.label} (${w.slug})` }))}
                      value={mannequinWorkflowTemplateId}
                      disabled={saving}
                      emptyLabel="— none —"
                      placeholder="— search workflow —"
                      onChange={setMannequinWorkflowTemplateId}
                    />
                    <span className="hint">
                      Drapes the uploaded garment onto the selected face, once per job.
                    </span>
                  </div>
                  <div className="field">
                    <label>Two-Input Mannequin (Body + Pallu) Workflow</label>
                    <SearchableSelect
                      options={workflows
                        .filter((w) => w.workflowType === 'saree_step1_two_input' && w.isActive)
                        .map((w) => ({ id: w.id, label: `${w.label} (${w.slug})` }))}
                      value={mannequinTwoInputWorkflowTemplateId}
                      disabled={saving}
                      emptyLabel="— none —"
                      placeholder="— search workflow —"
                      onChange={setMannequinTwoInputWorkflowTemplateId}
                    />
                    <span className="hint">
                      Optional. When set, the studio wizard offers a "Body & Pallu" two-image upload
                      mode for this garment type, using this workflow instead of the one above.
                    </span>
                  </div>
                  <div className="field">
                    <label>Two-Input Direct Try-On Workflow</label>
                    <SearchableSelect
                      options={workflows
                        .filter((w) => w.workflowType === 'saree_step1_two_input' && w.isActive)
                        .map((w) => ({ id: w.id, label: `${w.label} (${w.slug})` }))}
                      value={twoInputTryonWorkflowTemplateId}
                      disabled={saving}
                      emptyLabel="— none —"
                      placeholder="— search workflow —"
                      onChange={setTwoInputTryonWorkflowTemplateId}
                    />
                    <span className="hint">
                      Used when a customer tries on a merchant catalog item that has a second
                      (pallu) image — patches the customer's own photo directly, no mannequin step.
                    </span>
                  </div>
                  <div className="field">
                    <label>Draping (Step 2) Workflow</label>
                    <SearchableSelect
                      options={workflows
                        .filter((w) => w.workflowType === 'regular' && w.isActive)
                        .map((w) => ({ id: w.id, label: `${w.label} (${w.slug})` }))}
                      value={sareeStep2WorkflowTemplateId}
                      disabled={saving}
                      emptyLabel="— none —"
                      placeholder="— search workflow —"
                      onChange={setSareeStep2WorkflowTemplateId}
                    />
                    <span className="hint">
                      Used for EVERY pose in a job for this garment type — overrides each pose's own
                      workflow assignment.
                    </span>
                  </div>
                </>
              )}
            </>
          ),
        },
        {
          title: 'Default Lower Garment',
          flush: true,
          children: (
            <ItemPicker
              type="lower"
              gender={garmentType.genderSlug}
              items={catalogItems}
              categories={categories}
              selectedId={defaultLowerId}
              onSelect={setDefaultLowerId}
            />
          ),
        },
        {
          title: 'Default Shoe',
          flush: true,
          children: (
            <ItemPicker
              type="shoe"
              gender={garmentType.genderSlug}
              items={catalogItems}
              categories={categories}
              selectedId={defaultShoeId}
              onSelect={setDefaultShoeId}
            />
          ),
        },
        {
          title: 'Instruction Image',
          children: (
            <UploadBox
              label="instruction image"
              hint="Shown to users as an upload guide for this garment type."
              previewUrl={instructionPreview}
              onPick={(f) => {
                setInstructionFile(f);
                setRemoveInstructionImage(false);
              }}
              onRemove={
                instructionPreview
                  ? () => {
                      setInstructionFile(null);
                      setRemoveInstructionImage(true);
                    }
                  : undefined
              }
              disabled={saving}
            />
          ),
        },
      ]}
    />
  );
}
