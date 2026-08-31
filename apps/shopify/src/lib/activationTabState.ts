export type ActivationMode = 'global' | 'selective';
export type ActivationTab = 'collections' | 'individual' | 'exclusion';

/**
 * The Exclusion tab stays editable in every mode — exclusion always wins,
 * including under global, so it must never be locked out. Collections and
 * Individual Products go read-only under global mode: their data stays
 * visible (status badges included), only Add/Remove is disabled.
 */
export function isTabEditable(mode: ActivationMode, tab: ActivationTab): boolean {
  if (tab === 'exclusion') return true;
  return mode !== 'global';
}
