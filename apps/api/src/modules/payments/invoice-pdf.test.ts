import { describe, expect, it } from 'vitest';
import { financialYearFor, renderInvoicePdf } from './invoice-pdf.js';

describe('financialYearFor', () => {
  it('returns the Apr-start year for a date in April or later', () => {
    expect(financialYearFor(new Date('2026-08-12T00:00:00Z'))).toBe('2026-27');
    expect(financialYearFor(new Date('2026-04-01T00:00:00Z'))).toBe('2026-27');
  });

  it('returns the previous Apr-start year for a date in Jan-Mar', () => {
    expect(financialYearFor(new Date('2026-03-31T23:59:59Z'))).toBe('2025-26');
    expect(financialYearFor(new Date('2026-01-01T00:00:00Z'))).toBe('2025-26');
  });
});

describe('renderInvoicePdf', () => {
  it('produces a non-empty PDF buffer starting with the %PDF magic bytes', async () => {
    const buf = await renderInvoicePdf({
      invoiceNumber: 'INV-2026-27-000001',
      issuedAt: new Date('2026-08-12T00:00:00Z'),
      seller: {
        gstin: '27AAPFU0939F1ZV',
        legalName: 'Tryme Technologies Pvt Ltd',
        address: '123 Example St',
        pan: 'AAPFU0939F',
        tan: 'MUMA12345B',
        udyamRegNo: 'UDYAM-MH-01-0000001',
      },
      customer: {
        email: 'buyer@example.com',
        gstin: '29AAAAA0000A1Z5',
        displayName: 'Jane Buyer',
        companyName: null,
        phone: null,
      },
      orderId: 'order_abc123',
      planName: 'Growth',
      credits: 5000,
      basePaise: 100000,
      gstPaise: 18000,
      totalPaise: 118000,
      paymentStatus: 'paid',
      razorpayPaymentId: 'pay_abc123',
      paidAt: new Date('2026-08-12T00:05:00Z'),
    });
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('produces a valid PDF when seller/customer GST fields are empty', async () => {
    const buf = await renderInvoicePdf({
      invoiceNumber: 'INV-2026-27-000002',
      issuedAt: new Date('2026-08-12T00:00:00Z'),
      seller: { gstin: '', legalName: '', address: '', pan: '', tan: '', udyamRegNo: '' },
      customer: {
        email: 'buyer2@example.com',
        gstin: null,
        displayName: null,
        companyName: null,
        phone: null,
      },
      orderId: 'order_def456',
      planName: 'Starter',
      credits: 1000,
      basePaise: 20000,
      gstPaise: 3600,
      totalPaise: 23600,
      paymentStatus: 'paid',
      razorpayPaymentId: null,
      paidAt: null,
    });
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
