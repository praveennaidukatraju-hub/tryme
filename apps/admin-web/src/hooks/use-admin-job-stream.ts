import { useEffect, useLayoutEffect, useRef } from 'react';
import { createSSEConnection } from '../lib/sse';

export interface AdminJobStatusEvent {
  jobId: string;
  userId: string;
  type: 'STATUS';
  status: string;
  resultKey?: string;
  workerId?: string;
  errorCode?: string;
}

/**
 * Subscribes to the admin job event stream for the lifetime of the component.
 * Delivers real-time status transitions for all users' jobs.
 */
export function useAdminJobStream(onEvent: (evt: AdminJobStatusEvent) => void): void {
  const callbackRef = useRef(onEvent);
  useLayoutEffect(() => {
    callbackRef.current = onEvent;
  });

  useEffect(() => {
    const conn = createSSEConnection<AdminJobStatusEvent>('/admin/jobs/stream', (e) => {
      if (e.type === 'STATUS') callbackRef.current(e.data);
    });
    return () => conn.close();
  }, []);
}
