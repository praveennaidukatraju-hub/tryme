'use client';
import { requiredInputsForPoses } from '@tryme/types';
import { Copy, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { C } from '@/components/tokens';
import { SelectGridModal } from '../select-modal';
import type { BatchRowState, PoseOption, TrayGarment } from './types';
import { MAX_FILE_BYTES, uploadTrayFile } from './upload-garment';
import { rowIssues } from './use-batch-state';

export interface PickerItem {
  id: string;
  label: string;
  thumbnailUrl?: string | null;
  tags?: string[];
}

type OpenPicker = 'face' | 'background' | 'pose' | 'lower' | 'shoe' | null;

/**
 * Matches the CSS breakpoint the rest of Studio uses. A media-query hook rather
 * than a CSS class because the grid template lives in inline styles alongside
 * the rest of this page's styling.
 */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return narrow;
}

/**
 * A single grid cell: shows the current selection, opens a picker on click.
 * Renders the selection's thumbnail (matching GarmentCell's tile style) when
 * one is available, falling back to the label/value text otherwise — e.g. Poses
 * has no single thumbnail to show, and an unselected cell has none yet.
 */
function Cell({
  label,
  value,
  thumbnailUrl,
  disabled,
  onClick,
}: {
  label: string;
  value: string;
  thumbnailUrl?: string | null;
  disabled?: boolean;
  onClick: () => void;
}) {
  if (thumbnailUrl) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        title={value}
        style={{
          position: 'relative',
          padding: 0,
          borderRadius: 8,
          overflow: 'hidden',
          border: `1px solid ${C.border}`,
          width: '100%',
          aspectRatio: '1',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {/* biome-ignore lint/performance/noImgElement: small selection thumbnail, presigned R2 URL */}
        <img
          src={thumbnailUrl}
          alt={value}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        justifyContent: 'center',
        textAlign: 'left',
        padding: '8px 10px',
        borderRadius: 8,
        border: `1px solid ${C.border}`,
        background: disabled ? C.field : C.white,
        color: disabled ? C.mid : C.text,
        cursor: disabled ? 'not-allowed' : 'pointer',
        width: '100%',
        aspectRatio: '1',
        boxSizing: 'border-box',
      }}
    >
      <span style={{ display: 'block', fontSize: 11, color: C.mid }}>{label}</span>
      <span style={{ display: 'block', fontSize: 13 }}>{value}</span>
    </button>
  );
}

const POSE_STACK_MAX = 3;
const POSE_STACK_OFFSET = 6;

/**
 * The Poses cell: unlike every other cell, a row can have several poses
 * selected at once, so there is no single thumbnail to show. Renders the
 * selected poses' thumbnails as a diagonally offset stack (later pose on top)
 * instead of the plain "N selected" text, capped at POSE_STACK_MAX with a
 * "+N" badge for the rest.
 */
function PoseCell({
  poses,
  onClick,
}: {
  poses: Array<PickerItem & PoseOption>;
  onClick: () => void;
}) {
  if (poses.length === 0) {
    return <Cell label="Poses" value="Choose" onClick={onClick} />;
  }

  const visible = poses.slice(0, POSE_STACK_MAX);
  const extra = poses.length - visible.length;

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${poses.length} pose${poses.length > 1 ? 's' : ''} selected`}
      style={{
        position: 'relative',
        padding: 0,
        border: 'none',
        background: 'transparent',
        width: '100%',
        aspectRatio: '1',
        cursor: 'pointer',
      }}
    >
      {visible.map((p, i) => (
        <span
          key={p.id}
          style={{
            position: 'absolute',
            top: i * POSE_STACK_OFFSET,
            left: i * POSE_STACK_OFFSET,
            width: '72%',
            height: '72%',
            borderRadius: 8,
            overflow: 'hidden',
            border: `1px solid ${C.border}`,
            boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
            background: C.white,
            zIndex: i,
          }}
        >
          {/* biome-ignore lint/performance/noImgElement: small selection thumbnail, presigned R2 URL */}
          <img
            src={p.thumbnailUrl ?? ''}
            alt={p.label}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </span>
      ))}
      {extra > 0 && (
        <span
          style={{
            position: 'absolute',
            bottom: 0,
            right: 0,
            fontSize: 10,
            fontWeight: 600,
            padding: '1px 5px',
            borderRadius: 999,
            background: C.pink,
            color: C.white,
            zIndex: POSE_STACK_MAX + 1,
          }}
        >
          +{extra}
        </span>
      )}
    </button>
  );
}

/**
 * The row's own upload control — replaces picking from a shared bulk-uploaded
 * pool with uploading directly into this row. Empty: click/drop to upload.
 * Uploading: shows progress. Uploaded: shows a thumbnail with a remove affordance;
 * clicking the thumbnail re-opens the file picker to replace it.
 */
function GarmentCell({
  garment,
  onUpload,
  onRemove,
}: {
  garment: TrayGarment | null;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const pickFile = () => inputRef.current?.click();

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
          // Reset so re-selecting the same file fires onChange again.
          e.target.value = '';
        }}
      />
      {garment ? (
        <button
          type="button"
          onClick={pickFile}
          title={`${garment.fileName} — click to replace`}
          style={{
            position: 'relative',
            padding: 0,
            borderRadius: 8,
            overflow: 'hidden',
            border: `1px solid ${C.border}`,
            width: '100%',
            aspectRatio: '1',
            cursor: 'pointer',
          }}
        >
          {/* biome-ignore lint/performance/noImgElement: object URLs cannot go through next/image */}
          <img
            src={garment.previewUrl}
            alt={garment.fileName}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
          {!garment.r2Key && !garment.error && (
            <span
              style={{
                position: 'absolute',
                inset: 'auto 0 0 0',
                fontSize: 10,
                background: 'rgba(0,0,0,0.55)',
                color: C.white,
              }}
            >
              {garment.progress}%
            </span>
          )}
          {garment.error && (
            <span
              style={{
                position: 'absolute',
                inset: 'auto 0 0 0',
                fontSize: 10,
                background: 'rgba(0,0,0,0.55)',
                color: C.white,
              }}
            >
              {garment.error}
            </span>
          )}
          {/* biome-ignore lint/a11y/useSemanticElements: contains a nested interactive <button> (remove) — real <button> here would be invalid HTML (no nesting) */}
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                onRemove();
              }
            }}
            style={{
              position: 'absolute',
              top: 2,
              right: 2,
              display: 'flex',
              padding: 1,
              borderRadius: '50%',
              background: 'rgba(0,0,0,0.55)',
            }}
          >
            <X size={10} color={C.white} />
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={pickFile}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file) onUpload(file);
          }}
          onDragOver={(e) => e.preventDefault()}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            justifyContent: 'center',
            textAlign: 'left',
            padding: '8px 10px',
            borderRadius: 8,
            border: `1px dashed ${C.border}`,
            background: C.white,
            color: C.mid,
            cursor: 'pointer',
            width: '100%',
            aspectRatio: '1',
            boxSizing: 'border-box',
          }}
        >
          <span style={{ display: 'block', fontSize: 11, color: C.mid }}>Garment</span>
          <span style={{ display: 'block', fontSize: 13 }}>Upload</span>
        </button>
      )}
    </div>
  );
}

export function BatchRow({
  row,
  index,
  garments,
  faces,
  backgrounds,
  poses,
  lowerItems,
  shoeItems,
  invalid,
  onPatch,
  onSetPoses,
  onDuplicate,
  onRemove,
  onAddGarment,
  onPatchGarment,
  onRemoveGarment,
}: {
  row: BatchRowState;
  index: number;
  garments: TrayGarment[];
  faces: PickerItem[];
  backgrounds: PickerItem[];
  poses: Array<PickerItem & PoseOption>;
  lowerItems: PickerItem[];
  shoeItems: PickerItem[];
  invalid: boolean;
  onPatch: (patch: Partial<BatchRowState>) => void;
  onSetPoses: (poseIds: string[]) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onAddGarment: (garment: TrayGarment) => void;
  onPatchGarment: (id: string, patch: Partial<TrayGarment>) => void;
  onRemoveGarment: (id: string) => void;
}) {
  const [picker, setPicker] = useState<OpenPicker>(null);
  const narrow = useIsNarrow();

  const garment = garments.find((g) => g.id === row.garmentId) ?? null;
  const face = faces.find((f) => f.id === row.faceId) ?? null;
  const background = backgrounds.find((b) => b.id === row.backgroundId) ?? null;
  const lowerItem = lowerItems.find((i) => i.id === row.lowerCatalogId) ?? null;
  const shoeItem = shoeItems.find((i) => i.id === row.shoeCatalogId) ?? null;
  const selectedPoses = poses.filter((p) => row.poseIds.includes(p.id));
  const { needsLower, needsShoes } = requiredInputsForPoses(selectedPoses);
  const issues = rowIssues(row, poses);

  function handleUpload(file: File) {
    const id = crypto.randomUUID();
    onAddGarment({
      id,
      r2Key: null,
      previewUrl: URL.createObjectURL(file),
      fileName: file.name,
      progress: 0,
      error: file.size > MAX_FILE_BYTES ? 'Over 10 MB' : null,
    });
    onPatch({ garmentId: id });
    if (file.size > MAX_FILE_BYTES) return;
    uploadTrayFile(file, (pct) => onPatchGarment(id, { progress: pct }))
      .then((r2Key) => onPatchGarment(id, { r2Key, progress: 100, error: null }))
      .catch((err: Error) => onPatchGarment(id, { error: err.message || 'Upload failed' }));
  }

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: narrow ? '1fr' : '32px repeat(6, minmax(96px, 1fr)) 72px',
          gap: 8,
          alignItems: narrow ? 'stretch' : 'center',
          padding: 8,
          borderRadius: 10,
          border: `1px solid ${invalid ? C.danger : narrow ? C.border : 'transparent'}`,
          marginBottom: narrow ? 12 : 0,
        }}
      >
        <span style={{ color: C.mid, fontSize: 12 }}>
          {narrow ? `Row ${index + 1}` : index + 1}
        </span>

        <GarmentCell
          garment={garment}
          onUpload={handleUpload}
          onRemove={() => {
            if (row.garmentId) onRemoveGarment(row.garmentId);
          }}
        />
        <Cell
          label="Model"
          value={face?.label ?? 'Choose'}
          thumbnailUrl={face?.thumbnailUrl}
          onClick={() => setPicker('face')}
        />
        <Cell
          label="Background"
          value={background?.label ?? 'Choose'}
          thumbnailUrl={background?.thumbnailUrl}
          onClick={() => setPicker('background')}
        />
        <PoseCell poses={selectedPoses} onClick={() => setPicker('pose')} />
        <Cell
          label="Lower"
          value={needsLower ? (lowerItem?.label ?? 'Choose') : 'Not needed'}
          thumbnailUrl={needsLower ? lowerItem?.thumbnailUrl : null}
          disabled={!needsLower}
          onClick={() => setPicker('lower')}
        />
        <Cell
          label="Shoes"
          value={needsShoes ? (shoeItem?.label ?? 'Choose') : 'Not needed'}
          thumbnailUrl={needsShoes ? shoeItem?.thumbnailUrl : null}
          disabled={!needsShoes}
          onClick={() => setPicker('shoe')}
        />

        <div style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            onClick={onDuplicate}
            title="Duplicate row"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 4,
              border: 'none',
              background: 'transparent',
              color: C.mid,
              cursor: 'pointer',
            }}
          >
            <Copy size={16} />
          </button>
          <button
            type="button"
            onClick={onRemove}
            title="Remove row"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 4,
              border: 'none',
              background: 'transparent',
              color: C.mid,
              cursor: 'pointer',
            }}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* `invalid` also covers a row the server rejected, which has no client-side
          issues to list — in that case the general error message carries the
          reason and the border alone marks the row. */}
      {invalid && issues.length > 0 && (
        <p style={{ margin: '0 0 8px 40px', fontSize: 12, color: C.danger }}>
          Missing: {issues.join(', ')}
        </p>
      )}

      {picker === 'face' && (
        <SelectGridModal
          title="Choose model"
          items={faces}
          selectedIds={row.faceId ? [row.faceId] : []}
          hideLabels
          aspect={3 / 4}
          columns={6}
          onSelect={(id) => {
            onPatch({ faceId: id });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === 'background' && (
        <SelectGridModal
          title="Choose background"
          items={backgrounds}
          selectedIds={row.backgroundId ? [row.backgroundId] : []}
          hideLabels
          aspect={3 / 4}
          columns={6}
          onSelect={(id) => {
            onPatch({ backgroundId: id });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === 'pose' && (
        <SelectGridModal
          title="Choose poses"
          items={poses}
          multiSelect
          selectedIds={row.poseIds}
          continueLabel="Done"
          hideLabels
          aspect={3 / 4}
          columns={6}
          onSelect={(id) =>
            onSetPoses(
              row.poseIds.includes(id) ? row.poseIds.filter((p) => p !== id) : [...row.poseIds, id],
            )
          }
          onClose={() => setPicker(null)}
        />
      )}
      {picker === 'lower' && (
        <SelectGridModal
          title="Choose lower garment"
          items={lowerItems}
          selectedIds={row.lowerCatalogId ? [row.lowerCatalogId] : []}
          hideLabels
          aspect={1}
          columns={6}
          onSelect={(id) => {
            onPatch({ lowerCatalogId: id });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === 'shoe' && (
        <SelectGridModal
          title="Choose shoes"
          items={shoeItems}
          selectedIds={row.shoeCatalogId ? [row.shoeCatalogId] : []}
          hideLabels
          aspect={1}
          columns={6}
          onSelect={(id) => {
            onPatch({ shoeCatalogId: id });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );
}
