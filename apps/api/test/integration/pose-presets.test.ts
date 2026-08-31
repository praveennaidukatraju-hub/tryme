import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('pose presets', () => {
  let c: Containers;
  let app: TestApp;
  let nextTestClient = 1;
  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  // Each call registers+logs in a fresh user; /v1/auth/login is capped at
  // 5/min per IP (apps/api/src/modules/auth/routes.ts), and this suite logs in
  // more than 5 distinct users, so each call needs its own remoteAddress to
  // avoid colliding on the limiter bucket (same pattern as payments-tier.test.ts).
  async function getToken(email: string) {
    const remoteAddress = `127.0.0.${nextTestClient++}`;
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress,
      payload: { displayName: 'Preset User', email, password: 'password123' },
    });
    const [user] = await app.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    if (!user) throw new Error('user not found');
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress,
      payload: { email, password: 'password123' },
    });
    return { token: login.json().accessToken as string, userId: user.id };
  }

  async function makePose(active = true, gender = 'women') {
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: `pose-${Date.now()}-${Math.random()}`,
        genderSlug: gender,
        r2Key: 'p.jpg',
        thumbnailKey: 'p-thumb.jpg',
        isActive: active,
      })
      .returning();
    return pose.id;
  }

  async function makeGarmentType(gender = 'women') {
    const [row] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: gender,
        slug: `type-${Date.now()}-${Math.random()}`,
        label: 'Test Garment Type',
      })
      .returning();
    return row.id;
  }

  function listUrl(gender: string, garmentTypeId: string) {
    return `/v1/pose-presets?gender=${gender}&garmentTypeId=${garmentTypeId}`;
  }

  it('creates and lists a named preset', async () => {
    const { token } = await getToken('preset-crud@x.com');
    const poseId = await makePose();
    const garmentTypeId = await makeGarmentType();

    const create = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'My Look', gender: 'women', garmentTypeId, poseIds: [poseId] },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().name).toBe('My Look');

    const list = await app.inject({
      method: 'GET',
      url: listUrl('women', garmentTypeId),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().named).toHaveLength(1);
    expect(list.json().named[0].poseIds).toEqual([poseId]);
  });

  it('does not surface a preset saved under a different gender/garment-type scope', async () => {
    const { token } = await getToken('preset-scope-mismatch@x.com');
    const poseId = await makePose(true, 'women');
    const womenGarmentTypeId = await makeGarmentType('women');
    const menGarmentTypeId = await makeGarmentType('men');

    const create = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Only For Women',
        gender: 'women',
        garmentTypeId: womenGarmentTypeId,
        poseIds: [poseId],
      },
    });
    expect(create.statusCode).toBe(201);

    // Same user, same garment-type row reused across genders would be unusual in
    // practice, but the query params alone must scope the read — a different
    // garmentTypeId (men's) under the same user must not see the women's preset.
    const list = await app.inject({
      method: 'GET',
      url: listUrl('men', menGarmentTypeId),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().named).toHaveLength(0);
  });

  it('rejects an 11th named preset within the same scope with PRESET_LIMIT_REACHED', async () => {
    const { token } = await getToken('preset-cap@x.com');
    const garmentTypeId = await makeGarmentType();
    for (let i = 0; i < 10; i++) {
      const poseId = await makePose();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pose-presets',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: `Look ${i}`, gender: 'women', garmentTypeId, poseIds: [poseId] },
      });
      expect(res.statusCode).toBe(201);
    }
    const poseId = await makePose();
    const overflow = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Look 11', gender: 'women', garmentTypeId, poseIds: [poseId] },
    });
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json().error.code).toBe('PRESET_LIMIT_REACHED');

    // The cap is per (user, gender, garmentType) scope, not global — an 11th
    // preset under a different garment type must still succeed.
    const otherGarmentTypeId = await makeGarmentType();
    const otherPoseId = await makePose();
    const otherScope = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Look 11',
        gender: 'women',
        garmentTypeId: otherGarmentTypeId,
        poseIds: [otherPoseId],
      },
    });
    expect(otherScope.statusCode).toBe(201);
  });

  it('rejects a duplicate name (case-insensitive) within the same scope with PRESET_NAME_TAKEN', async () => {
    const { token } = await getToken('preset-dupe@x.com');
    const garmentTypeId = await makeGarmentType();
    const poseId = await makePose();
    await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Beach Day', gender: 'women', garmentTypeId, poseIds: [poseId] },
    });
    const dupe = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'beach day', gender: 'women', garmentTypeId, poseIds: [poseId] },
    });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.code).toBe('PRESET_NAME_TAKEN');

    // The same name is reusable under a different (gender, garmentType) scope.
    const otherGarmentTypeId = await makeGarmentType();
    const reused = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Beach Day',
        gender: 'women',
        garmentTypeId: otherGarmentTypeId,
        poseIds: [poseId],
      },
    });
    expect(reused.statusCode).toBe(201);
  });

  it('filters out inactive poses on GET and 400s on create with an inactive pose', async () => {
    const { token } = await getToken('preset-inactive@x.com');
    const garmentTypeId = await makeGarmentType();
    const inactivePoseId = await makePose(false);
    const create = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Stale', gender: 'women', garmentTypeId, poseIds: [inactivePoseId] },
    });
    expect(create.statusCode).toBe(400);
    expect(create.json().error.code).toBe('INVALID_POSE_IDS');

    // A pose that was active at save time but is later deactivated must be
    // filtered out of the preset's poseIds on GET (activePoseIds in
    // routes.ts), not just rejected at create time.
    const poseId = await makePose();
    const saved = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Goes Stale', gender: 'women', garmentTypeId, poseIds: [poseId] },
    });
    expect(saved.statusCode).toBe(201);

    await app.db
      .update(schema.modelPoseAssets)
      .set({ isActive: false })
      .where(eq(schema.modelPoseAssets.id, poseId));

    const list = await app.inject({
      method: 'GET',
      url: listUrl('women', garmentTypeId),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const staled = list.json().named.find((p: { name: string }) => p.name === 'Goes Stale');
    expect(staled.poseIds).toEqual([]);
  });

  it('rejects a poseId that belongs to a different gender than the preset claims', async () => {
    const { token } = await getToken('preset-gender-mismatch@x.com');
    const garmentTypeId = await makeGarmentType('men');
    const womenPoseId = await makePose(true, 'women');
    const create = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Wrong Gender', gender: 'men', garmentTypeId, poseIds: [womenPoseId] },
    });
    expect(create.statusCode).toBe(400);
    expect(create.json().error.code).toBe('INVALID_POSE_IDS');
  });

  it("cannot delete another user's preset", async () => {
    const a = await getToken('preset-owner-a@x.com');
    const b = await getToken('preset-owner-b@x.com');
    const garmentTypeId = await makeGarmentType();
    const poseId = await makePose();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${a.token}` },
      payload: { name: 'Owned By A', gender: 'women', garmentTypeId, poseIds: [poseId] },
    });
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/pose-presets/${created.json().id}`,
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(del.statusCode).toBe(404);
    expect(del.json().error.code).toBe('NOT_FOUND');
  });

  it('deletes a named preset and it no longer appears in GET', async () => {
    const { token } = await getToken('preset-delete-ok@x.com');
    const garmentTypeId = await makeGarmentType();
    const poseId = await makePose();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'To Delete', gender: 'women', garmentTypeId, poseIds: [poseId] },
    });
    expect(created.statusCode).toBe(201);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/pose-presets/${created.json().id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: listUrl('women', garmentTypeId),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(
      list.json().named.find((p: { id: string }) => p.id === created.json().id),
    ).toBeUndefined();
  });

  it('rejects deleting the last-used row', async () => {
    const { token, userId } = await getToken('preset-last-used-del@x.com');
    const garmentTypeId = await makeGarmentType();
    const poseId = await makePose();
    const [lastUsed] = await app.db
      .insert(schema.userPosePresets)
      .values({ userId, gender: 'women', garmentTypeId, poseIds: [poseId], isLastUsed: true })
      .returning();
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/pose-presets/${lastUsed.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(400);
    expect(del.json().error.code).toBe('VALIDATION');
  });

  describe('last-used auto-tracking', () => {
    let realHeadObject: typeof app.storage.headObject | undefined;
    beforeEach(() => {
      realHeadObject = app.storage.headObject?.bind(app.storage);
      app.storage.headObject = (async () => ({
        contentLength: 1024,
      })) as typeof app.storage.headObject;
    });
    afterEach(() => {
      if (realHeadObject) app.storage.headObject = realHeadObject;
    });

    async function seedFaceAndLook(suffix: string, garmentTypeId: string | undefined) {
      const [face] = await app.db
        .insert(schema.modelFaces)
        .values({
          gender: 'women',
          label: `Face${suffix}`,
          r2Key: `f${suffix}.jpg`,
          thumbnailKey: `f${suffix}.jpg`,
        })
        .returning();
      const [background] = await app.db
        .insert(schema.modelBackgrounds)
        .values({ label: `Bg${suffix}`, r2Key: `b${suffix}.jpg`, thumbnailKey: `b${suffix}.jpg` })
        .returning();
      // genderSlug must be set — updateLastUsedPosePreset derives the tracked
      // scope's gender from the resolved pose, not from the request body.
      const [pose] = await app.db
        .insert(schema.modelPoseAssets)
        .values({
          label: `Pose${suffix}`,
          genderSlug: 'women',
          r2Key: `p${suffix}.jpg`,
          thumbnailKey: `p${suffix}.jpg`,
        })
        .returning();
      return { faceId: face.id, backgroundId: background.id, poseId: pose.id, garmentTypeId };
    }

    async function submitTryonJob(
      token: string,
      userId: string,
      suffix: string,
      garmentTypeId: string | undefined,
    ) {
      const { faceId, backgroundId, poseId } = await seedFaceAndLook(suffix, garmentTypeId);
      // INPUT_GARMENT_KEY (packages/types/src/jobs.ts) only accepts the exact
      // literal `inputs/<uuid>/garment.jpg` — no suffix — so both submissions
      // for a given user reuse the same key; the Redis ownership binding is
      // reset before each submit and isn't consumed by createJob, so reuse is safe.
      const garmentKey = `inputs/${userId}/garment.jpg`;
      await app.redis.set(`upload:owner:${garmentKey}`, userId, 'EX', 3600);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/tryon',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          inputs: {
            upperGarmentKey: garmentKey,
            faceId,
            ...(garmentTypeId ? { garmentTypeId } : {}),
            looks: [{ poseId, backgroundId }],
          },
          aspectRatio: '1:1',
          resolution: '2K',
        },
      });
      return { res, poseId };
    }

    it('upserts the last-used preset after a successful tryon job, overwriting on resubmit', async () => {
      const { token, userId } = await getToken('preset-last-used-job@x.com');
      const garmentTypeId = await makeGarmentType('women');
      await app.db
        .insert(schema.userCredits)
        .values({ userId, balance: 100 })
        .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: 100 } });

      const first = await submitTryonJob(token, userId, 'a', garmentTypeId);
      expect(first.res.statusCode).toBe(201);

      const [lastUsedAfterFirst] = await app.db
        .select()
        .from(schema.userPosePresets)
        .where(
          and(
            eq(schema.userPosePresets.userId, userId),
            eq(schema.userPosePresets.isLastUsed, true),
          ),
        );
      expect(lastUsedAfterFirst).toBeDefined();
      expect(lastUsedAfterFirst.gender).toBe('women');
      expect(lastUsedAfterFirst.garmentTypeId).toBe(garmentTypeId);
      expect(lastUsedAfterFirst.poseIds).toEqual([first.poseId]);

      // Also assert through the actual response shape callers consume
      // (ListPosePresetsResponse's `lastUsed` field), not just the raw DB row —
      // the GET endpoint is what /v1/pose-presets clients (the studio wizard)
      // actually read.
      const listAfterFirst = await app.inject({
        method: 'GET',
        url: listUrl('women', garmentTypeId),
        headers: { authorization: `Bearer ${token}` },
      });
      expect(listAfterFirst.statusCode).toBe(200);
      expect(listAfterFirst.json().lastUsed?.poseIds).toEqual([first.poseId]);

      const second = await submitTryonJob(token, userId, 'b', garmentTypeId);
      expect(second.res.statusCode).toBe(201);

      const rows = await app.db
        .select()
        .from(schema.userPosePresets)
        .where(
          and(
            eq(schema.userPosePresets.userId, userId),
            eq(schema.userPosePresets.isLastUsed, true),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].poseIds).toEqual([second.poseId]);

      const listAfterSecond = await app.inject({
        method: 'GET',
        url: listUrl('women', garmentTypeId),
        headers: { authorization: `Bearer ${token}` },
      });
      expect(listAfterSecond.statusCode).toBe(200);
      expect(listAfterSecond.json().lastUsed?.poseIds).toEqual([second.poseId]);
    });

    it('scopes last-used tracking to the job garment type — a second job under a different garment type does not clobber the first', async () => {
      const { token, userId } = await getToken('preset-last-used-scoped@x.com');
      const garmentTypeA = await makeGarmentType('women');
      const garmentTypeB = await makeGarmentType('women');
      await app.db
        .insert(schema.userCredits)
        .values({ userId, balance: 100 })
        .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: 100 } });

      const first = await submitTryonJob(token, userId, 'c', garmentTypeA);
      expect(first.res.statusCode).toBe(201);
      const second = await submitTryonJob(token, userId, 'd', garmentTypeB);
      expect(second.res.statusCode).toBe(201);

      const rows = await app.db
        .select()
        .from(schema.userPosePresets)
        .where(
          and(
            eq(schema.userPosePresets.userId, userId),
            eq(schema.userPosePresets.isLastUsed, true),
          ),
        );
      // One last-used row per (user, gender, garmentType) — two distinct
      // garment types means two distinct rows, neither overwriting the other.
      expect(rows).toHaveLength(2);
      const byGarmentType = new Map(rows.map((r) => [r.garmentTypeId, r.poseIds]));
      expect(byGarmentType.get(garmentTypeA)).toEqual([first.poseId]);
      expect(byGarmentType.get(garmentTypeB)).toEqual([second.poseId]);
    });

    it('does not write a last-used row when the job omits garmentTypeId', async () => {
      const { token, userId } = await getToken('preset-last-used-no-garment-type@x.com');
      await app.db
        .insert(schema.userCredits)
        .values({ userId, balance: 100 })
        .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: 100 } });

      const submitted = await submitTryonJob(token, userId, 'e', undefined);
      expect(submitted.res.statusCode).toBe(201);

      const rows = await app.db
        .select()
        .from(schema.userPosePresets)
        .where(
          and(
            eq(schema.userPosePresets.userId, userId),
            eq(schema.userPosePresets.isLastUsed, true),
          ),
        );
      expect(rows).toHaveLength(0);
    });
  });
});
