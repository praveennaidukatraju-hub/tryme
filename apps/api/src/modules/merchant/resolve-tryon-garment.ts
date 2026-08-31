import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';

export interface ResolvedTryonGarment {
  r2Key: string;
  secondR2Key?: string;
  workflowTemplateId: string;
  workflowTemplateVersion?: number | null;
  isDemo: boolean;
}

/**
 * One garment lookup for both try-on entry points (the merchant-token route and
 * the kiosk-device route, which had byte-identical copies of this query). Tries
 * the merchant's own catalogue first, then falls back to admin demo items the
 * merchant has been assigned. `merchantCatalogItemId` is a shared id namespace
 * across two tables; UUIDs make collisions impossible.
 */
export async function resolveTryonGarment(
  app: FastifyInstance,
  merchantId: string,
  itemId: string,
): Promise<ResolvedTryonGarment> {
  const [own] = await app.db
    .select({
      merchantId: schema.merchantCatalogItems.merchantId,
      r2Key: schema.merchantCatalogItems.r2Key,
      secondR2Key: schema.merchantCatalogItems.secondR2Key,
      isActive: schema.merchantCatalogItems.isActive,
      moderationStatus: schema.merchantCatalogItems.moderationStatus,
      twoInputTryonWorkflowTemplateId: schema.garmentSubcategories.twoInputTryonWorkflowTemplateId,
      workflowTemplateId: schema.tryonCategories.workflowTemplateId,
      workflowTemplateVersion: schema.workflowTemplates.version,
      tryonCategoryIsActive: schema.tryonCategories.isActive,
      workflowTemplateIsActive: schema.workflowTemplates.isActive,
    })
    .from(schema.merchantCatalogItems)
    .innerJoin(
      schema.merchantCatalogSubcategories,
      eq(schema.merchantCatalogSubcategories.id, schema.merchantCatalogItems.subcategoryId),
    )
    .leftJoin(
      schema.garmentSubcategories,
      eq(schema.garmentSubcategories.id, schema.merchantCatalogSubcategories.garmentSubcategoryId),
    )
    .leftJoin(
      schema.tryonCategories,
      eq(schema.tryonCategories.id, schema.garmentSubcategories.tryonCategoryId),
    )
    .leftJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.tryonCategories.workflowTemplateId),
    )
    .where(eq(schema.merchantCatalogItems.id, itemId))
    .limit(1);

  if (own) {
    if (own.merchantId !== merchantId) {
      throw new AppError('NOT_FOUND', 404, 'catalog item not found');
    }
    if (!own.isActive || own.moderationStatus !== 'approved') {
      throw new AppError('FORBIDDEN', 403, 'catalog item is not available');
    }

    // A catalog item with a second (pallu) image bypasses the normal tryon-category
    // lookup entirely and goes through the garment type's dedicated two-input template —
    // see garmentSubcategories.twoInputTryonWorkflowTemplateId. Falling back to the
    // single-image template here would silently ignore the pallu image rather than fail
    // loud, so this is a hard config error, not a soft fallback.
    if (own.secondR2Key) {
      if (!own.twoInputTryonWorkflowTemplateId) {
        throw new AppError(
          'VALIDATION',
          400,
          'garment type has no two-input tryon workflow configured',
        );
      }
      const [twoInputTemplate] = await app.db
        .select({
          isActive: schema.workflowTemplates.isActive,
          version: schema.workflowTemplates.version,
        })
        .from(schema.workflowTemplates)
        .where(eq(schema.workflowTemplates.id, own.twoInputTryonWorkflowTemplateId))
        .limit(1);
      if (!twoInputTemplate?.isActive) {
        throw new AppError('VALIDATION', 400, 'two-input tryon workflow is inactive');
      }
      return {
        r2Key: own.r2Key,
        secondR2Key: own.secondR2Key,
        workflowTemplateId: own.twoInputTryonWorkflowTemplateId,
        workflowTemplateVersion: twoInputTemplate.version,
        isDemo: false,
      };
    }

    assertWorkflow(own);
    return {
      r2Key: own.r2Key,
      workflowTemplateId: own.workflowTemplateId,
      workflowTemplateVersion: own.workflowTemplateVersion,
      isDemo: false,
    };
  }

  const [demo] = await app.db
    .select({
      r2Key: schema.demoCatalogItems.r2Key,
      isActive: schema.demoCatalogItems.isActive,
      setIsActive: schema.demoCatalogSets.isActive,
      workflowTemplateId: schema.tryonCategories.workflowTemplateId,
      workflowTemplateVersion: schema.workflowTemplates.version,
      tryonCategoryIsActive: schema.tryonCategories.isActive,
      workflowTemplateIsActive: schema.workflowTemplates.isActive,
    })
    .from(schema.demoCatalogItems)
    .innerJoin(
      schema.demoCatalogSubcategories,
      eq(schema.demoCatalogSubcategories.id, schema.demoCatalogItems.subcategoryId),
    )
    .innerJoin(
      schema.demoCatalogSets,
      eq(schema.demoCatalogSets.id, schema.demoCatalogSubcategories.setId),
    )
    // The inner join IS the authorization check: no assignment row, no result.
    .innerJoin(
      schema.demoCatalogAssignments,
      and(
        eq(schema.demoCatalogAssignments.setId, schema.demoCatalogSets.id),
        eq(schema.demoCatalogAssignments.merchantId, merchantId),
      ),
    )
    .innerJoin(
      schema.merchants,
      and(eq(schema.merchants.id, merchantId), eq(schema.merchants.demoData, true)),
    )
    .leftJoin(
      schema.garmentSubcategories,
      eq(schema.garmentSubcategories.id, schema.demoCatalogSubcategories.garmentSubcategoryId),
    )
    .leftJoin(
      schema.tryonCategories,
      eq(schema.tryonCategories.id, schema.garmentSubcategories.tryonCategoryId),
    )
    .leftJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.tryonCategories.workflowTemplateId),
    )
    .where(eq(schema.demoCatalogItems.id, itemId))
    .limit(1);

  if (!demo) throw new AppError('NOT_FOUND', 404, 'catalog item not found');
  if (!demo.isActive || !demo.setIsActive) {
    throw new AppError('FORBIDDEN', 403, 'catalog item is not available');
  }
  assertWorkflow(demo);
  return {
    r2Key: demo.r2Key,
    workflowTemplateId: demo.workflowTemplateId,
    workflowTemplateVersion: demo.workflowTemplateVersion,
    isDemo: true,
  };
}

function assertWorkflow(row: {
  workflowTemplateId: string | null;
  tryonCategoryIsActive: boolean | null;
  workflowTemplateIsActive: boolean | null;
}): asserts row is {
  workflowTemplateId: string;
  tryonCategoryIsActive: boolean;
  workflowTemplateIsActive: boolean;
} {
  if (!row.workflowTemplateId || !row.tryonCategoryIsActive || !row.workflowTemplateIsActive) {
    throw new AppError('VALIDATION', 400, 'garment type has no tryon category configured');
  }
}
