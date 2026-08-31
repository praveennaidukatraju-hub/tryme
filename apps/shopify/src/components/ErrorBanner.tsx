import { Banner } from '@shopify/polaris';
import type { ClassifiedError } from '../lib/errors';

/**
 * Renders a classified backend/network error consistently across the app —
 * tone and whether a Retry action makes sense both come from classifyError,
 * not from each call site guessing.
 */
export function ErrorBanner({
  error,
  onRetry,
  onDismiss,
  title,
}: {
  error: ClassifiedError | null;
  onRetry?: () => void;
  onDismiss?: () => void;
  title?: string;
}) {
  if (!error) return null;
  return (
    <Banner
      tone={error.tone}
      title={title}
      onDismiss={onDismiss}
      action={error.retryable && onRetry ? { content: 'Retry', onAction: onRetry } : undefined}
    >
      {error.message}
    </Banner>
  );
}
