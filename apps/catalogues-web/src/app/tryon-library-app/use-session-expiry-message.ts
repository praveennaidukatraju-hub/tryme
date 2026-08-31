'use client';
import { CatalogAppSessionExpiredError } from './catalog-app-api';
import { useLoggedOut } from './logged-out-context';

/**
 * For imperative (try/catch) error handling in mutations/async handlers —
 * distinct from the useEffect-on-query.error pattern used by screens that
 * only read via useQuery. Triggers the session-expired logout side effect
 * and returns a message to show inline, so callers don't have to duplicate
 * the CatalogAppSessionExpiredError check at every catch site.
 */
export function useSessionExpiryMessage(): (err: unknown, fallback: string) => string {
  const onLoggedOut = useLoggedOut();
  return (err: unknown, fallback: string) => {
    if (err instanceof CatalogAppSessionExpiredError) {
      onLoggedOut();
      return err.message;
    }
    return err instanceof Error ? err.message : fallback;
  };
}
