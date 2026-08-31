import {
  Badge,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Page,
  Select,
  SkeletonPage,
  Tabs,
  Text,
  Toast,
} from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { apiFetch, apiFetchResponse } from '../lib/api';
import { type ClassifiedError, classifyError } from '../lib/errors';
import type {
  ShopifyMe,
  ShopifyShopperListItem,
  ShopifyStoreLimits,
  ShopifyStoreRetention,
} from '../types';

const OFF = 'off';

// Mirrors the option sets in packages/types/src/widget.ts. Values outside these
// sets are rejected by the API with a 400.
const STORE_DAILY_CAP_OPTIONS = [50, 100, 250, 500, 1000, 2500, 5000];
const PER_SHOPPER_CAP_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const EMAIL_AFTER_N_OPTIONS = [0, 1, 2, 3, 5];

// The value the dropdown SHOWS when a merchant switches a limit on. It is not
// an enforced default: an absent setting means Off, so nothing changes for a
// store whose merchant never opens this page.
const PRESELECTED = { storeDailyCap: 250, perShopperCap: 5, emailAfterNTryOns: 2 };

function numericOptions(values: number[], offLabel: string, format: (n: number) => string) {
  return [
    { label: offLabel, value: OFF },
    ...values.map((n) => ({ label: format(n), value: String(n) })),
  ];
}

/**
 * Parse a Select option value into the numeric limit to persist.
 *
 * `Number.isFinite` rather than a `||` fallback: `0` is a legitimate option
 * ("Before the first try-on") and is falsy, so `Number(raw) || preselected`
 * silently replaced it with the preselected value.
 */
export function resolveNumericLimit(raw: string, preselected: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : preselected;
}

export default function SettingsPage() {
  const [selectedTab, setSelectedTab] = useState(0);
  const [limits, setLimits] = useState<ShopifyStoreLimits>({});
  const [retention, setRetention] = useState<ShopifyStoreRetention>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [shoppers, setShoppers] = useState<ShopifyShopperListItem[] | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch<ShopifyMe>('/v1/shopify/me')
      .then((res) => {
        setLimits(res.store.settings.limits ?? {});
        setRetention(res.store.settings.retention ?? {});
        setLoading(false);
      })
      .catch((err) => {
        setError(classifyError(err));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (selectedTab !== 1 || shoppers) return;
    apiFetch<{ items: ShopifyShopperListItem[] }>('/v1/shopify/shoppers')
      .then((res) => setShoppers(res.items))
      .catch((err) => {
        setError(classifyError(err));
        // Without this the list stays null and IndexTable's `loading={!shoppers}`
        // spins forever behind the error banner. An empty list is the honest
        // rendering: we have nothing to show, and the banner says why.
        setShoppers([]);
      });
  }, [selectedTab, shoppers]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/v1/shopify/settings', {
        method: 'PATCH',
        body: JSON.stringify({ limits, retention }),
      });
      setToastMessage('Limits saved.');
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setSaving(false);
    }
  }

  /**
   * Resolve a Select value into the numeric limit to store.
   *
   * Pure and exported so the `0` case stays pinned by the comment below: `0` is
   * a real, selectable option ("Before the first try-on"), and a `||` fallback
   * would silently discard it because `0` is falsy — a merchant asking for the
   * email gate up front would have been saved as "after 2 try-ons" instead.
   * `preselected` is only the parse-failure fallback, which should never fire
   * since `raw` always comes from one of the rendered option values.
   */
  function setNumeric(key: keyof ShopifyStoreLimits, raw: string, preselected: number) {
    setLimits((prev) => ({
      ...prev,
      [key]: raw === OFF ? null : resolveNumericLimit(raw, preselected),
    }));
  }

  async function exportCsv() {
    // Not a plain <a href>: this SPA is served from a different origin than the
    // API in production, and /v1/shopify/shoppers.csv is behind
    // requireShopifySession, which needs the App Bridge bearer token that a
    // link navigation cannot carry. Fetch it authenticated, then hand the
    // browser a blob URL to download.
    setExporting(true);
    setError(null);
    try {
      const res = await apiFetchResponse('/v1/shopify/shoppers.csv');
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = 'shoppers.csv';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setExporting(false);
    }
  }

  if (loading) return <SkeletonPage title="Settings" />;

  const tabs = [
    { id: 'limits', content: 'Limits' },
    { id: 'data', content: 'Data' },
  ];

  return (
    <Page title="Settings">
      <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
        <BlockStack gap="400">
          <ErrorBanner error={error} onRetry={load} onDismiss={() => setError(null)} />

          {selectedTab === 0 && (
            <>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Store daily limit
                  </Text>
                  <Text as="p" tone="subdued">
                    The hard ceiling. Once this many try-ons have run today, the widget stops
                    generating until tomorrow — no matter who is asking. This is the only limit that
                    cannot be worked around from a browser.
                  </Text>
                  <Select
                    label="Try-ons per day"
                    options={numericOptions(
                      STORE_DAILY_CAP_OPTIONS,
                      'No limit',
                      (n) => `${n} per day`,
                    )}
                    value={limits.storeDailyCap == null ? OFF : String(limits.storeDailyCap)}
                    onChange={(v) => setNumeric('storeDailyCap', v, PRESELECTED.storeDailyCap)}
                  />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Per-shopper limit
                  </Text>
                  <Text as="p" tone="subdued">
                    Reduces casual overuse by one shopper. Treat it as friction, not as a spend
                    guarantee — a shopper who clears their browser storage gets a fresh allowance.
                    Set a store daily limit as well if you want a hard ceiling.
                  </Text>
                  <Select
                    label="Try-ons per shopper"
                    options={numericOptions(PER_SHOPPER_CAP_OPTIONS, 'No limit', (n) => String(n))}
                    value={limits.perShopperCap == null ? OFF : String(limits.perShopperCap)}
                    onChange={(v) => setNumeric('perShopperCap', v, PRESELECTED.perShopperCap)}
                  />
                  <Select
                    label="Resets every"
                    options={[
                      { label: 'Day', value: 'day' },
                      { label: 'Week', value: 'week' },
                      { label: 'Month', value: 'month' },
                    ]}
                    value={limits.perShopperWindow ?? 'week'}
                    onChange={(v) =>
                      setLimits((prev) => ({
                        ...prev,
                        perShopperWindow: v as 'day' | 'week' | 'month',
                      }))
                    }
                    disabled={limits.perShopperCap == null}
                  />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Ask for an email
                  </Text>
                  <Text as="p" tone="subdued">
                    After this many try-ons, shoppers are asked for their email before continuing.
                    Collected addresses appear under the Data tab.
                  </Text>
                  <Select
                    label="Ask after"
                    options={numericOptions(EMAIL_AFTER_N_OPTIONS, 'Never ask', (n) =>
                      n === 0 ? 'Before the first try-on' : `${n} try-on${n === 1 ? '' : 's'}`,
                    )}
                    value={
                      limits.emailAfterNTryOns == null ? OFF : String(limits.emailAfterNTryOns)
                    }
                    onChange={(v) =>
                      setNumeric('emailAfterNTryOns', v, PRESELECTED.emailAfterNTryOns)
                    }
                  />
                </BlockStack>
              </Card>

              <InlineStack align="end">
                <Button variant="primary" loading={saving} onClick={save}>
                  Save
                </Button>
              </InlineStack>
            </>
          )}

          {selectedTab === 1 && (
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Automatic deletion
                </Text>
                <Text as="p" tone="subdued">
                  Shopper photos and generated images are deleted from storage on this schedule.
                  Try-on records used for billing are always kept. Note that deleting shopper
                  records also resets their limits — set it longer than your per-shopper window.
                </Text>
                <Select
                  label="Delete shopper photos after"
                  options={numericOptions([7, 30, 90], 'Keep forever', (n) => `${n} days`)}
                  value={
                    retention.shopperPhotoDays == null ? OFF : String(retention.shopperPhotoDays)
                  }
                  onChange={(v) =>
                    setRetention((p) => ({
                      ...p,
                      shopperPhotoDays: v === OFF ? null : Number(v),
                    }))
                  }
                />
                <Select
                  label="Delete generated images after"
                  options={numericOptions([30, 90, 180, 365], 'Keep forever', (n) => `${n} days`)}
                  value={retention.resultDays == null ? OFF : String(retention.resultDays)}
                  onChange={(v) =>
                    setRetention((p) => ({ ...p, resultDays: v === OFF ? null : Number(v) }))
                  }
                />
                <Select
                  label="Delete shopper records after"
                  options={numericOptions([90, 180, 365], 'Keep forever', (n) => `${n} days`)}
                  value={
                    retention.shopperRecordDays == null ? OFF : String(retention.shopperRecordDays)
                  }
                  onChange={(v) =>
                    setRetention((p) => ({
                      ...p,
                      shopperRecordDays: v === OFF ? null : Number(v),
                    }))
                  }
                />
                <InlineStack align="end">
                  <Button variant="primary" loading={saving} onClick={save}>
                    Save
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          )}

          {selectedTab === 1 && (
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Collected emails
                  </Text>
                  <Button
                    onClick={exportCsv}
                    loading={exporting}
                    disabled={!shoppers || shoppers.length === 0}
                  >
                    Export CSV
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued">
                  Only shoppers who ticked the consent box have agreed to marketing. Check the
                  Consent column before adding an address to a mailing list.
                </Text>
                {shoppers && shoppers.length === 0 ? (
                  <EmptyState heading="No emails collected yet" image="">
                    <p>Turn on "Ask for an email" under Limits to start collecting.</p>
                  </EmptyState>
                ) : (
                  <IndexTable
                    resourceName={{ singular: 'shopper', plural: 'shoppers' }}
                    itemCount={shoppers?.length ?? 0}
                    selectable={false}
                    loading={!shoppers}
                    headings={[
                      { title: 'Email' },
                      { title: 'Consent' },
                      { title: 'First seen' },
                      { title: 'Try-ons' },
                    ]}
                  >
                    {(shoppers ?? []).map((s, index) => (
                      <IndexTable.Row id={s.id} key={s.id} position={index}>
                        <IndexTable.Cell>{s.email}</IndexTable.Cell>
                        <IndexTable.Cell>
                          <Badge tone={s.emailConsent ? 'success' : undefined}>
                            {s.emailConsent ? 'Consented' : 'No consent'}
                          </Badge>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {new Date(s.firstSeenAt).toLocaleDateString()}
                        </IndexTable.Cell>
                        <IndexTable.Cell>{String(s.tryOnCount)}</IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                )}
              </BlockStack>
            </Card>
          )}
        </BlockStack>
      </Tabs>

      {toastMessage && <Toast content={toastMessage} onDismiss={() => setToastMessage(null)} />}
    </Page>
  );
}
