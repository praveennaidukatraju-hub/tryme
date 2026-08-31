import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Single Prometheus registry shared across a process. Both `api` and `dispatcher`
 * import this module; each only writes the metrics it owns, but all metric names are
 * defined here so the package is the single source of truth. Unused metrics simply
 * stay at zero / emit no series until first observed.
 *
 * Default Node/process metrics (event-loop lag, heap, GC, CPU) are collected on import.
 */
export const register = new Registry();

collectDefaultMetrics({ register });

// ── API metrics ─────────────────────────────────────────────────────────────

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const jobsCreatedTotal = new Counter({
  name: 'jobs_created_total',
  help: 'Jobs enqueued by the API',
  labelNames: ['priority', 'kind'] as const,
  registers: [register],
});

export const creditsDeductedTotal = new Counter({
  name: 'credits_deducted_total',
  help: 'Total credits deducted from users',
  registers: [register],
});

export const creditsRefundedTotal = new Counter({
  name: 'credits_refunded_total',
  help: 'Total credits refunded to users',
  registers: [register],
});

export const auditLogWriteFailuresTotal = new Counter({
  name: 'audit_log_write_failures_total',
  help: 'Count of failed audit log write attempts inside admin mutation transactions',
  registers: [register],
});

// ── Dispatcher metrics ───────────────────────────────────────────────────────

export const jobsProcessedTotal = new Counter({
  name: 'jobs_processed_total',
  help: 'Jobs processed by the dispatcher, by terminal outcome',
  labelNames: ['outcome'] as const, // success | failed | retried | cancelled
  registers: [register],
});

export const jobProcessingDuration = new Histogram({
  name: 'job_processing_duration_seconds',
  help: 'End-to-end job processing duration in the dispatcher',
  labelNames: ['outcome', 'job_type'] as const, // job_type mirrors jobs.source (JOB_SOURCE)
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
  registers: [register],
});

export const jobAttemptsTotal = new Counter({
  name: 'job_attempts_total',
  help: 'Job processing attempts (incremented once per attempt)',
  registers: [register],
});

export const jobE2eDuration = new Histogram({
  name: 'job_e2e_duration_seconds',
  help: 'Wall-clock time from job creation to terminal status (includes queue wait)',
  labelNames: ['outcome', 'job_type'] as const, // outcome: completed | failed | cancelled; job_type mirrors jobs.source
  buckets: [5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600],
  registers: [register],
});

export const comfyRequestDuration = new Histogram({
  name: 'comfy_request_duration_seconds',
  help: 'Duration of the ComfyUI /prompt round-trip',
  labelNames: ['job_type'] as const, // mirrors jobs.source (JOB_SOURCE)
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
  registers: [register],
});

export const queueDepth = new Gauge({
  name: 'queue_depth',
  help: 'Number of pending messages in a Redis job stream',
  labelNames: ['stream'] as const,
  registers: [register],
});

export const workersHealthy = new Gauge({
  name: 'workers_healthy',
  help: 'Count of GPU workers currently reporting healthy',
  registers: [register],
});

// ── Chatbot metrics ──────────────────────────────────────────────────────────

export const chatbotMessagesTotal = new Counter({
  name: 'chatbot_messages_total',
  help: 'Chat messages persisted, by role',
  labelNames: ['role'] as const,
  registers: [register],
});

export const chatbotEscalationsTotal = new Counter({
  name: 'chatbot_escalations_total',
  help: 'Conversations escalated to a human, by reason',
  labelNames: ['reason'] as const,
  registers: [register],
});

export const chatbotFallbacksTotal = new Counter({
  name: 'chatbot_fallbacks_total',
  help: 'Bot low-confidence fallback replies',
  registers: [register],
});

export const chatbotBotTurnDuration = new Histogram({
  name: 'chatbot_bot_turn_duration_seconds',
  help: 'Bot turn latency (retrieval + tools + generation)',
  buckets: [0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const chatbotActiveSockets = new Gauge({
  name: 'chatbot_active_sockets',
  help: 'Open chatbot websockets',
  labelNames: ['kind'] as const,
  registers: [register],
});

// ── Exposition ───────────────────────────────────────────────────────────────

/** Prometheus text exposition for the `/metrics` endpoint. */
export function metricsText(): Promise<string> {
  return register.metrics();
}

export const metricsContentType = register.contentType;
