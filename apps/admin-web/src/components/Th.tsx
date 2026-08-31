import type { ThHTMLAttributes } from 'react';

export type SortDir = 'asc' | 'desc';

interface ThProps<T extends string> extends ThHTMLAttributes<HTMLTableCellElement> {
  k?: T;
  sortKey?: T;
  sortDir?: SortDir;
  onSort?: (k: T) => void;
  right?: boolean;
}

export function Th<T extends string>({
  children,
  k,
  sortKey,
  sortDir,
  onSort,
  right,
  className,
  ...rest
}: ThProps<T>) {
  if (!k) {
    return (
      <th className={`${right ? 'right' : ''} ${className || ''}`} {...rest}>
        {children}
      </th>
    );
  }

  const isActive = sortKey === k;
  const arrow = isActive ? (sortDir === 'asc' ? '\u25B2' : '\u25BC') : '';

  return (
    <th
      className={`sortable ${right ? 'right' : ''} ${className || ''}`}
      onClick={() => onSort?.(k)}
      {...rest}
    >
      {children}
      {isActive && <span className="sort-arrow">{arrow}</span>}
    </th>
  );
}
