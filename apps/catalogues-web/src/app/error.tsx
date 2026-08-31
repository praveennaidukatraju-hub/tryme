'use client';
import { useEffect } from 'react';
import { C } from '@/components/tokens';
import { ErrorState } from '@/components/ui/error-state';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  useEffect(() => {
    // Surface for whatever monitoring we wire later; keeps it out of silent void.
    console.error(error);
  }, [error]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', background: C.bg }}>
      <ErrorState
        title="Something went wrong"
        message="An unexpected error occurred. You can try again, or head back to the studio."
        onRetry={reset}
        homeHref="/studio"
        homeLabel="Go to Studio"
      />
    </div>
  );
}
