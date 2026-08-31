'use client';
import { countBatchJobs, requiredInputsForPoses } from '@tryme/types';
import { useCallback, useState } from 'react';
import type { BatchRowState, PoseOption } from './types';

function newRow(): BatchRowState {
  return {
    id: crypto.randomUUID(),
    garmentId: null,
    faceId: '',
    backgroundId: '',
    poseIds: [],
    lowerCatalogId: '',
    shoeCatalogId: '',
  };
}

/**
 * Lists what a row is still missing. Empty means the row is submittable.
 * The lower/shoe rule comes from requiredInputsForPoses so the client and the
 * API cannot drift — the API rejects exactly what this predicts.
 */
export function rowIssues(row: BatchRowState, poses: PoseOption[]): string[] {
  const issues: string[] = [];
  if (!row.garmentId) issues.push('garment');
  if (!row.faceId) issues.push('model');
  if (!row.backgroundId) issues.push('background');
  if (row.poseIds.length === 0) issues.push('pose');

  const selected = poses.filter((p) => row.poseIds.includes(p.id));
  const { needsLower, needsShoes } = requiredInputsForPoses(selected);
  if (needsLower && !row.lowerCatalogId) issues.push('lower garment');
  if (needsShoes && !row.shoeCatalogId) issues.push('shoes');
  return issues;
}

export function batchIssues(
  rows: BatchRowState[],
  poses: PoseOption[],
): { invalidRowIds: string[]; totalJobs: number } {
  return {
    invalidRowIds: rows.filter((r) => rowIssues(r, poses).length > 0).map((r) => r.id),
    totalJobs: countBatchJobs(rows),
  };
}

export function useBatchState() {
  const [rows, setRows] = useState<BatchRowState[]>([newRow()]);

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, newRow()]);
  }, []);

  const duplicateRow = useCallback((rowId: string) => {
    setRows((prev) => {
      const index = prev.findIndex((r) => r.id === rowId);
      if (index === -1) return prev;
      const copy = { ...prev[index], id: crypto.randomUUID() } as BatchRowState;
      return [...prev.slice(0, index + 1), copy, ...prev.slice(index + 1)];
    });
  }, []);

  /**
   * Bulk upload creates one row per garment. A lone untouched starter row
   * (the grid's initial empty row, or what's left after clearing) is reused
   * for the first garment instead of left behind as a stray empty row.
   */
  const addRowsForGarments = useCallback((garmentIds: string[]) => {
    if (garmentIds.length === 0) return;
    setRows((prev) => {
      const isBlank = (r: BatchRowState) =>
        !r.garmentId &&
        !r.faceId &&
        !r.backgroundId &&
        r.poseIds.length === 0 &&
        !r.lowerCatalogId &&
        !r.shoeCatalogId;
      const starter = prev[0];
      const reuseStarter = prev.length === 1 && starter !== undefined && isBlank(starter);
      const base = reuseStarter ? [{ ...starter, garmentId: garmentIds[0] ?? null }] : prev;
      const remaining = reuseStarter ? garmentIds.slice(1) : garmentIds;
      return [...base, ...remaining.map((gid) => ({ ...newRow(), garmentId: gid }))];
    });
  }, []);

  /** Overwrites one field on every row — the row-level "Apply to all" action. */
  const applyToAllRows = useCallback((patch: Partial<BatchRowState>) => {
    setRows((prev) => prev.map((r) => ({ ...r, ...patch })));
  }, []);

  /** Same as setPoses, but broadcast to every row instead of one. */
  const applyPosesToAllRows = useCallback((poseIds: string[], poses: PoseOption[]) => {
    setRows((prev) =>
      prev.map((r) => {
        const selected = poses.filter((p) => poseIds.includes(p.id));
        const { needsLower, needsShoes } = requiredInputsForPoses(selected);
        return {
          ...r,
          poseIds,
          lowerCatalogId: needsLower ? r.lowerCatalogId : '',
          shoeCatalogId: needsShoes ? r.shoeCatalogId : '',
        };
      }),
    );
  }, []);

  // The grid must never reach zero rows — an empty grid has no affordance to add
  // one back that is discoverable mid-task.
  const removeRow = useCallback((rowId: string) => {
    setRows((prev) => (prev.length === 1 ? [newRow()] : prev.filter((r) => r.id !== rowId)));
  }, []);

  const patchRow = useCallback((rowId: string, patch: Partial<BatchRowState>) => {
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
  }, []);

  /**
   * Changing the pose selection can retire the lower/shoe requirement. Clear the
   * now-irrelevant values rather than submitting them: the API strips inputs the
   * workflow does not support, so leaving them set would show the user a
   * selection that silently has no effect.
   */
  const setPoses = useCallback((rowId: string, poseIds: string[], poses: PoseOption[]) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== rowId) return r;
        const selected = poses.filter((p) => poseIds.includes(p.id));
        const { needsLower, needsShoes } = requiredInputsForPoses(selected);
        return {
          ...r,
          poseIds,
          lowerCatalogId: needsLower ? r.lowerCatalogId : '',
          shoeCatalogId: needsShoes ? r.shoeCatalogId : '',
        };
      }),
    );
  }, []);

  /**
   * Removing a tray tile must not leave rows pointing at it. rowIssues only asks
   * whether a row *has* a garmentId, so a dangling id would keep the row looking
   * complete and let submit fire — which then fails with a misleading
   * "still uploading" message and no row attribution. Clearing the reference
   * puts the row back into the normal "Missing: garment" state instead.
   */
  const clearGarmentFromRows = useCallback((garmentId: string) => {
    setRows((prev) => prev.map((r) => (r.garmentId === garmentId ? { ...r, garmentId: null } : r)));
  }, []);

  const resetRows = useCallback(() => {
    setRows([newRow()]);
  }, []);

  return {
    rows,
    addRow,
    duplicateRow,
    removeRow,
    patchRow,
    setPoses,
    clearGarmentFromRows,
    resetRows,
    addRowsForGarments,
    applyToAllRows,
    applyPosesToAllRows,
  };
}
