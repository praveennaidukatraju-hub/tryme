import { type DbTransaction, schema } from '@tryme/db';
import { auditLogWriteFailuresTotal } from '@tryme/observability';
import type { FastifyRequest } from 'fastify';

export interface RecordAuditParams {
  actor: { userId: string; role: string };
  action: string;
  resourceType: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  request?: FastifyRequest;
}

/**
 * Inserts an audit log entry within the caller's database transaction.
 *
 * Invariant: Must be called inside the mutation transaction (after mutation, before commit).
 * Fail-closed by design: if this insert throws, the mutation rolls back and
 * `audit_log_write_failures_total` is incremented.
 */
export async function recordAudit(tx: DbTransaction, params: RecordAuditParams): Promise<void> {
  try {
    const ipAddress = params.request?.ip;
    const userAgent = params.request?.headers['user-agent'];
    const requestId = params.request?.id ? String(params.request.id) : undefined;

    await tx.insert(schema.auditLogs).values({
      actorUserId: params.actor.userId,
      actorRole: params.actor.role,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      before: params.before ?? null,
      after: params.after ?? null,
      ipAddress: ipAddress ?? null,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
      requestId: requestId ?? null,
    });
  } catch (err) {
    auditLogWriteFailuresTotal.inc();
    throw err;
  }
}
