import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icons';
import { Switch } from '../../components/Switch';
import { apiErrorMessage, apiFetch } from '../../lib/data';

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export default function JobCostsTab({ toast }: Props) {
  const [resolutions, setResolutions] = useState<
    Record<string, { enabled: boolean; creditCost: number }>
  >({
    HD: { enabled: false, creditCost: 10 },
    '2K': { enabled: true, creditCost: 25 },
    '4K': { enabled: true, creditCost: 40 },
  });
  const [tryonCreditCost, setTryonCreditCost] = useState(5);
  const [sareeMannequinDevCreditCost, setSareeMannequinDevCreditCost] = useState(10);
  const [pixverseCreditCost, setPixverseCreditCost] = useState(150);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<{
      resolutions?: Record<string, { enabled: boolean; creditCost: number }>;
      tryon?: { creditCost: number };
      sareeMannequinDev?: { creditCost: number };
      pixverse?: { creditCost: number };
    }>('/admin/config')
      .then((cfg) => {
        if (cfg.resolutions) setResolutions(cfg.resolutions);
        if (cfg.tryon) setTryonCreditCost(cfg.tryon.creditCost);
        if (cfg.sareeMannequinDev) setSareeMannequinDevCreditCost(cfg.sareeMannequinDev.creditCost);
        if (cfg.pixverse) setPixverseCreditCost(cfg.pixverse.creditCost);
      })
      .catch((e) =>
        toast({
          kind: 'error',
          title: 'Failed to load job costs',
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
          resolutions,
          tryon: { creditCost: tryonCreditCost },
          sareeMannequinDev: { creditCost: sareeMannequinDevCreditCost },
          pixverse: { creditCost: pixverseCreditCost },
        }),
      });
      toast({ title: 'Job costs saved' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to save job costs',
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
          <Icon.Coin /> Job Costs
        </h3>
      </div>
      <div className="card-body">
        {loading ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            <div style={{ marginTop: 24, marginBottom: 8 }}>
              <div className="setting-lbl" style={{ marginBottom: 4 }}>
                Resolution Pricing
              </div>
              <div className="setting-desc" style={{ marginBottom: 12 }}>
                Credit cost per image for each resolution. Disable resolutions to hide them from the
                pricing page.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(['HD', '2K', '4K'] as const).map((res) => {
                  const cfg = resolutions[res] ?? { enabled: false, creditCost: 0 };
                  return (
                    <div
                      key={res}
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
                      <Switch
                        checked={cfg.enabled}
                        onChange={(v) =>
                          setResolutions((prev) => ({
                            ...prev,
                            [res]: { ...cfg, enabled: v },
                          }))
                        }
                      />
                      <span className="setting-lbl" style={{ width: 32 }}>
                        {res}
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
                          max={1000}
                          style={{ width: 80, textAlign: 'right' }}
                          value={cfg.creditCost}
                          disabled={saving || !cfg.enabled}
                          onChange={(e) =>
                            setResolutions((prev) => ({
                              ...prev,
                              [res]: { ...cfg, creditCost: Number(e.target.value) },
                            }))
                          }
                        />
                        <span style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                          credits / image
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ marginTop: 24, marginBottom: 8 }}>
              <div className="setting-lbl" style={{ marginBottom: 4 }}>
                Virtual Try-On Pricing
              </div>
              <div className="setting-desc" style={{ marginBottom: 12 }}>
                Credit cost per virtual try-on generation (studio "reuse as try-on" and saree try-on
                both share this cost).
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
                <span className="setting-lbl">Try-On</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={1000}
                    style={{ width: 80, textAlign: 'right' }}
                    value={tryonCreditCost}
                    disabled={saving}
                    onChange={(e) => setTryonCreditCost(Number(e.target.value))}
                  />
                  <span style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    credits / try-on
                  </span>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 24, marginBottom: 8 }}>
              <div className="setting-lbl" style={{ marginBottom: 4 }}>
                Dev API — Saree Mannequin
              </div>
              <div className="setting-desc" style={{ marginBottom: 12 }}>
                Credit cost per saree-mannequin (step-1) job created via the developer API (
                <code>/v1/dev/saree-mannequin</code>). Independent of the Virtual Try-On cost above.
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
                <span className="setting-lbl">Saree Mannequin (Dev API)</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={1000}
                    style={{ width: 80, textAlign: 'right' }}
                    value={sareeMannequinDevCreditCost}
                    disabled={saving}
                    onChange={(e) => setSareeMannequinDevCreditCost(Number(e.target.value))}
                  />
                  <span style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    credits / job
                  </span>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 24, marginBottom: 8 }}>
              <div className="setting-lbl" style={{ marginBottom: 4 }}>
                Catalog Video (PixVerse)
              </div>
              <div className="setting-desc" style={{ marginBottom: 12 }}>
                Credit cost per catalog-video generation (image-to-video via PixVerse).
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
                <span className="setting-lbl">Catalog Video</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={1000}
                    style={{ width: 80, textAlign: 'right' }}
                    value={pixverseCreditCost}
                    disabled={saving}
                    onChange={(e) => setPixverseCreditCost(Number(e.target.value))}
                  />
                  <span style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    credits / video
                  </span>
                </div>
              </div>
            </div>

            <div className="setting-actions">
              <button className="btn primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
