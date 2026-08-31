import { Button, Collapsible, DataTable } from '@shopify/polaris';
import { useState } from 'react';

/**
 * The non-graphical equivalent of a chart. Required rather than optional: a
 * chart that can only be read by looking at it is unreadable to anyone using a
 * screen reader.
 */
export function ChartTable({
  id,
  columns,
  rows,
}: {
  /** Distinct per instance — two of these render on the Analytics page, and a
   *  shared id would point both disclosure buttons at the same region. */
  id: string;
  columns: [string, string];
  rows: { label: string; value: string }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="plain"
        onClick={() => setOpen((o) => !o)}
        ariaExpanded={open}
        ariaControls={id}
      >
        {open ? 'Hide data table' : 'View as table'}
      </Button>
      <Collapsible open={open} id={id}>
        <DataTable
          columnContentTypes={['text', 'numeric']}
          headings={columns}
          rows={rows.map((r) => [r.label, r.value])}
        />
      </Collapsible>
    </>
  );
}
