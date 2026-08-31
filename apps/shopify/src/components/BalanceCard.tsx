import { BlockStack, Card, Text } from '@shopify/polaris';
import { tryOnsFromCredits } from '../lib/packs';
import type { ShopifyMe } from '../types';

// Shared between DashboardPage and PricingPage — same share pattern as
// LowCreditsBanner and PackGrid.
export function BalanceCard({ me }: { me: ShopifyMe | null }) {
  const balance = me?.creditBalance ?? 0;

  return (
    <Card>
      <BlockStack gap="200">
        <Text as="p" tone="subdued">
          Current balance
        </Text>
        <Text as="p" variant="heading2xl">
          {balance.toLocaleString()} credits
        </Text>
        <Text as="p" tone="subdued">
          About {(me?.runway?.tryOnsRemaining ?? tryOnsFromCredits(balance)).toLocaleString()}{' '}
          try-ons remaining
          {me?.runway?.daysRemaining != null
            ? ` — roughly ${Math.max(1, Math.round(me.runway.daysRemaining))} days at your current rate`
            : ''}
        </Text>
      </BlockStack>
    </Card>
  );
}
