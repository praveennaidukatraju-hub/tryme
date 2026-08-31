import { schema } from '@tryme/db';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

// One test per gender enum value - auto-shift is scoped per gender, so sharing
// a gender across tests in this file would let one test's shift touch another
// test's rows. Four tests, four genders, zero cross-test interference.
describe('garment-types sortOrder auto-shift', () => {
  let c: Containers;
  let app: TestApp;
  let headers: Record<string, string>;
  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    headers = await adminAuthHeader(app, 'SUPER_ADMIN');
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function seed(gender: string, entries: Array<{ label: string; sortOrder: number }>) {
    const slugPrefix = `shift-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const rows = await app.db
      .insert(schema.garmentSubcategories)
      .values(
        entries.map((e, i) => ({
          genderSlug: gender,
          slug: `${slugPrefix}-${i}`,
          label: e.label,
          sortOrder: e.sortOrder,
        })),
      )
      .returning();
    return rows;
  }

  async function sortOrdersFor(gender: string) {
    const rows = await app.db
      .select({
        label: schema.garmentSubcategories.label,
        sortOrder: schema.garmentSubcategories.sortOrder,
      })
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.genderSlug, gender))
      .orderBy(asc(schema.garmentSubcategories.sortOrder));
    return rows;
  }

  it('POST with a taken sortOrder shifts the colliding row and everything after it up by one', async () => {
    await seed('boys', [
      { label: 'Existing A', sortOrder: 1 },
      { label: 'Existing B', sortOrder: 2 },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/assets/garment-types',
      headers,
      payload: {
        genderSlug: 'boys',
        slug: `new-blazer-${Date.now()}`,
        label: 'New Blazer',
        sortOrder: 1,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sortOrder).toBe(1);

    expect(await sortOrdersFor('boys')).toEqual([
      { label: 'New Blazer', sortOrder: 1 },
      { label: 'Existing A', sortOrder: 2 },
      { label: 'Existing B', sortOrder: 3 },
    ]);
  });

  it('POST without sortOrder appends at the end (max + 1) for that gender', async () => {
    await seed('girls', [
      { label: 'Existing A', sortOrder: 1 },
      { label: 'Existing B', sortOrder: 2 },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/assets/garment-types',
      headers,
      payload: {
        genderSlug: 'girls',
        slug: `appended-${Date.now()}`,
        label: 'Appended',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sortOrder).toBe(3);

    expect(await sortOrdersFor('girls')).toEqual([
      { label: 'Existing A', sortOrder: 1 },
      { label: 'Existing B', sortOrder: 2 },
      { label: 'Appended', sortOrder: 3 },
    ]);
  });

  it('PATCH moving a row later shifts the rows between old and new position down by one', async () => {
    const seeded = await seed('men', [
      { label: 'A', sortOrder: 1 },
      { label: 'B', sortOrder: 2 },
      { label: 'C', sortOrder: 3 },
    ]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${seeded[0]!.id}`,
      headers,
      payload: { sortOrder: 3 },
    });
    expect(res.statusCode).toBe(200);

    expect(await sortOrdersFor('men')).toEqual([
      { label: 'B', sortOrder: 1 },
      { label: 'C', sortOrder: 2 },
      { label: 'A', sortOrder: 3 },
    ]);
  });

  it('PATCH moving a row earlier shifts the rows between new and old position up by one', async () => {
    const seeded = await seed('women', [
      { label: 'A', sortOrder: 1 },
      { label: 'B', sortOrder: 2 },
      { label: 'C', sortOrder: 3 },
    ]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${seeded[2]!.id}`,
      headers,
      payload: { sortOrder: 1 },
    });
    expect(res.statusCode).toBe(200);

    expect(await sortOrdersFor('women')).toEqual([
      { label: 'C', sortOrder: 1 },
      { label: 'A', sortOrder: 2 },
      { label: 'B', sortOrder: 3 },
    ]);
  });
});
