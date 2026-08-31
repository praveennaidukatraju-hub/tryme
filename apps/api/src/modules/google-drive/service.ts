import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { findOrCreateAppFolder, findOrCreateSubfolder, uploadFile } from './drive-client.js';
import { getValidDriveAccessToken } from './token.js';

export async function exportResultToDrive(
  app: FastifyInstance,
  userId: string,
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ driveFileId: string; webViewLink: string }> {
  const [row] = await app.db
    .select({
      resultKey: schema.jobOutputs.resultKey,
      catalogueId: schema.jobs.catalogueId,
      batchId: schema.jobs.batchId,
      createdAt: schema.jobs.createdAt,
    })
    .from(schema.jobs)
    .innerJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
    .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.userId, userId)))
    .limit(1);
  if (!row?.resultKey) throw new AppError('NOT_FOUND', 404, 'result not found');

  const accessToken = await getValidDriveAccessToken(app, userId, fetchImpl);
  const content = await app.storage.getObject(row.resultKey);
  const appFolderId = await findOrCreateAppFolder(accessToken, fetchImpl);

  // Group exports from the same catalogue/batch into one subfolder instead of
  // dumping everything flat into "AI Vastra" — a single-job Studio export has
  // neither id and stays at the root.
  const groupId = row.catalogueId ?? row.batchId;
  const folderId = groupId
    ? await findOrCreateSubfolder(
        accessToken,
        appFolderId,
        `Catalog ${row.createdAt.toISOString().slice(0, 10)} (${groupId.slice(0, 8)})`,
        fetchImpl,
      )
    : appFolderId;
  const filename = `tryme-${jobId.slice(0, 8)}.jpg`;

  try {
    const uploaded = await uploadFile(
      accessToken,
      folderId,
      filename,
      'image/jpeg',
      content,
      fetchImpl,
    );
    return { driveFileId: uploaded.id, webViewLink: uploaded.webViewLink };
  } catch (err) {
    app.log.error({ err, userId, jobId }, 'drive export failed');
    throw new AppError('GOOGLE_DRIVE_EXPORT_FAILED', 502, 'Could not save to Google Drive');
  }
}
