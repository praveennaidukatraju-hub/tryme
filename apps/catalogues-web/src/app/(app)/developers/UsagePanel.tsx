'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { C } from '@/components/tokens';
import { getApiUsage } from './api';

// "not a merchant account" / "merchant account inactive" — thrown by requireMerchant
// (apps/api/src/plugins/portal-auth.ts) when the logged-in user has no merchants row.
function isMerchantGateError(err: unknown): boolean {
  return err instanceof Error && /merchant account/i.test(err.message);
}

const STATUS_COLOR: Record<string, string> = {
  COMPLETED: C.mint,
  QUEUED: C.mid,
  RUNNING: C.amber,
  FAILED: C.pink,
};

const fmtDate = (s: string) =>
  new Date(s).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export function UsagePanel() {
  const usageQuery = useQuery({ queryKey: ['dev-api-usage'], queryFn: getApiUsage });
  const rows = usageQuery.data?.usage ?? [];
  const merchantGated = isMerchantGateError(usageQuery.error);

  if (merchantGated) return null; // KeysPanel already shows the merchant-gate message above.

  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: 24,
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: C.text, margin: 0 }}>Recent Usage</h3>
        <p style={{ fontSize: 13, color: C.mid, margin: '4px 0 0' }}>
          Last 50 jobs created through the developer API.
        </p>
      </div>

      {usageQuery.isLoading ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: C.light, fontSize: 14 }}>
          Loading usage...
        </div>
      ) : usageQuery.isError ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: C.pink, fontSize: 14 }}>
          {(usageQuery.error as Error).message}
        </div>
      ) : rows.length === 0 ? (
        <div
          style={{
            padding: '40px 0',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div style={{ color: C.pink, opacity: 0.8 }}>
            <Activity size={36} />
          </div>
          <p style={{ fontSize: 14, color: C.light, margin: 0 }}>
            No API jobs yet. Usage will show up here after your first call to{' '}
            <code>/v1/dev/tryon</code>.
          </p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto', width: '100%', borderRadius: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 500 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1.2fr 0.7fr 1.3fr',
                padding: '10px 14px',
                borderBottom: `1px solid ${C.border}`,
                fontSize: 12,
                fontWeight: 600,
                color: C.mid,
                textTransform: 'uppercase',
                letterSpacing: '0.4px',
              }}
            >
              <span>Status</span>
              <span>Key</span>
              <span>Credits</span>
              <span>Created</span>
            </div>
            {rows.map((r) => (
              <div
                key={r.jobId}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1.2fr 0.7fr 1.3fr',
                  padding: '12px 14px',
                  borderBottom: `1px solid ${C.border}`,
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '3px 10px',
                      borderRadius: 20,
                      fontSize: 12,
                      fontWeight: 600,
                      color: STATUS_COLOR[r.status] ?? C.mid,
                      border: `1px solid ${STATUS_COLOR[r.status] ?? C.border2}`,
                    }}
                  >
                    {r.status}
                  </span>
                </span>
                <span
                  style={{
                    fontSize: 13,
                    color: C.text,
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {r.keyLabel}{' '}
                  <span
                    style={{
                      color: C.mid,
                      fontSize: 12,
                      fontFamily:
                        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                    }}
                  >
                    ({r.keyPrefix}…)
                  </span>
                </span>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: C.text,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {r.creditsCharged}
                </span>
                <span
                  style={{
                    fontSize: 12.5,
                    color: C.mid,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {fmtDate(r.createdAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
