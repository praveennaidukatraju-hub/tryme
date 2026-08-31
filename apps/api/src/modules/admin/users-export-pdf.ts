import PDFDocument from 'pdfkit';
import {
  exportFilterSummary,
  fmtExportDate,
  type UsersExportFilters,
} from './users-export-format.js';
import type { UserExportRow } from './users-export-query.js';

const NAVY = '#1F3864';
const GRAY = '#555555';
const LIGHT_GRAY = '#888888';
const DANGER = '#B00020';

// pdfkit's `lineBreak: false` only skips defaulting `width` internally — it
// does not stop wrapping once a width is given, and `ellipsis: true` only
// truncates when a `height` constraint is also set (neither applies to a
// single-line table cell). So cells are truncated by hand, measuring against
// the currently active font/size via doc.widthOfString.
function truncateToWidth(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string {
  if (doc.widthOfString(text) <= maxWidth) return text;
  const ellipsis = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(text.slice(0, mid) + ellipsis) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + ellipsis : ellipsis;
}

function rowName(row: UserExportRow): string {
  return row.displayName || row.username || row.email || 'User';
}

interface Column {
  key: keyof ReturnType<typeof rowValues>;
  label: string;
  width: number;
  align?: 'left' | 'right' | 'center';
}

function rowValues(row: UserExportRow, idx: number) {
  return {
    idx: String(idx + 1),
    name: rowName(row),
    mobile: row.phone || '—',
    email: row.email || '—',
    plan: row.planName || row.tier,
    type: row.isMerchant ? 'Merchant' : 'User',
    company: row.companyName || '—',
    joined: fmtExportDate(row.createdAt),
    credits: row.balance.toLocaleString('en-IN'),
    jobs: String(row.totalJobs),
    lastActivity: row.lastJobAt ? fmtExportDate(new Date(row.lastJobAt)) : '—',
    status: row.isBanned ? 'Suspended' : 'Active',
  };
}

// Widths sum to 768 = A4 landscape width (842) minus 2*30 margin minus a hair
// of rounding slack — keep any edit here summing to the same total.
const COLUMNS: Column[] = [
  { key: 'idx', label: '#', width: 20 },
  { key: 'name', label: 'Name', width: 102 },
  { key: 'mobile', label: 'Mobile', width: 72 },
  { key: 'email', label: 'Email', width: 140 },
  { key: 'plan', label: 'Plan', width: 52, align: 'center' },
  { key: 'type', label: 'Type', width: 50, align: 'center' },
  { key: 'company', label: 'Company', width: 98 },
  { key: 'joined', label: 'Joined', width: 60, align: 'center' },
  { key: 'credits', label: 'Credits', width: 44, align: 'right' },
  { key: 'jobs', label: 'Jobs', width: 30, align: 'right' },
  { key: 'lastActivity', label: 'Last Activity', width: 60, align: 'center' },
  { key: 'status', label: 'Status', width: 40, align: 'center' },
];

export function renderUsersExportPdf(
  rows: UserExportRow[],
  meta: { generatedAt: Date; filters: UsersExportFilters },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 30;
    const right = doc.page.width - 30;
    const width = right - left;
    const bottomLimit = doc.page.height - 40;

    let page = 1;
    const drawFooter = () => {
      doc
        .fillColor(LIGHT_GRAY)
        .font('Helvetica')
        .fontSize(7.5)
        .text(
          `Page ${page} — Generated ${meta.generatedAt.toLocaleString('en-IN')}`,
          left,
          doc.page.height - 25,
          { width, align: 'center' },
        );
    };

    const drawColumnHeader = (y: number): number => {
      doc.rect(left, y, width, 18).fill(NAVY);
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8);
      let x = left;
      for (const col of COLUMNS) {
        doc.text(col.label, x + 4, y + 5, { width: col.width - 6, align: col.align ?? 'left' });
        x += col.width;
      }
      return y + 18 + 6;
    };

    doc
      .fillColor('#000')
      .font('Helvetica-Bold')
      .fontSize(16)
      .text('AI Vastra — User Export', left, 30);
    doc.fillColor(GRAY).font('Helvetica').fontSize(8.5);
    doc.text(
      `${rows.length.toLocaleString('en-IN')} users — ${exportFilterSummary(meta.filters)}`,
      left,
      doc.y + 4,
      {
        width,
      },
    );
    let y = drawColumnHeader(doc.y + 12);

    doc.font('Helvetica').fontSize(8);
    rows.forEach((row, i) => {
      if (y + 14 > bottomLimit) {
        drawFooter();
        doc.addPage();
        page += 1;
        y = drawColumnHeader(30);
        doc.font('Helvetica').fontSize(8);
      }
      const values = rowValues(row, i);
      doc.fillColor(row.isBanned ? DANGER : '#000');
      let x = left;
      for (const col of COLUMNS) {
        const cellWidth = col.width - 6;
        doc.text(truncateToWidth(doc, values[col.key], cellWidth), x + 4, y, {
          width: cellWidth,
          align: col.align ?? 'left',
          lineBreak: false,
        });
        x += col.width;
      }
      y += 14;
    });

    drawFooter();
    doc.end();
  });
}
