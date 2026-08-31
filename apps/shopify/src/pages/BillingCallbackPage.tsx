import { Banner, BlockStack, Page, Spinner, Text } from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConfirmWithRetry } from '../hooks/useConfirmWithRetry';
import { apiFetch } from '../lib/api';

/**
 * Shopify sends the merchant here after they approve a one-time charge for a
 * credit pack (the `confirmationUrl` returned from `POST
 * /v1/shopify/billing/purchase`). Confirming is what actually grants the
 * credits they just paid for, so this page is the one place in the app
 * where a silent failure is least acceptable — there is no background
 * scheduler reconciling purchases, so a swallowed error here means the
 * merchant was charged and never finds out the credits didn't land.
 */
export default function BillingCallbackPage() {
  const navigate = useNavigate();
  const [declined, setDeclined] = useState(false);

  const confirm = useCallback(async () => {
    const purchase = new URLSearchParams(window.location.search).get('purchase') ?? '';
    return apiFetch<{ status: string; creditsGranted: number; creditBalance: number }>(
      `/v1/shopify/billing/purchase/confirm?purchase=${encodeURIComponent(purchase)}`,
    );
  }, []);

  const { error, run } = useConfirmWithRetry(confirm);

  useEffect(() => {
    void run().then((result) => {
      if (!result.ok) return; // reauth redirect in flight, or error state already set
      // A DECLINED purchase is a normal outcome, not a failure — the merchant
      // looked at the charge and said no. Sending them to the dashboard with
      // no comment would be confusing, but so would an error banner about a
      // charge that deliberately never happened.
      if (result.data.status === 'DECLINED' || result.data.status === 'EXPIRED') {
        setDeclined(true);
        return;
      }
      navigate('/', { replace: true });
    });
  }, [run, navigate]);

  if (declined) {
    return (
      <Page>
        <Banner
          title="No charge was made"
          tone="info"
          action={{ content: 'Back to credits', onAction: () => navigate('/pricing') }}
        >
          <Text as="p">
            You didn't approve the charge, so nothing was billed and no credits were added.
          </Text>
        </Banner>
      </Page>
    );
  }

  if (error) {
    return (
      <Page>
        <Banner
          title="We couldn't confirm your purchase"
          tone="critical"
          action={{ content: 'Try again', onAction: () => void run() }}
          secondaryAction={{ content: 'Go to dashboard', onAction: () => navigate('/') }}
        >
          <BlockStack gap="200">
            <Text as="p">
              You may have been charged, but we haven't been able to add the credits to your account
              yet. Retrying is safe — credits are only ever granted once per purchase.
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
      <Spinner accessibilityLabel="Confirming your purchase" size="large" />
    </Page>
  );
}
