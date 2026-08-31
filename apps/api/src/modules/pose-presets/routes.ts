import { schema } from '@tryme/db';
import {
  CreatePosePresetRequest,
  ListPosePresetsQuery,
  ListPosePresetsResponse,
} from '@tryme/types';
import { and, desc, eq, inArray, isNull, not } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';

const MAX_NAMED_PRESETS = 10;

// Scoped to `gender` — a preset's poseIds must genuinely belong to the
// gender it claims, matching how /v1/models/poses partitions poses by
// gender. Not scoped to garmentTypeId here: poses have per-garment-type
// active/inactive overrides (pose_garment_configs), not a hard ownership
// tie, so gender is the only hard membership check available at write time.
async function activePoseIds(
  app: FastifyInstance,
  poseIds: string[],
  gender: string,
): Promise<string[]> {
  if (poseIds.length === 0) return [];
  const rows = await app.db
    .select({ id: schema.modelPoseAssets.id })
    .from(schema.modelPoseAssets)
    .where(
      and(
        inArray(schema.modelPoseAssets.id, poseIds),
        eq(schema.modelPoseAssets.genderSlug, gender),
        eq(schema.modelPoseAssets.isActive, true),
        isNull(schema.modelPoseAssets.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}

export async function posePresetsRoutes(app: FastifyInstance) {
  app.get(
    '/v1/pose-presets',
    { preHandler: app.requireUser, schema: { querystring: ListPosePresetsQuery } },
    async (req) => {
      const { gender, garmentTypeId } = req.query as z.infer<typeof ListPosePresetsQuery>;
      const rows = await app.db
        .select()
        .from(schema.userPosePresets)
        .where(
          and(
            eq(schema.userPosePresets.userId, req.userId),
            eq(schema.userPosePresets.gender, gender),
            eq(schema.userPosePresets.garmentTypeId, garmentTypeId),
          ),
        )
        .orderBy(desc(schema.userPosePresets.updatedAt));

      const filtered = await Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          name: r.name,
          gender: r.gender,
          garmentTypeId: r.garmentTypeId,
          poseIds: await activePoseIds(app, r.poseIds, r.gender),
          isLastUsed: r.isLastUsed,
          updatedAt: r.updatedAt.toISOString(),
        })),
      );

      return ListPosePresetsResponse.parse({
        lastUsed: filtered.find((p) => p.isLastUsed) ?? null,
        named: filtered.filter((p) => !p.isLastUsed),
      });
    },
  );

  app.post(
    '/v1/pose-presets',
    { preHandler: app.requireUser, schema: { body: CreatePosePresetRequest } },
    async (req, reply) => {
      const { name, gender, garmentTypeId, poseIds } = req.body as z.infer<
        typeof CreatePosePresetRequest
      >;

      // garmentTypeId is client-chosen and FK-constrained, but unvalidated
      // input reaching that FK would 500 instead of 400 — and without this,
      // gender is trusted from the client with nothing tying it to the
      // garment type actually being saved under, weakening the per-scope cap
      // this table relies on (see schema comment on user_pose_presets).
      const [garmentType] = await app.db
        .select({ genderSlug: schema.garmentSubcategories.genderSlug })
        .from(schema.garmentSubcategories)
        .where(
          and(
            eq(schema.garmentSubcategories.id, garmentTypeId),
            eq(schema.garmentSubcategories.isActive, true),
          ),
        );
      if (!garmentType || garmentType.genderSlug !== gender) {
        throw new AppError('VALIDATION', 400, 'garment type is not valid for this gender');
      }

      const valid = await activePoseIds(app, poseIds, gender);
      if (valid.length !== poseIds.length) {
        throw new AppError(
          'INVALID_POSE_IDS',
          400,
          'one or more poses are not active for this gender',
        );
      }

      const named = await app.db
        .select({ id: schema.userPosePresets.id, name: schema.userPosePresets.name })
        .from(schema.userPosePresets)
        .where(
          and(
            eq(schema.userPosePresets.userId, req.userId),
            eq(schema.userPosePresets.gender, gender),
            eq(schema.userPosePresets.garmentTypeId, garmentTypeId),
            not(schema.userPosePresets.isLastUsed),
          ),
        );
      if (named.length >= MAX_NAMED_PRESETS) {
        throw new AppError('PRESET_LIMIT_REACHED', 409, `max ${MAX_NAMED_PRESETS} presets`);
      }
      if (named.some((r) => r.name?.toLowerCase() === name.toLowerCase())) {
        throw new AppError('PRESET_NAME_TAKEN', 409, 'a preset with this name already exists');
      }

      const [created] = await app.db
        .insert(schema.userPosePresets)
        .values({ userId: req.userId, name, gender, garmentTypeId, poseIds })
        .returning();

      reply.code(201);
      return {
        id: created.id,
        name: created.name,
        gender: created.gender,
        garmentTypeId: created.garmentTypeId,
        poseIds: created.poseIds,
        isLastUsed: created.isLastUsed,
        updatedAt: created.updatedAt.toISOString(),
      };
    },
  );

  app.delete(
    '/v1/pose-presets/:id',
    { preHandler: app.requireUser, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await app.db
        .select()
        .from(schema.userPosePresets)
        .where(
          and(eq(schema.userPosePresets.id, id), eq(schema.userPosePresets.userId, req.userId)),
        );
      if (!row) throw new AppError('NOT_FOUND', 404, 'preset not found');
      if (row.isLastUsed) {
        throw new AppError('VALIDATION', 400, 'the last-used preset cannot be deleted directly');
      }
      await app.db.delete(schema.userPosePresets).where(eq(schema.userPosePresets.id, id));
      reply.code(204);
    },
  );
}
