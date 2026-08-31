import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  DatePicker,
  IndexTable,
  InlineGrid,
  InlineStack,
  OptionList,
  Page,
  Popover,
  Spinner,
  Text,
} from '@shopify/polaris';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart } from '../components/BarChart';
import { ChartTable } from '../components/ChartTable';
import { ErrorBanner } from '../components/ErrorBanner';
import { ANALYTICS_PRESETS, type AnalyticsPreset, resolvePreset } from '../lib/analyticsRange';
import { apiFetch } from '../lib/api';
import { type ClassifiedError, classifyError } from '../lib/errors';
import type { ShopifyAnalytics, ShopifyMe } from '../types';

// A headline number and its label. Deliberately no sparkline and no decoration
// — per the dataviz skill these are stat tiles, not charts.
function StatTile({ label, value, action }: { label: string; value: string; action?: ReactNode }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" tone="subdued" variant="bodySm">
          {label}
        </Text>
        <Text as="p" variant="heading2xl">
          {value}
        </Text>
        {action}
      </BlockStack>
    </Card>
  );
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default function AnalyticsPage() {
  const navigate = useNavigate();
  const [installedAt, setInstalledAt] = useState<Date | null>(null);
  const [preset, setPreset] = useState<AnalyticsPreset | 'custom'>('30d');
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [data, setData] = useState<ShopifyAnalytics | null>(null);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [month, setMonth] = useState({
    month: new Date().getMonth(),
    year: new Date().getFullYear(),
  });

  useEffect(() => {
    apiFetch<ShopifyMe>('/v1/shopify/me')
      .then((me) => {
        const installed = new Date(me.store.connectedSince);
        setInstalledAt(installed);
        setRange(resolvePreset('30d', installed));
      })
      .catch((err) => {
        setError(classifyError(err));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!range) return;
    setLoading(true);
    apiFetch<ShopifyAnalytics>(`/v1/shopify/analytics?from=${range.from}&to=${range.to}`)
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(classifyError(err)))
      .finally(() => setLoading(false));
  }, [range]);

  const choosePreset = useCallback(
    (selected: string[]) => {
      const next = selected[0] as AnalyticsPreset;
      setPreset(next);
      if (installedAt) setRange(resolvePreset(next, installedAt));
      setPickerOpen(false);
    },
    [installedAt],
  );

  const label =
    preset === 'custom'
      ? range
        ? `${range.from} – ${range.to}`
        : 'Select dates'
      : (ANALYTICS_PRESETS.find((p) => p.id === preset)?.label ?? 'Select dates');

  return (
    <Page title="Analytics">
      <BlockStack gap="400">
        <ErrorBanner
          error={error}
          onRetry={() => window.location.reload()}
          onDismiss={() => setError(null)}
        />

        <InlineStack align="start">
          <Popover
            active={pickerOpen}
            activator={<Button onClick={() => setPickerOpen((o) => !o)}>{label}</Button>}
            onClose={() => setPickerOpen(false)}
          >
            <Box padding="200">
              <InlineStack gap="400" align="start" blockAlign="start">
                <OptionList
                  options={ANALYTICS_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                  selected={[preset]}
                  onChange={choosePreset}
                />
                <DatePicker
                  month={month.month}
                  year={month.year}
                  onMonthChange={(m, y) => setMonth({ month: m, year: y })}
                  allowRange
                  selected={
                    range ? { start: new Date(range.from), end: new Date(range.to) } : undefined
                  }
                  onChange={({ start, end }) => {
                    setPreset('custom');
                    setRange({
                      from: start.toISOString().slice(0, 10),
                      to: end.toISOString().slice(0, 10),
                    });
                    setPickerOpen(false);
                  }}
                />
              </InlineStack>
            </Box>
          </Popover>
        </InlineStack>

        {loading && !data ? (
          <Spinner accessibilityLabel="Loading analytics" />
        ) : data ? (
          <>
            <InlineGrid columns={{ xs: 1, sm: 2, lg: 3 }} gap="400">
              <StatTile label="Try-ons" value={String(data.cards.tryOns)} />
              <StatTile label="Unique shoppers" value={String(data.cards.uniqueShoppers)} />
              <StatTile label="Added to cart" value={String(data.cards.addedToCart)} />
              {/* Never "Conversion rate" — a merchant reads that as purchased. */}
              <StatTile label="Add-to-cart rate" value={pct(data.cards.addToCartRate)} />
              {/* The list itself lives on Settings -> Data, where the GDPR
                  delete controls are. Duplicating it here would mean two places
                  to erase a shopper from, so this links across instead. */}
              <StatTile
                label="Emails captured"
                value={String(data.cards.emailsCaptured)}
                action={
                  <Button variant="plain" onClick={() => navigate('/settings')}>
                    View list
                  </Button>
                }
              />
              {/* A soft gate — most shoppers asked for an email submit it and
                  get their try-on anyway, so this is deliberately not part of
                  "Turned away" (which only counts genuinely lost traffic). */}
              <StatTile
                label="Asked for an email"
                value={String(data.cards.turnedAway.emailGate)}
              />
              <StatTile label="Turned away" value={String(data.cards.turnedAway.total)} />
            </InlineGrid>

            {data.cards.turnedAway.total > 0 && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Shoppers you turned away
                  </Text>
                  <InlineStack gap="200">
                    <Badge>{`Store daily cap: ${data.cards.turnedAway.storeCap}`}</Badge>
                    <Badge>{`Per-shopper cap: ${data.cards.turnedAway.shopperCap}`}</Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    These shoppers wanted a try-on and did not get one. Adjust your limits in
                    Settings. (Shoppers asked for an email are shown separately above — most of them
                    submit it and get their try-on anyway.)
                  </Text>
                </BlockStack>
              </Card>
            )}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Try-ons per day
                </Text>
                <BarChart
                  orientation="vertical"
                  data={data.daily.map((d) => ({ label: d.day, value: d.tryOns }))}
                />
                <ChartTable
                  id="daily-table"
                  columns={['Day', 'Try-ons']}
                  rows={data.daily.map((d) => ({ label: d.day, value: String(d.tryOns) }))}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Shopper journey
                </Text>
                <BarChart
                  orientation="horizontal"
                  data={[
                    { label: 'Clicked try-on', value: data.funnel.buttonClick },
                    { label: 'Uploaded a photo', value: data.funnel.upload },
                    { label: 'Generated a try-on', value: data.funnel.tryOn },
                    { label: 'Viewed the result', value: data.funnel.resultView },
                    { label: 'Added to cart', value: data.funnel.addToCart },
                  ]}
                />
                <Text as="p" tone="subdued" variant="bodySm">
                  Steps 1, 2, 4 and 5 are measured in the shopper&apos;s browser and can be blocked.
                  Try-ons are measured on our servers and are exact — so a later step can show more
                  shoppers than an earlier one.
                </Text>
                {data.funnel.unattributed > 0 && (
                  <Text as="p" tone="subdued" variant="bodySm">
                    {`${data.funnel.unattributed} try-ons came from an older widget version and could not be matched to a shopper, so they are not in this chart.`}
                  </Text>
                )}
                <ChartTable
                  id="funnel-table"
                  columns={['Step', 'Shoppers']}
                  rows={[
                    { label: 'Clicked try-on', value: String(data.funnel.buttonClick) },
                    { label: 'Uploaded a photo', value: String(data.funnel.upload) },
                    { label: 'Generated a try-on', value: String(data.funnel.tryOn) },
                    { label: 'Viewed the result', value: String(data.funnel.resultView) },
                    { label: 'Added to cart', value: String(data.funnel.addToCart) },
                  ]}
                />
              </BlockStack>
            </Card>

            <Card padding="0">
              <Box padding="400">
                <Text as="h2" variant="headingMd">
                  Products
                </Text>
              </Box>
              <IndexTable
                resourceName={{ singular: 'product', plural: 'products' }}
                itemCount={data.products.length}
                selectable={false}
                headings={[
                  { title: 'Product' },
                  { title: 'Try-ons' },
                  { title: 'Shoppers' },
                  { title: 'Added to cart' },
                  { title: 'Add-to-cart rate' },
                ]}
              >
                {data.products.map((p, i) => (
                  <IndexTable.Row
                    id={String(p.shopifyProductId)}
                    key={p.shopifyProductId}
                    position={i}
                  >
                    <IndexTable.Cell>{p.title ?? `#${p.shopifyProductId}`}</IndexTable.Cell>
                    <IndexTable.Cell>{p.tryOns}</IndexTable.Cell>
                    <IndexTable.Cell>{p.uniqueShoppers}</IndexTable.Cell>
                    <IndexTable.Cell>{p.addedToCart}</IndexTable.Cell>
                    <IndexTable.Cell>{pct(p.addToCartRate)}</IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>
          </>
        ) : null}
      </BlockStack>
    </Page>
  );
}
