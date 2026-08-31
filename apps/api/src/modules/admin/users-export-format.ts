// Shared between the PDF and Excel user-export renderers so the title-block
// filter summary and date formatting can never drift between the two formats.

export interface UsersExportFilters {
  search?: string;
  merchantsOnly?: boolean;
  showBanned?: boolean;
  createdFrom?: string;
  createdTo?: string;
  tier?: string;
  sortDir: 'asc' | 'desc';
}

export function fmtExportDate(date: Date): string {
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function exportFilterSummary(filters: UsersExportFilters): string {
  const parts: string[] = [];
  if (filters.search) parts.push(`Search: "${filters.search}"`);
  if (filters.merchantsOnly) parts.push('Merchants only');
  if (filters.showBanned) parts.push('Including suspended');
  if (filters.createdFrom || filters.createdTo) {
    const from = filters.createdFrom ? fmtExportDate(new Date(filters.createdFrom)) : 'the start';
    const to = filters.createdTo ? fmtExportDate(new Date(filters.createdTo)) : 'now';
    parts.push(`Joined ${from} – ${to}`);
  }
  if (filters.tier) parts.push(`Plan: ${filters.tier}`);
  parts.push(
    `Sorted by join date (${filters.sortDir === 'asc' ? 'oldest first' : 'newest first'})`,
  );
  return parts.join(' · ');
}
