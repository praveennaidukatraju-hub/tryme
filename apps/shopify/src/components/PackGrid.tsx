import { Badge, BlockStack, Button, Card, InlineGrid, InlineStack, Text } from '@shopify/polaris';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { apiFetch, navigateTopLevel } from '../lib/api';
import { type ClassifiedError, classifyError } from '../lib/errors';
import { PACK_DISPLAY } from '../lib/packs';

// Shared between DashboardPage and PricingPage — same pattern as
// DashboardPage's own LowCreditsBanner: one definition, imported wherever the
// buy-a-pack flow needs to render. `onError` bubbles a failed purchase up to
// whichever page-level Banner the caller already has, instead of duplicating
// one here.
//
// `leadingCard` renders as an extra tile ahead of the paid packs, same grid,
// same card sizing — currently the Dashboard's free-credits-for-email offer,
// but kept generic rather than importing that concern directly here.
export function PackGrid({
  onError,
  leadingCard,
}: {
  onError?: (error: ClassifiedError) => void;
  leadingCard?: ReactNode;
}) {
  const [buying, setBuying] = useState<string | null>(null);

  async function buyPack(packId: string) {
    setBuying(packId);
    try {
      const { confirmationUrl } = await apiFetch<{ purchaseId: string; confirmationUrl: string }>(
        '/v1/shopify/billing/purchase',
        { method: 'POST', body: JSON.stringify({ packId }) },
      );
      // Shopify's approval page is outside the embedded app's origin, so this
      // must be a top-level navigation — an iframe navigation is blocked.
      navigateTopLevel(confirmationUrl);
    } catch (err) {
      onError?.(classifyError(err));
      setBuying(null);
    }
  }

  return (
    <InlineGrid columns={{ xs: 1, sm: 2, lg: leadingCard ? 5 : 4 }} gap="400">
      {leadingCard}
      {PACK_DISPLAY.map((pack) => (
        <Card key={pack.id}>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                {pack.label}
              </Text>
              {pack.bestValue && <Badge tone="success">Best value</Badge>}
            </InlineStack>

            <Text as="p" variant="heading2xl">
              ${pack.priceUsd}
            </Text>

            <BlockStack gap="100">
              <Text as="p">{pack.tryOns.toLocaleString()} try-ons</Text>
              <Text as="p" tone="subdued">
                {pack.credits.toLocaleString()} credits · never expire
              </Text>
            </BlockStack>

            <Button
              variant="primary"
              loading={buying === pack.id}
              disabled={buying !== null}
              onClick={() => buyPack(pack.id)}
            >
              Buy credits
            </Button>
          </BlockStack>
        </Card>
      ))}
    </InlineGrid>
  );
}
