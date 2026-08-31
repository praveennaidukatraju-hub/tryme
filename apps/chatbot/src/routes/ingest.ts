import type { FastifyInstance } from 'fastify';
import { runIngest } from '../ingest/ingest.js';
import { requireServiceToken } from '../server.js';

export async function ingestRoutes(app: FastifyInstance) {
  const { deps } = app;
  app.post('/ingest', { preHandler: requireServiceToken(deps.env) }, async () => runIngest(deps));
}
