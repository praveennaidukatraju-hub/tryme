import { useEffect, useState } from 'react';
import { ConfirmModal } from '../../components/ConfirmModal';
import { Icon } from '../../components/Icons';
import { Switch } from '../../components/Switch';
import { apiErrorMessage, apiFetch } from '../../lib/data';
import type { CreditPlan } from '../../types';

type ToastFn = (t: { kind?: 'error'; title: string; body?: string }) => void;
type PlanType = 'catalogue' | 'tryon';

const EMPTY_FORM = {
  slug: '',
  name: '',
  subtext: '',
  credits: 0,
  priceRupees: 0,
  isActive: true,
  isHighlighted: false,
  badge: '',
  sortOrder: 0,
  queueStream: 'normal' as 'priority' | 'normal' | 'low',
  watermark: false,
  planType: 'catalogue' as PlanType,
  perUnitPriceLabel: '',
  unitCountLabel: '',
};

function PlanModal({
  plan,
  initialType,
  onSaved,
  onClose,
  toast,
}: {
  plan: CreditPlan | null;
  initialType: PlanType;
  onSaved: (p: CreditPlan) => void;
  onClose: () => void;
  toast: ToastFn;
}) {
  const [form, setForm] = useState(
    plan
      ? {
          slug: plan.slug,
          name: plan.name,
          subtext: plan.subtext,
          credits: plan.credits,
          priceRupees: plan.basePaise / 100,
          isActive: plan.isActive,
          isHighlighted: plan.isHighlighted,
          badge: plan.badge ?? '',
          sortOrder: plan.sortOrder,
          queueStream: plan.queueStream ?? ('normal' as 'priority' | 'normal' | 'low'),
          watermark: plan.watermark ?? false,
          planType: plan.planType,
          perUnitPriceLabel: plan.perUnitPriceLabel ?? '',
          unitCountLabel: plan.unitCountLabel ?? '',
        }
      : { ...EMPTY_FORM, planType: initialType },
  );
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const { priceRupees, ...rest } = form;
      const body = {
        ...rest,
        basePaise: Math.round(priceRupees * 100),
        badge: form.badge.trim() || null,
        perUnitPriceLabel: form.perUnitPriceLabel.trim() || null,
        unitCountLabel: form.unitCountLabel.trim() || null,
      };
      const saved = plan
        ? await apiFetch<CreditPlan>(`/admin/credit-plans/${plan.id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        : await apiFetch<CreditPlan>('/admin/credit-plans', {
            method: 'POST',
            body: JSON.stringify(body),
          });
      onSaved(saved);
      toast({ title: plan ? `${saved.name} updated` : `${saved.name} created` });
      onClose();
    } catch (err) {
      toast({
        kind: 'error',
        title: plan ? 'Failed to update plan' : 'Failed to create plan',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setSaving(false);
    }
  };

  const isFreePlan = plan?.slug === 'free';
  const isCatalogue = form.planType === 'catalogue';
  const valid =
    form.slug.trim() &&
    form.name.trim() &&
    form.credits >= 0 &&
    form.priceRupees >= 0 &&
    (isFreePlan || (form.credits > 0 && form.priceRupees > 0));

  return (
    <div className="modal-overlay" onClick={saving ? undefined : onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{plan ? 'Edit plan' : `Add ${isCatalogue ? 'Catalogue' : 'Try-On'} plan`}</h2>
          <button
            className="btn sm ghost"
            onClick={onClose}
            disabled={saving}
            style={{ marginLeft: 'auto' }}
          >
            <Icon.Close />
          </button>
        </div>

        <div className="drawer-body" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Identity Group */}
          {!isFreePlan && (
            <div className="field">
              <label>Plan Type</label>
              <select
                className="input"
                value={form.planType}
                disabled={saving || !!plan}
                onChange={(e) => set('planType', e.target.value as PlanType)}
              >
                <option value="catalogue">AI Catalogue Generation</option>
                <option value="tryon">AI Virtual Try-On</option>
              </select>
              {!plan && (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Which pricing tab this plan is sold under. Cannot change later.
                </span>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 16 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Slug (Identifier)</label>
              <input
                className="input"
                value={form.slug}
                disabled={saving || !!plan}
                placeholder="e.g. starter"
                onChange={(e) =>
                  set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                }
              />
              {!plan && (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Lowercase letters, numbers, hyphens. Cannot change later.
                </span>
              )}
            </div>
            <div className="field" style={{ flex: 1.5 }}>
              <label>Plan Name</label>
              <input
                className="input"
                value={form.name}
                disabled={saving}
                placeholder="e.g. Starter Pack"
                onChange={(e) => set('name', e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label>Subtext Description</label>
            <input
              className="input"
              value={form.subtext}
              disabled={saving}
              placeholder="e.g. Individual sellers & small stores"
              onChange={(e) => set('subtext', e.target.value)}
            />
          </div>

          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

          {/* Value Group */}
          <div style={{ display: 'flex', gap: 16 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>{isFreePlan ? 'Signup credits' : 'Credit Allocation'}</label>
              <input
                className="input"
                type="number"
                min={0}
                value={form.credits}
                disabled={saving}
                onChange={(e) => set('credits', Number(e.target.value))}
              />
              {isFreePlan && (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Granted once to every new signup. Set to 0 to disable.
                </span>
              )}
            </div>
            {!isFreePlan && (
              <div className="field" style={{ flex: 1 }}>
                <label>Price (₹, excl. GST)</label>
                <div style={{ position: 'relative' }}>
                  <span
                    style={{
                      position: 'absolute',
                      left: 12,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      fontSize: 14,
                      color: 'var(--muted)',
                      pointerEvents: 'none',
                    }}
                  >
                    ₹
                  </span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={form.priceRupees || ''}
                    disabled={saving}
                    placeholder="e.g. 2500"
                    style={{ paddingLeft: 26 }}
                    onChange={(e) => set('priceRupees', Number(e.target.value))}
                  />
                </div>
                {form.priceRupees > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                    ₹{form.priceRupees.toLocaleString('en-IN')} + 18% GST = ₹
                    {(form.priceRupees * 1.18).toLocaleString('en-IN', {
                      maximumFractionDigits: 2,
                    })}
                  </span>
                )}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <div className="field" style={{ flex: 1.5 }}>
              <label>Job Queue Priority</label>
              <select
                className="input"
                value={form.queueStream}
                disabled={saving}
                onChange={(e) =>
                  set('queueStream', e.target.value as 'priority' | 'normal' | 'low')
                }
              >
                <option value="priority">1st — Priority (jobs processed first)</option>
                <option value="normal">2nd — Normal</option>
                <option value="low">3rd — Low (processed last)</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Marketing Badge</label>
              <input
                className="input"
                value={form.badge}
                disabled={saving}
                placeholder="e.g. Best Value"
                onChange={(e) => set('badge', e.target.value)}
              />
            </div>
          </div>

          {!isFreePlan && (
            <div style={{ display: 'flex', gap: 16 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>
                  {isCatalogue ? 'Per Catalogue Photo Price' : 'Per Try-on Photo Price'}
                </label>
                <input
                  className="input"
                  value={form.perUnitPriceLabel}
                  disabled={saving}
                  placeholder={
                    isCatalogue ? 'e.g. ₹12.50 per Catalogue photo' : 'e.g. ₹6.25 per Try-on photo'
                  }
                  onChange={(e) => set('perUnitPriceLabel', e.target.value)}
                />
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Shown on the public pricing card. Leave blank to hide this row.
                </span>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>{isCatalogue ? 'Images Included' : 'Try-Ons Included'}</label>
                <input
                  className="input"
                  value={form.unitCountLabel}
                  disabled={saving}
                  placeholder={isCatalogue ? 'e.g. 80 Images' : 'e.g. 160 Try-Ons'}
                  onChange={(e) => set('unitCountLabel', e.target.value)}
                />
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Shown next to the price on the pricing card. Leave blank to hide.
                </span>
              </div>
            </div>
          )}

          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

          {/* Settings Group */}
          <div
            style={{
              display: 'flex',
              gap: 24,
              alignItems: 'center',
              background: 'var(--surface-2)',
              padding: 16,
              borderRadius: 'var(--r-lg)',
              border: '1px solid var(--border)',
            }}
          >
            <div className="field" style={{ width: 100, marginBottom: 0 }}>
              <label>Sort order</label>
              <input
                className="input"
                type="number"
                min={0}
                value={form.sortOrder}
                disabled={saving}
                style={{ background: 'var(--surface)' }}
                onChange={(e) => set('sortOrder', Number(e.target.value))}
              />
            </div>

            <div style={{ width: 1, height: 40, background: 'var(--border)' }} />

            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 32 }}>
              {!isFreePlan && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Switch checked={form.isActive} onChange={(v) => set('isActive', v)} />
                  <div>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        color: 'var(--ink)',
                        lineHeight: 1.2,
                      }}
                    >
                      Active
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                      Purchasable
                    </div>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Switch checked={form.isHighlighted} onChange={(v) => set('isHighlighted', v)} />
                <div>
                  <div
                    style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', lineHeight: 1.2 }}
                  >
                    Featured
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                    Accent styling
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Switch checked={form.watermark} onChange={(v) => set('watermark', v)} />
                <div>
                  <div
                    style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', lineHeight: 1.2 }}
                  >
                    Watermark
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                    Apply logo to jobs
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="drawer-foot">
          <button className="btn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn primary" onClick={handleSave} disabled={saving || !valid}>
            {saving ? 'Saving…' : plan ? 'Save changes' : 'Create plan'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlanCard({
  plan,
  onEdit,
  onDelete,
}: {
  plan: CreditPlan;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="card"
      style={{
        flex: '1 1 300px',
        maxWidth: 380,
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'hidden',
        opacity: plan.isActive ? 1 : 0.6,
        borderColor: plan.isHighlighted && plan.isActive ? 'var(--accent)' : 'var(--border)',
      }}
    >
      {plan.isHighlighted && plan.isActive && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 4,
            background: 'var(--accent)',
          }}
        />
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 16,
        }}
      >
        <div style={{ minWidth: 0, flex: 1, paddingRight: 8 }}>
          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: 'var(--ink)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {plan.name}
          </div>
          <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
            {plan.slug}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          {plan.badge && <span className="badge warn">{plan.badge}</span>}
          {!plan.isActive && <span className="badge dot">Inactive</span>}
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <div
          style={{
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: 'var(--ink)',
          }}
        >
          ₹
          {((plan.basePaise * 1.18) / 100).toLocaleString('en-IN', {
            maximumFractionDigits: 2,
          })}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          ₹{(plan.basePaise / 100).toLocaleString('en-IN')} + 18% GST
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          marginBottom: 28,
          flex: 1,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 13.5,
            color: 'var(--ink)',
          }}
        >
          <Icon.Coin style={{ color: 'var(--accent)', width: 16, height: 16 }} />
          <span>
            <strong className="mono">{plan.credits.toLocaleString()}</strong> credits
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 13.5,
            color: 'var(--muted)',
          }}
        >
          <Icon.Workflow style={{ width: 16, height: 16 }} />
          <span>
            {plan.queueStream === 'priority'
              ? 'Priority'
              : plan.queueStream === 'normal'
                ? 'Normal'
                : 'Low'}{' '}
            queue processing
          </span>
        </div>
        {plan.unitCountLabel && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 13.5,
              color: 'var(--muted)',
            }}
          >
            <Icon.Coin style={{ width: 16, height: 16 }} />
            <span>{plan.unitCountLabel} included</span>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
        <button className="btn sm" style={{ flex: 1, justifyContent: 'center' }} onClick={onEdit}>
          Edit Plan
        </button>
        <button
          className="btn sm ghost"
          style={{ color: 'var(--danger)', padding: '0 10px' }}
          onClick={onDelete}
          title="Delete Plan"
        >
          <Icon.Trash />
        </button>
      </div>
    </div>
  );
}

function PlanTypeSection({
  title,
  addLabel,
  emptyLabel,
  plans,
  loading,
  onAdd,
  onEdit,
  onDelete,
}: {
  title: string;
  addLabel: string;
  emptyLabel: string;
  plans: CreditPlan[];
  loading: boolean;
  onAdd: () => void;
  onEdit: (p: CreditPlan) => void;
  onDelete: (p: CreditPlan) => void;
}) {
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 20,
          marginTop: 32,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 18,
            fontWeight: 500,
            color: 'var(--ink)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Icon.Coin /> {title}
        </h3>
        <button className="btn sm primary" onClick={onAdd}>
          <Icon.Add /> {addLabel}
        </button>
      </div>

      {loading ? (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 24 }}>
          {plans.map((p) => (
            <PlanCard key={p.id} plan={p} onEdit={() => onEdit(p)} onDelete={() => onDelete(p)} />
          ))}

          {plans.length === 0 && (
            <div
              style={{
                gridColumn: '1 / -1',
                textAlign: 'center',
                padding: '40px 20px',
                color: 'var(--muted)',
                background: 'var(--surface-2)',
                borderRadius: 'var(--r-lg)',
                border: '1px dashed var(--border)',
              }}
            >
              {emptyLabel}
            </div>
          )}
        </div>
      )}
    </>
  );
}

interface Props {
  toast: ToastFn;
}

export default function PurchasablePlansTab({ toast }: Props) {
  const [plans, setPlans] = useState<CreditPlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [planModal, setPlanModal] = useState<{
    open: boolean;
    plan: CreditPlan | null;
    initialType: PlanType;
  }>({
    open: false,
    plan: null,
    initialType: 'catalogue',
  });
  const [confirmDelete, setConfirmDelete] = useState<CreditPlan | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    apiFetch<CreditPlan[]>('/admin/credit-plans')
      .then(setPlans)
      .catch((e) =>
        toast({
          kind: 'error',
          title: 'Failed to load credit plans',
          body: apiErrorMessage(e, 'Please try again.'),
        }),
      )
      .finally(() => setPlansLoading(false));
  }, [toast]);

  const handlePlanSaved = (saved: CreditPlan) => {
    setPlans((prev) => {
      const idx = prev.findIndex((p) => p.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next.sort((a, b) => a.sortOrder - b.sortOrder);
      }
      return [...prev, saved].sort((a, b) => a.sortOrder - b.sortOrder);
    });
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await apiFetch(`/admin/credit-plans/${confirmDelete.id}`, { method: 'DELETE' });
      setPlans((prev) => prev.filter((p) => p.id !== confirmDelete.id));
      toast({ title: `${confirmDelete.name} deleted` });
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Failed to delete plan',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  };

  const freePlan = plans.find((plan) => plan.slug === 'free') ?? null;
  const cataloguePlans = plans.filter(
    (plan) => plan.slug !== 'free' && plan.planType === 'catalogue',
  );
  const tryonPlans = plans.filter((plan) => plan.planType === 'tryon');

  return (
    <>
      <div
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
          padding: '24px 32px',
          display: 'flex',
          alignItems: 'center',
          gap: 40,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 280 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div
              style={{
                background: 'var(--ink)',
                color: 'var(--bg)',
                width: 32,
                height: 32,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon.Coin style={{ width: 16, height: 16 }} />
            </div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--ink)' }}>
              Free Signup Plan
            </h3>
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.5, maxWidth: 500 }}>
            New users are automatically granted a one-time credit allocation at signup. This
            system-owned plan is permanent and free.
          </div>
        </div>

        {plansLoading ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        ) : freePlan ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
            <div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: 4,
                }}
              >
                Allocation
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <div
                  style={{
                    fontSize: 32,
                    fontWeight: 700,
                    letterSpacing: '-0.02em',
                    color: 'var(--ink)',
                  }}
                >
                  {freePlan.credits.toLocaleString()}
                </div>
                <div style={{ fontSize: 14, color: 'var(--muted)' }}>credits</div>
              </div>
            </div>

            <div style={{ width: 1, height: 48, background: 'var(--border)' }} />

            <div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: 4,
                }}
              >
                Queue
              </div>
              <div style={{ fontSize: 18, fontWeight: 500, color: 'var(--ink)', marginTop: 8 }}>
                {freePlan.queueStream === 'priority'
                  ? 'Priority'
                  : freePlan.queueStream === 'normal'
                    ? 'Normal'
                    : 'Low'}
              </div>
            </div>

            <div style={{ marginLeft: 16 }}>
              <button
                className="btn"
                onClick={() =>
                  setPlanModal({ open: true, plan: freePlan, initialType: 'catalogue' })
                }
              >
                <Icon.Edit /> Edit
              </button>
            </div>
          </div>
        ) : (
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>
            Free plan missing. Run migrations to seed it.
          </div>
        )}
      </div>

      <PlanTypeSection
        title="AI Catalogue Generation Plans"
        addLabel="Add Catalogue plan"
        emptyLabel='No catalogue plans yet — click "Add Catalogue plan" to create one.'
        plans={cataloguePlans}
        loading={plansLoading}
        onAdd={() => setPlanModal({ open: true, plan: null, initialType: 'catalogue' })}
        onEdit={(p) => setPlanModal({ open: true, plan: p, initialType: 'catalogue' })}
        onDelete={setConfirmDelete}
      />

      <PlanTypeSection
        title="AI Virtual Try-On Plans"
        addLabel="Add Try-On plan"
        emptyLabel='No try-on plans yet — click "Add Try-On plan" to create one.'
        plans={tryonPlans}
        loading={plansLoading}
        onAdd={() => setPlanModal({ open: true, plan: null, initialType: 'tryon' })}
        onEdit={(p) => setPlanModal({ open: true, plan: p, initialType: 'tryon' })}
        onDelete={setConfirmDelete}
      />

      {planModal.open && (
        <PlanModal
          plan={planModal.plan}
          initialType={planModal.initialType}
          onSaved={handlePlanSaved}
          onClose={() => setPlanModal({ open: false, plan: null, initialType: 'catalogue' })}
          toast={toast}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete plan"
          body={`Are you sure you want to delete "${confirmDelete.name}"? This cannot be undone.`}
          what={`slug: ${confirmDelete.slug}`}
          danger
          confirmLabel={deleting ? 'Deleting…' : 'Delete'}
          onConfirm={handleDelete}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}
