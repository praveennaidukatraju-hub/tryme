interface PagerProps {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPage: (n: number) => void;
}

export function Pager({ page, totalPages, totalItems, pageSize, onPage }: PagerProps) {
  const pages = Math.max(1, totalPages);
  const start = totalItems === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, totalItems);

  const pageList: (number | `ellipsis-after-${number}`)[] = [];
  for (let i = 0; i < pages; i++) {
    if (i === 0 || i === pages - 1 || (i >= page - 2 && i <= page + 2)) {
      pageList.push(i);
    } else {
      const last = pageList[pageList.length - 1];
      if (typeof last === 'number') pageList.push(`ellipsis-after-${last}`);
    }
  }

  return (
    <div className="pager">
      <span className="pager-info">
        Showing {start}&ndash;{end} of {totalItems}
      </span>
      <div className="pages">
        <button disabled={page <= 0} onClick={() => onPage(page - 1)}>
          &#8249;
        </button>
        {pageList.map((p) =>
          typeof p === 'string' ? (
            <span key={p}>&hellip;</span>
          ) : (
            <button key={p} className={p === page ? 'active' : ''} onClick={() => onPage(p)}>
              {p + 1}
            </button>
          ),
        )}
        <button disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
          &#8250;
        </button>
      </div>
    </div>
  );
}
