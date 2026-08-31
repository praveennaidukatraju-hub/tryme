import PDFDocument from 'pdfkit';

export interface InvoiceData {
  invoiceNumber: string;
  issuedAt: Date;
  seller: {
    gstin: string;
    legalName: string;
    address: string;
    pan: string;
    tan: string;
    udyamRegNo: string;
  };
  customer: {
    email: string;
    gstin: string | null;
    displayName: string | null;
    companyName: string | null;
    phone: string | null;
  };
  orderId: string;
  planName: string;
  credits: number;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
  paymentStatus: string;
  razorpayPaymentId: string | null;
  paidAt: Date | null;
}

const NAVY = '#1F3864';
const AMBER = '#B5651D';
const GRAY = '#555555';
const LIGHT_GRAY = '#888888';
const GREEN = '#1E7A34';

// Apr 1 - Mar 31 Indian GST financial year, e.g. "2026-27" for any date
// from 2026-04-01 through 2027-03-31.
export function financialYearFor(date: Date): string {
  const y = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? y : y - 1; // getUTCMonth() is 0-indexed; 3 = April
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function fmtRupees(paise: number): string {
  return (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

function fmtDate(date: Date): string {
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Official GST state codes — the first two digits of any GSTIN. Used only to
// decide CGST+SGST (same state as seller) vs IGST (different state); the
// name itself is cosmetic ("Place of Supply").
const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};

function stateNameForGstin(gstin: string | null | undefined): string | null {
  if (!gstin || gstin.length < 2) return null;
  return GST_STATE_CODES[gstin.slice(0, 2)] ?? null;
}

// CGST+SGST when the customer's GSTIN state matches the seller's (or the
// customer has no GSTIN at all — most retail purchases — where we default to
// same-state since there's no billing address collected to determine
// otherwise). Only switches to IGST when a customer GSTIN proves a different state.
function isInterState(sellerGstin: string, customerGstin: string | null): boolean {
  const sellerState = stateNameForGstin(sellerGstin);
  const customerState = stateNameForGstin(customerGstin);
  if (!sellerState || !customerState) return false;
  return sellerState !== customerState;
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigitWords(n: number): string {
  if (n < 20) return ONES[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return ones ? `${TENS[tens]} ${ONES[ones]}` : TENS[tens];
}

function threeDigitWords(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (hundreds) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest) parts.push(twoDigitWords(rest));
  return parts.join(' ');
}

// Indian numbering (Lakh/Crore), matching how GST invoices conventionally
// spell out amounts — not the Western thousand/million grouping.
function numberToIndianWords(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${threeDigitWords(crore)} Crore`);
  if (lakh) parts.push(`${threeDigitWords(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigitWords(thousand)} Thousand`);
  if (rest) parts.push(threeDigitWords(rest));
  return parts.join(' ');
}

function amountInWords(totalPaise: number): string {
  const rupees = Math.floor(totalPaise / 100);
  const paise = totalPaise % 100;
  const rupeeWords = `Rupees ${numberToIndianWords(rupees)}`;
  const paiseWords = paise ? ` and ${numberToIndianWords(paise)} Paise` : '';
  return `${rupeeWords}${paiseWords} Only`;
}

export function renderInvoicePdf(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 50;
    const right = 545;
    const width = right - left;

    // ── Header ───────────────────────────────────────────────
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(22).text('AI VASTRA', left, 50);
    doc
      .fillColor(GRAY)
      .font('Helvetica-Oblique')
      .fontSize(10)
      .text(data.seller.legalName ? `by ${data.seller.legalName}` : '', left, 76);
    doc
      .fillColor(AMBER)
      .font('Helvetica-Bold')
      .fontSize(16)
      .text('TAX INVOICE', left, 55, { width, align: 'right' });

    doc.fillColor(NAVY).moveTo(left, 100).lineTo(right, 100).lineWidth(1.5).stroke();

    // ── Seller block (left) / Invoice meta (right) ──────────
    const infoTop = 115;
    doc
      .fillColor(AMBER)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(data.seller.legalName || 'Seller not configured', left, infoTop);
    doc.fillColor(GRAY).font('Helvetica').fontSize(9);
    let sellerY = infoTop + 16;
    for (const line of (data.seller.address || '').split('\n').filter(Boolean)) {
      doc.text(line, left, sellerY, { width: 260 });
      sellerY = doc.y;
    }
    if (data.seller.gstin) {
      doc.text(`GSTIN: ${data.seller.gstin}`, left, sellerY, { width: 260 });
      sellerY = doc.y;
    }
    if (data.seller.pan) {
      doc.text(`PAN: ${data.seller.pan}`, left, sellerY, { width: 260 });
      sellerY = doc.y;
    }
    if (data.seller.tan) {
      doc.text(`TAN: ${data.seller.tan}`, left, sellerY, { width: 260 });
      sellerY = doc.y;
    }
    if (data.seller.udyamRegNo) {
      doc.text(`Udyam Reg. No.: ${data.seller.udyamRegNo}`, left, sellerY, { width: 260 });
      sellerY = doc.y;
    }

    const metaX = left + 300;
    const metaValueX = metaX + 90;
    const placeOfSupply =
      stateNameForGstin(data.customer.gstin) ?? stateNameForGstin(data.seller.gstin) ?? '—';
    const metaRows: [string, string][] = [
      ['Invoice No.', data.invoiceNumber],
      ['Invoice Date', fmtDate(data.issuedAt)],
      ['Order ID', data.orderId],
      ['Place of Supply', placeOfSupply],
    ];
    let metaY = infoTop;
    for (const [label, value] of metaRows) {
      doc.fillColor(GRAY).font('Helvetica').fontSize(9).text(label, metaX, metaY, { width: 85 });
      doc
        .fillColor('#000')
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(value, metaValueX, metaY, { width: width - 300 - 90 });
      metaY += 18;
    }

    // ── Bill To ──────────────────────────────────────────────
    const billTop = Math.max(sellerY, metaY) + 20;
    doc.fillColor(AMBER).font('Helvetica-Bold').fontSize(10).text('BILL TO', left, billTop);
    let billY = billTop + 15;
    const customerName =
      data.customer.companyName || data.customer.displayName || data.customer.email;
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(10).text(customerName, left, billY);
    billY = doc.y + 3;
    doc.fillColor(GRAY).font('Helvetica').fontSize(9);
    if (data.customer.gstin) {
      doc.text(`GSTIN: ${data.customer.gstin}`, left, billY);
      billY = doc.y;
    }
    doc.text(`Contact: ${data.customer.phone || data.customer.email}`, left, billY);
    billY = doc.y;

    // ── Line items table ─────────────────────────────────────
    // `pad` insets the text columns from the table's outer edges (the navy
    // rect itself still spans the full `width`); the widths sum to exactly
    // `width - 2*pad` so nothing overflows the right margin.
    const tableTop = billY + 25;
    const pad = 6;
    const numW = 25;
    const descW = 255;
    const qtyW = 50;
    const amountW = width - 2 * pad - (numW + descW + qtyW);
    const colNum = left + pad;
    const colDesc = colNum + numW;
    const colQty = colDesc + descW;
    const colAmount = colQty + qtyW;

    doc.rect(left, tableTop, width, 22).fill(NAVY);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9);
    doc.text('#', colNum, tableTop + 6, { width: numW });
    doc.text('Description', colDesc, tableTop + 6, { width: descW });
    doc.text('Qty', colQty, tableTop + 6, { width: qtyW, align: 'right' });
    doc.text('Amount (INR)', colAmount, tableTop + 6, { width: amountW, align: 'right' });

    const rowTop = tableTop + 22 + 8;
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(9);
    doc.text('1', colNum, rowTop, { width: numW });
    doc.text('AI Vastra — Package Subscription', colDesc, rowTop, { width: descW });
    doc
      .fillColor(LIGHT_GRAY)
      .font('Helvetica')
      .fontSize(8)
      .text(
        `${data.planName} — ${data.credits.toLocaleString('en-IN')} Credits`,
        colDesc,
        doc.y + 1,
        { width: descW },
      );
    doc.fillColor('#000').font('Helvetica').fontSize(9);
    doc.text('1', colQty, rowTop, { width: qtyW, align: 'right' });
    doc.text(fmtRupees(data.basePaise), colAmount, rowTop, { width: amountW, align: 'right' });

    // ── Totals ───────────────────────────────────────────────
    const totalsLabelX = left + 260;
    const totalsValueX = left + 420;
    const totalsWidth = 65;
    let totalsY = Math.max(doc.y, rowTop + 20) + 25;

    const interState = isInterState(data.seller.gstin, data.customer.gstin);
    const totalsRows: [string, string][] = [['Taxable Value', fmtRupees(data.basePaise)]];
    if (interState) {
      totalsRows.push(['IGST @ 18%', fmtRupees(data.gstPaise)]);
    } else {
      const cgst = Math.round(data.gstPaise / 2);
      const sgst = data.gstPaise - cgst;
      totalsRows.push(['CGST @ 9%', fmtRupees(cgst)]);
      totalsRows.push(['SGST @ 9%', fmtRupees(sgst)]);
    }
    for (const [label, value] of totalsRows) {
      doc
        .fillColor(GRAY)
        .font('Helvetica')
        .fontSize(9)
        .text(label, totalsLabelX, totalsY, { width: 160, align: 'right' });
      doc
        .fillColor('#000')
        .text(value, totalsValueX, totalsY, { width: totalsWidth, align: 'right' });
      totalsY += 16;
    }

    if (!interState) {
      doc
        .fillColor(LIGHT_GRAY)
        .font('Helvetica-Oblique')
        .fontSize(7.5)
        .text(
          `(If inter-state supply: IGST @ 18% = ${fmtRupees(data.gstPaise)} instead of CGST+SGST)`,
          totalsLabelX,
          totalsY,
          { width: right - totalsLabelX, align: 'right' },
        );
      totalsY = doc.y + 4;
    }

    totalsY += 4;
    doc.rect(totalsLabelX, totalsY - 2, right - totalsLabelX, 20).fill('#EFEFEF');
    doc
      .fillColor('#000')
      .font('Helvetica-Bold')
      .fontSize(10)
      .text('TOTAL PAYABLE', totalsLabelX + 8, totalsY + 3, { width: 152, align: 'right' });
    doc.text(fmtRupees(data.totalPaise), totalsValueX, totalsY + 3, {
      width: totalsWidth,
      align: 'right',
    });
    totalsY += 26;

    doc
      .fillColor(GRAY)
      .font('Helvetica-Oblique')
      .fontSize(8)
      .text(`Amount in words: ${amountInWords(data.totalPaise)}`, left, totalsY, {
        width,
        align: 'right',
      });

    // ── Payment status ───────────────────────────────────────
    let y = totalsY + 30;
    doc.fillColor(NAVY).moveTo(left, y).lineTo(right, y).lineWidth(0.5).stroke();
    y += 12;

    const isPaid = data.paymentStatus === 'paid';
    doc
      .fillColor(isPaid ? GREEN : GRAY)
      .font('Helvetica-Bold')
      .fontSize(10)
      .text(`PAYMENT STATUS: ${isPaid ? 'PAID' : data.paymentStatus.toUpperCase()}`, left, y);
    y = doc.y + 6;

    doc.fillColor(GRAY).font('Helvetica').fontSize(9);
    doc.text('Payment Mode: Online (Website Checkout — tryme.com)', left, y);
    y = doc.y + 2;
    doc.text('Payment Gateway: Razorpay', left, y);
    y = doc.y + 2;
    doc.text(`Transaction / Reference ID: ${data.razorpayPaymentId || '—'}`, left, y);
    y = doc.y + 2;
    doc.text(`Payment Date: ${data.paidAt ? fmtDate(data.paidAt) : '—'}`, left, y);
    y = doc.y + 20;

    // ── Terms & Notes ────────────────────────────────────────
    doc.fillColor(AMBER).font('Helvetica-Bold').fontSize(10).text('TERMS & NOTES', left, y);
    y = doc.y + 6;
    doc.fillColor(GRAY).font('Helvetica').fontSize(8);
    const terms = [
      'This invoice confirms payment received via online checkout on tryme.com.',
      'This package covers AI Vastra catalogue creation / virtual try-on services as agreed with the customer.',
      'GST is applicable as per Government of India regulations.',
      'For refund or cancellation queries, contact support@tryme.com.',
      'This is a computer-generated invoice and does not require a physical signature.',
    ];
    terms.forEach((t, i) => {
      doc.text(`${i + 1}. ${t}`, left, y, { width });
      y = doc.y + 2;
    });

    // ── Footer ───────────────────────────────────────────────
    y += 20;
    if (data.seller.legalName) {
      doc
        .fillColor(NAVY)
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(`For ${data.seller.legalName}`, left, y, { width, align: 'right' });
      y = doc.y + 4;
    }
    doc
      .fillColor(LIGHT_GRAY)
      .font('Helvetica-Oblique')
      .fontSize(8)
      .text('(System-generated invoice)', left, y, { width, align: 'right' });

    doc.end();
  });
}
