import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ConfirmModal } from '../components/ConfirmModal';
import { EditDrawer } from '../components/EditDrawer';
import { Icon } from '../components/Icons';
import { SearchableSelect } from '../components/SearchableSelect';
import { Switch } from '../components/Switch';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage, apiFetch, UPLOAD_NETWORK_ERROR, uploadErrorMessage } from '../lib/data';
import JobCostsTab from './settings/JobCostsTab';
import PurchasablePlansTab from './settings/PurchasablePlansTab';
import RolesPermissionsTab from './settings/RolesPermissionsTab';
import ShopifyCreditsTab from './settings/ShopifyCreditsTab';

function uploadFile(url: string, file: Blob, contentType: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(uploadErrorMessage(xhr.status)));
    xhr.onerror = () => reject(new Error(UPLOAD_NETWORK_ERROR));
    xhr.send(file);
  });
}

type Theme = 'light' | 'dark' | 'system';

import type { SignupCampaign } from '../types';

type SettingsSection =
  | 'appearance'
  | 'notifications'
  | 'credit-plans'
  | 'signup-campaigns'
  | 'roles-permissions'
  | 'system'
  | 'session';

const SETTING_SECTIONS: { k: SettingsSection; label: string }[] = [
  { k: 'appearance', label: 'Appearance' },
  { k: 'notifications', label: 'Notifications' },
  { k: 'credit-plans', label: 'Credit Plans' },
  { k: 'signup-campaigns', label: 'Signup Campaigns' },
  { k: 'roles-permissions', label: 'Roles & Permissions' },
  { k: 'system', label: 'System' },
  { k: 'session', label: 'Session' },
];

interface Props {
  onNav: (_page: string, _filter?: { page: string; filter?: string }) => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const PAGE_SIZES = [15, 25, 50, 100] as const;

const EMPTY_CAMPAIGN_FORM = {
  code: '',
  name: '',
  bonusPercent: 25,
  startAt: '',
  endAt: '',
  isActive: true,
};

// Converts an ISO instant to the local wall time required by <input type="datetime-local">.
function toDatetimeLocal(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => value.toString().padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function serializeCampaignDatetime(datetimeLocal: string, originalIso?: string): string {
  // datetime-local has minute precision, so preserve the API instant when its displayed value is unchanged.
  return originalIso && datetimeLocal === toDatetimeLocal(originalIso)
    ? originalIso
    : new Date(datetimeLocal).toISOString();
}

function CampaignModal({
  campaign,
  onSaved,
  onClose,
  toast,
}: {
  campaign: SignupCampaign | null;
  onSaved: (c: SignupCampaign) => void;
  onClose: () => void;
  toast: Props['toast'];
}) {
  const [form, setForm] = useState(
    campaign
      ? {
          code: campaign.code,
          name: campaign.name,
          bonusPercent: campaign.bonusPercent,
          startAt: toDatetimeLocal(campaign.startAt),
          endAt: toDatetimeLocal(campaign.endAt),
          isActive: campaign.isActive,
        }
      : EMPTY_CAMPAIGN_FORM,
  );
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const body = {
        ...form,
        startAt: serializeCampaignDatetime(form.startAt, campaign?.startAt),
        endAt: serializeCampaignDatetime(form.endAt, campaign?.endAt),
      };
      const saved = campaign
        ? await apiFetch<SignupCampaign>(`/admin/signup-campaigns/${campaign.id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        : await apiFetch<SignupCampaign>('/admin/signup-campaigns', {
            method: 'POST',
            body: JSON.stringify(body),
          });
      onSaved(saved);
      toast({ title: campaign ? `${saved.name} updated` : `${saved.name} created` });
      onClose();
    } catch (err) {
      toast({
        kind: 'error',
        title: campaign ? 'Failed to update campaign' : 'Failed to create campaign',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setSaving(false);
    }
  };

  const valid =
    form.code.trim().length > 0 &&
    form.name.trim().length > 0 &&
    form.bonusPercent >= 0 &&
    form.bonusPercent <= 100 &&
    form.startAt.length > 0 &&
    form.endAt.length > 0 &&
    new Date(form.endAt) > new Date(form.startAt);

  return (
    <EditDrawer
      onClose={onClose}
      title={campaign ? 'Edit campaign' : 'Add campaign'}
      saving={saving}
      onSave={() => void handleSave()}
      saveLabel={saving ? 'Saving…' : campaign ? 'Save changes' : 'Create campaign'}
      saveDisabled={saving || !valid}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', gap: 16 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Code</label>
            <input
              className="input"
              value={form.code}
              disabled={saving || !!campaign}
              placeholder="e.g. gartex2026"
              onChange={(e) => set('code', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            />
            {!campaign && (
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                Matches the ?src= value on the signup link. Cannot change later.
              </span>
            )}
          </div>
          <div className="field" style={{ flex: 1.5 }}>
            <label>Name</label>
            <input
              className="input"
              value={form.name}
              disabled={saving}
              placeholder="e.g. Gartex Expo Delhi 2026"
              onChange={(e) => set('name', e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label>Bonus % (applied to first purchase and signup free credits)</label>
          <input
            className="input"
            type="number"
            min={0}
            max={100}
            value={form.bonusPercent}
            disabled={saving}
            onChange={(e) => set('bonusPercent', Number(e.target.value))}
          />
        </div>

        <div style={{ display: 'flex', gap: 16 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Starts</label>
            <input
              className="input"
              type="datetime-local"
              value={form.startAt}
              disabled={saving}
              onChange={(e) => set('startAt', e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Ends</label>
            <input
              className="input"
              type="datetime-local"
              value={form.endAt}
              disabled={saving}
              onChange={(e) => set('endAt', e.target.value)}
            />
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Switch checked={form.isActive} onChange={(v) => set('isActive', v)} disabled={saving} />
          Active
        </label>
      </div>
    </EditDrawer>
  );
}

export default function SettingsPage({ onNav: _onNav, toast, theme, setTheme }: Props) {
  const { logout } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = (searchParams.get('s') as SettingsSection | null) ?? 'appearance';
  const [creditSubTab, setCreditSubTab] = useState<'purchasable' | 'job-costs' | 'shopify'>(
    'purchasable',
  );
  const [pageSize, setPageSize] = useState<number>(25);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  const [maxOutputPx, setMaxOutputPx] = useState(2048);
  const [maxBatchJobs, setMaxBatchJobs] = useState(200);
  const [maxQueueDepth, setMaxQueueDepth] = useState(50);
  const [sellerGstin, setSellerGstin] = useState('');
  const [sellerLegalName, setSellerLegalName] = useState('');
  const [sellerAddress, setSellerAddress] = useState('');
  const [sellerPan, setSellerPan] = useState('');
  const [sellerTan, setSellerTan] = useState('');
  const [sellerUdyamRegNo, setSellerUdyamRegNo] = useState('');
  const [merchantCatalogDefaults, setMerchantCatalogDefaults] = useState<
    Record<
      string,
      { faceId: string; backgroundId: string; lowerCatalogId?: string; shoeCatalogId?: string }
    >
  >({});
  const [catalogItemsList, setCatalogItemsList] = useState<
    Array<{ id: string; label: string; type: 'lower' | 'shoe'; genderSlug: string | null }>
  >([]);
  const [merchantCatalogAspectRatio, setMerchantCatalogAspectRatio] = useState('2:3');
  const [modelFacesList, setModelFacesList] = useState<
    Array<{ id: string; label: string; gender: string }>
  >([]);
  const [modelBackgroundsList, setModelBackgroundsList] = useState<
    Array<{ id: string; label: string }>
  >([]);
  const [uploadLimitsMb, setUploadLimitsMb] = useState({
    merchantCatalogMaxBytes: 20,
    webGarmentMaxBytes: 20,
    merchantTryonMaxBytes: 20,
    devApiMaxBytes: 20,
    shopifyCatalogSourceMaxBytes: 20,
    shopifyCustomerPhotoMaxBytes: 20,
    shopifyProductImageMaxBytes: 20,
    shopifyProductSyncMaxBytes: 20,
  });
  const [bulkImportMaxGb, setBulkImportMaxGb] = useState(2.5);
  const [uploadLimitsExpanded, setUploadLimitsExpanded] = useState(false);
  const [sysLoading, setSysLoading] = useState(true);
  const [sysSaving, setSysSaving] = useState(false);
  const [appVideoUrl, setAppVideoUrl] = useState<string | null>(null);
  const [appVideoLoading, setAppVideoLoading] = useState(true);
  const [appVideoUploading, setAppVideoUploading] = useState(false);

  const [campaigns, setCampaigns] = useState<SignupCampaign[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [campaignModal, setCampaignModal] = useState<{
    open: boolean;
    campaign: SignupCampaign | null;
  }>({ open: false, campaign: null });
  const [confirmDeleteCampaign, setConfirmDeleteCampaign] = useState<SignupCampaign | null>(null);
  const [deletingCampaign, setDeletingCampaign] = useState(false);

  useEffect(() => {
    apiFetch<{
      maxOutputPx?: number;
      maxBatchJobs?: number;
      maxQueueDepth?: number;
      seller?: {
        gstin?: string;
        legalName?: string;
        address?: string;
        pan?: string;
        tan?: string;
        udyamRegNo?: string;
      };
      merchantCatalogDefaults?: Record<
        string,
        { faceId: string; backgroundId: string; lowerCatalogId?: string; shoeCatalogId?: string }
      >;
      merchantCatalogAspectRatio?: string;
      uploadLimits?: Record<string, number>;
    }>('/admin/config')
      .then((cfg) => {
        if (cfg.maxOutputPx) setMaxOutputPx(cfg.maxOutputPx);
        if (cfg.maxBatchJobs) setMaxBatchJobs(cfg.maxBatchJobs);
        if (cfg.maxQueueDepth) setMaxQueueDepth(cfg.maxQueueDepth);
        if (cfg.seller) {
          setSellerGstin(cfg.seller.gstin ?? '');
          setSellerLegalName(cfg.seller.legalName ?? '');
          setSellerAddress(cfg.seller.address ?? '');
          setSellerPan(cfg.seller.pan ?? '');
          setSellerTan(cfg.seller.tan ?? '');
          setSellerUdyamRegNo(cfg.seller.udyamRegNo ?? '');
        }
        if (cfg.merchantCatalogDefaults) setMerchantCatalogDefaults(cfg.merchantCatalogDefaults);
        if (cfg.merchantCatalogAspectRatio)
          setMerchantCatalogAspectRatio(cfg.merchantCatalogAspectRatio);
        if (cfg.uploadLimits) {
          const bytesToMb = (b: number) => Math.round((b / (1024 * 1024)) * 100) / 100;
          setUploadLimitsMb({
            merchantCatalogMaxBytes: bytesToMb(
              cfg.uploadLimits.merchantCatalogMaxBytes ?? 20 * 1024 * 1024,
            ),
            webGarmentMaxBytes: bytesToMb(cfg.uploadLimits.webGarmentMaxBytes ?? 20 * 1024 * 1024),
            merchantTryonMaxBytes: bytesToMb(
              cfg.uploadLimits.merchantTryonMaxBytes ?? 20 * 1024 * 1024,
            ),
            devApiMaxBytes: bytesToMb(cfg.uploadLimits.devApiMaxBytes ?? 20 * 1024 * 1024),
            shopifyCatalogSourceMaxBytes: bytesToMb(
              cfg.uploadLimits.shopifyCatalogSourceMaxBytes ?? 20 * 1024 * 1024,
            ),
            shopifyCustomerPhotoMaxBytes: bytesToMb(
              cfg.uploadLimits.shopifyCustomerPhotoMaxBytes ?? 20 * 1024 * 1024,
            ),
            shopifyProductImageMaxBytes: bytesToMb(
              cfg.uploadLimits.shopifyProductImageMaxBytes ?? 20 * 1024 * 1024,
            ),
            shopifyProductSyncMaxBytes: bytesToMb(
              cfg.uploadLimits.shopifyProductSyncMaxBytes ?? 20 * 1024 * 1024,
            ),
          });
          const bytesToGb = (b: number) => Math.round((b / (1024 * 1024 * 1024)) * 100) / 100;
          setBulkImportMaxGb(
            bytesToGb(cfg.uploadLimits.bulkImportMaxBytes ?? 2.5 * 1024 * 1024 * 1024),
          );
        }
      })
      .catch((e) =>
        toast({
          kind: 'error',
          title: 'Failed to load system config',
          body: apiErrorMessage(e, 'Please try again.'),
        }),
      )
      .finally(() => setSysLoading(false));
  }, [toast]);

  useEffect(() => {
    apiFetch<{ videoUrl: string | null }>('/admin/config/app-video')
      .then((res) => setAppVideoUrl(res.videoUrl))
      .catch(() => {})
      .finally(() => setAppVideoLoading(false));
  }, []);

  const handleAppVideoUpload = async (file: File) => {
    setAppVideoUploading(true);
    try {
      const presign = await apiFetch<{ uploadUrl: string; key: string }>(
        '/admin/config/app-video/presign',
        { method: 'POST', body: JSON.stringify({ contentType: 'video/mp4' }) },
      );
      await uploadFile(presign.uploadUrl, file, 'video/mp4');
      const confirmed = await apiFetch<{ videoUrl: string; updatedAt: string }>(
        '/admin/config/app-video/confirm',
        { method: 'POST' },
      );
      setAppVideoUrl(confirmed.videoUrl);
      toast({ title: 'App video updated' });
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Failed to upload video',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setAppVideoUploading(false);
    }
  };

  useEffect(() => {
    apiFetch<{ items: Array<{ id: string; label: string; gender: string }> }>('/admin/assets/faces')
      .then((res) => setModelFacesList(res.items))
      .catch(() => {});
    apiFetch<{ items: Array<{ id: string; label: string }> }>('/admin/assets/backgrounds')
      .then((res) => setModelBackgroundsList(res.items))
      .catch(() => {});
    apiFetch<
      Array<{ id: string; label: string; type: 'lower' | 'shoe'; genderSlug: string | null }>
    >('/admin/catalog/items')
      .then(setCatalogItemsList)
      .catch(() => {});
  }, []);

  const saveSysConfig = async () => {
    setSysSaving(true);
    try {
      const mbToBytes = (mb: number) => Math.round(mb * 1024 * 1024);
      const gbToBytes = (gb: number) => Math.round(gb * 1024 * 1024 * 1024);
      const sanitizedMerchantCatalogDefaults = Object.fromEntries(
        Object.entries(merchantCatalogDefaults).map(([cat, v]) => [
          cat,
          {
            faceId: v.faceId,
            backgroundId: v.backgroundId,
            ...(v.lowerCatalogId ? { lowerCatalogId: v.lowerCatalogId } : {}),
            ...(v.shoeCatalogId ? { shoeCatalogId: v.shoeCatalogId } : {}),
          },
        ]),
      );
      await apiFetch('/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({
          maxOutputPx,
          maxBatchJobs,
          maxQueueDepth,
          seller: {
            gstin: sellerGstin.trim(),
            legalName: sellerLegalName.trim(),
            address: sellerAddress.trim(),
            pan: sellerPan.trim(),
            tan: sellerTan.trim(),
            udyamRegNo: sellerUdyamRegNo.trim(),
          },
          merchantCatalogDefaults: sanitizedMerchantCatalogDefaults,
          merchantCatalogAspectRatio,
          uploadLimits: {
            merchantCatalogMaxBytes: mbToBytes(uploadLimitsMb.merchantCatalogMaxBytes),
            webGarmentMaxBytes: mbToBytes(uploadLimitsMb.webGarmentMaxBytes),
            merchantTryonMaxBytes: mbToBytes(uploadLimitsMb.merchantTryonMaxBytes),
            devApiMaxBytes: mbToBytes(uploadLimitsMb.devApiMaxBytes),
            shopifyCatalogSourceMaxBytes: mbToBytes(uploadLimitsMb.shopifyCatalogSourceMaxBytes),
            shopifyCustomerPhotoMaxBytes: mbToBytes(uploadLimitsMb.shopifyCustomerPhotoMaxBytes),
            shopifyProductImageMaxBytes: mbToBytes(uploadLimitsMb.shopifyProductImageMaxBytes),
            shopifyProductSyncMaxBytes: mbToBytes(uploadLimitsMb.shopifyProductSyncMaxBytes),
            bulkImportMaxBytes: gbToBytes(bulkImportMaxGb),
          },
        }),
      });
      toast({ title: 'System config saved' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to save system config',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setSysSaving(false);
    }
  };

  useEffect(() => {
    apiFetch<SignupCampaign[]>('/admin/signup-campaigns')
      .then(setCampaigns)
      .catch((e) =>
        toast({
          kind: 'error',
          title: 'Failed to load signup campaigns',
          body: apiErrorMessage(e, 'Please try again.'),
        }),
      )
      .finally(() => setCampaignsLoading(false));
  }, [toast]);

  const handleCampaignSaved = (saved: SignupCampaign) => {
    setCampaigns((prev) => {
      const idx = prev.findIndex((c) => c.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [...prev, saved];
    });
  };

  const handleDeleteCampaign = async () => {
    if (!confirmDeleteCampaign) return;
    setDeletingCampaign(true);
    try {
      await apiFetch(`/admin/signup-campaigns/${confirmDeleteCampaign.id}`, { method: 'DELETE' });
      setCampaigns((prev) => prev.filter((c) => c.id !== confirmDeleteCampaign.id));
      toast({ title: `${confirmDeleteCampaign.name} deleted` });
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Failed to delete campaign',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setDeletingCampaign(false);
      setConfirmDeleteCampaign(null);
    }
  };

  const save = (section: string) => {
    setSaving(section);
    setTimeout(() => {
      setSaving(null);
      toast({ title: `${section} saved` });
    }, 500);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="lede">Manage appearance, notifications, and administrative preferences.</p>
        </div>
      </div>

      <div className="tabs">
        {SETTING_SECTIONS.map((s) => (
          <button
            key={s.k}
            className={`tab ${section === s.k ? 'active' : ''}`}
            onClick={() => setSearchParams({ s: s.k })}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Appearance */}
      {section === 'appearance' && (
        <div className="card settings-card">
          <div className="card-head">
            <h3>
              <Icon.Settings /> Appearance
            </h3>
          </div>
          <div className="card-body">
            <div className="setting-row">
              <div>
                <div className="setting-lbl">Theme</div>
                <div className="setting-desc">Choose light, dark, or match your system.</div>
              </div>
              <div className="btn-group">
                {(['light', 'dark', 'system'] as const).map((t) => (
                  <button
                    key={t}
                    className={`btn sm ${theme === t ? 'primary' : ''}`}
                    onClick={() => setTheme(t)}
                    aria-pressed={theme === t}
                  >
                    {t === 'light' && <Icon.Sun />}
                    {t === 'dark' && <Icon.Moon />}
                    {t === 'system' && <Icon.Monitor />}
                    {t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <div>
                <div className="setting-lbl">Default page size</div>
                <div className="setting-desc">Items per page in tables.</div>
              </div>
              <select
                className="select"
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
              >
                {PAGE_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s} items
                  </option>
                ))}
              </select>
            </div>

            <div className="setting-actions">
              <button className="btn" onClick={() => save('Appearance')} disabled={saving !== null}>
                {saving === 'Appearance' ? <>Saving…</> : <>Save appearance</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notifications */}
      {section === 'notifications' && (
        <div className="card settings-card">
          <div className="card-head">
            <h3>
              <Icon.Bell /> Notifications
            </h3>
          </div>
          <div className="card-body">
            <div className="setting-row">
              <div>
                <div className="setting-lbl">Sound alerts</div>
                <div className="setting-desc">Play a sound on job failures and warnings.</div>
              </div>
              <Switch checked={soundEnabled} onChange={setSoundEnabled} />
            </div>

            <div className="setting-row" style={{ opacity: 0.6 }}>
              <div>
                <div className="setting-lbl">
                  Email alerts{' '}
                  <span className="badge" style={{ marginLeft: 6 }}>
                    Coming soon
                  </span>
                </div>
                <div className="setting-desc">Receive email notifications for critical events.</div>
              </div>
              <Switch checked={false} onChange={() => {}} disabled />
            </div>

            <div className="setting-row" style={{ opacity: 0.6 }}>
              <div>
                <div className="setting-lbl">
                  Slack webhook{' '}
                  <span className="badge" style={{ marginLeft: 6 }}>
                    Coming soon
                  </span>
                </div>
                <div className="setting-desc">Post job status updates to a Slack channel.</div>
              </div>
              <input
                className="input"
                style={{ width: 320 }}
                placeholder="https://hooks.slack.com/services/…"
                value=""
                onChange={() => {}}
                disabled
              />
            </div>

            <div className="setting-actions">
              <button
                className="btn"
                onClick={() => save('Notifications')}
                disabled={saving !== null}
              >
                {saving === 'Notifications' ? <>Saving…</> : <>Save notifications</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Credit Plans */}
      {section === 'credit-plans' && (
        <>
          <div className="tabs" style={{ marginBottom: 20 }}>
            {(
              [
                { k: 'purchasable', label: 'Purchasable Plans' },
                { k: 'job-costs', label: 'Job Costs' },
                { k: 'shopify', label: 'Shopify' },
              ] as const
            ).map((t) => (
              <button
                key={t.k}
                className={`tab ${creditSubTab === t.k ? 'active' : ''}`}
                onClick={() => setCreditSubTab(t.k)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {creditSubTab === 'purchasable' && <PurchasablePlansTab toast={toast} />}
          {creditSubTab === 'job-costs' && <JobCostsTab toast={toast} />}
          {creditSubTab === 'shopify' && <ShopifyCreditsTab toast={toast} />}
        </>
      )}

      {/* Signup Campaigns */}
      {section === 'signup-campaigns' && (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 20,
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
              <Icon.Coin /> Signup Campaigns
            </h3>
            <button
              className="btn sm primary"
              onClick={() => setCampaignModal({ open: true, campaign: null })}
            >
              <Icon.Add /> Add campaign
            </button>
          </div>

          {campaignsLoading ? (
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
          ) : campaigns.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '40px 20px',
                color: 'var(--muted)',
                background: 'var(--surface-2)',
                borderRadius: 'var(--r-lg)',
                border: '1px dashed var(--border)',
              }}
            >
              No signup campaigns yet — click "Add campaign" to create one.
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Bonus %</th>
                    <th>Window</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} style={{ opacity: c.isActive ? 1 : 0.55 }}>
                      <td className="mono">{c.code}</td>
                      <td>{c.name}</td>
                      <td>{c.bonusPercent}%</td>
                      <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {new Date(c.startAt).toLocaleDateString()} –{' '}
                        {new Date(c.endAt).toLocaleDateString()}
                      </td>
                      <td>
                        {c.isActive ? (
                          <span className="badge">Active</span>
                        ) : (
                          <span className="badge dot">Inactive</span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="btn sm ghost"
                            onClick={() => setCampaignModal({ open: true, campaign: c })}
                            title="Edit"
                          >
                            <Icon.Edit />
                          </button>
                          <button
                            className="btn sm ghost"
                            onClick={() => setConfirmDeleteCampaign(c)}
                            title="Delete"
                            style={{ color: 'var(--danger)' }}
                          >
                            <Icon.Trash />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Roles & Permissions */}
      {section === 'roles-permissions' && <RolesPermissionsTab toast={toast} />}

      {/* System */}
      {section === 'system' && (
        <div className="card settings-card">
          <div className="card-head">
            <h3>
              <Icon.Settings /> System Configuration
            </h3>
          </div>
          <div className="card-body">
            {sysLoading ? (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
            ) : (
              <>
                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    Max Output Resolution
                  </div>
                  <div className="setting-desc" style={{ marginBottom: 12 }}>
                    Platform-wide ceiling on the long edge of a generated image, in pixels. Applies
                    to every job regardless of which workflow produced it.
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
                      maxWidth: 260,
                    }}
                  >
                    <input
                      className="input"
                      type="number"
                      min={512}
                      max={4096}
                      style={{ width: 100 }}
                      value={maxOutputPx}
                      disabled={sysSaving}
                      onChange={(e) => setMaxOutputPx(Number(e.target.value))}
                    />
                    <span style={{ fontSize: 13, color: 'var(--muted)' }}>px, long edge</span>
                  </div>
                </div>

                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    Max Batch Size
                  </div>
                  <div className="setting-desc" style={{ marginBottom: 12 }}>
                    Ceiling on jobs per Studio batch submission. Also sizes the row cap on the batch
                    catalogues view, so raising this stays consistent end-to-end.
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
                      maxWidth: 260,
                    }}
                  >
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={2000}
                      style={{ width: 100 }}
                      value={maxBatchJobs}
                      disabled={sysSaving}
                      onChange={(e) => setMaxBatchJobs(Number(e.target.value))}
                    />
                    <span style={{ fontSize: 13, color: 'var(--muted)' }}>jobs per batch</span>
                  </div>
                </div>

                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    Max Queue Depth
                  </div>
                  <div className="setting-desc" style={{ marginBottom: 12 }}>
                    Ceiling on QUEUED catalog/saree jobs system-wide. New Studio submissions are
                    rejected with "server is busy" once this many jobs are already waiting for a
                    worker, instead of being accepted and silently timing out 10 minutes later.
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
                      maxWidth: 260,
                    }}
                  >
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={5000}
                      style={{ width: 100 }}
                      value={maxQueueDepth}
                      disabled={sysSaving}
                      onChange={(e) => setMaxQueueDepth(Number(e.target.value))}
                    />
                    <span style={{ fontSize: 13, color: 'var(--muted)' }}>jobs queued</span>
                  </div>
                </div>

                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    GST Invoice — Seller Details
                  </div>
                  <div className="setting-desc" style={{ marginBottom: 12 }}>
                    Printed as the seller block on every customer GST invoice. Leave blank fields
                    empty on the invoice until filled in.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 420 }}>
                    <input
                      className="input"
                      placeholder="Seller GSTIN"
                      value={sellerGstin}
                      disabled={sysSaving}
                      onChange={(e) => setSellerGstin(e.target.value)}
                    />
                    <input
                      className="input"
                      placeholder="Legal business name"
                      value={sellerLegalName}
                      disabled={sysSaving}
                      onChange={(e) => setSellerLegalName(e.target.value)}
                    />
                    <textarea
                      className="input"
                      placeholder="Registered address"
                      value={sellerAddress}
                      disabled={sysSaving}
                      rows={3}
                      onChange={(e) => setSellerAddress(e.target.value)}
                    />
                    <input
                      className="input"
                      placeholder="PAN"
                      value={sellerPan}
                      disabled={sysSaving}
                      onChange={(e) => setSellerPan(e.target.value)}
                    />
                    <input
                      className="input"
                      placeholder="TAN"
                      value={sellerTan}
                      disabled={sysSaving}
                      onChange={(e) => setSellerTan(e.target.value)}
                    />
                    <input
                      className="input"
                      placeholder="Udyam Registration No."
                      value={sellerUdyamRegNo}
                      disabled={sysSaving}
                      onChange={(e) => setSellerUdyamRegNo(e.target.value)}
                    />
                  </div>
                </div>

                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    App Video
                  </div>
                  <div className="setting-desc" style={{ marginBottom: 12 }}>
                    Intro/promo clip served to the Android app via{' '}
                    <code>GET /v1/config/app-video</code>. Uploading a new file replaces the current
                    one immediately — no separate save step.
                  </div>
                  {appVideoLoading ? (
                    <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 16,
                        padding: 14,
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--r)',
                        background: 'var(--surface-2)',
                      }}
                    >
                      {appVideoUrl ? (
                        // biome-ignore lint/a11y/useMediaCaption: admin preview of an uploaded clip, not end-user content
                        <video
                          key={appVideoUrl}
                          src={appVideoUrl}
                          controls
                          style={{
                            width: 220,
                            aspectRatio: '9 / 16',
                            borderRadius: 6,
                            background: '#000',
                            flexShrink: 0,
                          }}
                        />
                      ) : (
                        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                          No video uploaded yet.
                        </div>
                      )}
                      <div>
                        <input
                          id="app-video-file-input"
                          type="file"
                          accept="video/mp4"
                          style={{ display: 'none' }}
                          disabled={appVideoUploading}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = '';
                            if (file) handleAppVideoUpload(file);
                          }}
                        />
                        <label
                          htmlFor="app-video-file-input"
                          className={`btn sm ${appVideoUploading ? '' : 'primary'}`}
                          style={{
                            cursor: appVideoUploading ? 'default' : 'pointer',
                            opacity: appVideoUploading ? 0.6 : 1,
                            pointerEvents: appVideoUploading ? 'none' : 'auto',
                          }}
                        >
                          <Icon.Upload />
                          {appVideoUploading
                            ? 'Uploading…'
                            : appVideoUrl
                              ? 'Upload new video'
                              : 'Upload video'}
                        </label>
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    Upload Limits
                    <button
                      type="button"
                      aria-expanded={uploadLimitsExpanded}
                      aria-controls="upload-limits-options"
                      aria-label={
                        uploadLimitsExpanded ? 'Collapse upload limits' : 'Expand upload limits'
                      }
                      onClick={() => setUploadLimitsExpanded((expanded) => !expanded)}
                      style={{
                        width: 26,
                        height: 26,
                        marginLeft: 8,
                        padding: 0,
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        background: 'var(--surface-2)',
                        color: 'var(--text)',
                        fontSize: 20,
                        lineHeight: 1,
                        cursor: 'pointer',
                        verticalAlign: 'middle',
                      }}
                    >
                      <span aria-hidden="true">{uploadLimitsExpanded ? '−' : '+'}</span>
                    </button>
                  </div>
                  {uploadLimitsExpanded && (
                    <div id="upload-limits-options">
                      <div className="setting-desc" style={{ marginBottom: 12 }}>
                        Maximum accepted file size per upload surface. Existing uploads already in
                        progress are unaffected; this only applies to uploads made after saving.
                      </div>
                      {(
                        [
                          ['merchantCatalogMaxBytes', 'Merchant catalogue (Android flat photo)'],
                          ['webGarmentMaxBytes', 'Studio / web garment upload'],
                          ['merchantTryonMaxBytes', 'Merchant try-on customer photo'],
                          ['devApiMaxBytes', 'Dev API upload'],
                          ['shopifyCatalogSourceMaxBytes', 'Shopify catalogue source image'],
                          ['shopifyCustomerPhotoMaxBytes', 'Shopify storefront customer photo'],
                          ['shopifyProductImageMaxBytes', 'Shopify product-image import'],
                          ['shopifyProductSyncMaxBytes', 'Shopify webhook product sync'],
                        ] as const
                      ).map(([key, label]) => (
                        <div
                          key={key}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 12,
                            padding: '10px 12px',
                            marginBottom: 8,
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--r)',
                            background: 'var(--surface-2)',
                          }}
                        >
                          <span className="setting-lbl">{label}</span>
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
                              min={0}
                              max={50}
                              step={0.1}
                              style={{ width: 80, textAlign: 'right' }}
                              value={uploadLimitsMb[key]}
                              disabled={sysSaving}
                              onChange={(e) =>
                                setUploadLimitsMb((prev) => ({
                                  ...prev,
                                  [key]: Number(e.target.value),
                                }))
                              }
                            />
                            <span style={{ fontSize: 13, color: 'var(--muted)' }}>MB</span>
                          </div>
                        </div>
                      ))}
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
                        <span className="setting-lbl">Admin bulk-import ZIP</span>
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
                            min={0}
                            max={3}
                            step={0.1}
                            style={{ width: 80, textAlign: 'right' }}
                            value={bulkImportMaxGb}
                            disabled={sysSaving}
                            onChange={(e) => setBulkImportMaxGb(Number(e.target.value))}
                          />
                          <span style={{ fontSize: 13, color: 'var(--muted)' }}>GB</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    Merchant Catalogue Defaults
                  </div>
                  <div className="setting-desc" style={{ marginBottom: 12 }}>
                    Fixed model/background used when a merchant generates a catalogue image from a
                    flat garment photo — guarantees every generated image is try-on-suitable.
                    <br />
                    Lower garment and shoe defaults are only applied when the assigned pose's
                    workflow needs one.
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '80px 1fr 1fr 1fr 1fr',
                      gap: 12,
                      alignItems: 'end',
                      marginBottom: 6,
                    }}
                  >
                    <span aria-hidden="true" />
                    {['Face', 'Background', 'Lower garment', 'Shoe'].map((heading) => (
                      <div
                        key={heading}
                        className="setting-lbl"
                        style={{ marginBottom: 0, paddingInline: 2 }}
                      >
                        {heading}
                      </div>
                    ))}
                  </div>
                  {(['men', 'women', 'boys', 'girls'] as const).map((cat) => (
                    <div
                      key={cat}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '80px 1fr 1fr 1fr 1fr',
                        gap: 12,
                        alignItems: 'center',
                        marginBottom: 10,
                      }}
                    >
                      <label style={{ textTransform: 'capitalize' }}>{cat}</label>
                      <SearchableSelect
                        options={modelFacesList.filter((f) => f.gender === cat)}
                        value={merchantCatalogDefaults[cat]?.faceId ?? ''}
                        disabled={sysSaving}
                        placeholder="— search face —"
                        onChange={(faceId) =>
                          setMerchantCatalogDefaults((prev) => ({
                            ...prev,
                            [cat]: {
                              ...prev[cat],
                              faceId,
                              backgroundId: prev[cat]?.backgroundId ?? '',
                            },
                          }))
                        }
                      />
                      <SearchableSelect
                        options={modelBackgroundsList}
                        value={merchantCatalogDefaults[cat]?.backgroundId ?? ''}
                        disabled={sysSaving}
                        placeholder="— search background —"
                        onChange={(backgroundId) =>
                          setMerchantCatalogDefaults((prev) => ({
                            ...prev,
                            [cat]: {
                              ...prev[cat],
                              faceId: prev[cat]?.faceId ?? '',
                              backgroundId,
                            },
                          }))
                        }
                      />
                      <SearchableSelect
                        options={catalogItemsList.filter(
                          (c) =>
                            c.type === 'lower' && (c.genderSlug == null || c.genderSlug === cat),
                        )}
                        value={merchantCatalogDefaults[cat]?.lowerCatalogId ?? ''}
                        disabled={sysSaving}
                        placeholder={'\u2014 search lower garment \u2014'}
                        emptyLabel={'\u2014 none / not needed \u2014'}
                        onChange={(lowerCatalogId) =>
                          setMerchantCatalogDefaults((prev) => ({
                            ...prev,
                            [cat]: {
                              ...prev[cat],
                              faceId: prev[cat]?.faceId ?? '',
                              backgroundId: prev[cat]?.backgroundId ?? '',
                              lowerCatalogId,
                            },
                          }))
                        }
                      />
                      <SearchableSelect
                        options={catalogItemsList.filter(
                          (c) =>
                            c.type === 'shoe' && (c.genderSlug == null || c.genderSlug === cat),
                        )}
                        value={merchantCatalogDefaults[cat]?.shoeCatalogId ?? ''}
                        disabled={sysSaving}
                        placeholder={'\u2014 search shoe \u2014'}
                        emptyLabel={'\u2014 none / not needed \u2014'}
                        onChange={(shoeCatalogId) =>
                          setMerchantCatalogDefaults((prev) => ({
                            ...prev,
                            [cat]: {
                              ...prev[cat],
                              faceId: prev[cat]?.faceId ?? '',
                              backgroundId: prev[cat]?.backgroundId ?? '',
                              shoeCatalogId,
                            },
                          }))
                        }
                      />
                    </div>
                  ))}
                  <div style={{ maxWidth: 200 }}>
                    <div className="setting-lbl" style={{ marginBottom: 4 }}>
                      Aspect ratio
                    </div>
                    <select
                      className="select"
                      value={merchantCatalogAspectRatio}
                      disabled={sysSaving}
                      onChange={(e) => setMerchantCatalogAspectRatio(e.target.value)}
                    >
                      <option value="1:1">1:1</option>
                      <option value="2:3">2:3</option>
                      <option value="3:4">3:4</option>
                      <option value="4:5">4:5</option>
                    </select>
                  </div>
                </div>

                <div className="setting-actions">
                  <button
                    className="btn primary"
                    onClick={saveSysConfig}
                    disabled={
                      sysSaving ||
                      !Number.isInteger(maxOutputPx) ||
                      maxOutputPx < 512 ||
                      maxOutputPx > 4096 ||
                      !Number.isInteger(maxBatchJobs) ||
                      maxBatchJobs < 1 ||
                      maxBatchJobs > 2000 ||
                      !Number.isInteger(maxQueueDepth) ||
                      maxQueueDepth < 1 ||
                      maxQueueDepth > 5000
                    }
                  >
                    {sysSaving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Session */}
      {section === 'session' && (
        <div className="card settings-card">
          <div className="card-head">
            <h3>
              <Icon.Logout /> Session
            </h3>
          </div>
          <div className="card-body">
            <div className="setting-row">
              <div>
                <div className="setting-lbl">Sign out</div>
                <div className="setting-desc">End your current admin session.</div>
              </div>
              <button className="btn danger" onClick={() => logout()}>
                <Icon.Logout /> Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      {campaignModal.open && (
        <CampaignModal
          campaign={campaignModal.campaign}
          onSaved={handleCampaignSaved}
          onClose={() => setCampaignModal({ open: false, campaign: null })}
          toast={toast}
        />
      )}

      {confirmDeleteCampaign && (
        <ConfirmModal
          title="Delete campaign"
          body={`Are you sure you want to delete "${confirmDeleteCampaign.name}"? This cannot be undone.`}
          what={`code: ${confirmDeleteCampaign.code}`}
          danger
          confirmLabel={deletingCampaign ? 'Deleting…' : 'Delete'}
          onConfirm={handleDeleteCampaign}
          onClose={() => setConfirmDeleteCampaign(null)}
        />
      )}
    </>
  );
}
