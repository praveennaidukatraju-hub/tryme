import { faker } from '@faker-js/faker';
import { Algorithm, hash } from '@node-rs/argon2';
import { createDb } from './index.js';
import * as schema from './schema/index.js';

// Deterministic seed for reproducible data
faker.seed(12345);

// Matches apps/api/src/modules/auth/service.ts's ARGON so the seeded admin
// can actually log in through the normal auth flow.
const ARGON: Parameters<typeof hash>[1] = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

const DEV_ADMIN_EMAIL = 'admin@tryme.dev';
const DEV_ADMIN_PASSWORD = 'dev-admin-password';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required to seed the database');
    process.exit(1);
  }

  const { db, close } = createDb(url);
  console.log('🌱 Seeding database with dummy data...');

  try {
    // 1. Users & Merchants & Credits
    console.log('Seeding users (100) with diverse statuses and join dates...');
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    const userRecords = Array.from({ length: 80 }).map((_, idx) => {
      const daysAgo = (idx % 28) + (idx % 3) * 0.2;
      const createdAt = new Date(now - daysAgo * dayMs);
      const isSuspended = idx % 5 === 0;
      const isDeleted = idx % 15 === 0;
      return {
        email: isDeleted
          ? `deleted+${faker.string.uuid()}@example.invalid`
          : `${faker.internet.email().toLowerCase()}_${idx}`,
        displayName: isDeleted ? 'Deleted User' : faker.person.fullName(),
        tier: faker.helpers.arrayElement(['free', 'starter', 'growth', 'pro']),
        emailVerified: true,
        isBanned: isSuspended || isDeleted,
        banReason: isDeleted
          ? 'admin erasure (GDPR)'
          : isSuspended
            ? 'Account suspended due to policy violation'
            : null,
        createdAt,
        updatedAt: createdAt,
      };
    });

    await db.insert(schema.users).values(userRecords).onConflictDoNothing();

    // Seed credit balances and merchants
    console.log('Seeding credits and merchant profiles...');
    const allUsers = await db.select({ id: schema.users.id }).from(schema.users);
    for (const u of allUsers) {
      await db
        .insert(schema.userCredits)
        .values({
          userId: u.id,
          balance: faker.helpers.arrayElement([0, 15, 50, 120, 450, 1000]),
        })
        .onConflictDoNothing();
    }

    // Seed ~20 merchants among users
    const merchantUsers = allUsers.slice(0, 20);
    for (const [mIdx, mu] of merchantUsers.entries()) {
      await db
        .insert(schema.merchants)
        .values({
          userId: mu.id,
          companyName: `${faker.company.name()} Apparel`,
          contactName: faker.person.fullName(),
          phone: `+9198${faker.string.numeric(8)}`,
          businessAddress: `${faker.location.streetAddress()}, ${faker.location.city()}`,
          signupSource: mIdx % 2 === 0 ? 'android_google' : 'admin',
          isActive: true,
          demoData: false,
        })
        .onConflictDoNothing();
    }

    // 2. Catalog Types
    console.log('Ensuring catalog types...');
    const typesToInsert = [
      { slug: 'models', label: 'Models' },
      { slug: 'garments', label: 'Garments' },
      { slug: 'backgrounds', label: 'Backgrounds' },
    ];
    await db.insert(schema.catalogTypes).values(typesToInsert).onConflictDoNothing();
    const dbTypes = await db.select().from(schema.catalogTypes);

    // 3. Categories and Items
    if (dbTypes.length > 0) {
      const modelsType = dbTypes.find((t) => t.slug === 'models') ?? dbTypes[0];

      console.log('Seeding catalog categories (20)...');
      const categories = Array.from({ length: 20 }).map(() => ({
        typeId: modelsType.id,
        slug: `${faker.lorem.slug()}-${faker.string.uuid().slice(0, 8)}`,
        label: faker.commerce.department(),
      }));
      const insertedCategories = await db
        .insert(schema.catalogCategories)
        .values(categories)
        .returning({ id: schema.catalogCategories.id });

      if (insertedCategories.length > 0) {
        console.log('Seeding catalog items (2000)...');
        const items = Array.from({ length: 2000 }).map(() => ({
          categoryId: faker.helpers.arrayElement(insertedCategories).id,
          type: faker.helpers.arrayElement(['lower', 'shoe']),
          label: faker.commerce.productName(),
          r2Key: `catalog/${faker.string.uuid()}.png`,
          thumbnailKey: `catalog/thumbs/${faker.string.uuid()}.png`,
        }));

        // Insert in chunks to avoid parameter limits (Postgres max 65535 parameters)
        for (let i = 0; i < items.length; i += 500) {
          await db.insert(schema.catalogItems).values(items.slice(i, i + 500));
        }
      }
    }

    // 4. Dev admin user
    console.log('Seeding dev admin user...');
    const passwordHash = await hash(DEV_ADMIN_PASSWORD, ARGON);
    const [adminUser] = await db
      .insert(schema.users)
      .values({
        email: DEV_ADMIN_EMAIL,
        displayName: 'Dev Admin',
        tier: 'pro',
        emailVerified: true,
        passwordHash,
      })
      .onConflictDoUpdate({
        target: schema.users.email,
        set: { passwordHash },
      })
      .returning({ id: schema.users.id });
    await db
      .insert(schema.adminUsers)
      .values({ userId: adminUser.id, role: 'SUPER_ADMIN', status: 'active', passwordHash })
      .onConflictDoUpdate({
        target: schema.adminUsers.userId,
        set: { status: 'active', passwordHash },
      });
    console.log(`   → login with ${DEV_ADMIN_EMAIL} / ${DEV_ADMIN_PASSWORD}`);

    // 5. Jobs across different dates, statuses, and workers
    console.log('Seeding jobs (60) with diverse statuses and timestamps...');
    const statuses = ['COMPLETED', 'GENERATING', 'QUEUED', 'FAILED', 'CANCELLED'];
    const workers = ['gpu-worker-1', 'gpu-worker-2', 'worker-lambda-3', 'worker-backup-4'];
    const sources = ['tryon', 'studio', 'pose'];

    const jobRows = Array.from({ length: 60 }).map((_, idx) => {
      const targetUser = faker.helpers.arrayElement(allUsers);
      const daysAgo = (idx % 20) + (idx % 4) * 0.25;
      const createdAt = new Date(now - daysAgo * dayMs);
      const status = statuses[idx % statuses.length];
      const startedAt = status !== 'QUEUED' ? new Date(createdAt.getTime() + 15000) : null;
      const completedAt =
        status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED'
          ? new Date(createdAt.getTime() + 45000)
          : null;
      return {
        userId: targetUser.id,
        status,
        workerId: status !== 'QUEUED' ? workers[idx % workers.length] : null,
        source: sources[idx % sources.length],
        creditsCharged: 1,
        attempts: status === 'FAILED' ? 3 : 1,
        errorCode: status === 'FAILED' ? 'ERR_WORKER_TIMEOUT' : null,
        createdAt,
        startedAt,
        completedAt,
      };
    });

    await db.insert(schema.jobs).values(jobRows);

    // 6. Audit Logs across different dates and actions
    console.log('Seeding audit logs (40) for Team Activity...');
    const auditActions = [
      {
        action: 'users.credits.grant',
        resourceType: 'user',
        before: { balance: 50 },
        after: { balance: 150, note: 'Loyalty compensation' },
      },
      {
        action: 'users.ban',
        resourceType: 'user',
        before: { isBanned: false },
        after: { isBanned: true, banReason: 'Violation of acceptable use terms' },
      },
      {
        action: 'users.unban',
        resourceType: 'user',
        before: { isBanned: true },
        after: { isBanned: false, reviewPassed: true },
      },
      {
        action: 'credit_plans.update',
        resourceType: 'credit_plan',
        before: { price: 2900, creditsPerMonth: 300 },
        after: { price: 2900, creditsPerMonth: 350 },
      },
      {
        action: 'workflow.update',
        resourceType: 'workflow',
        before: { isActive: false, version: '1.2.0' },
        after: { isActive: true, version: '1.3.0' },
      },
      {
        action: 'merchants.create',
        resourceType: 'merchant',
        before: null,
        after: { companyName: 'Silk & Saree Boutique', status: 'approved' },
      },
    ];

    const auditRows = Array.from({ length: 40 }).map((_, idx) => {
      const template = auditActions[idx % auditActions.length];
      const targetUser = allUsers[idx % allUsers.length];
      const daysAgo = (idx % 25) + (idx % 5) * 0.15;
      const createdAt = new Date(now - daysAgo * dayMs);
      return {
        actorUserId: adminUser.id,
        actorRole: 'SUPER_ADMIN',
        action: template.action,
        resourceType: template.resourceType,
        resourceId: targetUser ? targetUser.id : faker.string.uuid(),
        before: template.before,
        after: template.after,
        ipAddress: '127.0.0.1',
        userAgent: 'Mozilla/5.0 Admin Console',
        createdAt,
      };
    });

    await db.insert(schema.auditLogs).values(auditRows);

    // 7. Minimal workflow template
    console.log('Seeding minimal workflow template...');
    await db
      .insert(schema.workflowTemplates)
      .values({
        slug: 'dev-seed-template',
        label: 'Dev Seed Template',
        jsonContent: {},
        poseNodeId: 'pose',
        upperNodeIds: [],
        garmentPhasePromptNode: 'garment',
        workflowType: 'tryon',
        isActive: true,
      })
      .onConflictDoNothing({ target: schema.workflowTemplates.slug });

    // 8. Shopify Stores & Credit Ledgers
    console.log('Seeding Shopify stores and credit ledgers...');
    const storeDomains = [
      { domain: 'manyavar-ethnic.myshopify.com', balance: 1250, daysAgo: 30, uninstalled: false },
      { domain: 'fabindia-crafts.myshopify.com', balance: 850, daysAgo: 24, uninstalled: false },
      { domain: 'biba-apparel.myshopify.com', balance: 420, daysAgo: 18, uninstalled: false },
      { domain: 'raymond-custom.myshopify.com', balance: 2100, daysAgo: 14, uninstalled: false },
      { domain: 'w-for-woman.myshopify.com', balance: 95, daysAgo: 8, uninstalled: false },
      { domain: 'lifestyle-stores.myshopify.com', balance: 340, daysAgo: 5, uninstalled: false },
      { domain: 'global-desi-fashion.myshopify.com', balance: 50, daysAgo: 2, uninstalled: false },
      { domain: 'legacy-apparel-demo.myshopify.com', balance: 0, daysAgo: 45, uninstalled: true },
    ];

    for (const [sIdx, s] of storeDomains.entries()) {
      const installedAt = new Date(now - s.daysAgo * dayMs);
      const uninstalledAt = s.uninstalled ? new Date(now - 3 * dayMs) : null;
      const ownerUser = merchantUsers[sIdx % merchantUsers.length] || adminUser;

      const [store] = await db
        .insert(schema.shopifyStores)
        .values({
          shopDomain: s.domain,
          shopifyShopId: 8800000000 + sIdx,
          accessToken: '0000000000000000:0000000000000000:dummy_seeded_access_token',
          scope: 'read_products,write_products,read_themes',
          ianaTimezone: 'Asia/Kolkata',
          ownerUserId: ownerUser.id,
          installedAt,
          uninstalledAt,
          shopEmail: `support@${s.domain.replace('.myshopify.com', '')}.com`,
        })
        .onConflictDoUpdate({
          target: schema.shopifyStores.shopDomain,
          set: { uninstalledAt, ownerUserId: ownerUser.id },
        })
        .returning({ id: schema.shopifyStores.id });

      if (store) {
        // Store credit balance
        await db
          .insert(schema.shopifyStoreCredits)
          .values({
            storeId: store.id,
            balance: s.balance,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: schema.shopifyStoreCredits.storeId,
            set: { balance: s.balance, updatedAt: new Date() },
          });

        // Store credit ledger entries
        const ledgerEntries = [
          { delta: 50, reason: 'TRIAL_GRANT', daysAgo: s.daysAgo },
          { delta: 500, reason: 'PURCHASE_GROWTH_PACK', daysAgo: Math.max(1, s.daysAgo - 2) },
          { delta: -1, reason: 'JOB_DISPATCH', daysAgo: Math.max(1, s.daysAgo - 4) },
          { delta: -1, reason: 'JOB_DISPATCH', daysAgo: Math.max(1, s.daysAgo - 5) },
          { delta: 1, reason: 'JOB_FAILED_REFUND', daysAgo: Math.max(1, s.daysAgo - 5) },
          { delta: -2, reason: 'JOB_DISPATCH_BATCH', daysAgo: Math.max(1, s.daysAgo - 7) },
          { delta: 250, reason: 'AUTOREFILL_TRIGGERED', daysAgo: Math.max(1, s.daysAgo - 10) },
        ];

        for (const entry of ledgerEntries) {
          await db.insert(schema.shopifyCreditLedger).values({
            storeId: store.id,
            delta: entry.delta,
            reason: entry.reason,
            createdAt: new Date(now - entry.daysAgo * dayMs),
          });
        }
      }
    }

    console.log('✅ Seeding complete!');
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  } finally {
    await close();
  }
}

main();
