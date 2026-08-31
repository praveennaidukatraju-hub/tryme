'use client';
import { Users } from 'lucide-react';
import { useState } from 'react';
import { C } from '@/components/tokens';
import { SelectGridModal } from '../select-modal';
import { BatchRow, type PickerItem } from './batch-row';
import type { BatchRowState, PoseOption, TrayGarment } from './types';

type ApplyAllField = 'face' | 'background' | 'pose' | 'lower' | 'shoe' | null;

const APPLY_ALL_FIELDS: Array<{ field: Exclude<ApplyAllField, null>; label: string }> = [
  { field: 'face', label: 'Model' },
  { field: 'background', label: 'Background' },
  { field: 'pose', label: 'Poses' },
  { field: 'lower', label: 'Lower' },
  { field: 'shoe', label: 'Shoes' },
];

/**
 * Sets one field on every row at once. Lives in the Configure panel itself
 * (rather than as a checkbox inside each row's own picker popup) so it reads
 * as a batch-wide action, not something buried a level down in a per-row
 * modal.
 */
function ApplyAllToolbar({
  faces,
  backgrounds,
  poses,
  lowerItems,
  shoeItems,
  onApplyToAll,
  onApplyPosesToAll,
}: {
  faces: PickerItem[];
  backgrounds: PickerItem[];
  poses: Array<PickerItem & PoseOption>;
  lowerItems: PickerItem[];
  shoeItems: PickerItem[];
  onApplyToAll: (patch: Partial<BatchRowState>) => void;
  onApplyPosesToAll: (poseIds: string[]) => void;
}) {
  const [open, setOpen] = useState<ApplyAllField>(null);
  const [selectedPoseIds, setSelectedPoseIds] = useState<string[]>([]);

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        marginBottom: 16,
        borderRadius: 10,
        border: `1px solid ${C.border}`,
        background: C.field,
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          fontWeight: 600,
          color: C.text,
        }}
      >
        <Users size={14} />
        Apply to all rows:
      </span>
      {APPLY_ALL_FIELDS.map(({ field, label }) => (
        <button
          key={field}
          type="button"
          onClick={() => {
            setSelectedPoseIds([]);
            setOpen(field);
          }}
          style={{
            padding: '6px 12px',
            borderRadius: 999,
            border: `1px solid ${C.border2}`,
            background: C.white,
            color: C.text,
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {label}
        </button>
      ))}

      {open === 'face' && (
        <SelectGridModal
          title="Apply model to all rows"
          items={faces}
          selectedIds={[]}
          hideLabels
          aspect={3 / 4}
          columns={6}
          onSelect={(id) => {
            onApplyToAll({ faceId: id });
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'background' && (
        <SelectGridModal
          title="Apply background to all rows"
          items={backgrounds}
          selectedIds={[]}
          hideLabels
          aspect={3 / 4}
          columns={6}
          onSelect={(id) => {
            onApplyToAll({ backgroundId: id });
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'pose' && (
        <SelectGridModal
          title="Apply poses to all rows"
          items={poses}
          multiSelect
          selectedIds={selectedPoseIds}
          continueLabel="Apply to all rows"
          hideLabels
          aspect={3 / 4}
          columns={6}
          onSelect={(id) =>
            setSelectedPoseIds((prev) =>
              prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
            )
          }
          onClose={() => {
            if (selectedPoseIds.length > 0) onApplyPosesToAll(selectedPoseIds);
            setOpen(null);
          }}
        />
      )}
      {open === 'lower' && (
        <SelectGridModal
          title="Apply lower garment to all rows"
          items={lowerItems}
          selectedIds={[]}
          hideLabels
          aspect={1}
          columns={6}
          onSelect={(id) => {
            onApplyToAll({ lowerCatalogId: id });
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'shoe' && (
        <SelectGridModal
          title="Apply shoes to all rows"
          items={shoeItems}
          selectedIds={[]}
          hideLabels
          aspect={1}
          columns={6}
          onSelect={(id) => {
            onApplyToAll({ shoeCatalogId: id });
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

export function BatchGrid({
  rows,
  invalidRowIds,
  garments,
  faces,
  backgrounds,
  poses,
  lowerItems,
  shoeItems,
  onPatchRow,
  onSetPoses,
  onDuplicateRow,
  onRemoveRow,
  onAddRow,
  onAddGarment,
  onPatchGarment,
  onRemoveGarment,
  onApplyToAll,
  onApplyPosesToAll,
}: {
  rows: BatchRowState[];
  invalidRowIds: string[];
  garments: TrayGarment[];
  faces: PickerItem[];
  backgrounds: PickerItem[];
  poses: Array<PickerItem & PoseOption>;
  lowerItems: PickerItem[];
  shoeItems: PickerItem[];
  onPatchRow: (rowId: string, patch: Partial<BatchRowState>) => void;
  onSetPoses: (rowId: string, poseIds: string[]) => void;
  onDuplicateRow: (rowId: string) => void;
  onRemoveRow: (rowId: string) => void;
  onAddRow: () => void;
  onAddGarment: (garment: TrayGarment) => void;
  onPatchGarment: (id: string, patch: Partial<TrayGarment>) => void;
  onRemoveGarment: (id: string) => void;
  onApplyToAll: (patch: Partial<BatchRowState>) => void;
  onApplyPosesToAll: (poseIds: string[]) => void;
}) {
  return (
    <div>
      {rows.length > 1 && (
        <ApplyAllToolbar
          faces={faces}
          backgrounds={backgrounds}
          poses={poses}
          lowerItems={lowerItems}
          shoeItems={shoeItems}
          onApplyToAll={onApplyToAll}
          onApplyPosesToAll={onApplyPosesToAll}
        />
      )}

      {/* Row cells have a min width floor (see batch-row.tsx's gridTemplateColumns)
          so they stay legible at any zoom/window size. When the container is
          narrower than that floor, scroll horizontally instead of clipping —
          Lower/Shoe are the rightmost columns and are the first to disappear
          silently without this. */}
      <div style={{ overflowX: 'auto' }}>
        {rows.map((row, index) => (
          <BatchRow
            key={row.id}
            row={row}
            index={index}
            garments={garments}
            faces={faces}
            backgrounds={backgrounds}
            poses={poses}
            lowerItems={lowerItems}
            shoeItems={shoeItems}
            invalid={invalidRowIds.includes(row.id)}
            onPatch={(patch) => onPatchRow(row.id, patch)}
            onSetPoses={(poseIds) => onSetPoses(row.id, poseIds)}
            onDuplicate={() => onDuplicateRow(row.id)}
            onRemove={() => onRemoveRow(row.id)}
            onAddGarment={onAddGarment}
            onPatchGarment={onPatchGarment}
            onRemoveGarment={onRemoveGarment}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onAddRow}
        style={{
          marginTop: 8,
          padding: '8px 14px',
          borderRadius: 8,
          border: `1px dashed ${C.border}`,
          background: 'transparent',
          color: C.text,
          cursor: 'pointer',
        }}
      >
        + Add row
      </button>
    </div>
  );
}
