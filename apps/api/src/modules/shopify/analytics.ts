import type { DB } from '@tryme/db';
import { schema } from '@tryme/db';
import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';

export interface AnalyticsRange {
  /** Inclusive UTC instant of the first store-local day. */
  from: Date;
  /** Exclusive UTC instant — the start of the day AFTER the last one shown. */
  to: Date;
  timezone: string;
}

export interface AnalyticsCards {
  tryOns: number;
  uniqueShoppers: number;
  addedToCart: number;
  /** 0..1. Named add-to-cart, never "conversion" — it is not a sale. */
  addToCartRate: number;
  emailsCaptured: number;
  turnedAway: { total: number; storeCap: number; shopperCap: number; emailGate: number };
}

const int = (expr: ReturnType<typeof sql>) => sql<number>`${expr}::int`;

export async function analyticsCards(
  db: DB,
  storeId: string,
  range: AnalyticsRange,
): Promise<AnalyticsCards> {
  const inJobRange = and(
    eq(schema.jobs.shopifyStoreId, storeId),
    gte(schema.jobs.createdAt, range.from),
    lt(schema.jobs.createdAt, range.to),
  );

  const [jobRow] = await db
    .select({
      tryOns: int(sql`count(*)`),
      uniqueShoppers: int(sql`count(distinct ${schema.jobs.shopifyShopperId})`),
    })
    .from(schema.jobs)
    .where(inJobRange);

  // The add-to-cart denominator. NOT `tryOns`: that counts jobs and includes
  // shoppers with no client_id, so dividing a client-id-keyed numerator by it
  // would understate the rate for every store still serving old widget builds.
  const [identifiedRow] = await db
    .select({
      n: int(sql`count(distinct ${schema.shopifyShoppers.clientId})`),
    })
    .from(schema.jobs)
    .innerJoin(schema.shopifyShoppers, eq(schema.jobs.shopifyShopperId, schema.shopifyShoppers.id))
    .where(inJobRange);

  const ev = schema.shopifyWidgetEvents;
  const inEventRange = and(
    eq(ev.storeId, storeId),
    gte(ev.createdAt, range.from),
    lt(ev.createdAt, range.to),
  );

  const [eventRow] = await db
    .select({
      addedToCart: int(
        sql`count(distinct ${ev.clientId}) filter (where ${ev.type} = 'add_to_cart')`,
      ),
      storeCap: int(sql`count(*) filter (where ${ev.type} = 'refused_store_cap')`),
      shopperCap: int(sql`count(*) filter (where ${ev.type} = 'refused_shopper_cap')`),
      emailGate: int(sql`count(*) filter (where ${ev.type} = 'refused_email_gate')`),
    })
    .from(ev)
    .where(inEventRange);

  const [emailRow] = await db
    .select({ n: int(sql`count(*)`) })
    .from(schema.shopifyShoppers)
    .where(
      and(
        eq(schema.shopifyShoppers.storeId, storeId),
        isNotNull(schema.shopifyShoppers.email),
        gte(schema.shopifyShoppers.emailCapturedAt, range.from),
        lt(schema.shopifyShoppers.emailCapturedAt, range.to),
      ),
    );

  const identified = identifiedRow.n;
  return {
    tryOns: jobRow.tryOns,
    uniqueShoppers: jobRow.uniqueShoppers,
    addedToCart: eventRow.addedToCart,
    addToCartRate: identified === 0 ? 0 : eventRow.addedToCart / identified,
    emailsCaptured: emailRow.n,
    turnedAway: {
      // Deliberately excludes emailGate: a shopper who hits the email gate
      // typically submits their email and gets their try-on anyway (a soft
      // gate), unlike a store-cap or shopper-cap refusal, which is a genuine
      // lost try-on. emailGate is still reported as its own field below.
      total: eventRow.storeCap + eventRow.shopperCap,
      storeCap: eventRow.storeCap,
      shopperCap: eventRow.shopperCap,
      emailGate: eventRow.emailGate,
    },
  };
}

/** YYYY-MM-DD strings between two instants, in the store's own calendar. */
function localDaySpan(range: AnalyticsRange): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: range.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const days: string[] = [];
  // Step in whole days from `from`; en-CA formats as YYYY-MM-DD natively.
  for (let t = range.from.getTime(); t < range.to.getTime(); t += 86_400_000) {
    const day = fmt.format(new Date(t));
    if (days[days.length - 1] !== day) days.push(day);
  }
  return days;
}

export async function analyticsDaily(
  db: DB,
  storeId: string,
  range: AnalyticsRange,
): Promise<{ day: string; tryOns: number }[]> {
  const rows = await db
    .select({
      day: sql<string>`to_char((${schema.jobs.createdAt} AT TIME ZONE ${range.timezone})::date, 'YYYY-MM-DD')`,
      tryOns: int(sql`count(*)`),
    })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.shopifyStoreId, storeId),
        gte(schema.jobs.createdAt, range.from),
        lt(schema.jobs.createdAt, range.to),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  // Zero-fill: a quiet day must render as an empty slot, not be skipped. A
  // skipped day compresses the x-axis and makes a gap look like a busy stretch.
  const counts = new Map(rows.map((r) => [r.day, r.tryOns]));
  return localDaySpan(range).map((day) => ({ day, tryOns: counts.get(day) ?? 0 }));
}

export interface AnalyticsFunnel {
  buttonClick: number;
  upload: number;
  tryOn: number;
  resultView: number;
  addToCart: number;
  /** Try-ons from widget builds that send no client_id — countable, not joinable. */
  unattributed: number;
}

export async function analyticsFunnel(
  db: DB,
  storeId: string,
  range: AnalyticsRange,
): Promise<AnalyticsFunnel> {
  const ev = schema.shopifyWidgetEvents;

  // Distinct shoppers per step, never raw event counts — one shopper clicking
  // five times is one shopper, and counting events would put later steps above
  // earlier ones for reasons that have nothing to do with drop-off.
  const [steps] = await db
    .select({
      buttonClick: int(
        sql`count(distinct ${ev.clientId}) filter (where ${ev.type} = 'button_click')`,
      ),
      upload: int(sql`count(distinct ${ev.clientId}) filter (where ${ev.type} = 'upload')`),
      resultView: int(
        sql`count(distinct ${ev.clientId}) filter (where ${ev.type} = 'result_view')`,
      ),
      addToCart: int(sql`count(distinct ${ev.clientId}) filter (where ${ev.type} = 'add_to_cart')`),
    })
    .from(ev)
    .where(and(eq(ev.storeId, storeId), gte(ev.createdAt, range.from), lt(ev.createdAt, range.to)));

  const inJobRange = and(
    eq(schema.jobs.shopifyStoreId, storeId),
    gte(schema.jobs.createdAt, range.from),
    lt(schema.jobs.createdAt, range.to),
  );

  const [tryOnRow] = await db
    .select({ n: int(sql`count(distinct ${schema.shopifyShoppers.clientId})`) })
    .from(schema.jobs)
    .innerJoin(schema.shopifyShoppers, eq(schema.jobs.shopifyShopperId, schema.shopifyShoppers.id))
    .where(inJobRange);

  const [unattributedRow] = await db
    .select({ n: int(sql`count(*)`) })
    .from(schema.jobs)
    .where(and(inJobRange, sql`${schema.jobs.shopifyShopperId} is null`));

  // Returned exactly as measured. The caller must NOT clamp these to be
  // monotonic: a shopper running an ad blocker that eats the event endpoint
  // still generates a real try-on, and hiding that would hide that the
  // client-side steps under-report.
  return {
    buttonClick: steps.buttonClick,
    upload: steps.upload,
    tryOn: tryOnRow.n,
    resultView: steps.resultView,
    addToCart: steps.addToCart,
    unattributed: unattributedRow.n,
  };
}

export interface AnalyticsProduct {
  shopifyProductId: number;
  title: string | null;
  tryOns: number;
  uniqueShoppers: number;
  addedToCart: number;
  addToCartRate: number;
}

export async function analyticsProducts(
  db: DB,
  storeId: string,
  range: AnalyticsRange,
): Promise<AnalyticsProduct[]> {
  // No expression index on the JSONB is needed: `jobs` is filtered first by
  // (shopify_store_id, created_at), then job_inputs is reached by its own
  // primary key, so the params extraction only ever runs on the narrowed set.
  const productId = sql<number>`(${schema.jobInputs.params}->>'shopifyProductId')::bigint`;

  const jobRows = await db
    .select({
      productId,
      tryOns: int(sql`count(*)`),
      uniqueShoppers: int(sql`count(distinct ${schema.jobs.shopifyShopperId})`),
    })
    .from(schema.jobs)
    .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
    .where(
      and(
        eq(schema.jobs.shopifyStoreId, storeId),
        gte(schema.jobs.createdAt, range.from),
        lt(schema.jobs.createdAt, range.to),
        sql`${schema.jobInputs.params}->>'shopifyProductId' is not null`,
      ),
    )
    .groupBy(sql`1`);

  const ev = schema.shopifyWidgetEvents;
  const cartRows = await db
    .select({
      productId: ev.shopifyProductId,
      addedToCart: int(sql`count(distinct ${ev.clientId})`),
    })
    .from(ev)
    .where(
      and(
        eq(ev.storeId, storeId),
        eq(ev.type, 'add_to_cart'),
        gte(ev.createdAt, range.from),
        lt(ev.createdAt, range.to),
        isNotNull(ev.shopifyProductId),
      ),
    )
    .groupBy(ev.shopifyProductId);

  // Scoped to only the products that actually appear in `jobRows` — this
  // table is paginated elsewhere (see products.routes.ts) because it can get
  // large, and a full-store read here would make every page load (and every
  // date-range change) pay for it regardless of how few products were tried
  // on in range.
  const jobProductIds = jobRows.map((r) => Number(r.productId));
  const titleRows =
    jobProductIds.length === 0
      ? []
      : await db
          .select({
            productId: schema.shopifyProductGarments.shopifyProductId,
            title: schema.shopifyProductGarments.title,
          })
          .from(schema.shopifyProductGarments)
          .where(
            and(
              eq(schema.shopifyProductGarments.storeId, storeId),
              inArray(schema.shopifyProductGarments.shopifyProductId, jobProductIds),
            ),
          );

  const carts = new Map(cartRows.map((r) => [Number(r.productId), r.addedToCart]));
  const titles = new Map(titleRows.map((r) => [Number(r.productId), r.title]));

  return jobRows
    .map((r) => {
      const id = Number(r.productId);
      const addedToCart = carts.get(id) ?? 0;
      return {
        shopifyProductId: id,
        title: titles.get(id) ?? null,
        tryOns: r.tryOns,
        uniqueShoppers: r.uniqueShoppers,
        addedToCart,
        addToCartRate: r.uniqueShoppers === 0 ? 0 : addedToCart / r.uniqueShoppers,
      };
    })
    .sort((a, b) => b.tryOns - a.tryOns);
}
