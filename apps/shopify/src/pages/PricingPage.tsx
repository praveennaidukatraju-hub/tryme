import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Icon,
  InlineGrid,
  InlineStack,
  Page,
  Select,
  SkeletonBodyText,
  SkeletonPage,
  Text,
  TextField,
} from '@shopify/polaris';
import { CheckIcon } from '@shopify/polaris-icons';
import { useCallback, useEffect, useState } from 'react';
import { BalanceCard } from '../components/BalanceCard';
import { ErrorBanner } from '../components/ErrorBanner';
import { apiFetch, navigateTopLevel } from '../lib/api';
import { type ClassifiedError, classifyError } from '../lib/errors';
import { PACK_DISPLAY, SHARED_FEATURE_BULLETS, tryOnsFromCredits } from '../lib/packs';
import type { ShopifyMe } from '../types';
import { LowCreditsBanner } from './DashboardPage';

export default function PricingPage() {
  const [me, setMe] = useState<ShopifyMe | null>(null);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refillPack, setRefillPack] = useState('pack_25');
  const [refillCap, setRefillCap] = useState('100');
  // Percent of the selected pack's credits, not a raw credit count — matches
  // the server's own default (defaultTriggerCredits, autorefill.ts: 20% of
  // pack.credits) so leaving this untouched reproduces exactly what enrolling
  // with no triggerCredits at all already did.
  const [refillThresholdPct, setRefillThresholdPct] = useState('20');
  const [enrolling, setEnrolling] = useState(false);
  const [newCap, setNewCap] = useState('');
  const [raisingCap, setRaisingCap] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch<ShopifyMe>('/v1/shopify/me')
      .then(setMe)
      .catch((err) => setError(classifyError(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function enableAutorefill() {
    setEnrolling(true);
    setError(null);
    try {
      const selectedPack = PACK_DISPLAY.find((p) => p.id === refillPack);
      const triggerCredits = selectedPack
        ? Math.round((selectedPack.credits * Number.parseInt(refillThresholdPct, 10)) / 100)
        : undefined;
      const { confirmationUrl } = await apiFetch<{ confirmationUrl: string }>(
        '/v1/shopify/billing/autorefill',
        {
          method: 'POST',
          body: JSON.stringify({
            packId: refillPack,
            cappedAmountUsd: Number.parseFloat(refillCap),
            ...(triggerCredits ? { triggerCredits } : {}),
          }),
        },
      );
      navigateTopLevel(confirmationUrl);
    } catch (err) {
      setError(classifyError(err));
      setEnrolling(false);
    }
  }

  async function turnOffAutorefill() {
    setError(null);
    try {
      await apiFetch('/v1/shopify/billing/autorefill', { method: 'DELETE' });
    } catch (err) {
      setError(classifyError(err));
      return;
    }
    // Turning off already succeeded at this point — a failure here is only a
    // stale-balance-display problem, not a "turn off failed" one, so it gets
    // its own message rather than being folded into the DELETE's error path.
    try {
      setMe(await apiFetch<ShopifyMe>('/v1/shopify/me'));
    } catch (err) {
      const classified = classifyError(err);
      setError({
        ...classified,
        message: `Auto-refill is now off, but we couldn't refresh this page: ${classified.message}`,
      });
    }
  }

  async function raiseAutorefillCap() {
    setRaisingCap(true);
    setError(null);
    try {
      const { confirmationUrl } = await apiFetch<{ confirmationUrl: string }>(
        '/v1/shopify/billing/autorefill/raise-cap',
        { method: 'POST', body: JSON.stringify({ cappedAmountUsd: Number.parseFloat(newCap) }) },
      );
      // Same top-level-navigation requirement as buyPack/enableAutorefill —
      // Shopify's approval page is outside the embedded app's origin.
      navigateTopLevel(confirmationUrl);
    } catch (err) {
      setError(classifyError(err));
      setRaisingCap(false);
    }
  }

  if (loading) {
    return (
      <SkeletonPage primaryAction>
        <SkeletonBodyText />
      </SkeletonPage>
    );
  }

  const autorefillStatus = me?.autorefill.status ?? null;
  // A CANCELLED or DECLINED subscription is dead at Shopify's end — nothing
  // further happens to it, so the merchant needs the enrolment form back, not
  // a dead-end screen that only shows a "Turn off" button for a subscription
  // that's already off. `me.autorefill.enabled` (server-side) stays true for
  // these two statuses on purpose — it means "there's a status to show", not
  // "there's a live subscription" — so this page derives its own narrower
  // "still live at Shopify" flag instead of reusing that field.
  const isLive =
    autorefillStatus === 'PENDING' ||
    autorefillStatus === 'ACTIVE' ||
    autorefillStatus === 'CAP_REACHED';
  const canEnrol = !isLive;

  return (
    <Page title="Credits" subtitle="Buy credits once. They never expire.">
      <BlockStack gap="400">
        <ErrorBanner error={error} onRetry={load} />

        {me && <LowCreditsBanner me={me} hideCapReached />}

        <BalanceCard me={me} />

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Auto-refill
              </Text>
              {autorefillStatus === 'ACTIVE' && <Badge tone="success">On</Badge>}
              {autorefillStatus === 'PENDING' && <Badge tone="attention">Awaiting approval</Badge>}
              {autorefillStatus === 'CAP_REACHED' && <Badge tone="critical">Limit reached</Badge>}
              {autorefillStatus === 'CANCELLED' && <Badge>Cancelled</Badge>}
              {autorefillStatus === 'DECLINED' && <Badge tone="attention">Declined</Badge>}
            </InlineStack>

            <Text as="p" tone="subdued">
              Never run out. When your balance drops below your chosen threshold we buy your chosen
              pack automatically — and auto-refill packs include 10% extra credits.
            </Text>

            {/* Called out in its own block, not folded into the paragraph above —
                these are the exact numbers governing when and how much the
                merchant gets charged, so they should be scannable at a glance
                rather than read out of a sentence. */}
            {isLive && me && (
              <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                <BlockStack gap="150">
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">
                      Refill pack
                    </Text>
                    <Text as="span" fontWeight="semibold">
                      {PACK_DISPLAY.find((p) => p.id === me.autorefill.packId)?.label ??
                        me.autorefill.packId}
                    </Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">
                      Refills when balance drops below
                    </Text>
                    <Text as="span" fontWeight="semibold">
                      {me.autorefill.triggerCredits != null
                        ? `${me.autorefill.triggerCredits.toLocaleString()} credits`
                        : '—'}
                    </Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued">
                      This cycle
                    </Text>
                    {/* Both figures come from Shopify, which is authoritative
                        for the ceiling — a merchant can change it from the
                        Shopify admin without this app ever seeing the click.
                        Showing spend against it beats showing the ceiling
                        alone: the limit only matters relative to how close
                        they are to it. */}
                    <Text as="span" fontWeight="semibold">
                      {me.autorefill.cappedAmountUsdCents != null
                        ? me.autorefill.balanceUsedUsdCents != null
                          ? `$${(me.autorefill.balanceUsedUsdCents / 100).toFixed(2)} of $${(me.autorefill.cappedAmountUsdCents / 100).toFixed(2)} limit`
                          : `$${(me.autorefill.cappedAmountUsdCents / 100).toFixed(2)} limit`
                        : '—'}
                    </Text>
                  </InlineStack>
                </BlockStack>
              </Box>
            )}

            {autorefillStatus === 'CANCELLED' && (
              <Banner tone="warning" title="Auto-refill was cancelled">
                <Text as="p">
                  It was cancelled from Shopify's billing screen or is no longer active. Turn it
                  back on below whenever you're ready.
                </Text>
              </Banner>
            )}

            {autorefillStatus === 'DECLINED' && (
              <Banner tone="warning" title="Auto-refill authorization was declined">
                <Text as="p">
                  You didn't approve the charge authorization, so auto-refill was never turned on.
                  You can try again below.
                </Text>
              </Banner>
            )}

            {canEnrol && (
              <BlockStack gap="200">
                <Select
                  label="Refill with"
                  options={PACK_DISPLAY.map((p) => ({
                    label: `${p.label} — $${p.priceUsd} (${tryOnsFromCredits(p.autorefillCredits).toLocaleString()} try-ons)`,
                    value: p.id,
                  }))}
                  value={refillPack}
                  onChange={setRefillPack}
                />
                <Select
                  label="Refill when balance drops below"
                  options={['10', '20', '30'].map((pct) => {
                    const pack = PACK_DISPLAY.find((p) => p.id === refillPack);
                    const credits = pack ? Math.round((pack.credits * Number(pct)) / 100) : 0;
                    return { label: `${pct}% (${credits.toLocaleString()} credits)`, value: pct };
                  })}
                  value={refillThresholdPct}
                  onChange={setRefillThresholdPct}
                  helpText="20% is the default we use if you don't change this — lower means fewer, bigger refills; higher means smaller top-ups more often."
                />
                <TextField
                  label="Monthly limit"
                  type="number"
                  prefix="$"
                  value={refillCap}
                  onChange={setRefillCap}
                  helpText="The most we can charge you in a 30-day period. You approve this once; refills after that are automatic. You can change or cancel it any time."
                  autoComplete="off"
                />
                <Button variant="primary" loading={enrolling} onClick={enableAutorefill}>
                  Turn on auto-refill
                </Button>
              </BlockStack>
            )}

            {autorefillStatus === 'CAP_REACHED' && me && (
              <Banner tone="critical" title="Auto-refill has stopped">
                <BlockStack gap="200">
                  <Text as="p">
                    You've reached your $
                    {((me.autorefill.cappedAmountUsdCents ?? 0) / 100).toFixed(2)} monthly limit.
                    Raise it to resume automatic refills — Shopify will ask you to approve the new
                    limit.
                  </Text>
                  <InlineStack gap="200" blockAlign="end">
                    <TextField
                      label="New monthly limit"
                      labelHidden
                      type="number"
                      prefix="$"
                      value={newCap}
                      onChange={setNewCap}
                      placeholder={((me.autorefill.cappedAmountUsdCents ?? 0) / 100).toFixed(0)}
                      autoComplete="off"
                    />
                    <Button loading={raisingCap} disabled={!newCap} onClick={raiseAutorefillCap}>
                      Raise limit
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Banner>
            )}

            {isLive && (
              <Button tone="critical" variant="plain" onClick={turnOffAutorefill}>
                Turn off auto-refill
              </Button>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Included with every pack
            </Text>
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="200">
              {SHARED_FEATURE_BULLETS.map((label) => (
                <InlineStack key={label} gap="200" blockAlign="center" wrap={false}>
                  <Box width="20px">
                    <Icon source={CheckIcon} tone="success" />
                  </Box>
                  <Text as="span">{label}</Text>
                </InlineStack>
              ))}
            </InlineGrid>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
