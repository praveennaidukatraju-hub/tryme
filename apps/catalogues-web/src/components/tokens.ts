export const C = {
  pink: 'var(--c-pink)',
  amber: 'var(--c-amber)',
  dark: 'var(--c-dark)',
  dark2: 'var(--c-dark2)',
  onDark: 'var(--c-on-dark)',
  white: 'var(--c-white)',
  bg: 'var(--c-bg)',
  card: 'var(--c-card)',
  border: 'var(--c-border)',
  border2: 'var(--c-border2)',
  text: 'var(--c-text)',
  mid: 'var(--c-mid)',
  light: 'var(--c-light)',
  lighter: 'var(--c-lighter)',
  field: 'var(--c-field)',
  mint: 'var(--c-mint)',
  /**
   * Error/invalid signal. Points at the same CSS variable the merchant token map
   * uses (`M.danger`), which globals.css already defines for both light and dark
   * themes — C.pink must stay reserved for "selected/active", or a red invalid
   * row and a chosen picker item read as the same state.
   */
  danger: 'var(--c-merchant-danger)',
} as const;

export const M = {
  pageBg: 'var(--c-merchant-bg)',
  card: 'var(--c-card)',
  accent: 'var(--c-merchant-accent)',
  accentLight: 'var(--c-merchant-accent-light)',
  text: 'var(--c-text)',
  textSecondary: 'var(--c-merchant-text-secondary)',
  textMuted: 'var(--c-merchant-text-muted)',
  textPlaceholder: 'var(--c-merchant-text-placeholder)',
  border: 'var(--c-merchant-border)',
  borderLight: 'var(--c-merchant-border-light)',
  hover: 'var(--c-merchant-hover)',
  divider: 'var(--c-merchant-divider)',
  success: 'var(--c-merchant-success)',
  danger: 'var(--c-merchant-danger)',
  warning: 'var(--c-merchant-warning)',
  white: 'var(--c-white)',
  codeBg: 'var(--c-merchant-code-bg)',
  inputBorder: 'var(--c-merchant-input-border)',
  toggleOff: 'var(--c-merchant-toggle-off)',
  statusGreen: 'var(--c-merchant-status-green)',
  statusRed: 'var(--c-merchant-status-red)',
  statusBlue: 'var(--c-merchant-status-blue)',
  scrollbar: 'var(--c-merchant-scrollbar)',
  successTint: 'var(--c-merchant-success-tint)',
  dangerTint: 'var(--c-merchant-danger-tint)',
  accentTint: 'var(--c-merchant-accent-tint)',
  warningTint: 'var(--c-merchant-warning-tint)',
  mutedTint: 'var(--c-merchant-muted-tint)',
  blueTint: 'var(--c-merchant-blue-tint)',
} as const;

export const grad = 'linear-gradient(91.84deg, #521D9C 0.33%, #BD2587 50.77%, #F96657 99.67%)';
export const gradSubtle = 'var(--c-grad-subtle)';

export const BG_TINTS = [
  '#f5f0e8',
  '#e8f0f5',
  '#f0e8f5',
  '#e8f5ee',
  '#f5e8e8',
  '#eef5e8',
  '#f5f5e8',
  '#e8e8f5',
];
