import { schema } from '@tryme/db';
import { JOB_SOURCE } from '@tryme/types';
import { sql } from 'drizzle-orm';

// jobs.source is set by every job-creation path (see packages/db/src/schema/jobs.ts).
// Only rows predating that column (or a since-fixed gap in it) have source IS NULL —
// for those, fall back to the old faceId-nullity heuristic instead of inventing data.
// Requires job_inputs to already be left-joined in the caller's query.
export function jobTypeSql() {
  return sql<string>`COALESCE(${schema.jobs.source}, CASE WHEN ${schema.jobInputs.faceId} IS NULL THEN ${JOB_SOURCE.TRYON} ELSE ${JOB_SOURCE.CATALOG} END)`;
}
