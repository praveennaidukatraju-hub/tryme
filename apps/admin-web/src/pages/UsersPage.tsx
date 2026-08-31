import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { EditDrawer } from '../components/EditDrawer';
import { Icon } from '../components/Icons';
import { KV } from '../components/KV';
import { NameAvatar } from '../components/NameAvatar';
import { Pager } from '../components/Pager';
import { SearchableSelect } from '../components/SearchableSelect';
import { StatusBadge } from '../components/StatusBadge';
import type { SortDir } from '../components/Th';
import { Th } from '../components/Th';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage, apiFetch, apiFetchBlob } from '../lib/data';
import type { CreditLedgerEntry, CreditPlan, User } from '../types';

const PAGE_SIZE = 20;

const EMPTY_GRANT_MERCHANT_FORM = {
  companyName: '',
  contactName: '',
  phone: '',
  businessAddress: '',
};
const EMPTY_EDIT_MERCHANT_FORM = {
  companyName: '',
  contactName: '',
  phone: '',
  businessAddress: '',
  jobRateLimitPerMin: '',
};
const EMPTY_CREATE_USER_FORM = {
  username: '',
  password: '',
  displayName: '',
  email: '',
  phone: '',
};

function adminRoleLabel(role: string | null) {
  if (role === 'SUPER_ADMIN') return 'Super Admin';
  if (role === 'MODERATOR') return 'Moderator';
  if (role === 'SUPPORT') return 'Support';
  return 'Admin';
}
function userLabel(u: {
  displayName: string | null;
  email: string | null;
  username: string | null;
}) {
  return u.displayName ?? u.email ?? u.username ?? 'User';
}
function userContact(u: { email: string | null; username: string | null }) {
  return u.email ?? (u.username ? `@${u.username}` : '\u2014');
}

interface Props {
  onNav: (
    _page: string,
    _filter?: {
      page: string;
      filter?: string;
      search?: string;
      jobId?: string;
      fromUserId?: string;
    },
  ) => void;
  toast: (t: { kind?: 'error' | 'warning' | 'success'; title: string; body?: string }) => void;
}

export default function UsersPage({ onNav, toast }: Props) {
  const location = useLocation();
  const requestedUserId = (location.state as { userId?: string })?.userId;
  const { role: myRole } = useAuth();
  const isSuperAdmin = myRole === 'SUPER_ADMIN';
  const [query, setQuery] = useState('');
  const [merchantsOnly, setMerchantsOnly] = useState(false);
  const [showBanned, setShowBanned] = useState(false);
  const [planFilter, setPlanFilter] = useState('');
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<keyof User>('createdAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<User | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmSuspend, setConfirmSuspend] = useState<string | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deletingUser, setDeletingUser] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [grantUserId, setGrantUserId] = useState<string | null>(null);
  const [grantMode, setGrantMode] = useState<'grant' | 'deduct'>('grant');
  const [grantAmount, setGrantAmount] = useState('');
  const [grantReason, setGrantReason] = useState('');
  const [granting, setGranting] = useState(false);
  const [adminActioning, setAdminActioning] = useState(false);
  const [tierOptions, setTierOptions] = useState<string[]>([]);
  const [selectedTier, setSelectedTier] = useState('');
  const [tierSaving, setTierSaving] = useState(false);
  const [selectedMaxDevices, setSelectedMaxDevices] = useState('1');
  const [deviceLimitSaving, setDeviceLimitSaving] = useState(false);
  const [editingAccountField, setEditingAccountField] = useState<'plan' | 'devices' | null>(null);
  const [showGrantMerchant, setShowGrantMerchant] = useState(false);
  const [grantMerchantForm, setGrantMerchantForm] = useState(EMPTY_GRANT_MERCHANT_FORM);
  const [grantingMerchant, setGrantingMerchant] = useState(false);
  const [showEditMerchant, setShowEditMerchant] = useState(false);
  const [merchantEditForm, setMerchantEditForm] = useState(EMPTY_EDIT_MERCHANT_FORM);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [savingMerchantEdit, setSavingMerchantEdit] = useState(false);
  const [togglingMerchant, setTogglingMerchant] = useState(false);
  const [togglingDemoData, setTogglingDemoData] = useState(false);
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [createUserForm, setCreateUserForm] = useState(EMPTY_CREATE_USER_FORM);
  const [creatingUser, setCreatingUser] = useState(false);
  const [createUserError, setCreateUserError] = useState('');
  const [resettingPassword, setResettingPassword] = useState(false);
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [creditActivity, setCreditActivity] = useState<CreditLedgerEntry[]>([]);
  const [creditActivityLoading, setCreditActivityLoading] = useState(false);
  const [showAllCreditActivity, setShowAllCreditActivity] = useState(false);
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');
  const [exportSortDir, setExportSortDir] = useState<'asc' | 'desc'>('desc');
  const [exportingFormat, setExportingFormat] = useState<'pdf' | 'xlsx' | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [menuOpen]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page + 1), pageSize: String(PAGE_SIZE) });
      if (query) params.set('search', query);
      if (merchantsOnly) params.set('merchant', 'true');
      if (showBanned) params.set('showBanned', 'true');
      if (exportFrom) params.set('createdFrom', exportFrom);
      if (exportTo) params.set('createdTo', exportTo);
      if (planFilter) params.set('tier', planFilter);
      const data = await apiFetch<{ items: User[]; total: number }>(`/admin/users?${params}`);
      setUsers(data.items);
      setTotal(data.total);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to load users',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setLoading(false);
    }
  }, [page, query, merchantsOnly, showBanned, exportFrom, exportTo, planFilter, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    apiFetch<CreditPlan[]>('/admin/credit-plans')
      .then((rows) => setTierOptions(rows.filter((plan) => plan.isActive).map((plan) => plan.slug)))
      .catch((e) =>
        toast({
          kind: 'error',
          title: 'Failed to load credit plan tiers',
          body: apiErrorMessage(e, 'Please try again.'),
        }),
      );
  }, [toast]);

  const handleSearch = (q: string) => {
    setQuery(q);
    setPage(0);
  };

  const handleExport = async (format: 'pdf' | 'xlsx') => {
    setExportingFormat(format);
    try {
      const params = new URLSearchParams({ sortDir: exportSortDir });
      if (query) params.set('search', query);
      if (merchantsOnly) params.set('merchant', 'true');
      if (showBanned) params.set('showBanned', 'true');
      if (exportFrom) params.set('createdFrom', exportFrom);
      if (exportTo) params.set('createdTo', exportTo);
      if (planFilter) params.set('tier', planFilter);
      const blob = await apiFetchBlob(`/admin/users/export.${format}?${params}`);
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `users-export-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
    } catch (e) {
      toast({
        kind: 'error',
        title: `Failed to export users (${format.toUpperCase()})`,
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setExportingFormat(null);
    }
  };

  const sorted = [...users].sort((a, b) => {
    const aVal = a[sortKey] ?? '';
    const bVal = b[sortKey] ?? '';
    const cmp =
      typeof aVal === 'string'
        ? aVal.localeCompare(bVal as string)
        : (aVal as number) - (bVal as number);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handleSort = (k: keyof User) => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(k);
      setSortDir('asc');
    }
  };

  const loadCreditActivity = useCallback(
    async (userId: string) => {
      setCreditActivityLoading(true);
      try {
        const rows = await apiFetch<CreditLedgerEntry[]>(`/admin/credits/ledger/${userId}`);
        setCreditActivity(rows);
      } catch (e) {
        toast({
          kind: 'error',
          title: 'Failed to load credit activity',
          body: apiErrorMessage(e, 'Please try again.'),
        });
      } finally {
        setCreditActivityLoading(false);
      }
    },
    [toast],
  );

  const openDetail = async (u: User) => {
    setDetail(u);
    setSelectedTier(u.tier);
    setSelectedMaxDevices(String(u.maxActiveDevices ?? 1));
    setShowAllCreditActivity(false);
    setDetailLoading(true);
    try {
      const [full] = await Promise.all([
        apiFetch<User>(`/admin/users/${u.id}`),
        loadCreditActivity(u.id),
      ]);
      setDetail(full);
      setSelectedTier(full.tier);
      setSelectedMaxDevices(String(full.maxActiveDevices ?? 1));
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to load user detail',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    if (!requestedUserId) return;
    let cancelled = false;
    setDetailLoading(true);
    Promise.all([
      apiFetch<User>(`/admin/users/${requestedUserId}`),
      loadCreditActivity(requestedUserId),
    ])
      .then(([full]) => {
        if (cancelled) return;
        setDetail(full);
        setSelectedTier(full.tier);
        setSelectedMaxDevices(String(full.maxActiveDevices ?? 1));
        setShowAllCreditActivity(false);
      })
      .catch((e) => {
        if (!cancelled)
          toast({
            kind: 'error',
            title: 'Failed to load user detail',
            body: apiErrorMessage(e, 'Please try again.'),
          });
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requestedUserId, loadCreditActivity, toast]);

  const openAdjustCredits = () => {
    if (!detail) return;
    setGrantUserId(detail.id);
    setGrantMode('grant');
    setGrantAmount('');
    setGrantReason('');
  };

  const closeAdjustCredits = () => {
    setGrantUserId(null);
    setGrantMode('grant');
    setGrantAmount('');
    setGrantReason('');
  };

  const openPlanEditor = () => {
    if (!detail) return;
    setSelectedTier(detail.tier);
    setEditingAccountField('plan');
  };

  const openDeviceLimitEditor = () => {
    if (!detail) return;
    setSelectedMaxDevices(String(detail.maxActiveDevices ?? 1));
    setEditingAccountField('devices');
  };

  const closeAccountFieldEditor = () => {
    if (detail) {
      setSelectedTier(detail.tier);
      setSelectedMaxDevices(String(detail.maxActiveDevices ?? 1));
    }
    setEditingAccountField(null);
  };

  const handleSuspendConfirm = async () => {
    if (!confirmSuspend || !detail) return;
    const willBan = !detail.isBanned;
    try {
      await apiFetch(`/admin/users/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isBanned: willBan }),
      });
      setDetail({ ...detail, isBanned: willBan });
      setUsers((prev) => prev.map((u) => (u.id === detail.id ? { ...u, isBanned: willBan } : u)));
      toast({ title: `User ${willBan ? 'suspended' : 'unsuspended'}` });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Action failed',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
    setConfirmSuspend(null);
  };

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return;
    const targetId = confirmDelete;
    setDeletingUser(true);
    try {
      await apiFetch(`/admin/users/${targetId}`, { method: 'DELETE' });
      if (detail?.id === targetId) setDetail(null);
      toast({ title: 'User data erased' });
      await load();
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Action failed',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setDeletingUser(false);
      setConfirmDelete(null);
    }
  };

  const handleBulkDeleteConfirm = async () => {
    if (selectedUserIds.length === 0) return;
    setBulkDeleting(true);
    try {
      const res = await apiFetch<{
        succeeded: string[];
        skipped: { id: string; reason: string }[];
      }>('/admin/users/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ ids: selectedUserIds }),
      });
      const succLen = res.succeeded.length;
      const skipLen = res.skipped.length;
      toast({
        title: `Erased ${succLen}, skipped ${skipLen}`,
        body:
          skipLen > 0
            ? res.skipped
                .map((s) => {
                  const u = users.find((x) => x.id === s.id);
                  return `${u ? (u.email ?? userLabel(u)) : s.id}: ${s.reason}`;
                })
                .join(', ')
            : undefined,
      });
      setSelectedUserIds([]);
      await load();
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Bulk delete failed',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setBulkDeleting(false);
      setShowBulkDeleteConfirm(false);
    }
  };

  const handleTierSave = async () => {
    if (!detail || !selectedTier || selectedTier === detail.tier) return;
    setTierSaving(true);
    try {
      await apiFetch(`/admin/users/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ tier: selectedTier }),
      });
      setDetail((prev) => (prev ? { ...prev, tier: selectedTier } : null));
      setUsers((prev) =>
        prev.map((user) => (user.id === detail.id ? { ...user, tier: selectedTier } : user)),
      );
      toast({ title: 'User tier updated' });
      setEditingAccountField(null);
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Failed to update tier',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setTierSaving(false);
    }
  };

  const handleDeviceLimitSave = async () => {
    if (!detail) return;
    const maxActiveDevices = parseInt(selectedMaxDevices, 10);
    if (Number.isNaN(maxActiveDevices) || maxActiveDevices < 1 || maxActiveDevices > 50) {
      toast({ kind: 'error', title: 'Device limit must be between 1 and 50' });
      return;
    }
    if (maxActiveDevices === detail.maxActiveDevices) return;
    setDeviceLimitSaving(true);
    try {
      await apiFetch(`/admin/users/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ maxActiveDevices }),
      });
      setDetail((prev) => (prev ? { ...prev, maxActiveDevices } : null));
      setUsers((prev) =>
        prev.map((user) => (user.id === detail.id ? { ...user, maxActiveDevices } : user)),
      );
      toast({ title: 'Device limit updated' });
      setEditingAccountField(null);
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Failed to update device limit',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setDeviceLimitSaving(false);
    }
  };

  const handleGrant = async () => {
    if (!grantUserId || !grantAmount) return;
    const amt = parseInt(grantAmount, 10);
    if (Number.isNaN(amt) || amt < 1) return;
    setGranting(true);
    try {
      if (grantMode === 'grant') {
        const body = {
          userId: grantUserId,
          amount: amt,
          reason: grantReason.trim() || 'Manual credit grant',
        };
        await apiFetch('/admin/credits/grant', { method: 'POST', body: JSON.stringify(body) });
        setDetail((prev) => (prev ? { ...prev, balance: prev.balance + amt } : null));
        setUsers((prev) =>
          prev.map((u) => (u.id === grantUserId ? { ...u, balance: u.balance + amt } : u)),
        );
        toast({ title: `Granted ${amt.toLocaleString()} credits` });
      } else {
        const body = {
          userId: grantUserId,
          amount: amt,
          reason: grantReason.trim() || 'Manual credit deduction',
        };
        await apiFetch('/admin/credits/deduct', { method: 'POST', body: JSON.stringify(body) });
        setDetail((prev) => (prev ? { ...prev, balance: prev.balance - amt } : null));
        setUsers((prev) =>
          prev.map((u) => (u.id === grantUserId ? { ...u, balance: u.balance - amt } : u)),
        );
        toast({ title: `Deducted ${amt.toLocaleString()} credits` });
      }
      void loadCreditActivity(grantUserId);
      closeAdjustCredits();
    } catch (err) {
      toast({
        kind: 'error',
        title: grantMode === 'grant' ? 'Failed to grant credits' : 'Failed to deduct credits',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setGranting(false);
    }
  };

  function openGrantMerchant() {
    setGrantMerchantForm(EMPTY_GRANT_MERCHANT_FORM);
    setShowGrantMerchant(true);
  }

  async function handleGrantMerchant() {
    if (!detail || !grantMerchantForm.companyName.trim()) return;
    setGrantingMerchant(true);
    try {
      await apiFetch('/admin/merchants', {
        method: 'POST',
        body: JSON.stringify({
          userId: detail.id,
          companyName: grantMerchantForm.companyName.trim(),
          contactName: grantMerchantForm.contactName.trim() || undefined,
          phone: grantMerchantForm.phone.trim() || undefined,
          businessAddress: grantMerchantForm.businessAddress.trim() || undefined,
        }),
      });
      toast({ title: `Merchant access granted to ${userLabel(detail)}` });
      setShowGrantMerchant(false);
      await openDetail(detail);
      setUsers((prev) => prev.map((u) => (u.id === detail.id ? { ...u, isMerchant: true } : u)));
    } catch (err) {
      toast({ kind: 'error', title: apiErrorMessage(err, 'Failed to grant merchant access') });
    } finally {
      setGrantingMerchant(false);
    }
  }

  function openEditMerchant() {
    if (!detail?.merchant) return;
    const m = detail.merchant;
    setMerchantEditForm({
      companyName: m.companyName,
      contactName: m.contactName,
      phone: m.phone,
      businessAddress: m.businessAddress,
      jobRateLimitPerMin: m.jobRateLimitPerMin != null ? String(m.jobRateLimitPerMin) : '',
    });
    setShowEditMerchant(true);
  }

  async function handleMerchantEditSave() {
    if (!detail?.merchant) return;
    setSavingMerchantEdit(true);
    try {
      const trimmedLimit = merchantEditForm.jobRateLimitPerMin.trim();
      await apiFetch(`/admin/merchants/${detail.merchant.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          companyName: merchantEditForm.companyName,
          contactName: merchantEditForm.contactName,
          phone: merchantEditForm.phone,
          businessAddress: merchantEditForm.businessAddress,
          jobRateLimitPerMin: trimmedLimit === '' ? null : Number(trimmedLimit),
        }),
      });
      toast({ title: 'Merchant details updated' });
      setShowEditMerchant(false);
      await openDetail(detail);
    } catch (err) {
      toast({ kind: 'error', title: apiErrorMessage(err, 'Failed to update merchant') });
    } finally {
      setSavingMerchantEdit(false);
    }
  }
  async function handleLogoUpload(file: File) {
    if (!detail?.merchant) return;
    setUploadingLogo(true);
    try {
      const presign = await apiFetch<{ uploadUrl: string; logoKey: string }>(
        `/admin/merchants/${detail.merchant.id}/logo/presign`,
        { method: 'POST', body: JSON.stringify({ contentType: file.type }) },
      );
      await fetch(presign.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      await apiFetch(`/admin/merchants/${detail.merchant.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ logoKey: presign.logoKey }),
      });
      toast({ title: 'Merchant logo updated' });
      await openDetail(detail);
    } catch (err) {
      toast({ kind: 'error', title: apiErrorMessage(err, 'Failed to upload logo') });
    } finally {
      setUploadingLogo(false);
    }
  }

  async function handleToggleMerchantActive() {
    if (!detail?.merchant) return;
    setTogglingMerchant(true);
    try {
      await apiFetch(`/admin/merchants/${detail.merchant.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !detail.merchant.isActive }),
      });
      toast({ title: `Merchant access ${detail.merchant.isActive ? 'revoked' : 'reactivated'}` });
      await openDetail(detail);
    } catch (err) {
      toast({ kind: 'error', title: apiErrorMessage(err, 'Failed to update merchant') });
    } finally {
      setTogglingMerchant(false);
    }
  }

  async function handleToggleMerchantDemoData() {
    if (!detail?.merchant) return;
    setTogglingDemoData(true);
    try {
      await apiFetch(`/admin/merchants/${detail.merchant.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ demoData: !detail.merchant.demoData }),
      });
      toast({
        title: `Demo data ${detail.merchant.demoData ? 'disabled' : 'enabled'}`,
      });
      await openDetail(detail);
    } catch (err) {
      toast({ kind: 'error', title: apiErrorMessage(err, 'Failed to update demo data access') });
    } finally {
      setTogglingDemoData(false);
    }
  }

  function openCreateUser() {
    setCreateUserForm(EMPTY_CREATE_USER_FORM);
    setCreateUserError('');
    setShowCreateUser(true);
  }

  async function handleCreateUser() {
    setCreateUserError('');
    if (
      !createUserForm.username.trim() ||
      !createUserForm.password ||
      !createUserForm.displayName.trim()
    ) {
      setCreateUserError('Username, password, and name are required.');
      return;
    }
    setCreatingUser(true);
    try {
      await apiFetch('/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: createUserForm.username.trim(),
          password: createUserForm.password,
          displayName: createUserForm.displayName.trim(),
          email: createUserForm.email.trim() || undefined,
          phone: createUserForm.phone.trim() || undefined,
        }),
      });
      toast({ title: `Account created for ${createUserForm.displayName.trim()}` });
      setShowCreateUser(false);
      setPage(0);
      await load();
    } catch (err) {
      setCreateUserError(apiErrorMessage(err, 'Failed to create user'));
    } finally {
      setCreatingUser(false);
    }
  }

  async function handleResetPassword(newPassword: string) {
    if (!detail) return;
    await apiFetch(`/admin/users/${detail.id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    });
    if (detail.isAdmin) {
      toast({
        kind: 'warning',
        title: 'Password reset \u2014 admin panel access not yet updated',
        body: `${userLabel(detail)} is also an active admin. Use "Sync Admin Password" to update their admin.tryme.com login too.`,
      });
    } else {
      toast({ title: 'Password reset \u2014 share the new password with the customer' });
    }
  }

  async function syncAdminPassword(u: User) {
    setAdminActioning(true);
    try {
      await apiFetch(`/admin/admin-users/${u.id}/sync-password`, { method: 'POST' });
      toast({ title: `${userLabel(u)}'s admin panel password now matches their account password` });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to sync admin password',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setAdminActioning(false);
    }
  }

  async function assignAdminRole(u: User, role: string) {
    setAdminActioning(true);
    try {
      await apiFetch('/admin/admin-users', {
        method: 'POST',
        body: JSON.stringify({ userId: u.id, role }),
      });
      setDetail((prev) => prev && { ...prev, isAdmin: true, adminRole: role });
      setUsers((prev) =>
        prev.map((x) => (x.id === u.id ? { ...x, isAdmin: true, adminRole: role } : x)),
      );
      toast({ title: `${userLabel(u)} set to ${adminRoleLabel(role)}` });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to update admin role',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setAdminActioning(false);
    }
  }

  async function revokeAdminRole(u: User) {
    setAdminActioning(true);
    try {
      await apiFetch(`/admin/admin-users/${u.id}`, { method: 'DELETE' });
      setDetail((prev) => prev && { ...prev, isAdmin: false, adminRole: null });
      setUsers((prev) =>
        prev.map((x) => (x.id === u.id ? { ...x, isAdmin: false, adminRole: null } : x)),
      );
      toast({ title: `${userLabel(u)} admin access revoked` });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to revoke admin access',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setAdminActioning(false);
    }
  }

  if (detail) {
    const u = detail;
    const effectiveTierOptions =
      selectedTier && !tierOptions.includes(selectedTier)
        ? [selectedTier, ...tierOptions]
        : tierOptions;

    return (
      <>
        <div className="page-head">
          <div>
            <button className="btn ghost" onClick={() => setDetail(null)}>
              <Icon.Back /> Back to users
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 12 }}>
              <NameAvatar name={userLabel(u)} email={u.email ?? undefined} size={44} />
              <div>
                <h1 style={{ marginBottom: 2 }}>{userLabel(u)}</h1>
                <p className="lede" style={{ margin: 0 }}>
                  {userContact(u)}
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
              {u.isAdmin && <span className="badge accent">{adminRoleLabel(u.adminRole)}</span>}
              {u.isMerchant && <span className="badge success">Merchant</span>}
              {u.hasShopifyStore && <span className="badge success">Shopify</span>}
              {!u.hasPassword && <span className="badge info">Google account</span>}
              {u.isBanned ? (
                <span className="badge danger dot">Suspended</span>
              ) : (
                <span className="badge success dot">Active</span>
              )}
            </div>
          </div>
          <div className="head-tools">
            <button
              className="btn ghost"
              onClick={() => {
                setNewPasswordInput('');
                setResettingPassword(true);
              }}
            >
              <Icon.Refresh /> Reset Password
            </button>
            {isSuperAdmin && u.isAdmin && (
              <button
                className="btn ghost"
                disabled={adminActioning}
                onClick={() => void syncAdminPassword(u)}
              >
                <Icon.Refresh /> Sync Admin Password
              </button>
            )}
            {isSuperAdmin && u.adminRole !== 'SUPER_ADMIN' && (u.isAdmin || u.hasPassword) && (
              <select
                className="input"
                value={u.isAdmin ? (u.adminRole ?? 'ADMIN') : 'NONE'}
                disabled={adminActioning}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next === 'NONE') void revokeAdminRole(u);
                  else void assignAdminRole(u, next);
                }}
                title="Admin role"
                style={{ width: 'auto', height: 36 }}
              >
                <option value="NONE">Not admin</option>
                <option value="ADMIN">Admin</option>
                <option value="MODERATOR">Moderator</option>
                <option value="SUPPORT">Support</option>
              </select>
            )}
            {!u.isAdmin && (
              <button className="btn danger" onClick={() => setConfirmSuspend(u.id)}>
                <Icon.Ban /> {u.isBanned ? 'Unsuspend' : 'Suspend'}
              </button>
            )}
            {isSuperAdmin && !u.isAdmin && (
              <button className="btn danger" onClick={() => setConfirmDelete(u.id)}>
                <Icon.Trash /> Delete
              </button>
            )}
          </div>
        </div>

        {detailLoading ? (
          <p className="sub" style={{ textAlign: 'center', padding: '48px 0' }}>
            Loading user data&hellip;
          </p>
        ) : (
          <>
            <div className="stat-grid">
              <button className="stat" onClick={openPlanEditor} title="Change credit plan">
                <div className="lbl">
                  <Icon.Credit /> Current plan
                </div>
                <div className="val" style={{ textTransform: 'capitalize' }}>
                  {u.tier}
                </div>
                <div className="delta">
                  Change plan <Icon.Chevron />
                </div>
              </button>
              <button className="stat" onClick={openAdjustCredits} title="Adjust credits">
                <div className="lbl">
                  <Icon.Coin /> Credit balance
                </div>
                <div className="val">{u.balance.toLocaleString()}</div>
                <div className="delta">
                  Adjust credits <Icon.Chevron />
                </div>
              </button>
              <button
                className="stat"
                onClick={() => onNav('jobs', { page: 'jobs', search: u.email ?? u.username ?? '' })}
                title="View this user's jobs"
              >
                <div className="lbl">
                  <Icon.Activity /> Jobs generated
                </div>
                <div className="val">{(u.totalJobs ?? 0).toLocaleString()}</div>
              </button>
              <button
                className="stat"
                onClick={openDeviceLimitEditor}
                title="Change active device limit"
              >
                <div className="lbl">
                  <Icon.Monitor /> Device limit
                </div>
                <div className="val">{u.maxActiveDevices}</div>
                <div className="delta">
                  Change limit <Icon.Chevron />
                </div>
              </button>
            </div>

            <div className="card">
              <div className="card-head">
                <h3>Account details</h3>
              </div>
              <div className="card-body">
                <div className="kv-grid">
                  <KV k="Phone" v={u.phone ? `+91 ${u.phone}` : 'Not provided'} />
                  <KV
                    k="Authentication"
                    v={u.hasPassword ? 'Email and password' : 'Google account'}
                  />
                  <KV k="Joined" v={new Date(u.createdAt).toLocaleString()} />
                  <KV
                    k="Last job"
                    v={u.lastJobAt ? new Date(u.lastJobAt).toLocaleString() : 'No activity'}
                  />
                  <KV
                    k="User ID"
                    v={
                      <span title={u.id}>
                        {u.id.slice(0, 8)}…{u.id.slice(-6)}
                      </span>
                    }
                    mono
                  />
                  {u.isBanned && <KV k="Suspension" v={u.banReason || 'No reason provided'} />}
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h3>Merchant access</h3>
                {u.merchant && (
                  <div className="tools">
                    <button className="btn sm ghost" onClick={openEditMerchant}>
                      <Icon.Edit /> Edit
                    </button>
                    <button
                      className={`btn sm ${u.merchant.isActive ? 'danger' : 'primary'}`}
                      disabled={togglingMerchant}
                      onClick={() => void handleToggleMerchantActive()}
                    >
                      {togglingMerchant ? 'Saving…' : u.merchant.isActive ? 'Revoke' : 'Reactivate'}
                    </button>
                  </div>
                )}
              </div>
              <div className="card-body">
                {!u.merchant ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <span
                      style={{
                        display: 'grid',
                        placeItems: 'center',
                        width: 38,
                        height: 38,
                        borderRadius: 10,
                        background: 'var(--surface-2)',
                        color: 'var(--muted-2)',
                        flexShrink: 0,
                      }}
                    >
                      <Icon.Shield />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="semi">No merchant access</div>
                      <div className="sub">
                        Grant access to seed a product catalogue for mobile try-on.
                      </div>
                    </div>
                    <button className="btn primary" onClick={openGrantMerchant}>
                      Grant access
                    </button>
                  </div>
                ) : (
                  <div className="kv-grid-3-col">
                    <KV
                      k="Status"
                      v={<StatusBadge status={u.merchant.isActive ? 'active' : 'inactive'} />}
                    />
                    <KV k="Company" v={u.merchant.companyName} />
                    <KV k="Contact" v={u.merchant.contactName || '—'} />
                    <KV k="Phone" v={u.merchant.phone || '—'} />
                    <KV
                      k="Demo data"
                      v={
                        <label
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 8,
                            cursor: isSuperAdmin && !togglingDemoData ? 'pointer' : 'not-allowed',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={u.merchant.demoData}
                            disabled={!isSuperAdmin || togglingDemoData}
                            onChange={() => void handleToggleMerchantDemoData()}
                          />
                          <span>{u.merchant.demoData ? 'Enabled' : 'Disabled'}</span>
                        </label>
                      }
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="card" style={{ overflow: 'hidden' }}>
              <div className="card-head">
                <div>
                  <h3>Credit activity</h3>
                  <span className="sub">
                    {showAllCreditActivity
                      ? `All ${creditActivity.length} ledger entries`
                      : 'Latest five ledger entries'}
                  </span>
                </div>
                {creditActivity.length > 5 && (
                  <button
                    className="btn sm ghost"
                    onClick={() => setShowAllCreditActivity((v) => !v)}
                  >
                    {showAllCreditActivity ? 'Show less' : `Show all (${creditActivity.length})`}{' '}
                    <Icon.Chevron />
                  </button>
                )}
              </div>
              <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Reason</th>
                      <th>Delta</th>
                      <th>Job</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {creditActivityLoading ? (
                      <tr>
                        <td
                          colSpan={4}
                          style={{ textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}
                        >
                          Loading&hellip;
                        </td>
                      </tr>
                    ) : creditActivity.length ? (
                      (showAllCreditActivity ? creditActivity : creditActivity.slice(0, 5)).map(
                        (l) => (
                          <tr key={l.id}>
                            <td>{l.reason}</td>
                            <td>
                              <span
                                className="mono"
                                style={{
                                  color: l.delta < 0 ? 'var(--danger)' : 'var(--success, #4caf50)',
                                }}
                              >
                                {l.delta > 0 ? '+' : ''}
                                {l.delta.toLocaleString()}
                              </span>
                            </td>
                            <td>
                              {l.jobId ? (
                                <span
                                  className="mono sub"
                                  style={{ cursor: 'pointer' }}
                                  title="Open job details"
                                  onClick={() => {
                                    const jobId = l.jobId as string;
                                    onNav('jobs', {
                                      page: 'jobs',
                                      search: jobId,
                                      jobId,
                                      fromUserId: detail.id,
                                    });
                                  }}
                                >
                                  {l.jobId.slice(0, 8)}&hellip;
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td>{new Date(l.createdAt).toLocaleString()}</td>
                          </tr>
                        ),
                      )
                    ) : (
                      <tr>
                        <td
                          colSpan={4}
                          style={{ textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}
                        >
                          No credit activity.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {resettingPassword && (
          <EditDrawer
            onClose={() => setResettingPassword(false)}
            title="Reset Password"
            width="min(420px, calc(100vw - 40px))"
            onSave={async () => {
              await handleResetPassword(newPasswordInput);
              setResettingPassword(false);
            }}
            saveLabel="Reset Password"
            saveDisabled={!newPasswordInput}
          >
            <div className="field">
              <label>New password</label>
              <input
                className="input"
                type="password"
                value={newPasswordInput}
                onChange={(e) => setNewPasswordInput(e.target.value)}
                placeholder="At least 8 characters with a letter and number"
              />
            </div>
          </EditDrawer>
        )}

        {confirmSuspend && (
          <div className="modal-overlay" onClick={() => setConfirmSuspend(null)}>
            <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h3>{u.isBanned ? 'Unsuspend' : 'Suspend'} user</h3>
              </div>
              <div className="modal-body">
                <p>
                  Are you sure you want to {u.isBanned ? 'unsuspend' : 'suspend'}{' '}
                  <strong>{userLabel(u)}</strong>?
                </p>
              </div>
              <div className="modal-foot">
                <button className="btn ghost" onClick={() => setConfirmSuspend(null)}>
                  Cancel
                </button>
                <button className="btn danger" onClick={handleSuspendConfirm}>
                  Confirm
                </button>
              </div>
            </div>
          </div>
        )}

        {confirmDelete && (
          <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
            <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h3>Delete user</h3>
              </div>
              <div className="modal-body">
                <p>
                  Permanently erase personal data for{' '}
                  <strong>
                    {(() => {
                      const u = confirmDelete
                        ? detail?.id === confirmDelete
                          ? detail
                          : users.find((x) => x.id === confirmDelete)
                        : null;
                      return u ? (u.email ?? userLabel(u)) : 'this user';
                    })()}
                  </strong>
                  ? This cannot be undone. Their job and payment history will be retained but
                  anonymized.
                </p>
              </div>
              <div className="modal-foot">
                <button
                  className="btn ghost"
                  onClick={() => setConfirmDelete(null)}
                  disabled={deletingUser}
                >
                  Cancel
                </button>
                <button
                  className="btn danger"
                  onClick={handleDeleteConfirm}
                  disabled={deletingUser}
                >
                  {deletingUser ? 'Erasing…' : 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        )}

        {editingAccountField && (
          <div className="modal-overlay" onClick={closeAccountFieldEditor}>
            <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h3>
                  {editingAccountField === 'plan' ? 'Change credit plan' : 'Change device limit'}
                </h3>
              </div>
              <div className="modal-body">
                {editingAccountField === 'plan' ? (
                  <div className="field">
                    <label htmlFor="user-credit-plan">Credit plan</label>
                    <SearchableSelect
                      id="user-credit-plan"
                      options={effectiveTierOptions.map((slug) => ({ id: slug, label: slug }))}
                      value={selectedTier}
                      disabled={tierSaving}
                      placeholder="— search plan —"
                      onChange={setSelectedTier}
                    />
                    <span className="hint">
                      This changes the account's pricing and credit-plan entitlement.
                    </span>
                  </div>
                ) : (
                  <div className="field">
                    <label htmlFor="user-device-limit">Active device limit</label>
                    <input
                      id="user-device-limit"
                      className="input"
                      type="number"
                      min={1}
                      max={50}
                      value={selectedMaxDevices}
                      disabled={deviceLimitSaving}
                      onChange={(e) => setSelectedMaxDevices(e.target.value)}
                    />
                    <span className="hint">Enter a value between 1 and 50 devices.</span>
                  </div>
                )}
              </div>
              <div className="modal-foot">
                <button
                  className="btn ghost"
                  onClick={closeAccountFieldEditor}
                  disabled={tierSaving || deviceLimitSaving}
                >
                  Cancel
                </button>
                <button
                  className="btn primary"
                  onClick={editingAccountField === 'plan' ? handleTierSave : handleDeviceLimitSave}
                  disabled={
                    editingAccountField === 'plan'
                      ? tierSaving || !selectedTier || selectedTier === u.tier
                      : deviceLimitSaving ||
                        !selectedMaxDevices ||
                        parseInt(selectedMaxDevices, 10) === u.maxActiveDevices
                  }
                >
                  {tierSaving || deviceLimitSaving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
          </div>
        )}

        {grantUserId && (
          <EditDrawer
            onClose={closeAdjustCredits}
            title={`Adjust credits — ${userLabel(u)}`}
            width="min(480px, calc(100vw - 40px))"
            saving={granting}
            onSave={handleGrant}
            saveLabel={
              granting
                ? grantMode === 'grant'
                  ? 'Granting…'
                  : 'Deducting…'
                : grantMode === 'grant'
                  ? `Grant ${grantAmount ? parseInt(grantAmount, 10).toLocaleString() : ''} credits`
                  : `Deduct ${grantAmount ? parseInt(grantAmount, 10).toLocaleString() : ''} credits`
            }
            saveDisabled={granting || !grantAmount || parseInt(grantAmount, 10) < 1}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="field">
                <label>Action</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className={`btn${grantMode === 'grant' ? ' primary' : ' ghost'}`}
                    style={{ flex: 1 }}
                    onClick={() => setGrantMode('grant')}
                  >
                    + Grant
                  </button>
                  <button
                    type="button"
                    className={`btn${grantMode === 'deduct' ? ' danger' : ' ghost'}`}
                    style={{ flex: 1 }}
                    onClick={() => setGrantMode('deduct')}
                  >
                    − Deduct
                  </button>
                </div>
              </div>
              <div className="field">
                <label>Amount</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={10000}
                  value={grantAmount}
                  onChange={(e) => setGrantAmount(e.target.value)}
                  placeholder={
                    grantMode === 'grant'
                      ? 'Credits to add (max 10,000)'
                      : `Credits to remove (max ${u.balance.toLocaleString()})`
                  }
                />
                {grantMode === 'deduct' && (
                  <p className="hint">Current balance: {u.balance.toLocaleString()} credits</p>
                )}
              </div>
              <div className="field">
                <label>Reason</label>
                <textarea
                  className="input"
                  value={grantReason}
                  onChange={(e) => setGrantReason(e.target.value)}
                  placeholder={
                    grantMode === 'grant'
                      ? 'e.g. Customer support, bulk top-up'
                      : 'e.g. Refund correction, duplicate charge'
                  }
                  rows={3}
                />
              </div>
            </div>
          </EditDrawer>
        )}

        {showGrantMerchant && (
          <EditDrawer
            onClose={() => setShowGrantMerchant(false)}
            title={`Grant merchant access — ${userLabel(u)}`}
            width="min(520px, calc(100vw - 40px))"
            saving={grantingMerchant}
            onSave={() => void handleGrantMerchant()}
            saveLabel={grantingMerchant ? 'Granting…' : 'Grant access'}
            saveDisabled={grantingMerchant || !grantMerchantForm.companyName.trim()}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="field">
                <label>Company name</label>
                <input
                  className="input"
                  value={grantMerchantForm.companyName}
                  onChange={(e) =>
                    setGrantMerchantForm((f) => ({ ...f, companyName: e.target.value }))
                  }
                  placeholder="e.g. XYZ Family Mall"
                />
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Contact name</label>
                  <input
                    className="input"
                    value={grantMerchantForm.contactName}
                    onChange={(e) =>
                      setGrantMerchantForm((f) => ({ ...f, contactName: e.target.value }))
                    }
                    placeholder="Optional — defaults to account name"
                  />
                </div>
                <div className="field">
                  <label>Phone</label>
                  <input
                    className="input"
                    value={grantMerchantForm.phone}
                    onChange={(e) => setGrantMerchantForm((f) => ({ ...f, phone: e.target.value }))}
                    placeholder="Optional"
                  />
                </div>
              </div>
              <div className="field">
                <label>Business address</label>
                <input
                  className="input"
                  value={grantMerchantForm.businessAddress}
                  onChange={(e) =>
                    setGrantMerchantForm((f) => ({ ...f, businessAddress: e.target.value }))
                  }
                  placeholder="Optional — can be filled in later via Edit"
                />
              </div>
              <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: 0 }}>
                This instantly grants {userContact(u)} access to the catalogue manager, using their
                existing login.
              </p>
            </div>
          </EditDrawer>
        )}

        {showEditMerchant && u.merchant && (
          <EditDrawer
            onClose={() => setShowEditMerchant(false)}
            title="Edit merchant details"
            width="min(520px, calc(100vw - 40px))"
            saving={savingMerchantEdit}
            onSave={() => void handleMerchantEditSave()}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="field">
                <label>Logo</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {detail.merchant?.logoUrl && (
                    // biome-ignore lint/performance/noImgElement: admin SPA, not Next.js
                    <img
                      src={detail.merchant.logoUrl}
                      alt="Merchant logo"
                      style={{
                        width: 48,
                        height: 48,
                        objectFit: 'contain',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                      }}
                    />
                  )}
                  <label className="btn sm ghost" style={{ cursor: 'pointer' }}>
                    {uploadingLogo ? 'Uploading…' : 'Upload logo'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      style={{ display: 'none' }}
                      disabled={uploadingLogo}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleLogoUpload(file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
              </div>
              <div className="field">
                <label>Company name</label>
                <input
                  className="input"
                  value={merchantEditForm.companyName}
                  onChange={(e) =>
                    setMerchantEditForm((f) => ({ ...f, companyName: e.target.value }))
                  }
                />
              </div>
              <div className="field">
                <label>Contact name</label>
                <input
                  className="input"
                  value={merchantEditForm.contactName}
                  onChange={(e) =>
                    setMerchantEditForm((f) => ({ ...f, contactName: e.target.value }))
                  }
                />
              </div>
              <div className="field">
                <label>Phone</label>
                <input
                  className="input"
                  value={merchantEditForm.phone}
                  onChange={(e) => setMerchantEditForm((f) => ({ ...f, phone: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Business address</label>
                <input
                  className="input"
                  value={merchantEditForm.businessAddress}
                  onChange={(e) =>
                    setMerchantEditForm((f) => ({ ...f, businessAddress: e.target.value }))
                  }
                />
              </div>
              <div className="field">
                <label>Job rate limit (per minute)</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={500}
                  placeholder="Default (15/min)"
                  value={merchantEditForm.jobRateLimitPerMin}
                  onChange={(e) =>
                    setMerchantEditForm((f) => ({ ...f, jobRateLimitPerMin: e.target.value }))
                  }
                />
              </div>
            </div>
          </EditDrawer>
        )}
      </>
    );
  }

  const hasActiveFilters = Boolean(
    query || merchantsOnly || showBanned || exportFrom || exportTo || planFilter,
  );
  const clearFilters = () => {
    setQuery('');
    setMerchantsOnly(false);
    setShowBanned(false);
    setExportFrom('');
    setExportTo('');
    setPlanFilter('');
    setPage(0);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p className="lede">
            {loading ? 'Loading…' : `${total.toLocaleString()} accounts`} — manage access, credit
            plans, and merchant catalogue permissions.
          </p>
        </div>
        <div className="head-tools">
          <button className="btn primary" onClick={openCreateUser}>
            <Icon.Plus /> Create User
          </button>
        </div>
      </div>

      <div className="filter-card" style={{ marginBottom: 16 }}>
        <div className="filter-row">
          {/* User Segment Tabs */}
          <div className="segmented-control" role="tablist">
            <button
              type="button"
              className={`segmented-btn ${!merchantsOnly ? 'active' : ''}`}
              onClick={() => {
                setMerchantsOnly(false);
                setPage(0);
              }}
            >
              All users
              <span className="badge-count">{total.toLocaleString()}</span>
            </button>
            <button
              type="button"
              className={`segmented-btn ${merchantsOnly ? 'active' : ''}`}
              onClick={() => {
                setMerchantsOnly(true);
                setPage(0);
              }}
            >
              Merchants
            </button>
          </div>

          {/* Search Box */}
          <div className="filter-search-box">
            <Icon.Search />
            <input
              placeholder="Search by name, email, or username…"
              value={query}
              onChange={(e) => handleSearch(e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="filter-clear-btn"
                onClick={() => handleSearch('')}
                title="Clear search"
              >
                <Icon.Close />
              </button>
            )}
          </div>

          {/* Options Menu Button & Popover */}
          <div ref={menuRef} className="filter-popover-wrapper">
            <button
              type="button"
              className={`filter-toggle-btn ${menuOpen || showBanned || exportFrom || exportTo || planFilter ? 'active' : ''}`}
              onClick={() => setMenuOpen(!menuOpen)}
              title="Filters & Export options"
            >
              <Icon.Filter />
              <span>Options</span>
              {(showBanned || exportFrom || exportTo || planFilter) && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--accent)',
                    display: 'inline-block',
                  }}
                />
              )}
            </button>

            {menuOpen && (
              <div className="filter-popover-menu">
                {/* 1. Joined Date Filter */}
                <div>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      display: 'block',
                      marginBottom: 6,
                    }}
                  >
                    Joined Date Range
                  </span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, color: 'var(--muted)', width: 40 }}>From:</span>
                      <input
                        type="date"
                        className="filter-input"
                        value={exportFrom}
                        onChange={(e) => {
                          setExportFrom(e.target.value);
                          setPage(0);
                        }}
                        style={{ flex: 1, height: 32, fontSize: 12 }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, color: 'var(--muted)', width: 40 }}>To:</span>
                      <input
                        type="date"
                        className="filter-input"
                        value={exportTo}
                        onChange={(e) => {
                          setExportTo(e.target.value);
                          setPage(0);
                        }}
                        style={{ flex: 1, height: 32, fontSize: 12 }}
                      />
                    </div>
                  </div>
                </div>

                <div style={{ borderTop: '1px solid var(--border)' }} />

                {/* 2. Plan Filter */}
                <div>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      display: 'block',
                      marginBottom: 6,
                    }}
                  >
                    Plan
                  </span>
                  <select
                    className="filter-select"
                    value={planFilter}
                    onChange={(e) => {
                      setPlanFilter(e.target.value);
                      setPage(0);
                    }}
                    style={{ width: '100%', height: 32, fontSize: 12.5 }}
                  >
                    <option value="">All plans</option>
                    {tierOptions.map((slug) => (
                      <option key={slug} value={slug} style={{ textTransform: 'capitalize' }}>
                        {slug}
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{ borderTop: '1px solid var(--border)' }} />

                {/* 3. Show Suspended/Deleted Users */}
                <div>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      display: 'block',
                      marginBottom: 6,
                    }}
                  >
                    User Status
                  </span>
                  <button
                    type="button"
                    className={`filter-toggle-btn ${showBanned ? 'active' : ''}`}
                    onClick={() => {
                      setShowBanned(!showBanned);
                      setPage(0);
                    }}
                    style={{
                      width: '100%',
                      justifyContent: 'flex-start',
                      height: 32,
                      fontSize: 12.5,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: showBanned ? 'var(--accent)' : 'var(--muted)',
                        display: 'inline-block',
                      }}
                    />
                    Show suspended/deleted
                  </button>
                </div>

                <div style={{ borderTop: '1px solid var(--border)' }} />

                {/* 4. Export Data (PDF & Excel) */}
                <div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 6,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'var(--muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      Export Data
                    </span>
                    <select
                      className="filter-select"
                      value={exportSortDir}
                      onChange={(e) => setExportSortDir(e.target.value as 'asc' | 'desc')}
                      style={{ height: 24, fontSize: 11, padding: '0 20px 0 6px' }}
                    >
                      <option value="desc">Newest first</option>
                      <option value="asc">Oldest first</option>
                    </select>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => {
                        handleExport('pdf');
                        setMenuOpen(false);
                      }}
                      disabled={exportingFormat !== null}
                      style={{ flex: 1, justifyContent: 'center' }}
                      title="Download PDF report"
                    >
                      <Icon.Download /> {exportingFormat === 'pdf' ? 'Exporting…' : 'PDF'}
                    </button>
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => {
                        handleExport('xlsx');
                        setMenuOpen(false);
                      }}
                      disabled={exportingFormat !== null}
                      style={{ flex: 1, justifyContent: 'center' }}
                      title="Download Excel spreadsheet"
                    >
                      <Icon.Download /> {exportingFormat === 'xlsx' ? 'Exporting…' : 'Excel'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Clear Filters Button */}
          {hasActiveFilters && (
            <button
              type="button"
              className="btn sm ghost"
              onClick={clearFilters}
              style={{ marginLeft: 'auto' }}
            >
              <Icon.Close /> Clear filters
            </button>
          )}
        </div>

        {/* Active Filter Chips */}
        {hasActiveFilters && (
          <div className="filter-chips-row">
            <span style={{ color: 'var(--muted)', fontSize: 11.5, marginRight: 2 }}>Active:</span>
            {query && (
              <span className="filter-chip">
                Search: <strong>"{query}"</strong>
                <button
                  type="button"
                  className="filter-chip-remove"
                  onClick={() => handleSearch('')}
                >
                  <Icon.Close />
                </button>
              </span>
            )}
            {merchantsOnly && (
              <span className="filter-chip">
                Filter: <strong>Merchants only</strong>
                <button
                  type="button"
                  className="filter-chip-remove"
                  onClick={() => {
                    setMerchantsOnly(false);
                    setPage(0);
                  }}
                >
                  <Icon.Close />
                </button>
              </span>
            )}
            {showBanned && (
              <span className="filter-chip">
                Status: <strong>Including suspended/deleted</strong>
                <button
                  type="button"
                  className="filter-chip-remove"
                  onClick={() => {
                    setShowBanned(false);
                    setPage(0);
                  }}
                >
                  <Icon.Close />
                </button>
              </span>
            )}
            {(exportFrom || exportTo) && (
              <span className="filter-chip">
                Joined:{' '}
                <strong>
                  {exportFrom || 'Any'} → {exportTo || 'Today'}
                </strong>
                <button
                  type="button"
                  className="filter-chip-remove"
                  onClick={() => {
                    setExportFrom('');
                    setExportTo('');
                    setPage(0);
                  }}
                >
                  <Icon.Close />
                </button>
              </span>
            )}
            {planFilter && (
              <span className="filter-chip">
                Plan: <strong style={{ textTransform: 'capitalize' }}>{planFilter}</strong>
                <button
                  type="button"
                  className="filter-chip-remove"
                  onClick={() => {
                    setPlanFilter('');
                    setPage(0);
                  }}
                >
                  <Icon.Close />
                </button>
              </span>
            )}
          </div>
        )}

        {/* Bulk Selection Actions Bar */}
        {(() => {
          const pagedUserIds = sorted.map((u) => u.id);
          const pageSelected =
            pagedUserIds.length > 0 && pagedUserIds.every((id) => selectedUserIds.includes(id));
          return (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                paddingTop: 8,
                borderTop: '1px solid var(--border)',
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => {
                  setSelectedUserIds((prev) =>
                    pageSelected
                      ? prev.filter((id) => !pagedUserIds.includes(id))
                      : [...new Set([...prev, ...pagedUserIds])],
                  );
                }}
              >
                {pageSelected ? 'Deselect page' : 'Select page'}
              </button>
              {selectedUserIds.length > 0 && (
                <>
                  <span
                    className="badge accent"
                    style={{ fontSize: 12, padding: '3px 10px', fontWeight: 600 }}
                  >
                    {selectedUserIds.length} user{selectedUserIds.length > 1 ? 's' : ''} selected
                  </span>
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => setSelectedUserIds([])}
                  >
                    Clear selection
                  </button>
                  {isSuperAdmin && (
                    <button
                      type="button"
                      className="btn sm danger"
                      onClick={() => setShowBulkDeleteConfirm(true)}
                      style={{ marginLeft: 'auto' }}
                    >
                      <Icon.Trash /> Delete selected ({selectedUserIds.length})
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })()}
      </div>

      {loading ? (
        <p style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>
          Loading users&hellip;
        </p>
      ) : (
        <>
          <div className="desktop-only table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 36 }} />
                  <Th k="displayName" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>
                    User
                  </Th>
                  <Th k="tier" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>
                    Plan
                  </Th>
                  <th>Access</th>
                  <th>Signup</th>
                  <Th k="balance" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>
                    Credits
                  </Th>
                  <Th k="totalJobs" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>
                    Jobs
                  </Th>
                  <Th k="lastJobAt" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>
                    Last activity
                  </Th>
                  <Th k="createdAt" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>
                    Joined
                  </Th>
                  <Th k="isBanned" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>
                    Status
                  </Th>
                  <th aria-label="Open user"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((u) => (
                  <tr
                    key={u.id}
                    onClick={() => openDetail(u)}
                    style={{ cursor: 'pointer', opacity: u.isBanned ? 0.6 : 1 }}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedUserIds.includes(u.id)}
                        onChange={(e) =>
                          setSelectedUserIds((prev) =>
                            e.target.checked ? [...prev, u.id] : prev.filter((x) => x !== u.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 220 }}
                      >
                        <NameAvatar name={userLabel(u)} email={u.email ?? undefined} size={32} />
                        <div style={{ minWidth: 0 }}>
                          <div
                            className="semi"
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {userLabel(u)}
                          </div>
                          {u.displayName && (
                            <div
                              className="sub"
                              style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {userContact(u)}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="badge" style={{ textTransform: 'capitalize' }}>
                        {u.tier}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {u.isAdmin && (
                          <span className="badge accent">
                            {u.adminRole === 'SUPER_ADMIN' ? 'Super Admin' : 'Admin'}
                          </span>
                        )}
                        {u.isMerchant && <span className="badge success">Merchant</span>}
                        {u.hasShopifyStore && <span className="badge success">Shopify</span>}
                        {!u.hasPassword && <span className="badge info">Google</span>}
                        {!u.isAdmin && !u.isMerchant && u.hasPassword && (
                          <span className="sub">Standard</span>
                        )}
                      </div>
                    </td>
                    <td>
                      {u.isMerchant ? (
                        u.signupSource === 'android_google' ? (
                          <span className="badge warn">Self-signup</span>
                        ) : (
                          <span className="badge">Admin</span>
                        )
                      ) : (
                        <span className="sub">&mdash;</span>
                      )}
                    </td>
                    <td>
                      <span className="mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {u.balance.toLocaleString()}
                      </span>
                    </td>
                    <td>
                      <span className="mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {(u.totalJobs ?? 0).toLocaleString()}
                      </span>
                    </td>
                    <td>
                      <span className="sub">
                        {u.lastJobAt ? new Date(u.lastJobAt).toLocaleDateString() : 'No activity'}
                      </span>
                    </td>
                    <td>
                      <span className="sub">{new Date(u.createdAt).toLocaleDateString()}</span>
                    </td>
                    <td>
                      {u.isBanned ? (
                        <span className="badge danger dot">Suspended</span>
                      ) : (
                        <span className="badge success dot">Active</span>
                      )}
                    </td>
                    <td>
                      <span style={{ color: 'var(--muted-2)' }} aria-hidden="true">
                        <Icon.Chevron />
                      </span>
                    </td>
                  </tr>
                ))}
                {sorted.length === 0 && (
                  <tr>
                    <td
                      colSpan={11}
                      style={{ textAlign: 'center', color: 'var(--muted)', padding: '2.5rem' }}
                    >
                      No users found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mobile-only" style={{ gap: 12 }}>
            {sorted.map((u) => (
              <button
                type="button"
                key={u.id}
                onClick={() => openDetail(u)}
                className="card"
                style={{
                  padding: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  cursor: 'pointer',
                  userSelect: 'none',
                  opacity: u.isBanned ? 0.6 : 1,
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'var(--surface)',
                  width: '100%',
                  textAlign: 'left',
                  color: 'inherit',
                  fontFamily: 'inherit',
                  fontSize: 'inherit',
                }}
              >
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}
                >
                  <NameAvatar name={userLabel(u)} email={u.email ?? undefined} size={32} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      className="semi"
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 14,
                      }}
                    >
                      {userLabel(u)}
                    </div>
                    <div
                      className="sub"
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 11,
                        display: 'flex',
                        gap: 6,
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ textTransform: 'capitalize' }}>{u.tier}</span>
                      <span>&middot;</span>
                      <span className="mono">{u.balance.toLocaleString()} credits</span>
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 4,
                    flexShrink: 0,
                  }}
                >
                  {u.isBanned ? (
                    <span className="badge danger dot">Suspended</span>
                  ) : (
                    <span className="badge success dot">Active</span>
                  )}
                  {u.isAdmin && (
                    <span className="badge accent" style={{ fontSize: 10 }}>
                      {u.adminRole === 'SUPER_ADMIN' ? 'Super Admin' : 'Admin'}
                    </span>
                  )}
                  {u.isMerchant && (
                    <span className="badge success" style={{ fontSize: 10 }}>
                      Merchant
                    </span>
                  )}
                </div>
              </button>
            ))}
            {sorted.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>
                No users found.
              </div>
            )}
          </div>

          <Pager
            page={page}
            totalPages={totalPages}
            onPage={setPage}
            totalItems={total}
            pageSize={PAGE_SIZE}
          />
        </>
      )}
      {showCreateUser && (
        <EditDrawer
          onClose={() => setShowCreateUser(false)}
          title="Create User"
          width="min(480px, calc(100vw - 40px))"
          saving={creatingUser}
          onSave={() => void handleCreateUser()}
          saveLabel={creatingUser ? 'Creating…' : 'Create User'}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: 0 }}>
              Give the account a username and password now. Email and phone are optional here — the
              customer will be prompted to add them the first time they log in.
            </p>
            {createUserError && (
              <div className="banner warn">
                <p style={{ margin: 0, fontSize: 13 }}>{createUserError}</p>
              </div>
            )}
            <div className="field">
              <label>Username</label>
              <input
                className="input"
                value={createUserForm.username}
                onChange={(e) => setCreateUserForm((f) => ({ ...f, username: e.target.value }))}
                placeholder="e.g. priya_shop1"
              />
            </div>
            <div className="field">
              <label>Password</label>
              <input
                className="input"
                value={createUserForm.password}
                onChange={(e) => setCreateUserForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="Share this with the customer directly"
              />
            </div>
            <div className="field">
              <label>Full name</label>
              <input
                className="input"
                value={createUserForm.displayName}
                onChange={(e) => setCreateUserForm((f) => ({ ...f, displayName: e.target.value }))}
              />
            </div>
            <div className="field-row">
              <div className="field">
                <label>Email</label>
                <input
                  className="input"
                  value={createUserForm.email}
                  onChange={(e) => setCreateUserForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="Optional"
                />
              </div>
              <div className="field">
                <label>Phone</label>
                <input
                  className="input"
                  value={createUserForm.phone}
                  onChange={(e) => setCreateUserForm((f) => ({ ...f, phone: e.target.value }))}
                  placeholder="Optional — 10-digit mobile number"
                />
              </div>
            </div>
          </div>
        </EditDrawer>
      )}

      {showBulkDeleteConfirm && (
        <div className="modal-overlay" onClick={() => setShowBulkDeleteConfirm(false)}>
          <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Delete selected users</h3>
            </div>
            <div className="modal-body">
              <p>
                Permanently erase personal data for {selectedUserIds.length} selected user
                {selectedUserIds.length > 1 ? 's' : ''}? This cannot be undone. Their job and
                payment history will be retained but anonymized.
              </p>
              <ul
                style={{
                  maxHeight: 180,
                  overflowY: 'auto',
                  margin: '8px 0',
                  paddingLeft: 20,
                  fontSize: 13,
                }}
              >
                {selectedUserIds.slice(0, 10).map((id) => {
                  const uObj = users.find((x) => x.id === id);
                  const label = uObj ? (uObj.email ?? userLabel(uObj)) : id;
                  return (
                    <li key={id}>
                      <strong>{label}</strong>
                    </li>
                  );
                })}
                {selectedUserIds.length > 10 && (
                  <li style={{ fontStyle: 'italic', color: 'var(--muted)' }}>
                    and {selectedUserIds.length - 10} more
                  </li>
                )}
              </ul>
            </div>
            <div className="modal-foot">
              <button
                className="btn ghost"
                onClick={() => setShowBulkDeleteConfirm(false)}
                disabled={bulkDeleting}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={handleBulkDeleteConfirm}
                disabled={bulkDeleting}
              >
                {bulkDeleting ? 'Erasing…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
