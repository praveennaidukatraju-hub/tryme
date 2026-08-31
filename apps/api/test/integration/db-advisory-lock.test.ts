import { createDb, schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantStore } from '../../src/modules/credits/shopify-ledger.js';
import { startContainers } from '../helpers/containers.js';

/**
 * Direct coverage for `withAdvisoryLock` (packages/db/src/index.ts) — the
 * hand-rolled `.begin`/`.savepoint` polyfill it wires onto a reserved
 * connection is the riskiest new primitive `runRefill` depends on (see
 * autorefill.ts's Guard 1 docstring), and until now it had only been verified
 * with scratch scripts that were deleted after use. This talks to `createDb`
 * directly rather than through the full Fastify app, since what's under test
 * is the primitive itself, not any route built on top of it.
 */

let ctx: Awaited<ReturnType<typeof startContainers>>;
let dbHandle: ReturnType<typeof createDb>;
let store: typeof schema.shopifyStores.$inferSelect;

beforeAll(async () => {
  ctx = await startContainers();
  dbHandle = createDb(ctx.pgUrl);
  [store] = await dbHandle.db
    .insert(schema.shopifyStores)
    .values({
      shopDomain: 'advisory-lock-test.myshopify.com',
      shopifyShopId: 77701,
      accessToken: 'enc:token',
      scope: 'read_products',
    })
    .returning();
});

afterAll(async () => {
  await dbHandle.close();
  await ctx.stop();
});

describe('withAdvisoryLock', () => {
  it('commit-on-resolve: a transaction that completes successfully persists its row', async () => {
    const result = await dbHandle.withAdvisoryLock('lock-test:commit', async (lockedDb) => {
      return lockedDb.transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.shopifyCreditLedger)
          .values({
            storeId: store.id,
            delta: 5,
            reason: 'TEST_COMMIT',
            externalRef: 'lock-test-commit-1',
          })
          .returning({ id: schema.shopifyCreditLedger.id });
        return row?.id;
      });
    });
    expect(result).toBeTruthy();

    const rows = await dbHandle.db
      .select()
      .from(schema.shopifyCreditLedger)
      .where(eq(schema.shopifyCreditLedger.externalRef, 'lock-test-commit-1'));
    expect(rows).toHaveLength(1);
  });

  it('rollback-on-throw: a transaction whose callback throws leaves no row behind', async () => {
    await expect(
      dbHandle.withAdvisoryLock('lock-test:rollback', async (lockedDb) => {
        return lockedDb.transaction(async (tx) => {
          await tx.insert(schema.shopifyCreditLedger).values({
            storeId: store.id,
            delta: 5,
            reason: 'TEST_ROLLBACK',
            externalRef: 'lock-test-rollback-1',
          });
          throw new Error('boom');
        });
      }),
    ).rejects.toThrow('boom');

    const rows = await dbHandle.db
      .select()
      .from(schema.shopifyCreditLedger)
      .where(eq(schema.shopifyCreditLedger.externalRef, 'lock-test-rollback-1'));
    expect(rows).toHaveLength(0);
  });

  it('nested savepoint release: tx.transaction() nested in an outer transaction — the grantStore(tx as never, ...) shape — both commit', async () => {
    // Mirrors runRefill's real usage exactly: an outer statement, then
    // grantStore(tx as never, ...) called with the already-open transaction,
    // which internally does its own tx.transaction(...) — a nested savepoint.
    const { granted } = await dbHandle.withAdvisoryLock(
      'lock-test:nested-commit',
      async (lockedDb) => {
        return lockedDb.transaction(async (tx) => {
          await tx
            .update(schema.shopifyStores)
            .set({ updatedAt: new Date() })
            .where(eq(schema.shopifyStores.id, store.id));
          return grantStore(
            tx as never,
            store.id,
            111,
            'TEST_NESTED_COMMIT',
            'lock-test-nested-commit-1',
          );
        });
      },
    );
    expect(granted).toBe(true);

    const [credits] = await dbHandle.db
      .select()
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));
    expect(credits?.balance).toBeGreaterThanOrEqual(111);

    const ledgerRows = await dbHandle.db
      .select()
      .from(schema.shopifyCreditLedger)
      .where(eq(schema.shopifyCreditLedger.externalRef, 'lock-test-nested-commit-1'));
    expect(ledgerRows).toHaveLength(1);
  });

  it('nested savepoint rollback: an inner tx.transaction() that throws rolls back only itself, and the outer transaction still commits', async () => {
    const outerRef = 'lock-test-nested-rollback-outer';
    const innerRef = 'lock-test-nested-rollback-inner';

    await dbHandle.withAdvisoryLock('lock-test:nested-rollback', async (lockedDb) => {
      await lockedDb.transaction(async (tx) => {
        // Explicit throw inside a nested savepoint, caught and handled right
        // here — the same shape as an onConflictDoNothing no-op path inside a
        // nested call: the savepoint rolls back, but the outer transaction
        // must not be aborted by it.
        await tx
          .transaction(async (tx2) => {
            await tx2.insert(schema.shopifyCreditLedger).values({
              storeId: store.id,
              delta: 1,
              reason: 'TEST_NESTED_ROLLBACK_INNER',
              externalRef: innerRef,
            });
            throw new Error('nested rollback');
          })
          .catch(() => {
            /* expected — the nested savepoint rolled back; outer transaction continues */
          });

        await tx.insert(schema.shopifyCreditLedger).values({
          storeId: store.id,
          delta: 1,
          reason: 'TEST_NESTED_ROLLBACK_OUTER',
          externalRef: outerRef,
        });
      });
    });

    const innerRows = await dbHandle.db
      .select()
      .from(schema.shopifyCreditLedger)
      .where(eq(schema.shopifyCreditLedger.externalRef, innerRef));
    expect(innerRows).toHaveLength(0);

    const outerRows = await dbHandle.db
      .select()
      .from(schema.shopifyCreditLedger)
      .where(eq(schema.shopifyCreditLedger.externalRef, outerRef));
    expect(outerRows).toHaveLength(1);
  });

  it('lock exclusion: a second concurrent call for the same key does not block and returns undefined immediately', async () => {
    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = dbHandle.withAdvisoryLock('lock-test:exclusion', async () => {
      resolveFirstStarted();
      await holdFirst;
      return 'first';
    });

    // Don't race the assertion below against lock acquisition — wait until
    // the first call has definitely entered its callback (and thus definitely
    // holds the lock) before attempting the second.
    await firstStarted;

    const second = await dbHandle.withAdvisoryLock('lock-test:exclusion', async () => 'second');
    expect(second).toBeUndefined();

    releaseFirst();
    expect(await first).toBe('first');

    // Lock is free again once the first call's `finally` has run.
    const third = await dbHandle.withAdvisoryLock('lock-test:exclusion', async () => 'third');
    expect(third).toBe('third');
  });
});
