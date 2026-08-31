'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SSEState } from '@/lib/sse';
import { createSSEConnection } from '@/lib/sse';

export interface JobStatusEvent {
  jobId: string;
  userId: string;
  type: 'STATUS';
  status: string;
  resultKey?: string;
  workerId?: string;
  errorCode?: string;
}

type Subscriber = (evt: JobStatusEvent) => void;

interface JobStreamContextValue {
  subscribe: (fn: Subscriber) => () => void;
  sseState: SSEState;
}

const JobStreamContext = createContext<JobStreamContextValue | null>(null);

export function JobStreamProvider({ children }: { children: React.ReactNode }) {
  const subscribers = useRef<Set<Subscriber>>(new Set());
  const [sseState, setSseState] = useState<SSEState>('connecting');

  useEffect(() => {
    const conn = createSSEConnection<JobStatusEvent>(
      '/v1/jobs/stream',
      (e) => {
        if (e.type === 'STATUS') {
          for (const fn of subscribers.current) fn(e.data);
        }
      },
      undefined,
      setSseState,
    );
    return () => conn.close();
  }, []);

  const subscribe = useCallback((fn: Subscriber) => {
    subscribers.current.add(fn);
    return () => subscribers.current.delete(fn);
  }, []);

  const contextValue = useMemo(() => ({ subscribe, sseState }), [subscribe, sseState]);

  return (
    <JobStreamContext.Provider value={contextValue}>
      {sseState === 'reconnecting' && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            bottom: 20,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 9999,
            background: 'rgba(20,20,20,0.88)',
            color: '#fff',
            borderRadius: 8,
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
            backdropFilter: 'blur(4px)',
            whiteSpace: 'nowrap',
          }}
        >
          <div
            className="av-spin"
            style={{
              width: 12,
              height: 12,
              border: '2px solid rgba(255,255,255,0.3)',
              borderTopColor: '#fff',
              borderRadius: '50%',
              flexShrink: 0,
            }}
          />
          Connection lost — reconnecting to live updates…
        </div>
      )}
      {children}
    </JobStreamContext.Provider>
  );
}

export function useJobStreamContext(): JobStreamContextValue {
  const ctx = useContext(JobStreamContext);
  if (!ctx) throw new Error('useJobStreamContext must be used inside JobStreamProvider');
  return ctx;
}
