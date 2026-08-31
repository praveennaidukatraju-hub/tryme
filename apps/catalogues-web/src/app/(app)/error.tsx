'use client';
import { useEffect } from 'react';
import { ErrorState } from '@/components/ui/error-state';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <ErrorState
      title="Something went wrong"
      message="We couldn't load this page. Try again, or go back to your catalogs."
      onRetry={reset}
      homeHref="/catalogs"
      homeLabel="Back to Catalogs"
    />
  );
}
