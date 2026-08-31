import type { AdminHeldJobsReleaseResponse, AdminHeldJobsResponse } from '@tryme/types';
import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage, apiFetch } from '../lib/data';

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export default function HeldBatchesPage({ toast }: Props) {
  const [data, setData] = useState<AdminHeldJobsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isReleasing, setIsReleasing] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setData(await apiFetch<AdminHeldJobsResponse>('/admin/held-jobs'));
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to load held batches',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const release = async () => {
    setIsReleasing(true);
    try {
      const { released, remaining } = await apiFetch<AdminHeldJobsReleaseResponse>(
        '/admin/held-jobs/release',
        { method: 'POST' },
      );
      toast({
        title:
          remaining > 0
            ? `Released ${released} job${released === 1 ? '' : 's'} — ${remaining} still held, click Release again`
            : `Released ${released} job${released === 1 ? '' : 's'} to the GPU queue`,
      });
      await load();
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Release failed',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setIsReleasing(false);
    }
  };

  const total = data?.total ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Held Batches</h1>
          <p className="lede">
            Bulk flat-image uploads waiting for GPU time. Releasing sends every merchant&apos;s
            backlog to the low-priority queue at once.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          disabled={isReleasing || total === 0}
          onClick={() => void release()}
        >
          {isReleasing ? 'Releasing…' : `Release all (${total})`}
        </button>
      </div>

      {isLoading ? (
        <p style={{ color: 'var(--muted)', padding: '24px 0' }}>Loading...</p>
      ) : total === 0 ? (
        <p style={{ color: 'var(--muted)', padding: '24px 0' }}>Nothing is held right now.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Held images</th>
                <th>Oldest upload</th>
              </tr>
            </thead>
            <tbody>
              {data?.byUser.map((row) => (
                <tr key={row.userId ?? 'unknown'}>
                  <td>{row.email ?? '(unknown)'}</td>
                  <td>{row.count}</td>
                  <td>{new Date(row.oldestCreatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
