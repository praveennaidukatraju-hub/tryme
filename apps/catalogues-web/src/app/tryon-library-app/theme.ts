import type { MerchantCatalogCategory as Category } from '@tryme/types';

// This entire app section (Try On Library merchant mini-app, embedded in the
// Android WebView) is designed light-only — hardcoded hex rather than the
// site's theme-aware C/M tokens (@/components/tokens), which flip dark under
// html.dark and would turn near-white text invisible against the forced white
// background used throughout this section.
export const LIGHT = {
  bg: '#fafafa',
  card: '#ffffff',
  text: '#141414',
  mid: '#626262',
  border: '#eeeeee',
  border2: '#e8e8e8',
  field: '#f9f9f9',
} as const;

// `accent` colors chevrons/icons/CTAs per category; `tint` is the matching
// pill/badge background — hardcoded rgba (not theme-var-derived) so it stays
// correct under the forced-light design above.
export const GENDER_OPTIONS: {
  id: Category;
  label: string;
  description: string;
  accent: string;
  tint: string;
}[] = [
  {
    id: 'women',
    label: 'Women',
    description: "Upload and manage women's wear products.",
    accent: '#f55c7a',
    tint: 'rgba(245, 92, 122, 0.12)',
  },
  {
    id: 'men',
    label: 'Men',
    description: "Upload and manage men's wear products.",
    accent: '#f55c7a',
    tint: 'rgba(245, 92, 122, 0.12)',
  },
  {
    id: 'girls',
    label: 'Girls',
    description: "Upload and manage girls' wear products.",
    accent: '#f55c7a',
    tint: 'rgba(245, 92, 122, 0.12)',
  },
  {
    id: 'boys',
    label: 'Boys',
    description: "Upload and manage boys' wear products.",
    accent: '#f55c7a',
    tint: 'rgba(245, 92, 122, 0.12)',
  },
];

const DEFAULT_ACCENT = GENDER_OPTIONS[0]?.accent ?? '#f55c7a';
const DEFAULT_TINT = GENDER_OPTIONS[0]?.tint ?? 'rgba(245, 92, 122, 0.12)';

export function categoryAccent(id: Category | null | undefined): string {
  return GENDER_OPTIONS.find((g) => g.id === id)?.accent ?? DEFAULT_ACCENT;
}

export function categoryTint(id: Category | null | undefined): string {
  return GENDER_OPTIONS.find((g) => g.id === id)?.tint ?? DEFAULT_TINT;
}
