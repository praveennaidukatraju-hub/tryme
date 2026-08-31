import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type DB = PostgresJsDatabase<typeof schema>;
export type DbTransaction = Parameters<Parameters<DB['transaction']>[0]>[0];

export function createDb(url: string): {
  db: DB;
  close: () => Promise<void>;
  withAdvisoryLock: <T>(lockKey: string, fn: (db: DB) => Promise<T>) => Promise<T | undefined>;
} {
  const client = postgres(url, { max: 10, prepare: false });
  const db = drizzle(client, { schema });

  /**
   * Holds a SESSION-scoped Postgres advisory lock (`pg_advisory_lock`, not the
   * transaction-scoped `pg_advisory_xact_lock` used elsewhere in this codebase)
   * across the whole callback, including any awaited external calls inside it.
   *
   * A transaction-scoped lock releases at its own transaction's COMMIT, which
   * cannot span an external network call (e.g. a Shopify charge) without
   * either (a) holding one giant transaction open across that call — which
   * would roll back an already-committed audit row on a mid-call crash, or
   * (b) releasing the lock before the external call even starts, reopening
   * the window for a second caller to slip in. This reserves a single
   * connection out of the pool for the duration, acquires the lock on it, and
   * releases both in a `finally` regardless of outcome — so the caller can
   * still commit intermediate transactions on `db` (the scoped client passed
   * to `fn`) as separate, durable steps while the lock keeps a second caller
   * out for the full operation.
   *
   * Acquisition is NON-BLOCKING (`pg_try_advisory_lock`, not `pg_advisory_lock`):
   * a caller that can't get the lock returns `undefined` immediately rather
   * than waiting. Blocking would mean waiting WHILE STILL HOLDING a reserved
   * connection — `client.reserve()` necessarily happens before the lock
   * attempt, so a blocked waiter would starve the shared pool (`max: 10`,
   * shared with every other request path) for as long as the lock holder
   * takes, which can include a slow external network call. A second caller
   * for the same key has nothing useful to do while blocked anyway, so
   * non-blocking + treating "did not acquire" as the caller's own "someone
   * else is already doing this" case is strictly safer than waiting.
   *
   * IMPORTANT: everything issued on the `db` passed into `fn` runs on this one
   * reserved connection, not a fresh one from the pool per query — unlike a
   * normal pooled `DB`, a query started here while another transaction on this
   * same `db` is still open does NOT get its own isolated connection; it lands
   * inside whatever transaction is currently open on this session. Callers
   * must keep their use of `db` strictly sequential (no `Promise.all` of two
   * queries against the same `db` instance) for this to behave as expected.
   */
  async function withAdvisoryLock<T>(
    lockKey: string,
    fn: (db: DB) => Promise<T>,
  ): Promise<T | undefined> {
    const reserved = await client.reserve();
    // Tracks whether THIS session actually holds the lock, so the `finally`
    // below only attempts an unlock when there's something to unlock — and so
    // `reserved.release()` still runs (returning the connection to the pool)
    // even if the `pg_try_advisory_lock` query itself throws (dead connection,
    // statement timeout, etc.) before we ever get a locked/not-locked answer.
    // Everything from here to the end of the function is inside one try/finally
    // specifically so no exit path — early return, lock query throwing, `fn`
    // throwing — can skip `reserved.release()` and leak the connection.
    let locked = false;
    try {
      const lockRows =
        await reserved`select pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) as locked`;
      locked = Boolean(lockRows[0]?.locked);
      if (!locked) {
        // Someone else already holds this key. Don't wait — see the
        // non-blocking rationale above. Connection releases in the outer
        // `finally`.
        return undefined;
      }

      // postgres.js's reserve() returns a bare Sql handle built from its inner
      // Sql(handler) factory. Two things the top-level pooled client gets via a
      // separate Object.assign in its own factory are missing from it, both
      // confirmed with isolated repro scripts (not a race — reproduces every
      // single time, on the very first call):
      //
      // 1. `.options` — drizzle-orm's postgres-js driver unconditionally reads
      //    client.options.parsers/serializers at construction time, so passing
      //    `reserved` straight to drizzle() throws "Cannot read properties of
      //    undefined (reading 'parsers')". `options` describes shared parsing/
      //    serialization config for the whole pool (every pooled connection is
      //    built from this same object internally, per postgres.js's own
      //    source), not per-connection state, so borrowing the reference from
      //    `client` is correct, not a workaround that changes behavior. This is
      //    load-bearing, not cosmetic: it's what makes timestamp/date columns
      //    (and every other typed column) parse and serialize the same way on
      //    this connection as on every other one in the pool — without it,
      //    drizzle wouldn't just fail to construct, a version that skipped this
      //    line would silently get wrong types back from queries that did run.
      // 2. `.begin` / `.savepoint` — drizzle's `db.transaction()` calls
      //    `client.begin(cb)`, and a transaction's own nested `tx.transaction()`
      //    (used by `grantStore` when composed inside a caller's transaction,
      //    e.g. `grantStore(tx as never, ...)`) calls `client.savepoint(cb)`.
      //    Neither exists on a reserved connection — postgres.js's own docs
      //    scope `reserve()` to raw tagged-template queries only ("This can be
      //    used for running queries on an isolated connection"); `.begin`'s
      //    real implementation lives in the pool factory and reserves its own
      //    connection internally, incompatible with reusing one we already
      //    reserved. Since `reserved` is already a single dedicated connection
      //    for the whole withAdvisoryLock call, everything issued through it is
      //    inherently serialized on one session — so BEGIN/COMMIT/ROLLBACK and
      //    SAVEPOINT/RELEASE/ROLLBACK TO are safe to issue by hand here and
      //    give drizzle exactly the interface it expects. Verified against
      //    nested transactions, sequential (non-nested) transactions, and
      //    rollback-on-throw, all on one reserved connection — covered by
      //    apps/api/test/integration/db-advisory-lock.test.ts.
      const txCapable = reserved as unknown as {
        options: typeof client.options;
        begin<R>(fn: (sql: typeof reserved) => R | Promise<R>): Promise<R>;
        savepoint<R>(fn: (sql: typeof reserved) => R | Promise<R>): Promise<R>;
      };
      // Load-bearing (see point 1 above), not just satisfying a type — every
      // pooled connection is built from this exact same shared config object.
      txCapable.options = client.options;
      txCapable.begin = async (fn2) => {
        await reserved`BEGIN`;
        try {
          const result = await fn2(reserved);
          await reserved`COMMIT`;
          return result;
        } catch (e) {
          await reserved`ROLLBACK`;
          throw e;
        }
      };
      let savepointCounter = 0;
      txCapable.savepoint = async (fn2) => {
        // Postgres savepoint names must be valid identifiers; a per-connection
        // counter is enough since only one call ever owns this reserved
        // connection at a time.
        const name = `sp_${savepointCounter++}`;
        await reserved.unsafe(`SAVEPOINT ${name}`);
        try {
          const result = await fn2(reserved);
          await reserved.unsafe(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (e) {
          await reserved.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
          throw e;
        }
      };

      const scopedDb = drizzle(reserved, { schema });
      return await fn(scopedDb);
    } finally {
      // Never return a connection to the pool while it might still hold the
      // session lock: if the unlock query itself throws (dead-but-still-open
      // connection, statement timeout, etc.), a plain `reserved.release()`
      // here would leak the connection back into the pool AND leave the lock
      // held forever on a session nobody can reach — the next caller for this
      // key would then never see pg_try_advisory_lock succeed, while a NEW
      // caller for a DIFFERENT key keeps eating into the same finite pool,
      // eventually starving every other query in the process. Falling back to
      // pg_advisory_unlock_all() is safe because this connection only ever
      // acquires the one lock this function took above.
      if (locked) {
        try {
          await reserved`select pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
        } catch {
          try {
            await reserved`select pg_advisory_unlock_all()`;
          } catch {
            // Connection is genuinely gone; Postgres frees a session's advisory
            // locks on disconnect, so there's nothing further to do here.
          }
        }
      }
      reserved.release();
    }
  }

  return { db, close: () => client.end({ timeout: 5 }), withAdvisoryLock };
}

export { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
export * as schema from './schema/index.js';
export type {
  ShopifyWidgetBehavior,
  ShopifyWidgetConfig,
  ShopifyWidgetCopy,
  ShopifyWidgetTheme,
} from './schema/shopify.js';
