import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icons';
import { apiErrorMessage, apiFetch } from '../lib/data';

interface AuditLogItem {
  id: string;
  actorUserId: string;
  actorRole: string;
  actorEmail: string | null;
  actorDisplayName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  resourceLabel: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  createdAt: string;
}

interface AuditLogsResponse {
  page: number;
  pageSize: number;
  total: number;
  items: AuditLogItem[];
}

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

type ActionRiskTier = 'destructive' | 'sensitive' | 'default';

// Destructive: undoes or removes something. Sensitive: changes who can do what,
// or moves credits/money. Everything else (create/patch/reassign/...) is routine.
function actionRiskTier(action: string): ActionRiskTier {
  if (/\.(delete|revoke|erase|ban)$/.test(action)) return 'destructive';
  if (/\.(update_role|drain|deduct)$/.test(action)) return 'sensitive';
  return 'default';
}

const RISK_TIER_STYLE: Record<ActionRiskTier, { bg: string; ink: string }> = {
  destructive: { bg: 'var(--danger-soft)', ink: 'var(--danger-ink)' },
  sensitive: { bg: 'var(--warn-soft)', ink: 'var(--warn-ink)' },
  default: { bg: 'var(--bg-subtle)', ink: 'inherit' },
};

type DiffStatus = 'added' | 'removed' | 'changed';
interface DiffRow {
  key: string;
  before: string | undefined;
  after: string | undefined;
  status: DiffStatus;
}

const DIFF_ROW_STYLE: Record<DiffStatus, { bg: string; ink: string }> = {
  added: { bg: 'var(--success-soft)', ink: 'var(--success-ink)' },
  removed: { bg: 'var(--danger-soft)', ink: 'var(--danger-ink)' },
  changed: { bg: 'var(--warn-soft)', ink: 'var(--warn-ink)' },
};

// Field-level diff between the before/after JSONB snapshots. Unchanged keys are
// dropped — the point of the view is to surface what actually moved, not to
// re-render the whole payload as two side-by-side dumps.
function computeDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): DiffRow[] {
  const b = before ?? {};
  const a = after ?? {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const rows: DiffRow[] = [];
  for (const key of keys) {
    const hasBefore = key in b;
    const hasAfter = key in a;
    const beforeStr = hasBefore ? JSON.stringify(b[key]) : undefined;
    const afterStr = hasAfter ? JSON.stringify(a[key]) : undefined;
    if (beforeStr === afterStr) continue;
    rows.push({
      key,
      before: beforeStr,
      after: afterStr,
      status: !hasBefore ? 'added' : !hasAfter ? 'removed' : 'changed',
    });
  }
  return rows.sort((x, y) => x.key.localeCompare(y.key));
}

// Turns "admin_users.update_role" into "Changed admin role" as a last-resort
// fallback for any action this page doesn't have a specific sentence for yet —
// so a new action type never regresses to raw dotted.notation on screen.
function humanizeActionFallback(action: string): string {
  const verb = action.split('.').pop() ?? action;
  const words = verb.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// One plain-English sentence per action, written for a non-technical reader
// (a manager checking "what happened," not an engineer reading a log line).
// `who` is the resolved resource label (an email, a worker name, ...) —
// falls back to the resourceType so the sentence still reads if a label
// couldn't be resolved (e.g. the record was later deleted).
function describeAction(log: AuditLogItem): string {
  const who = log.resourceLabel ?? log.resourceType.replace(/_/g, ' ');
  const after = log.after ?? {};
  const amount = typeof after.amount === 'number' ? after.amount : undefined;
  const role = typeof after.role === 'string' ? after.role : undefined;

  switch (log.action) {
    case 'credits.grant':
      return amount !== undefined ? `Added ${amount} credits to ${who}` : `Added credits to ${who}`;
    case 'credits.deduct':
      return amount !== undefined
        ? `Removed ${amount} credits from ${who}`
        : `Removed credits from ${who}`;
    case 'users.ban':
      return `Banned user ${who}`;
    case 'users.update':
      return `Updated account details for ${who}`;
    case 'users.create':
      return `Created a new user account for ${who}`;
    case 'users.delete':
      return `Deleted user account ${who} (data erasure)`;
    case 'admin_users.approve':
      return `Approved admin access for ${who}`;
    case 'admin_users.reject':
      return `Rejected the admin access request from ${who}`;
    case 'admin_users.update_role':
      return role ? `Changed ${who}'s admin role to ${role}` : `Changed admin role for ${who}`;
    case 'admin_users.revoke':
      return `Removed admin access from ${who}`;
    case 'worker.create':
      return `Added GPU worker "${who}"`;
    case 'worker.update':
      return `Updated GPU worker "${who}"`;
    case 'worker.delete':
      return `Removed GPU worker "${who}"`;
    case 'workflow.create':
      return `Created workflow "${who}"`;
    case 'workflow.update':
      return `Updated workflow "${who}"`;
    case 'workflow.reassign':
      return `Reassigned workflow "${who}"`;
    case 'workflow.delete':
      return `Deleted workflow "${who}"`;
    default:
      return `${humanizeActionFallback(log.action)} — ${who}`;
  }
}

// "role" -> "Role", "workflowType" -> "Workflow Type", falling back to a
// camelCase/snake_case splitter for any field this page doesn't know by name.
const FIELD_LABELS: Record<string, string> = {
  id: 'ID',
  role: 'Role',
  status: 'Status',
  label: 'Name',
  slug: 'Slug',
  url: 'URL',
  isActive: 'Active',
  allowedJobTypes: 'Allowed Job Types',
  workflowType: 'Workflow Type',
  amount: 'Amount',
  reason: 'Reason',
  tier: 'Tier',
  username: 'Username',
  email: 'Email',
  displayName: 'Display Name',
  banReason: 'Ban Reason',
};

function humanizeFieldKey(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const spaced = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Diff values are JSON.stringify'd strings (e.g. `"ADMIN"`, `true`, `null`) so
// they can be diffed as text — render them back as plain values, not raw JSON,
// for a reader who doesn't know what a quoted string or `null` means.
function humanizeFieldValue(jsonStr: string | undefined): string {
  if (jsonStr === undefined) return '(not set)';
  try {
    const value = JSON.parse(jsonStr);
    if (value === null) return '(not set)';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)';
    if (typeof value === 'object') return JSON.stringify(value);
    // Status/role-style bare words (e.g. "active") read better title-cased;
    // leave anything with an @, ., or digit (emails, URLs, IDs) exactly as-is.
    const str = String(value);
    return /^[a-z]+$/.test(str) ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  } catch {
    return jsonStr;
  }
}

// One full sentence per changed field, instead of a FIELD/BEFORE/AFTER grid —
// "Set the Role to ADMIN" reads on its own; a table cell with an em-dash
// doesn't, to someone who isn't reading this as a database diff.
function describeFieldChange(row: DiffRow): string {
  const field = humanizeFieldKey(row.key);
  const after = humanizeFieldValue(row.after);
  const before = humanizeFieldValue(row.before);
  if (row.status === 'added') return `Set the ${field} to ${after}`;
  if (row.status === 'removed') return `Removed the ${field} (was ${before})`;
  return `Changed the ${field} from ${before} to ${after}`;
}

// Plain-English options for the "what kind of activity" dropdown — the value
// sent to the API is still the real action string, exact-matched (the backend
// does a substring `ilike`, which an exact string satisfies too).
const ACTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'credits.grant', label: 'Credits added' },
  { value: 'credits.deduct', label: 'Credits removed' },
  { value: 'users.ban', label: 'User banned' },
  { value: 'users.update', label: 'User details updated' },
  { value: 'users.create', label: 'User account created' },
  { value: 'users.delete', label: 'User account deleted' },
  { value: 'admin_users.approve', label: 'Admin access approved' },
  { value: 'admin_users.reject', label: 'Admin access request rejected' },
  { value: 'admin_users.update_role', label: 'Admin role changed' },
  { value: 'admin_users.revoke', label: 'Admin access removed' },
  { value: 'worker.create', label: 'Worker added' },
  { value: 'worker.update', label: 'Worker updated' },
  { value: 'worker.delete', label: 'Worker removed' },
  { value: 'workflow.create', label: 'Workflow created' },
  { value: 'workflow.update', label: 'Workflow updated' },
  { value: 'workflow.reassign', label: 'Workflow reassigned' },
  { value: 'workflow.delete', label: 'Workflow deleted' },
];

const RESOURCE_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'worker', label: 'Workers' },
  { value: 'workflow', label: 'Workflows' },
  { value: 'user', label: 'Users' },
  { value: 'admin_user', label: 'Team members' },
  { value: 'user_credits', label: 'Credits' },
];

export default function AuditLogsPage({ toast }: Props) {
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [loading, setLoading] = useState(true);

  // Filters
  const [actionFilter, setActionFilter] = useState('');
  const [resourceTypeFilter, setResourceTypeFilter] = useState('');
  const [resourceIdFilter, setResourceIdFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [actorFilterLabel, setActorFilterLabel] = useState('');
  const [startDateFilter, setStartDateFilter] = useState('');
  const [endDateFilter, setEndDateFilter] = useState('');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (actionFilter.trim()) params.set('action', actionFilter.trim());
      if (resourceTypeFilter.trim()) params.set('resourceType', resourceTypeFilter.trim());
      if (resourceIdFilter.trim()) params.set('resourceId', resourceIdFilter.trim());
      if (actorFilter.trim()) params.set('actorUserId', actorFilter.trim());
      if (startDateFilter) params.set('startDate', startDateFilter);
      if (endDateFilter) params.set('endDate', endDateFilter);

      const data = await apiFetch<AuditLogsResponse>(`/admin/audit-logs?${params.toString()}`);
      setLogs(data.items);
      setTotal(data.total);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to load audit logs',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setLoading(false);
    }
  }, [
    page,
    pageSize,
    actionFilter,
    resourceTypeFilter,
    resourceIdFilter,
    actorFilter,
    startDateFilter,
    endDateFilter,
    toast,
  ]);

  const filterByActor = (userId: string, label: string) => {
    setActorFilter(userId);
    setActorFilterLabel(label);
    setPage(1);
  };

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  const totalPages = Math.ceil(total / pageSize) || 1;

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  const hasActiveFilters = Boolean(
    actionFilter ||
      resourceTypeFilter ||
      resourceIdFilter ||
      actorFilter ||
      startDateFilter ||
      endDateFilter,
  );

  const clearAllFilters = () => {
    setActionFilter('');
    setResourceTypeFilter('');
    setResourceIdFilter('');
    setActorFilter('');
    setActorFilterLabel('');
    setStartDateFilter('');
    setEndDateFilter('');
    setPage(1);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Team Activity</h1>
          <p className="lede">
            {loading ? 'Loading…' : `${total.toLocaleString()} logged events`} — permanent audit
            trail of administrative actions and permission changes.
          </p>
        </div>
        <div className="head-tools">
          <button
            type="button"
            className="btn ghost"
            onClick={() => void fetchLogs()}
            disabled={loading}
            title="Refresh activity logs"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span
              style={{
                display: 'inline-block',
                animation: loading ? 'spin 0.8s linear infinite' : 'none',
              }}
            >
              <Icon.Refresh />
            </span>
            Refresh
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="filter-card" style={{ marginBottom: 16 }}>
        <div className="filter-row">
          {/* Action Filter */}
          <select
            value={actionFilter}
            onChange={(e) => {
              setActionFilter(e.target.value);
              setPage(1);
            }}
            className="filter-select"
            title="Filter by Activity"
          >
            <option value="">All activity</option>
            {ACTION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          {/* Category Filter */}
          <select
            value={resourceTypeFilter}
            onChange={(e) => {
              setResourceTypeFilter(e.target.value);
              setPage(1);
            }}
            className="filter-select"
            title="Filter by Category"
          >
            <option value="">All categories</option>
            {RESOURCE_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          {/* Date Range Picker */}
          <div className="filter-date-group">
            <span className="date-lbl">Date:</span>
            <input
              type="date"
              value={startDateFilter}
              onChange={(e) => {
                setStartDateFilter(e.target.value);
                setPage(1);
              }}
              title="Start date"
            />
            <span className="date-lbl" style={{ opacity: 0.6 }}>
              to
            </span>
            <input
              type="date"
              value={endDateFilter}
              onChange={(e) => {
                setEndDateFilter(e.target.value);
                setPage(1);
              }}
              title="End date"
            />
          </div>

          {/* Advanced / ID Lookup Toggle Button */}
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className={`filter-toggle-btn ${showAdvanced || resourceIdFilter || actorFilter ? 'active' : ''}`}
          >
            <Icon.Search />
            {showAdvanced ? 'Hide ID lookup' : 'Look up by ID'}
          </button>

          {/* Clear Filters Button */}
          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="btn sm ghost"
              style={{ marginLeft: 'auto' }}
            >
              <Icon.Close /> Clear filters
            </button>
          )}
        </div>

        {/* ID Lookup Drawer/Row */}
        {showAdvanced && (
          <div
            style={{
              display: 'flex',
              gap: 10,
              flexWrap: 'wrap',
              paddingTop: 8,
              borderTop: '1px solid var(--border)',
            }}
          >
            <input
              type="text"
              placeholder="Filter by Record / Resource ID…"
              value={resourceIdFilter}
              onChange={(e) => {
                setResourceIdFilter(e.target.value);
                setPage(1);
              }}
              className="filter-input"
              style={{ flex: '1 1 240px' }}
            />
            <input
              type="text"
              placeholder="Filter by Team Member User ID…"
              value={actorFilter}
              onChange={(e) => {
                setActorFilter(e.target.value);
                setActorFilterLabel('');
                setPage(1);
              }}
              className="filter-input"
              style={{ flex: '1 1 240px' }}
            />
          </div>
        )}

        {/* Active Filter Chips */}
        {hasActiveFilters && (
          <div className="filter-chips-row">
            <span style={{ color: 'var(--muted)', fontSize: 11.5, marginRight: 2 }}>Active:</span>
            {actorFilter && (
              <span className="filter-chip">
                Team member: <strong>{actorFilterLabel || actorFilter}</strong>
                <button
                  type="button"
                  className="filter-chip-remove"
                  onClick={() => {
                    setActorFilter('');
                    setActorFilterLabel('');
                    setPage(1);
                  }}
                  title="Remove actor filter"
                >
                  <Icon.Close />
                </button>
              </span>
            )}
            {actionFilter && (
              <span className="filter-chip">
                Activity:{' '}
                <strong>
                  {ACTION_OPTIONS.find((o) => o.value === actionFilter)?.label || actionFilter}
                </strong>
                <button
                  type="button"
                  className="filter-chip-remove"
                  onClick={() => {
                    setActionFilter('');
                    setPage(1);
                  }}
                  title="Remove activity filter"
                >
                  <Icon.Close />
                </button>
              </span>
            )}
            {resourceTypeFilter && (
              <span className="filter-chip">
                Category:{' '}
                <strong>
                  {RESOURCE_TYPE_OPTIONS.find((o) => o.value === resourceTypeFilter)?.label ||
                    resourceTypeFilter}
                </strong>
                <button
                  type="button"
                  className="filter-chip-remove"
                  onClick={() => {
                    setResourceTypeFilter('');
                    setPage(1);
                  }}
                  title="Remove category filter"
                >
                  <Icon.Close />
                </button>
              </span>
            )}
            {(startDateFilter || endDateFilter) && (
              <span className="filter-chip">
                Date:{' '}
                <strong>
                  {startDateFilter || 'Any'} → {endDateFilter || 'Today'}
                </strong>
                <button
                  type="button"
                  className="filter-chip-remove"
                  onClick={() => {
                    setStartDateFilter('');
                    setEndDateFilter('');
                    setPage(1);
                  }}
                  title="Remove date filter"
                >
                  <Icon.Close />
                </button>
              </span>
            )}
            {resourceIdFilter && (
              <span className="filter-chip">
                Record ID: <strong>{resourceIdFilter}</strong>
                <button
                  type="button"
                  className="filter-chip-remove"
                  onClick={() => {
                    setResourceIdFilter('');
                    setPage(1);
                  }}
                  title="Remove record ID filter"
                >
                  <Icon.Close />
                </button>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Desktop Table View */}
      <div className="desktop-only table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 160 }}>When</th>
              <th style={{ width: 220 }}>Team Member</th>
              <th>What Happened</th>
              <th style={{ textAlign: 'right', width: 140 }}>Details</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={4}
                  style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}
                >
                  Loading activity…
                </td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}
                >
                  Nothing found for these filters.
                </td>
              </tr>
            ) : (
              logs.map((log) => {
                const isExpanded = expandedLogId === log.id;
                return (
                  <tr key={log.id}>
                    <td
                      style={{
                        fontSize: 12.5,
                        whiteSpace: 'nowrap',
                        color: 'var(--muted)',
                      }}
                    >
                      {formatDate(log.createdAt)}
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() =>
                          filterByActor(
                            log.actorUserId,
                            log.actorEmail ?? log.actorDisplayName ?? log.actorUserId,
                          )
                        }
                        title="Filter to this team member"
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          fontWeight: 500,
                          color: 'var(--ink)',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          textDecorationStyle: 'dotted',
                          fontSize: 13,
                        }}
                      >
                        {log.actorEmail ?? log.actorDisplayName ?? log.actorUserId}
                      </button>
                      <div style={{ marginTop: 2 }}>
                        <span className="badge" style={{ fontSize: 10.5 }}>
                          {log.actorRole}
                        </span>
                      </div>
                    </td>
                    <td>
                      {(() => {
                        const tier = actionRiskTier(log.action);
                        const style = RISK_TIER_STYLE[tier];
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {tier !== 'default' && (
                              <span
                                title={
                                  tier === 'destructive'
                                    ? 'This removed access, data, or a resource'
                                    : 'This changed permissions or credits'
                                }
                                style={{
                                  display: 'inline-block',
                                  width: 8,
                                  height: 8,
                                  borderRadius: '50%',
                                  background: style.ink,
                                  flexShrink: 0,
                                }}
                              />
                            )}
                            <span style={{ fontSize: 13.5 }}>{describeAction(log)}</span>
                          </div>
                        );
                      })()}
                      {log.resourceId && (
                        <button
                          type="button"
                          onClick={() => void navigator.clipboard.writeText(log.resourceId ?? '')}
                          title="Click to copy the internal record ID"
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            marginTop: 3,
                            cursor: 'pointer',
                            color: 'var(--muted)',
                            fontSize: 11,
                            fontFamily: 'var(--mono)',
                          }}
                        >
                          Record ID: {log.resourceId.slice(0, 8)}…
                        </button>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {log.before || log.after ? (
                        <button
                          type="button"
                          className="btn sm ghost"
                          onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                        >
                          {isExpanded ? 'Hide Details' : 'View Details'}
                        </button>
                      ) : (
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile & Tablet Card View */}
      <div className="mobile-only" style={{ gap: 10 }}>
        {loading ? (
          <div
            className="card"
            style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}
          >
            Loading activity…
          </div>
        ) : logs.length === 0 ? (
          <div
            className="card"
            style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}
          >
            Nothing found for these filters.
          </div>
        ) : (
          logs.map((log) => {
            const isMobileExpanded = expandedLogId === log.id;
            const tier = actionRiskTier(log.action);
            const style = RISK_TIER_STYLE[tier];
            const diff = isMobileExpanded ? computeDiff(log.before, log.after) : [];
            return (
              <div
                key={log.id}
                className="card"
                style={{
                  padding: '12px 14px',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r)',
                  background: 'var(--surface)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                {/* Header row: WHEN and TEAM MEMBER name */}
                <div
                  onClick={() => setExpandedLogId(isMobileExpanded ? null : log.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
                    >
                      <span
                        style={{
                          fontWeight: 600,
                          fontSize: 13.5,
                          color: 'var(--ink)',
                          wordBreak: 'break-word',
                        }}
                      >
                        {log.actorEmail ?? log.actorDisplayName ?? log.actorUserId}
                      </span>
                      <span className="badge" style={{ fontSize: 10 }}>
                        {log.actorRole}
                      </span>
                    </div>
                    <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                      {formatDate(log.createdAt)}
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      color: 'var(--muted)',
                      transform: isMobileExpanded ? 'rotate(90deg)' : 'none',
                      transition: 'transform 0.15s ease',
                    }}
                  >
                    <Icon.Chevron />
                  </div>
                </div>

                {/* Expanded Section: Displays WHAT HAPPENED when clicked */}
                {isMobileExpanded && (
                  <div
                    style={{
                      paddingTop: 10,
                      borderTop: '1px solid var(--border)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {tier !== 'default' && (
                        <span
                          title={
                            tier === 'destructive'
                              ? 'This removed access, data, or a resource'
                              : 'This changed permissions or credits'
                          }
                          style={{
                            display: 'inline-block',
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: style.ink,
                            flexShrink: 0,
                          }}
                        />
                      )}
                      <span style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 500 }}>
                        {describeAction(log)}
                      </span>
                    </div>

                    {log.resourceId && (
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(log.resourceId ?? '')}
                        title="Click to copy record ID"
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          color: 'var(--muted)',
                          fontSize: 11,
                          fontFamily: 'var(--mono)',
                          textAlign: 'left',
                        }}
                      >
                        Record ID: {log.resourceId}
                      </button>
                    )}

                    {/* What Changed Diff */}
                    {(log.before || log.after) && diff.length > 0 && (
                      <div style={{ marginTop: 4 }}>
                        <span
                          style={{
                            fontSize: 11.5,
                            fontWeight: 600,
                            color: 'var(--muted)',
                            display: 'block',
                            marginBottom: 4,
                          }}
                        >
                          What Changed:
                        </span>
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                          {diff.map((row) => {
                            const rowStyle = DIFF_ROW_STYLE[row.status];
                            return (
                              <li
                                key={row.key}
                                style={{
                                  display: 'flex',
                                  alignItems: 'flex-start',
                                  gap: 8,
                                  padding: '5px 8px',
                                  marginBottom: 4,
                                  background: rowStyle.bg,
                                  borderRadius: 4,
                                  fontSize: 12,
                                }}
                              >
                                <span
                                  style={{
                                    display: 'inline-block',
                                    width: 6,
                                    height: 6,
                                    borderRadius: '50%',
                                    background: rowStyle.ink,
                                    marginTop: 5,
                                    flexShrink: 0,
                                  }}
                                />
                                <span style={{ color: rowStyle.ink }}>
                                  {describeFieldChange(row)}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Expanded Modal / Details for selected log (Desktop) */}
      <div className="desktop-only">
        {expandedLogId && (
          <div
            className="card"
            style={{
              marginTop: 14,
              padding: 16,
              background: 'var(--surface-2)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: 8,
                alignItems: 'center',
              }}
            >
              <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>What Changed</h3>
              <button type="button" className="btn sm ghost" onClick={() => setExpandedLogId(null)}>
                <Icon.Close /> Close
              </button>
            </div>
            {(() => {
              const item = logs.find((l) => l.id === expandedLogId);
              if (!item) return null;
              const diff = computeDiff(item.before, item.after);
              if (diff.length === 0) {
                return (
                  <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0 }}>
                    Nothing else to show for this event.
                  </p>
                );
              }
              return (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {diff.map((row) => {
                    const style = DIFF_ROW_STYLE[row.status];
                    return (
                      <li
                        key={row.key}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 8,
                          padding: '6px 10px',
                          marginBottom: 4,
                          background: style.bg,
                          borderRadius: 4,
                          fontSize: 12.5,
                        }}
                      >
                        <span
                          style={{
                            display: 'inline-block',
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            background: style.ink,
                            marginTop: 5,
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ color: style.ink }}>{describeFieldChange(row)}</span>
                      </li>
                    );
                  })}
                </ul>
              );
            })()}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 14,
          }}
        >
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            Showing {logs.length} of {total} events
          </span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              type="button"
              className="btn sm ghost"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <span style={{ padding: '0 8px', fontSize: 12.5, color: 'var(--muted)' }}>
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              className="btn sm ghost"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </>
  );
}
