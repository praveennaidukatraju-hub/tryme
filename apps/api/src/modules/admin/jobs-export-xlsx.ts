import ExcelJS from 'exceljs';
import type { JobExportRow } from './jobs-export-query.js';

const NAVY = 'FF1F3864';
const DANGER = 'FFB00020';

interface Column {
  header: string;
  width: number;
}

const COLUMNS: Column[] = [
  { header: '#', width: 6 },
  { header: 'Job ID', width: 38 },
  { header: 'User', width: 26 },
  { header: 'Email', width: 32 },
  { header: 'Job Type', width: 16 },
  { header: 'Started', width: 20 },
  { header: 'Ended', width: 20 },
  { header: 'Credits Used', width: 14 },
  { header: 'Credits Remaining', width: 16 },
  { header: 'Status', width: 16 },
  { header: 'Failure Reason', width: 32 },
];

function titleCaseStatus(status: string): string {
  return status
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const FAILED_LIKE = new Set(['FAILED', 'CANCELLED']);

export interface JobsExportSummary {
  generatedAt: Date;
  filterDescription: string;
}

export async function renderJobsExportXlsx(
  rows: JobExportRow[],
  meta: JobsExportSummary,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AI Vastra Admin';
  wb.created = meta.generatedAt;

  const sheet = wb.addWorksheet('Jobs');
  sheet.columns = COLUMNS.map((c) => ({ width: c.width }));

  sheet.mergeCells(1, 1, 1, COLUMNS.length);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = 'AI Vastra — Jobs Export';
  titleCell.font = { bold: true, size: 14 };

  sheet.mergeCells(2, 1, 2, COLUMNS.length);
  const summaryCell = sheet.getCell(2, 1);
  summaryCell.value = `${rows.length.toLocaleString('en-IN')} jobs — ${meta.filterDescription}`;
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
    const isFailed = row.status === 'FAILED';
    const failureReason = isFailed ? row.errorCode || 'Failed' : '';
    const excelRow = sheet.addRow([
      i + 1,
      row.jobId,
      row.userName,
      row.userEmail || '',
      titleCaseStatus(row.jobType || 'Tryon'),
      row.startedAt,
      row.completedAt,
      row.creditsUsed,
      row.creditsRemaining,
      titleCaseStatus(row.status),
      failureReason,
    ]);
    excelRow.getCell(6).numFmt = 'dd mmm yyyy hh:mm';
    excelRow.getCell(7).numFmt = 'dd mmm yyyy hh:mm';
    if (FAILED_LIKE.has(row.status)) {
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
