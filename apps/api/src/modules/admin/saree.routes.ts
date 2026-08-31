import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  AdminSareeSettingsPatch,
  AdminSareeSettingsPresignBody,
  AdminSareeWorkflowCreateBody,
} from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { getSareeSettings, upsertSareeSettings } from '../saree/settings.js';
import { requirePermission } from './guard.js';
import { detectSareeMappings } from './saree-detect.js';

export async function adminSareeRoutes(app: FastifyInstance) {
  const W = requirePermission('saree.write');
  const R = requirePermission('saree.read');
  const uuidParam = z.object({ id: z.string().uuid() });

  // ── Workflows ─────────────────────────────────────────────────────────────

  // GET /admin/saree-workflows/active
  app.get('/admin/saree-workflows/active', { preHandler: R }, async () => {
    const [row] = await app.db
      .select()
      .from(schema.workflowTemplates)
      .where(
        and(
          eq(schema.workflowTemplates.workflowType, 'saree'),
          eq(schema.workflowTemplates.isActive, true),
        ),
      )
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', 404, 'no active saree workflow');
    const { detected } = detectSareeMappings(row.jsonContent as Record<string, unknown>);
    return {
      id: row.id,
      slug: row.slug,
      label: row.label,
      isActive: row.isActive,
      jsonContent: row.jsonContent,
      detected,
    };
  });

  // POST /admin/saree-workflows
  app.post(
    '/admin/saree-workflows',
    { preHandler: W, schema: { body: AdminSareeWorkflowCreateBody } },
    async (req) => {
      const body = req.body as z.infer<typeof AdminSareeWorkflowCreateBody>;
      const { detected } = detectSareeMappings(body.jsonContent);
      if (!detected.modelImageNode || !detected.sareeImageNode) {
        throw new AppError(
          'VALIDATION',
          400,
          'saree workflow must contain a "person"/"model" LoadImage and a "flatsaree"/"saree" LoadImage',
        );
      }
      const result = await app.db.transaction(async (tx) => {
        // Demote any existing active saree workflow (single-active invariant for the temp feature).
        await tx
          .update(schema.workflowTemplates)
          .set({ isActive: false, updatedAt: new Date() })
          .where(
            and(
              eq(schema.workflowTemplates.workflowType, 'saree'),
              eq(schema.workflowTemplates.isActive, true),
            ),
          );
        try {
          const [created] = await tx
            .insert(schema.workflowTemplates)
            .values({
              slug: body.slug,
              label: body.label,
              workflowType: 'saree',
              jsonContent: body.jsonContent,
              isActive: true,
              // Required notNull columns from the workflowTemplates table — saree
              // flows don't use the regular/tryon pose/garment columns, so use
              // empty placeholders. (Mirrors the tryon insert in workflows.routes.ts.)
              faceNodeId: '',
              poseNodeId: '',
              bgNodeId: '',
              upperNodeIds: [],
              facePhasePromptNode: '',
              garmentPhasePromptNode: '',
              defaultFacePhasePrompt: '',
              defaultGarmentPhasePrompt: '',
              // The saree flow uses the same node-ID columns as tryon — both flows
              // are 2-image-input + 1-output. The dispatcher's processSareeJob
              // reads tryonPersonNodeId / tryonGarmentNodeId / tryonOutputNodeId
              // for saree workflows too.
              tryonPersonNodeId: detected.modelImageNode,
              tryonGarmentNodeId: detected.sareeImageNode,
              tryonOutputNodeId: detected.outputNode,
            })
            .returning();
          return created;
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            throw new AppError('CONFLICT', 409, `slug "${body.slug}" already exists`);
          }
          throw err;
        }
      });
      return {
        id: result.id,
        slug: result.slug,
        label: result.label,
        isActive: result.isActive,
        jsonContent: result.jsonContent,
        detected,
      };
    },
  );

  // DELETE /admin/saree-workflows/:id
  app.delete(
    '/admin/saree-workflows/:id',
    { preHandler: W, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      const [updated] = await app.db
        .update(schema.workflowTemplates)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(schema.workflowTemplates.id, id),
            eq(schema.workflowTemplates.workflowType, 'saree'),
          ),
        )
        .returning({ id: schema.workflowTemplates.id });
      if (!updated) throw new AppError('NOT_FOUND', 404, 'saree workflow not found');
      return { ok: true };
    },
  );

  // ── Settings ──────────────────────────────────────────────────────────────

  // GET /admin/saree-settings
  app.get('/admin/saree-settings', { preHandler: R }, async () => {
    const row = await getSareeSettings(app.db);
    const modelImageKey = row?.modelImageKey ?? null;
    const modelImageThumbKey = row?.modelImageThumbKey ?? null;
    const sampleSareeImageKey = row?.sampleSareeImageKey ?? null;
    const sampleSareeImageThumbKey = row?.sampleSareeImageThumbKey ?? null;
    const presign = async (key: string | null) => {
      if (!key) return null;
      try {
        return (await app.storage.presignGet(key, 3600)).url;
      } catch {
        return null;
      }
    };
    const [modelImageUrl, modelImageThumbUrl, sampleSareeImageUrl, sampleSareeImageThumbUrl] =
      await Promise.all([
        presign(modelImageThumbKey ?? modelImageKey),
        presign(modelImageThumbKey),
        presign(sampleSareeImageThumbKey ?? sampleSareeImageKey),
        presign(sampleSareeImageThumbKey),
      ]);
    return {
      modelImageKey,
      modelImageThumbKey,
      modelImageUrl,
      modelImageThumbUrl,
      sampleSareeImageKey,
      sampleSareeImageThumbKey,
      sampleSareeImageUrl,
      sampleSareeImageThumbUrl,
      workflowTemplateId: row?.workflowTemplateId ?? null,
      isConfigured: !!modelImageKey,
    };
  });

  // POST /admin/saree-settings/presign
  app.post(
    '/admin/saree-settings/presign',
    { preHandler: W, schema: { body: AdminSareeSettingsPresignBody } },
    async (req) => {
      const { contentType, purpose } = req.body as z.infer<typeof AdminSareeSettingsPresignBody>;
      const r2Key = purpose === 'sample' ? keys.sareeSampleImage() : keys.sareeModelImage();
      const thumbKey =
        purpose === 'sample' ? keys.sareeSampleImageThumb() : keys.sareeModelImageThumb();
      const [main, thumb] = await Promise.all([
        app.storage.presignPut(r2Key, contentType, 10_000_000, 300),
        app.storage.presignPut(thumbKey, 'image/jpeg', 1_000_000, 300),
      ]);
      return {
        r2Key,
        uploadUrl: main.url,
        thumbnailKey: thumbKey,
        thumbnailUploadUrl: thumb.url,
      };
    },
  );

  // PATCH /admin/saree-settings
  app.patch(
    '/admin/saree-settings',
    { preHandler: W, schema: { body: AdminSareeSettingsPatch } },
    async (req) => {
      const body = req.body as z.infer<typeof AdminSareeSettingsPatch>;
      await upsertSareeSettings(app.db, body);
      return { ok: true };
    },
  );

  // ── Workers (informational) ───────────────────────────────────────────────

  // GET /admin/saree-workers
  app.get('/admin/saree-workers', { preHandler: R }, async () => {
    const all = await app.db.select().from(schema.workers).orderBy(schema.workers.label);
    return all.map((w) => ({
      id: w.id,
      label: w.label,
      url: w.url,
      isActive: w.isActive,
      allowedJobTypes: w.allowedJobTypes,
      status: null, // Live worker status lives in Redis (worker:health:); skip the round-trip here.
    }));
  });
}
