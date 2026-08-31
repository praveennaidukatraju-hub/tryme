import { useLayoutEffect, useRef } from 'react';
import type { JobStatusEvent } from '@/components/job-stream-provider';
import { useJobStreamContext } from '@/components/job-stream-provider';

export type { JobStatusEvent };

/**
 * Subscribes to the shared user-level job event stream.
 * A single SSE connection is maintained by JobStreamProvider at the app layout;
 * this hook just registers/unregisters a callback — no new connection is opened.
 */
export function useJobStream(onEvent: (evt: JobStatusEvent) => void): void {
  const { subscribe } = useJobStreamContext();
  const callbackRef = useRef(onEvent);
  useLayoutEffect(() => {
    callbackRef.current = onEvent;
  });

  useLayoutEffect(() => {
    return subscribe((evt) => callbackRef.current(evt));
  }, [subscribe]);
}
