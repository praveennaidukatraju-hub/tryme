import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icons';
import { apiErrorMessage, apiFetch } from '../../lib/data';

// Static, and deliberately not editable here: the price is the number sent to
// Shopify in the charge mutation. Config that changes what a merchant is
// *charged* is a different risk class from config that changes what they
// *receive*, so only the credit figures below are tunable.
const PACKS = [
  { id: 'pack_10', label: 'Starter', priceUsd: 10 },
  { id: 'pack_25', label: 'Growth', priceUsd: 25 },
  { id: 'pack_50', label: 'Pro', priceUsd: 50 },
  { id: 'pack_100', label: 'Enterprise', priceUsd: 100 },
] as const;

type PackId = (typeof PACKS)[number]['id'];
type PackCredits = Record<PackId, { credits: number; autorefillCredits: number }>;

const DEFAULT_PACK_CREDITS: PackCredits = {
  pack_10: { credits: 800, autorefillCredits: 880 },
  pack_25: { credits: 2250, autorefillCredits: 2475 },
  pack_50: { credits: 4800, autorefillCredits: 5280 },
  pack_100: { credits: 10000, autorefillCredits: 11000 },
};

function centsPerCredit(priceUsd: number, credits: number): string {
  if (!credits) return '—';
  return `${((priceUsd * 100) / credits).toFixed(2)}¢/credit`;
}

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export default function ShopifyCreditsTab({ toast }: Props) {
  const [shopifyTrialCredits, setShopifyTrialCredits] = useState(25);
  const [packCredits, setPackCredits] = useState<PackCredits>(DEFAULT_PACK_CREDITS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    type IncomingPackCredits = Partial<
      Record<PackId, Partial<{ credits: number; autorefillCredits: number }>>
    >;
    apiFetch<{
      shopify?: {
        trialCredits: number;
        packCredits?: IncomingPackCredits;
      };
    }>('/admin/config')
      .then((cfg) => {
        if (cfg.shopify) {
          setShopifyTrialCredits(cfg.shopify.trialCredits);
          if (cfg.shopify.packCredits) {
            setPackCredits((prev) => {
              const incoming = cfg.shopify?.packCredits;
              if (!incoming) return prev;
              return Object.fromEntries(
                PACKS.map((p) => [p.id, { ...prev[p.id], ...incoming[p.id] }]),
              ) as PackCredits;
            });
          }
        }
      })
      .catch((e) =>
        toast({
          kind: 'error',
          title: 'Failed to load Shopify credits',
          body: apiErrorMessage(e, 'Please try again.'),
        }),
      )
      .finally(() => setLoading(false));
  }, [toast]);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch('/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({
          shopify: { trialCredits: shopifyTrialCredits, packCredits },
        }),
      });
      toast({ title: 'Shopify credits saved' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to save Shopify credits',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card settings-card">
      <div className="card-head">
        <h3>
          <Icon.Coin /> Shopify
        </h3>
      </div>
      <div className="card-body">
        {loading ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            <div style={{ marginTop: 24, marginBottom: 8 }}>
              <div className="setting-lbl" style={{ marginBottom: 4 }}>
                Shopify Email Bonus
              </div>
              <div className="setting-desc" style={{ marginBottom: 12 }}>
                Credits granted once when a store owner confirms their contact email from the
                Dashboard popup — before the merchant buys any credit pack. This is the only free
                tier; nothing is granted automatically at install anymore.
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 12px',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r)',
                  background: 'var(--surface-2)',
                }}
              >
                <span className="setting-lbl">Trial Credits</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={99999}
                    style={{ width: 80, textAlign: 'right' }}
                    value={shopifyTrialCredits}
                    disabled={saving}
                    onChange={(e) => setShopifyTrialCredits(Number(e.target.value))}
                  />
                  <span style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    credits / store
                  </span>
                </div>
              </div>
              <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                {PACKS.map((pack) => (
                  <div
                    key={pack.id}
                    style={{
                      display: 'grid',
                      gap: 8,
                      padding: '10px 12px',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--r)',
                      background: 'var(--surface-2)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span className="setting-lbl">{pack.label}</span>
                      <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                        ${pack.priceUsd} · fixed
                      </span>
                    </div>

                    {(['credits', 'autorefillCredits'] as const).map((field) => (
                      <div key={field} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                          {field === 'credits' ? 'One-time purchase' : 'Auto-refill (+bonus)'}
                        </span>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            marginLeft: 'auto',
                          }}
                        >
                          <input
                            className="input"
                            type="number"
                            min={1}
                            max={1000000}
                            style={{ width: 100, textAlign: 'right' }}
                            value={packCredits[pack.id][field]}
                            disabled={saving}
                            onChange={(e) =>
                              setPackCredits((prev) => ({
                                ...prev,
                                [pack.id]: {
                                  ...prev[pack.id],
                                  [field]: Number(e.target.value),
                                },
                              }))
                            }
                          />
                          <span
                            style={{
                              fontSize: 13,
                              color: 'var(--muted)',
                              whiteSpace: 'nowrap',
                              width: 110,
                            }}
                          >
                            {centsPerCredit(pack.priceUsd, packCredits[pack.id][field])}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div className="setting-actions">
              <button
                className="btn primary"
                onClick={save}
                disabled={
                  saving ||
                  !Number.isInteger(shopifyTrialCredits) ||
                  shopifyTrialCredits < 0 ||
                  shopifyTrialCredits > 1000 ||
                  PACKS.some((pack) =>
                    (['credits', 'autorefillCredits'] as const).some((field) => {
                      const value = packCredits[pack.id][field];
                      return !Number.isInteger(value) || value < 1 || value > 1000000;
                    }),
                  )
                }
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
