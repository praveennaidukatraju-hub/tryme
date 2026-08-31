import ExcelJS from 'exceljs';
import { exportFilterSummary, type UsersExportFilters } from './users-export-format.js';
import type { UserExportRow } from './users-export-query.js';

const NAVY = 'FF1F3864';
const DANGER = 'FFB00020';

interface Column {
  header: string;
  width: number;
}

const COLUMNS: Column[] = [
  { header: '#', width: 6 },
  { header: 'Name', width: 28 },
  { header: 'Mobile', width: 16 },
  { header: 'Email', width: 34 },
  { header: 'Plan', width: 14 },
  { header: 'Type', width: 12 },
  { header: 'Company', width: 26 },
  { header: 'Joined', width: 14 },
  { header: 'Credits', width: 12 },
  { header: 'Jobs', width: 10 },
  { header: 'Last Activity', width: 16 },
  { header: 'Status', width: 12 },
];

function rowName(row: UserExportRow): string {
  return row.displayName || row.username || row.email || 'User';
}

export async function renderUsersExportXlsx(
  rows: UserExportRow[],
  meta: { generatedAt: Date; filters: UsersExportFilters },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AI Vastra Admin';
  wb.created = meta.generatedAt;

  const sheet = wb.addWorksheet('Users');
  sheet.columns = COLUMNS.map((c) => ({ width: c.width }));

  sheet.mergeCells(1, 1, 1, COLUMNS.length);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = 'AI Vastra — User Export';
  titleCell.font = { bold: true, size: 14 };

  sheet.mergeCells(2, 1, 2, COLUMNS.length);
  const summaryCell = sheet.getCell(2, 1);
  summaryCell.value = `${rows.length.toLocaleString('en-IN')} users — ${exportFilterSummary(meta.filters)}`;
  summaryCell.font = { italic: true, size: 10, color: { argb: 'FF555555' } };

  const HEADER_ROW = 4;
  const headerRow = sheet.getRow(HEADER_ROW);
  COLUMNS.forEach((col, i) => {
    headerRow.getCell(i + 1).value = col.header;
  });
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    cell.alignment = { vertical: 'middle' };
  });
  sheet.views = [{ state: 'frozen', ySplit: HEADER_ROW }];

  rows.forEach((row, i) => {
    const excelRow = sheet.addRow([
      i + 1,
      rowName(row),
      row.phone || '',
      row.email || '',
      row.planName || row.tier,
      row.isMerchant ? 'Merchant' : 'User',
      row.companyName || '',
      row.createdAt,
      row.balance,
      row.totalJobs,
      row.lastJobAt ? new Date(row.lastJobAt) : 'No activity',
      row.isBanned ? 'Suspended' : 'Active',
    ]);
    excelRow.getCell(8).numFmt = 'dd mmm yyyy';
    if (row.lastJobAt) {
      excelRow.getCell(11).numFmt = 'dd mmm yyyy';
    }
    if (row.isBanned) {
      excelRow.font = { color: { argb: DANGER } };
    }
  });

  sheet.autoFilter = {
    from: { row: HEADER_ROW, column: 1 },
    to: { row: HEADER_ROW, column: COLUMNS.length },
  };

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
