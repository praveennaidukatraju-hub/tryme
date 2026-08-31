import { BlockStack, Modal, Text, TextField } from '@shopify/polaris';
import { useState } from 'react';
import { apiFetch } from '../lib/api';
import { type ClassifiedError, classifyError } from '../lib/errors';
import type { ShopifyEmailBonusClaimResponse, ShopifyMe } from '../types';
import { ErrorBanner } from './ErrorBanner';

// Dashboard-only popup, shown once until `settings.emailBonusClaimed` is set
// (DashboardPage gates rendering this on that flag). Prefills from
// `shopEmail` — auto-captured from `shop.email` at install — since the
// merchant is usually just confirming, not typing from scratch.
export function EmailBonusModal({
  me,
  onClaimed,
  onClose,
}: {
  me: ShopifyMe;
  onClaimed: (result: ShopifyEmailBonusClaimResponse) => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState(me.store.shopEmail ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ClassifiedError | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiFetch<ShopifyEmailBonusClaimResponse>(
        '/v1/shopify/onboarding/claim-email-bonus',
        { method: 'POST', body: JSON.stringify({ email }) },
      );
      onClaimed(result);
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      title="Get free credits"
      onClose={onClose}
      primaryAction={{ content: 'Claim credits', onAction: submit, loading: submitting }}
      secondaryActions={[{ content: 'Maybe later', onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          <ErrorBanner error={error} />
          <Text as="p">
            Confirm your contact email and we'll add bonus credits to your balance — no purchase
            required.
          </Text>
          <TextField
            label="Contact email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
