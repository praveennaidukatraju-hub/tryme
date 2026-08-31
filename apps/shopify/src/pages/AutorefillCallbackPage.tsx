import { Banner, BlockStack, Page, Spinner, Text } from '@shopify/polaris';
import { useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConfirmWithRetry } from '../hooks/useConfirmWithRetry';
import { apiFetch } from '../lib/api';

// Shopify sends the merchant here after they approve the auto-refill charge
// authorization — same "money already committed at Shopify" situation as
// BillingCallbackPage, so it shares that page's retry-with-backoff and
// reauth-aware handling via useConfirmWithRetry rather than a single-attempt
// confirm that gives up on the first blip.
export default function AutorefillCallbackPage() {
  const navigate = useNavigate();

  const confirm = useCallback(() => apiFetch('/v1/shopify/billing/autorefill/confirm'), []);
  const { error, run } = useConfirmWithRetry(confirm);

  useEffect(() => {
    void run().then((result) => {
      if (!result.ok) return; // reauth redirect in flight, or error state already set
      navigate('/pricing', { replace: true });
    });
  }, [run, navigate]);

  if (error) {
    return (
      <Page>
        <Banner
          title="We couldn't confirm auto-refill"
          tone="critical"
          action={{ content: 'Try again', onAction: () => void run() }}
          secondaryAction={{ content: 'Back to credits', onAction: () => navigate('/pricing') }}
        >
          <BlockStack gap="200">
            <Text as="p">
              Auto-refill may have been authorized at Shopify, but we haven't been able to confirm
              it here yet. Retrying is safe.
            </Text>
            <Text as="p" tone="subdued">
              {error.message}
            </Text>
          </BlockStack>
        </Banner>
      </Page>
    );
  }
  return (
    <Page>
      <Spinner accessibilityLabel="Confirming auto-refill" size="large" />
    </Page>
  );
}
