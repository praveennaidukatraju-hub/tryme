/**
 * Seed a handful of paid payments + real GST invoice PDFs (rendered with
 * renderInvoicePdf and uploaded to R2/MinIO, same as the live
 * issueInvoiceIfNeeded path) so the Invoices tab in catalogues-web (3000)
 * and the Payments page in admin-web (5173) both have something to show.
 *
 * Targets the first login-capable user found among: chand@gmail.com (the
 * scripts/seed-user.mts dev user), admin@tryme.dev (the db:seed dev
 * admin), or any existing user row — in that order.
 *
 * Usage:  tsx --env-file=.env scripts/seed-invoices.mts
 */
import { randomUUID } from 'node:crypto';
import { createDb, eq, schema, sql } from '@tryme/db';
import { createR2Provider, keys } from '@tryme/storage';
import { DEFAULT_SELLER_CONFIG } from '../apps/api/src/lib/resolution-config.js';
import {
  financialYearFor,
  renderInvoicePdf,
} from '../apps/api/src/modules/payments/invoice-pdf.js';

const GST_RATE = 0.18;
const CANDIDATE_EMAILS = ['chand@gmail.com', 'admin@tryme.dev'];
const dayMs = 24 * 60 * 60 * 1000;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`${key} not set`);
    process.exit(1);
  }
  return value;
}

const storage = createR2Provider({
  endpoint: requireEnv('R2_ENDPOINT'),
  accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  bucket: requireEnv('R2_BUCKET'),
  publicUrl: requireEnv('R2_PUBLIC_URL'),
  forcePathStyle: process.env.R2_FORCE_PATH_STYLE === 'true',
  presignBaseUrl: process.env.R2_PUBLIC_PRESIGN_BASE,
  signEndpoint: process.env.R2_SIGN_ENDPOINT,
});

const { db, close } = createDb(databaseUrl);

async function allocateInvoiceNumber(financialYear: string): Promise<string> {
  const [row] = await db
    .insert(schema.invoiceSequences)
    .values({ financialYear, nextNumber: 2 })
    .onConflictDoUpdate({
      target: schema.invoiceSequences.financialYear,
      set: { nextNumber: sql`${schema.invoiceSequences.nextNumber} + 1` },
    })
    .returning({ nextNumber: schema.invoiceSequences.nextNumber });
  const issuedNumber = (row?.nextNumber ?? 2) - 1;
  return `INV-${financialYear}-${String(issuedNumber).padStart(6, '0')}`;
}

async function main() {
  let user:
    | {
        id: string;
        email: string;
        displayName: string | null;
        companyName: string | null;
        phone: string | null;
      }
    | undefined;
  for (const email of CANDIDATE_EMAILS) {
    [user] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        companyName: schema.users.companyName,
        phone: schema.users.phone,
      })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    if (user) break;
  }
  if (!user) {
    [user] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        companyName: schema.users.companyName,
        phone: schema.users.phone,
      })
      .from(schema.users)
      .limit(1);
  }
  if (!user) {
    console.error('No users found — run `pnpm db:seed` or `tsx scripts/seed-user.mts` first.');
    process.exit(1);
  }
  console.log(`Seeding invoices for ${user.email} (${user.id})`);

  const plans = await db
    .select({
      slug: schema.creditPlans.slug,
      name: schema.creditPlans.name,
      credits: schema.creditPlans.credits,
      basePaise: schema.creditPlans.basePaise,
    })
    .from(schema.creditPlans)
    .where(eq(schema.creditPlans.isActive, true))
    .orderBy(schema.creditPlans.sortOrder);
  const paidPlans = plans.filter((p) => p.slug !== 'free');
  if (paidPlans.length === 0) {
    console.error('No paid credit plans found — run `pnpm db:seed` or apply migrations first.');
    process.exit(1);
  }

  const daysAgoByIndex = [2, 15, 40];
  const now = Date.now();

  for (let i = 0; i < Math.min(paidPlans.length, daysAgoByIndex.length); i++) {
    const plan = paidPlans[i];
    const daysAgo = daysAgoByIndex[i];
    const paidAt = new Date(now - daysAgo * dayMs);
    const gstPaise = Math.round(plan.basePaise * GST_RATE);
    const totalPaise = plan.basePaise + gstPaise;
    const razorpayOrderId = `order_seed_${randomUUID().slice(0, 18)}`;
    const razorpayPaymentId = `pay_seed_${randomUUID().slice(0, 18)}`;

    const [payment] = await db
      .insert(schema.payments)
      .values({
        userId: user.id,
        planId: plan.slug,
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature: 'seeded',
        basePaise: plan.basePaise,
        gstPaise,
        totalPaise,
        credits: plan.credits,
        gstin: null,
        status: 'paid',
        createdAt: paidAt,
        paidAt,
      })
      .returning({ id: schema.payments.id });
    if (!payment) continue;

    const financialYear = financialYearFor(paidAt);
    const invoiceNumber = await allocateInvoiceNumber(financialYear);
    const pdfBuffer = await renderInvoicePdf({
      invoiceNumber,
      issuedAt: paidAt,
      seller: DEFAULT_SELLER_CONFIG,
      customer: {
        email: user.email,
        gstin: null,
        displayName: user.displayName,
        companyName: user.companyName,
        phone: user.phone,
      },
      orderId: razorpayOrderId,
      planName: plan.name,
      credits: plan.credits,
      basePaise: plan.basePaise,
      gstPaise,
      totalPaise,
      paymentStatus: 'paid',
      razorpayPaymentId,
      paidAt,
    });

    const r2Key = keys.invoice(payment.id);
    await storage.putObject(r2Key, pdfBuffer, 'application/pdf');
    await db
      .insert(schema.invoices)
      .values({ paymentId: payment.id, invoiceNumber, r2Key, issuedAt: paidAt })
      .onConflictDoNothing({ target: schema.invoices.paymentId });

    console.log(`  ✅ ${invoiceNumber} — ${plan.name} — ₹${(totalPaise / 100).toFixed(2)}`);
  }

  console.log(
    'Done. View at http://localhost:5173 (Payments) and http://localhost:3000/settings (Invoices tab, after logging in as this user).',
  );
  await close();
}

main().catch((err) => {
  console.error('❌ Seeding invoices failed:', err);
  process.exit(1);
});
