# Admin-Web Unified Edit Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every hand-rolled add/edit popup in `apps/admin-web` with one shared `EditDrawer` component — full-height right-side panel, titled sections where a form has genuine multiple groupings, richer header (thumbnail/icon + title + tags), consistent `Cancel` / `Save changes` footer.

**Architecture:** One new component, `apps/admin-web/src/components/EditDrawer.tsx`, built entirely from CSS classes that already exist in `tokens.css` (`.drawer`, `.drawer-head`, `.drawer-body`, `.drawer-foot`, `.modal-overlay`, `.card`/`.card-head`/`.card-body` for sections) — zero new CSS. Every in-scope popup across ~28 files is migrated to render through it, each file keeping its own field markup, state, validation, and API calls untouched; only the outer container changes.

**Tech Stack:** React 18 + TypeScript, existing `tokens.css` design tokens, no new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-10-admin-web-unified-edit-drawer-design.md`.
- In scope: only popups that create or edit a record (or perform an action with real input fields, e.g. Reset Password). Confirm dialogs (title + body text + Cancel/Confirm, no fields) and lightweight anchored dropdowns/pickers are explicitly out of scope — do not touch them.
- No new field validation or API behavior changes anywhere in this plan — this is a structural/visual migration only.
- No new CSS classes for the drawer container or sections — reuse `.drawer`/`.drawer-head`/`.drawer-body`/`.drawer-foot`/`.modal-overlay`/`.card`/`.card-head`/`.card-body` exactly as they exist in `apps/admin-web/src/styles/tokens.css` today.
- `admin-web` has no automated UI test suite. Verification per task is: `pnpm --filter @tryme/admin typecheck`, `pnpm --filter @tryme/admin build`, and a manual browser pass (open the relevant admin page, exercise every add/edit action touched by the task).
- Every task's diff must be a pure container swap: the fields, `useState` calls, validation, and `apiFetch` calls in each migrated file must be byte-for-byte the same logic as before — only the JSX wrapper around them changes.

---

### Task 1: Build `EditDrawer` and migrate the first two consumers (Add/Edit Model Face)

**Files:**
- Create: `apps/admin-web/src/components/EditDrawer.tsx`
- Modify: `apps/admin-web/src/components/AddFaceModal.tsx:241-337` (the `return (...)` block)
- Modify: `apps/admin-web/src/components/EditFaceModal.tsx:112-262` (the `return (...)` block)

**Interfaces:**
- Produces (used by every later task):
  ```ts
  export interface EditDrawerSection {
    title: string;
    children: ReactNode;
    flush?: boolean; // maps to .card-body.flush — for edge-to-edge content like a picker grid
  }

  export interface EditDrawerTag {
    label: string;
    tone?: 'accent' | 'dot-accent';
  }

  export interface EditDrawerProps {
    onClose: () => void;
    title: string;
    subtitle?: string; // rendered with className="mono sub", e.g. a slug
    tags?: EditDrawerTag[];
    thumbnail?: { thumbnailKey?: string; r2Key?: string; storagePublicUrl: string | null };
    width?: string; // CSS width value; defaults to the .drawer CSS default (640px) when omitted
    sections?: EditDrawerSection[]; // use this OR children, never both
    children?: ReactNode;
    saving?: boolean;
    onSave: () => void;
    saveLabel?: string; // default 'Save changes'
    saveDisabled?: boolean;
  }

  export function EditDrawer(props: EditDrawerProps): JSX.Element
  ```

- [ ] **Step 1: Create `EditDrawer.tsx`**

```tsx
import type { ReactNode } from 'react';
import { AssetThumb } from './AssetThumb';
import { Icon } from './Icons';

export interface EditDrawerSection {
  title: string;
  children: ReactNode;
  flush?: boolean;
}

export interface EditDrawerTag {
  label: string;
  tone?: 'accent' | 'dot-accent';
}

export interface EditDrawerProps {
  onClose: () => void;
  title: string;
  subtitle?: string;
  tags?: EditDrawerTag[];
  thumbnail?: { thumbnailKey?: string; r2Key?: string; storagePublicUrl: string | null };
  width?: string;
  sections?: EditDrawerSection[];
  children?: ReactNode;
  saving?: boolean;
  onSave: () => void;
  saveLabel?: string;
  saveDisabled?: boolean;
}

export function EditDrawer({
  onClose,
  title,
  subtitle,
  tags,
  thumbnail,
  width,
  sections,
  children,
  saving,
  onSave,
  saveLabel,
  saveDisabled,
}: EditDrawerProps) {
  return (
    <div className="modal-overlay" onClick={saving ? undefined : onClose}>
      <div
        className="drawer"
        onClick={(e) => e.stopPropagation()}
        style={width ? { width } : undefined}
      >
        <div className="drawer-head">
          {thumbnail && (
            <AssetThumb
              thumbnailKey={thumbnail.thumbnailKey}
              r2Key={thumbnail.r2Key}
              label={title}
              w={40}
              h={40}
              storageBase={thumbnail.storagePublicUrl}
            />
          )}
          <div style={{ minWidth: 0 }}>
            <h2>{title}</h2>
            {(subtitle || (tags && tags.length > 0)) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                {tags?.map((t) => (
                  <span
                    key={t.label}
                    className={`badge ${t.tone === 'dot-accent' ? 'dot accent' : t.tone === 'accent' ? 'accent' : ''}`}
                  >
                    {t.label}
                  </span>
                ))}
                {subtitle && <span className="mono sub">{subtitle}</span>}
              </div>
            )}
          </div>
          <button
            className="btn sm ghost"
            onClick={onClose}
            disabled={saving}
            style={{ marginLeft: 'auto' }}
          >
            <Icon.Close />
          </button>
        </div>

        <div className="drawer-body" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {sections
            ? sections.map((s) => (
                <div className="card" key={s.title}>
                  <div className="card-head">
                    <h3>{s.title}</h3>
                  </div>
                  <div className={`card-body${s.flush ? ' flush' : ''}`}>{s.children}</div>
                </div>
              ))
            : children}
        </div>

        <div className="drawer-foot">
          <button className="btn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn primary" onClick={onSave} disabled={saving || saveDisabled}>
            {saving ? 'Saving…' : (saveLabel ?? 'Save changes')}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Migrate `AddFaceModal.tsx` to use `EditDrawer`**

Replace lines 241-337 (the entire `return (...)` statement) with:

```tsx
  return (
    <EditDrawer
      onClose={onClose}
      title="Add Model Face"
      width="min(640px, calc(100vw - 60px))"
      saving={busy}
      onSave={() => void handleSubmit()}
      saveLabel={busy ? 'Uploading…' : `Add face${multi ? `s (${files.length})` : ''}`}
      saveDisabled={files.length === 0 || !allLabeled}
    >
      {error && (
        <div
          style={{
            color: 'var(--danger)',
            fontSize: 13,
            padding: '8px 12px',
            borderRadius: 'var(--r)',
            background: 'var(--danger-soft)',
            border: '1px solid var(--danger-border)',
          }}
        >
          {error}
        </div>
      )}

      <div>
        <MultiPhotoDropzone files={files} onFilesChange={setFiles} disabled={busy} />
        <span className="hint" style={{ display: 'block', marginTop: 8 }}>
          Label defaults to the file name — edit any of them before uploading.
        </span>
      </div>

      <div className="field-row">
        <div className="field">
          <label>Gender</label>
          <select
            className="select"
            value={gender}
            disabled={busy}
            onChange={(e) => setGender(e.target.value as GenderSlug)}
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
            value={sortOrder}
            disabled={busy}
            onChange={(e) => setSortOrder(Number(e.target.value))}
          />
        </div>
      </div>

      {busy && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {status === 'uploading' ? `Uploading… ${progress}%` : 'Saving…'}
          </div>
          <div className="bar-track">
            <div className="bar-fill accent" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
    </EditDrawer>
  );
```

Add `import { EditDrawer } from './EditDrawer';` to the top of the file. The `<div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>` wrapper is dropped — its children become `EditDrawer`'s `children` directly, and `EditDrawer`'s own `.drawer-body` already applies `display: flex; flex-direction: column; gap: 18px`, close enough to the original `gap: 16` that no visual regression results; if you want pixel parity, wrap the returned children in a single `<div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>...</div>` instead of passing them as siblings.

- [ ] **Step 3: Migrate `EditFaceModal.tsx` to use `EditDrawer`**

Replace lines 112-262 (the entire `return (...)` statement) with:

```tsx
  return (
    <EditDrawer
      onClose={onClose}
      title="Edit model face"
      width="min(480px, calc(100vw - 40px))"
      thumbnail={{ thumbnailKey: face.thumbnailKey, storagePublicUrl }}
      saving={saving || replaceUploading}
      onSave={handleSave}
      saveDisabled={!form.label.trim()}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="field">
          <label>Label</label>
          <input
            className="input"
            value={form.label}
            disabled={saving}
            placeholder="e.g. Model 1 — Men"
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>Gender</label>
          <select
            className="select"
            value={form.gender}
            disabled={saving}
            onChange={(e) => setForm((f) => ({ ...f, gender: e.target.value as GenderSlug }))}
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
            value={form.sortOrder}
            disabled={saving}
            style={{ width: 100 }}
            onChange={(e) => setForm((f) => ({ ...f, sortOrder: Number(e.target.value) }))}
          />
        </div>
        <PublicApiSlugField
          value={form.publicApiSlug}
          disabled={saving}
          kind="model"
          onChange={(v) => setForm((f) => ({ ...f, publicApiSlug: v }))}
        />
        <div className="field">
          <label>
            Tags <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            className="input"
            value={form.tagsInput}
            disabled={saving}
            placeholder="e.g. warm tone, closeup, studio"
            onChange={(e) => setForm((f) => ({ ...f, tagsInput: e.target.value }))}
          />
        </div>
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
          Tags are comma-separated — lets you filter models in Studio (e.g. all "closeup" faces).
        </p>
        <div className="field">
          <label>Replace image</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {(replacePreview ??
              (storagePublicUrl && face.thumbnailKey
                ? `${storagePublicUrl}/${face.thumbnailKey}`
                : null)) && (
              // biome-ignore lint/performance/noImgElement: face thumbnail preview
              <img
                src={replacePreview ?? `${storagePublicUrl}/${face.thumbnailKey}`}
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
                ref={replaceRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setReplaceFile(file);
                  setReplacePreview(URL.createObjectURL(file));
                }}
              />
              <button
                type="button"
                className="btn sm ghost"
                disabled={saving || replaceUploading}
                onClick={() => replaceRef.current?.click()}
              >
                <Icon.Image /> {replaceFile ? replaceFile.name : 'Pick new image'}
              </button>
              {replaceFile && (
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={replaceUploading}
                  onClick={handleReplaceImage}
                >
                  {replaceUploading ? 'Uploading…' : 'Upload & replace'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </EditDrawer>
  );
```

Add `import { EditDrawer } from './EditDrawer';` to the top of the file. Note `saveLabel` is omitted here so it defaults to `'Save changes'`, matching the original button text exactly.

- [ ] **Step 4: Typecheck and build**

Run: `pnpm --filter @tryme/admin typecheck && pnpm --filter @tryme/admin build`
Expected: both succeed with no errors.

- [ ] **Step 5: Manual browser verification**

Run `pnpm --filter @tryme/admin dev`, open Assets → Model Faces:
- Click "Add face" — drawer slides in from the right, wider than before, image dropzone + Gender/Sort-order fields visible, Cancel/Add-face footer works, uploading a face still succeeds and appears in the grid.
- Click edit on an existing face — drawer shows the face thumbnail in the header, all fields pre-filled, Save changes persists an edit, Replace image still works.

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/components/EditDrawer.tsx apps/admin-web/src/components/AddFaceModal.tsx apps/admin-web/src/components/EditFaceModal.tsx
git commit -m "feat(admin-web): add shared EditDrawer, migrate Add/Edit Model Face onto it"
```

---

### Task 2: Migrate Add/Edit Garment Type onto `EditDrawer` (the motivating example)

**Files:**
- Modify: `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx:865-1090ish` (the "Add garment type" modal block — read the file first to find the exact current end line, since Task 1 doesn't touch this file)
- Modify: `apps/admin-web/src/components/EditGarmentTypeModal.tsx:511-828` (the `return (...)` block)

**Interfaces:**
- Consumes: `EditDrawer`, `EditDrawerSection` from `apps/admin-web/src/components/EditDrawer.tsx` (Task 1).

- [ ] **Step 1: Migrate `EditGarmentTypeModal.tsx`'s `return` (lines 511-828) to use `EditDrawer` with 5 sections**

Replace with:

```tsx
  return (
    <EditDrawer
      onClose={onClose}
      title="Edit Garment Type"
      subtitle={garmentType.slug}
      tags={[{ label: garmentType.genderSlug, tone: 'dot-accent' }]}
      thumbnail={{ thumbnailKey: garmentType.thumbnailKey ?? undefined, storagePublicUrl }}
      width="min(780px, calc(100vw - 60px))"
      saving={saving}
      onSave={() => void save()}
      saveDisabled={!dirty}
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
                <Switch checked={requiresLowerUpload} onChange={setRequiresLowerUpload} disabled={saving} />
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
                <Switch checked={requiresThirdUpload} onChange={setRequiresThirdUpload} disabled={saving} />
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
                <Switch checked={requiresMannequinStep} onChange={setRequiresMannequinStep} disabled={saving} />
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
              storagePublicUrl={storagePublicUrl}
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
              storagePublicUrl={storagePublicUrl}
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
```

Add `import { EditDrawer } from './EditDrawer';`. This produces the exact same 5 sections the component already renders today, just through the shared component instead of bespoke `.drawer`/`.card` JSX.

- [ ] **Step 2: Read the current "Add garment type" modal in `GarmentTypesTab.tsx`**

Read `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx` starting at line 865 (`{/* Add garment type */}`) through its closing `)}` — confirmed today to run from the `showSubcatModal &&` block open at line 866 through the modal-foot's save handler ending sometime after line 1080 (find the exact closing brace/parenthesis by reading forward from line 1080 until the block closes). Note the exact state variable names in use: `subcatForm` (with `label`, `slug`, `genderSlug`, `sortOrder`, `requiresLowerUpload`, `requiresThirdUpload` fields), `subcatSaving`, `subcatImageFile`, `setShowSubcatModal`, `nextSortOrderFor`.

- [ ] **Step 3: Replace the "Add garment type" modal's outer wrapper (lines 866-1112) with `EditDrawer`**

Replace the entire block from `{/* Add garment type */}` / `{showSubcatModal && (` (line 865-866) through its closing `)}` (line 1112) with:

```tsx
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
        Thumbnail image <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {subcatImageFile ? (
          // biome-ignore lint/performance/noImgElement: admin panel
          <img
            src={URL.createObjectURL(subcatImageFile)}
            alt="preview"
            style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
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
```

This is a pure relocation: the same field JSX, the same async save handler body, the same API calls as the current file — only the outer `.modal-overlay`/`.modal`/`.modal-head`/`.modal-body`/`.modal-foot` wrapper is replaced by `EditDrawer`. Do not alter field names, the save handler's logic, or API calls.

- [ ] **Step 4: Typecheck and build**

Run: `pnpm --filter @tryme/admin typecheck && pnpm --filter @tryme/admin build`
Expected: both succeed with no errors.

- [ ] **Step 5: Manual browser verification**

Open Assets → Garment Types:
- Click "Add garment type" — drawer slides in from the right (previously a small centered modal), same fields, same validation, saving still creates a new garment type.
- Click a garment type row to edit it — drawer looks identical to before (it already used `EditGarmentTypeModal`'s bespoke drawer JSX; confirm no visual regression from the swap to the shared component), all 5 sections present, saving still works.
- Confirm Add and Edit now look like the same UI family — same width class of drawer, same header/footer treatment — closing the exact inconsistency this whole project started from.

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/pages/assets/GarmentTypesTab.tsx apps/admin-web/src/components/EditGarmentTypeModal.tsx
git commit -m "feat(admin-web): migrate Add/Edit Garment Type onto shared EditDrawer"
```

---

### Task 3: Migrate GarmentTypesTab's remaining two edit popups

**Files:**
- Modify: `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx:1734-1900ish` ("pose config" mapping modal, header at line 1741-1746: `<h3>{mapping.label}</h3>` with subtitle `{garmentTypeLabel} / {configuredCount} of {items.length} poses ready`)
- Modify: `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx:2346-2450ish` ("Edit override" modal, header at line 2354-2357: `<h3>{sub.label} — {editing.displayName ?? editing.label}</h3>`)

**Interfaces:**
- Consumes: `EditDrawer` from Task 1.

- [ ] **Step 1: Read both modal blocks in full**

Read `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx` lines 1734-1900 (pose-config mapping modal — a per-pose list/table body, not a simple field form, currently `width: 'min(820px, calc(100vw - 64px))'`) and lines 2346-2450 (edit-override modal, currently `width: 'min(720px, calc(100vw - 80px))'`) to get their exact current body content, state variable names, and save handlers.

- [ ] **Step 2: Migrate the pose-config mapping modal to `EditDrawer`**

From Step 1's read, determine which of these two shapes the current footer has:

- **A single explicit bulk "Save"/"Apply" button**: wrap as usual — `onSave` calls that existing handler, `saveDisabled`/`saving` map to its existing disabled/loading state, `saveLabel` matches its existing button text.
- **No bulk save button — each pose row saves itself independently as you interact with it** (the more likely shape, given `savingId`/`savingLookId` look like per-row loading flags rather than a single bulk-saving flag): pass `onSave={onClose}` and `saveLabel="Done"`, so the drawer's primary footer button just closes it — do not invent a bulk-save action that doesn't exist today.

Either way, replace the `.modal-overlay > .modal > .modal-head/.modal-body/.modal-foot` wrapper with:

```tsx
<EditDrawer
  onClose={onClose}
  title={mapping.label}
  subtitle={`${garmentTypeLabel} / ${configuredCount} of ${items.length} poses ready`}
  width="min(820px, calc(100vw - 64px))"
  saving={!!savingId || !!savingLookId}
  onSave={/* per the rule above: either the existing bulk-save handler, or onClose */}
  saveLabel={/* per the rule above: either the existing button's label, or "Done" */}
>
  {/* existing modal-body content — the per-pose list/table — moved here unchanged */}
</EditDrawer>
```

- [ ] **Step 3: Migrate the edit-override modal to `EditDrawer`**

Replace its wrapper with:

```tsx
<EditDrawer
  onClose={closeEdit}
  title={`${sub.label} — ${editing.displayName ?? editing.label}`}
  width="min(720px, calc(100vw - 80px))"
  saving={savingId === editing.id}
  onSave={/* move the existing save handler here verbatim */}
>
  {/* existing modal-body content, unchanged */}
</EditDrawer>
```

- [ ] **Step 4: Typecheck, build, and manually verify**

Run: `pnpm --filter @tryme/admin typecheck && pnpm --filter @tryme/admin build`
Open Assets → Garment Types → click into a garment type's pose configs, open both the pose-mapping view and an individual pose's edit-override — confirm both render as drawers and all existing interactions (whatever they are) still work exactly as before.

- [ ] **Step 5: Commit**

```bash
git add apps/admin-web/src/pages/assets/GarmentTypesTab.tsx
git commit -m "feat(admin-web): migrate remaining Garment Types popups onto EditDrawer"
```

---

### Task 4: Migrate Backgrounds

**Files:**
- Modify: `apps/admin-web/src/components/BackgroundUploadModal.tsx:144` (read file, find the `return (...)` block, migrate)
- Modify: `apps/admin-web/src/components/EditBackgroundModal.tsx:141` (same)
- Modify: `apps/admin-web/src/pages/assets/BackgroundsTab.tsx:1053` ("Add background category") and `:1257` ("Edit category") — the other 5 modal instances in this file (745, 799, 860, 917, 970) are confirm/bulk-action dialogs, out of scope, do not touch them.

**Interfaces:**
- Consumes: `EditDrawer` from Task 1.

- [ ] **Step 1: Read all four target files' current modal blocks in full**, noting exact field lists, state variable names, save handlers, and current modal widths.

- [ ] **Step 2: Migrate `BackgroundUploadModal.tsx` and `EditBackgroundModal.tsx`** — same pattern as Task 1's `AddFaceModal`/`EditFaceModal`: replace the `<div className="modal-overlay">...<div className="modal">...</div></div>` wrapper with `<EditDrawer title="..." onClose={...} onSave={...} saving={...} saveDisabled={...}>{/* existing modal-body fields, unchanged */}</EditDrawer>`. `EditBackgroundModal` should pass `thumbnail={{ thumbnailKey: background.thumbnailKey, storagePublicUrl }}` in its header, matching `EditFaceModal`'s pattern from Task 1.

- [ ] **Step 3: Migrate `BackgroundsTab.tsx`'s "Add background category" (line 1053) and "Edit category" (line 1257)** the same way — read their current field lists and save handlers, wrap in `EditDrawer` with `title="Add background category"` / `title="Edit category"` respectively, preserving every field and the save handler's logic unchanged.

- [ ] **Step 4: Typecheck, build, and manually verify**

Run: `pnpm --filter @tryme/admin typecheck && pnpm --filter @tryme/admin build`
Open Assets → Backgrounds: Add a background, edit an existing background, add a background category, edit a background category — confirm all four now render as drawers and all saves still work.

- [ ] **Step 5: Commit**

```bash
git add apps/admin-web/src/components/BackgroundUploadModal.tsx apps/admin-web/src/components/EditBackgroundModal.tsx apps/admin-web/src/pages/assets/BackgroundsTab.tsx
git commit -m "feat(admin-web): migrate Backgrounds add/edit popups onto EditDrawer"
```

---

### Task 5: Migrate Pose Assets

**Files:**
- Modify: `apps/admin-web/src/components/PoseUploadModal.tsx:210`
- Modify: `apps/admin-web/src/components/EditPoseAssetModal.tsx:239`
- Modify: `apps/admin-web/src/components/EditPoseModal.tsx:293`

Note: `apps/admin-web/src/pages/assets/PoseAssetsTab.tsx`'s 5 modal instances (649, 685, 739, 786, 846) are all confirm/bulk-action/import dialogs — out of scope, do not touch this file.

**Interfaces:**
- Consumes: `EditDrawer` from Task 1.

- [ ] **Step 1: Read all three files' current modal blocks in full**, noting field lists, state variable names, save handlers, current widths, and whether each has a thumbnail to show in the header (pose assets have `r2Key`/`thumbnailKey` — likely yes for the Edit variants).

- [ ] **Step 2: Migrate each of the three to `EditDrawer`**, same pattern as Task 1: replace the modal wrapper, preserve all fields/handlers unchanged, pass `thumbnail={{ thumbnailKey: ..., storagePublicUrl }}` for the Edit modals.

- [ ] **Step 3: Typecheck, build, and manually verify**

Run: `pnpm --filter @tryme/admin typecheck && pnpm --filter @tryme/admin build`
Open Assets → Pose Assets: Add a pose, edit an existing pose asset, edit a pose (the separate `EditPoseModal` flow) — confirm all render as drawers, all saves still work.

- [ ] **Step 4: Commit**

```bash
git add apps/admin-web/src/components/PoseUploadModal.tsx apps/admin-web/src/components/EditPoseAssetModal.tsx apps/admin-web/src/components/EditPoseModal.tsx
git commit -m "feat(admin-web): migrate Pose Assets add/edit popups onto EditDrawer"
```

---

### Task 6: Migrate Catalog (lower garments / shoes)

**Files:**
- Modify: `apps/admin-web/src/components/UploadModal.tsx:186`
- Modify: `apps/admin-web/src/components/BatchCatalogUploadModal.tsx:153`
- Modify: `apps/admin-web/src/pages/CatalogPage.tsx:437` ("Edit catalog item" only — line 563 "Delete catalog item" is a confirm, out of scope)
- Modify: `apps/admin-web/src/pages/assets/CatalogTab.tsx:749` ("Add category"), `:953` ("Edit category"), `:1142` ("Edit catalog item") — lines 543, 588, 628, 681, 1451 in this file are confirm/bulk-action dialogs, out of scope, do not touch them.

**Interfaces:**
- Consumes: `EditDrawer` from Task 1.

- [ ] **Step 1: Read all four files' target modal blocks in full**, noting field lists, state variable names, save handlers, current widths.

- [ ] **Step 2: Migrate `UploadModal.tsx` and `BatchCatalogUploadModal.tsx`** — same pattern as Task 1.

- [ ] **Step 3: Migrate `CatalogPage.tsx`'s "Edit catalog item" (line 437)** to `EditDrawer`, preserving its fields/handler unchanged. Leave line 563 ("Delete catalog item") untouched.

- [ ] **Step 4: Migrate `CatalogTab.tsx`'s three in-scope modals** ("Add category" at 749, "Edit category" at 953, "Edit catalog item" at 1142) to `EditDrawer`, preserving fields/handlers unchanged. Leave the other five modal instances in this file untouched.

- [ ] **Step 5: Typecheck, build, and manually verify**

Run: `pnpm --filter @tryme/admin typecheck && pnpm --filter @tryme/admin build`
Open Assets → Lower garments and Shoes tabs, and the Catalog page: add/edit a category, edit a catalog item, run a batch upload — confirm all render as drawers and all saves/uploads still work.

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/components/UploadModal.tsx apps/admin-web/src/components/BatchCatalogUploadModal.tsx apps/admin-web/src/pages/CatalogPage.tsx apps/admin-web/src/pages/assets/CatalogTab.tsx
git commit -m "feat(admin-web): migrate Catalog add/edit popups onto EditDrawer"
```

---

### Task 7: Migrate Catalogue Templates, Sample Videos, Saree Styles

**Files:**
- Modify: `apps/admin-web/src/components/EditCatalogueTemplateModal.tsx:419-427ish` (already a `.drawer` with `.card` sections "Template Info"/"Looks" — a direct swap onto `EditDrawer`, same shape as Task 2's `EditGarmentTypeModal`)
- Modify: `apps/admin-web/src/components/SampleVideoUploadModal.tsx:135`
- Modify: `apps/admin-web/src/pages/assets/SareeStylesTab.tsx:118` ("Edit style" / "New saree style")
- Modify: `apps/admin-web/src/pages/SareePage.tsx:666` ("Upload saree workflow JSON")

Note: `CatalogueTemplatesTab.tsx:211` ("Delete catalogue template") and `SampleVideosTab.tsx:166` ("Delete sample video") are confirm dialogs — out of scope, do not touch those files.

**Interfaces:**
- Consumes: `EditDrawer`, `EditDrawerSection` from Task 1.

- [ ] **Step 1: Read all four files' target modal blocks in full.**

- [ ] **Step 2: Migrate `EditCatalogueTemplateModal.tsx`** the same way Task 2 migrated `EditGarmentTypeModal` — map its existing "Template Info" and "Looks" `.card` blocks onto `EditDrawer`'s `sections` prop, preserving all field/list content unchanged.

- [ ] **Step 3: Migrate `SampleVideoUploadModal.tsx`, `SareeStylesTab.tsx`'s modal, and `SareePage.tsx`'s modal** — same flat-form pattern as Task 1.

- [ ] **Step 4: Typecheck, build, and manually verify**

Run: `pnpm --filter @tryme/admin typecheck && pnpm --filter @tryme/admin build`
Open Assets → Catalogue Templates (add/edit a template), Assets → Sample Videos (add a video), Assets → Saree Styles (add/edit a style), and the Saree page (upload a saree workflow JSON) — confirm all render as drawers and all saves/uploads still work.

- [ ] **Step 5: Commit**

```bash
git add apps/admin-web/src/components/EditCatalogueTemplateModal.tsx apps/admin-web/src/components/SampleVideoUploadModal.tsx apps/admin-web/src/pages/assets/SareeStylesTab.tsx apps/admin-web/src/pages/SareePage.tsx
git commit -m "feat(admin-web): migrate Catalogue Templates/Sample Videos/Saree Styles popups onto EditDrawer"
```

---

### Task 8: Migrate Workflows

**Files:**
- Modify: `apps/admin-web/src/components/WorkflowUploadModal.tsx:430`
- Modify: `apps/admin-web/src/pages/WorkflowsPage.tsx:1020-1195ish` ("Edit workflow" modal — the prompt/KSampler editing UI built earlier this project)
- Modify: `apps/admin-web/src/pages/WorkflowsPage.tsx:1195-1260ish` ("Reassign workflow" modal)

Note: `WorkflowsPage.tsx:732` (the "View workflow" JSON/detail viewer, title `{viewingDetail.label}`) is a read-only viewer, not an add/edit form — out of scope, do not touch it. The delete-confirmation at line 1172 (`<ConfirmModal ...>`) is also out of scope.

**Interfaces:**
- Consumes: `EditDrawer` from Task 1.

- [ ] **Step 1: Read the "Edit workflow" modal (around line 1020) and "Reassign workflow" modal (around line 1195) in full** — the Edit workflow modal contains the label/slug fields plus the prompt-editing and KSampler-editing UI built earlier in this project; note every field and the exact `handleEditSave` logic so it's preserved unchanged.

- [ ] **Step 2: Migrate `WorkflowUploadModal.tsx`** — same flat-form pattern as Task 1.

- [ ] **Step 3: Migrate the "Edit workflow" modal to `EditDrawer`**, preserving every field (label, slug, isActive toggle, garment/face phase prompt textareas, KSampler steps/cfg/denoise inputs) and `handleEditSave` exactly as they are today. This form likely benefits from `sections` (e.g. "Basic Info" for label/slug/isActive, "Prompts" for the two textareas, "KSampler" for the three numeric fields) — use judgment based on what Step 1's read reveals about the current field grouping; if the fields are currently presented as one flat list with no visual grouping, keep them as `children` rather than inventing new section boundaries that don't exist today (per the spec's rule: sections only where a genuine existing grouping exists).

- [ ] **Step 4: Migrate the "Reassign workflow" modal to `EditDrawer`**, preserving its field(s) and save handler unchanged.

- [ ] **Step 5: Typecheck, build, and manually verify**

Run: `pnpm --filter @tryme/admin typecheck && pnpm --filter @tryme/admin build`
Open Workflows: add a workflow, edit an existing workflow (confirm label/slug/prompts/KSampler fields all still save correctly), reassign a workflow's poses — confirm all three render as drawers and all saves still work. Do not touch the "View workflow" detail viewer or the delete confirmation — verify those two are visually unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/components/WorkflowUploadModal.tsx apps/admin-web/src/pages/WorkflowsPage.tsx
git commit -m "feat(admin-web): migrate Workflows add/edit popups onto EditDrawer"
```

---

### Task 9: Migrate Users

**Files:**
- Modify: `apps/admin-web/src/pages/UsersPage.tsx:952-987` ("Reset Password")
- Modify: `apps/admin-web/src/pages/UsersPage.tsx:1123-1210ish` ("Adjust credits")
- Modify: `apps/admin-web/src/pages/UsersPage.tsx:1210-1289ish` ("Grant merchant access")
- Modify: `apps/admin-web/src/pages/UsersPage.tsx:1289-1765ish` ("Edit merchant details")
- Modify: `apps/admin-web/src/pages/UsersPage.tsx:1763-1853ish` ("Create User")

Note: lines 991, 1015, 1058, 1853 in this file are hand-rolled `.modal.confirm` dialogs (Suspend/Unsuspend, Delete user, Change credit plan/device limit, Delete selected users) — out of scope per the spec (these duplicate `ConfirmModal`'s markup; fixing that duplication is not part of this plan). Do not touch them.

**Interfaces:**
- Consumes: `EditDrawer` from Task 1.

- [ ] **Step 1: Read all five target modal blocks in full**, in the order listed above, noting exact field lists, state variable names, and save handlers. The "Reset Password" block (lines 952-987) was already fully read during planning and is reproduced below for reference — the other four still need a full read before migrating.

Reset Password's current full body (for reference, already verified — no need to re-read this one specifically):

```tsx
{resettingPassword && (
  <div className="modal-overlay" onClick={() => setResettingPassword(false)}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <div className="modal-head">
        <h3>Reset Password</h3>
      </div>
      <div className="modal-body">
        <div className="field">
          <label>New password</label>
          <input
            className="input"
            type="password"
            value={newPasswordInput}
            onChange={(e) => setNewPasswordInput(e.target.value)}
            placeholder="At least 8 characters with a letter and number"
          />
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={() => setResettingPassword(false)}>
          Cancel
        </button>
        <button
          className="btn primary"
          onClick={async () => {
            await handleResetPassword(newPasswordInput);
            setResettingPassword(false);
          }}
          disabled={!newPasswordInput}
        >
          Reset Password
        </button>
      </div>
    </div>
  </div>
)}
```

Migrate to:

```tsx
{resettingPassword && (
  <EditDrawer
    onClose={() => setResettingPassword(false)}
    title="Reset Password"
    width="min(420px, calc(100vw - 40px))"
    onSave={async () => {
      await handleResetPassword(newPasswordInput);
      setResettingPassword(false);
    }}
    saveLabel="Reset Password"
    saveDisabled={!newPasswordInput}
  >
    <div className="field">
      <label>New password</label>
      <input
        className="input"
        type="password"
        value={newPasswordInput}
        onChange={(e) => setNewPasswordInput(e.target.value)}
        placeholder="At least 8 characters with a letter and number"
      />
    </div>
  </EditDrawer>
)}
```

- [ ] **Step 2: Migrate "Adjust credits", "Grant merchant access", "Edit merchant details", and "Create User"** the same way — read each block, replace its `.modal-overlay`/`.modal` wrapper with `EditDrawer`, preserving every field and save handler unchanged. "Edit merchant details" likely has enough distinct field groups (contact info, kiosk settings, etc.) to warrant `sections` — use judgment based on what the read reveals, following the same rule as Task 8 Step 3 (only group into sections where a real existing grouping exists).

- [ ] **Step 3: Typecheck, build, and manually verify**

Run: `pnpm --filter @tryme/admin typecheck && pnpm --filter @tryme/admin build`
Open Users: reset a password, adjust a user's credits, grant merchant access, edit merchant details, create a new user — confirm all five render as drawers and all saves still work. Verify the four confirm dialogs (Suspend/Unsuspend, Delete user, Change credit plan/device limit, Delete selected users) are visually unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/admin-web/src/pages/UsersPage.tsx
git commit -m "feat(admin-web): migrate Users add/edit popups onto EditDrawer"
```

---

### Task 10: Migrate Shopify Funnels, Tryon, Dev API

**Files:**
- Modify: `apps/admin-web/src/pages/ShopifyFunnelsPage.tsx:397` ("New funnel template") and `:491` ("Edit funnel template") — line 583 ("Move products") is out of scope, leave untouched
- Modify: `apps/admin-web/src/pages/TryonPage.tsx:405` ("Sample images") and `:523` (create/edit form, `modalMode === 'create'`) — line 662 ("Delete category") is out of scope, leave untouched
- Modify: `apps/admin-web/src/pages/DevApiPage.tsx:594` (create/edit form, `modalMode === 'create'`) — lines 486 ("Backfill public slugs") and 733 ("Delete category") are out of scope, leave untouched

**Interfaces:**
- Consumes: `EditDrawer` from Task 1.

- [ ] **Step 1: Read all five target modal blocks in full**, noting field lists, state variable names, save handlers, current widths.

- [ ] **Step 2: Migrate `ShopifyFunnelsPage.tsx`'s two funnel-template modals** to `EditDrawer`, preserving fields/handlers unchanged.

- [ ] **Step 3: Migrate `TryonPage.tsx`'s "Sample images" and create/edit-category modals** to `EditDrawer`, preserving fields/handlers unchanged.

- [ ] **Step 4: Migrate `DevApiPage.tsx`'s create/edit-category modal** to `EditDrawer`, preserving fields/handlers unchanged.

- [ ] **Step 5: Typecheck, build, and manually verify**

Run: `pnpm --filter @tryme/admin typecheck && pnpm --filter @tryme/admin build`
Open Shopify → Funnels (create/edit a funnel template), Try-on (manage sample images, create/edit a category), Dev API (create/edit a category) — confirm all five render as drawers and all saves still work.

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/pages/ShopifyFunnelsPage.tsx apps/admin-web/src/pages/TryonPage.tsx apps/admin-web/src/pages/DevApiPage.tsx
git commit -m "feat(admin-web): migrate Shopify Funnels/Tryon/Dev API popups onto EditDrawer"
```

---

### Task 11: Migrate Settings, Chatbot QnA, Demo Catalog

**Files:**
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx:143-146ish` ("Add/Edit plan", already a `.drawer`)
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx:479-482ish` ("Add/Edit campaign", already a `.drawer`)
- Modify: `apps/admin-web/src/pages/ChatbotQnaPage.tsx:197-199ish` ("New/Edit Q&A", already a `.drawer`, currently uses `.scrim` for its backdrop instead of `.modal-overlay` — normalize this to `.modal-overlay` as part of the swap onto `EditDrawer`, since `EditDrawer` always renders `.modal-overlay`)
- Modify: `apps/admin-web/src/components/DemoItemModal.tsx:149` ("Add/Edit demo product")
- Modify: `apps/admin-web/src/components/DemoSetModal.tsx:43` ("Add/Edit demo set")
- Modify: `apps/admin-web/src/components/DemoSubcategoryModal.tsx:50` ("Add/Edit subcategory")

**Interfaces:**
- Consumes: `EditDrawer`, `EditDrawerSection` from Task 1.

- [ ] **Step 1: Read all six target modal blocks in full.**

- [ ] **Step 2: Migrate `SettingsPage.tsx`'s two drawers and `ChatbotQnaPage.tsx`'s drawer** onto `EditDrawer` — these are already `.drawer`-shaped, so this is a direct container swap like Task 2/7, preserving whatever field groupings already exist (map to `sections` if the current markup already groups fields under headings, otherwise `children`). For `ChatbotQnaPage.tsx` specifically, confirm after the swap that the backdrop is `.modal-overlay` (via `EditDrawer`) and no visual/behavioral difference results from no longer using `.scrim`.

- [ ] **Step 3: Migrate `DemoItemModal.tsx`, `DemoSetModal.tsx`, `DemoSubcategoryModal.tsx`** — same flat-form pattern as Task 1, preserving fields/handlers unchanged.

- [ ] **Step 4: Typecheck, build, and manually verify**

Run: `pnpm --filter @tryme/admin typecheck && pnpm --filter @tryme/admin build`
Open Settings (add/edit a credit plan, add/edit a signup campaign), Chatbot Q&A (add/edit a Q&A entry), Kiosk Demo Data (add/edit a demo product, demo set, subcategory) — confirm all six render as drawers and all saves still work.

- [ ] **Step 5: Final full-app sanity pass**

Walk every page in the admin sidebar once (Dashboard, Assets — all tabs, Workflows, Try-on, Kiosk Demo Data, Dev API, Saree, Shopify, Users, Jobs, Held Batches, Workers, Recycle bin, Credit Analysis, Contacts, Chatbot Q&A, Settings) and exercise at least one add/edit action per page that has one, confirming nothing regressed across the whole migration. Confirm untouched popups (all confirm dialogs, `SearchableSelect`, filter dropdowns) still look and behave exactly as before.

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/pages/SettingsPage.tsx apps/admin-web/src/pages/ChatbotQnaPage.tsx apps/admin-web/src/components/DemoItemModal.tsx apps/admin-web/src/components/DemoSetModal.tsx apps/admin-web/src/components/DemoSubcategoryModal.tsx
git commit -m "feat(admin-web): migrate Settings/Chatbot QnA/Demo Catalog popups onto EditDrawer, complete unified drawer migration"
```
