import { Fragment, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icons';
import { apiErrorMessage, apiFetch } from '../../lib/data';

interface Permission {
  id: string;
  key: string;
  description: string | null;
}
interface MatrixResponse {
  roles: string[];
  editableRoles: string[];
  permissions: Permission[];
  matrix: Record<string, string[]>;
}

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

// Two prefixes the naive title-case below gets wrong ("Dev Api", "Tryon") — every
// other prefix already reads fine auto-split, so this stays a short override list
// instead of a full lookup table to keep in sync with every permission key.
const GROUP_LABEL_OVERRIDES: Record<string, string> = {
  dev_api: 'Dev API',
  tryon: 'Try-On',
};

// "credit_analysis.read" -> "Credit Analysis" — every key already carries its own
// resource prefix, so grouping needs no separate lookup table to keep in sync.
function groupLabel(key: string): string {
  const prefix = key.split('.')[0];
  return (
    GROUP_LABEL_OVERRIDES[prefix] ??
    prefix
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}

function roleLabel(role: string): string {
  return role === 'SUPER_ADMIN' ? 'Super Admin' : role.charAt(0) + role.slice(1).toLowerCase();
}

export default function RolesPermissionsTab({ toast }: Props) {
  const [data, setData] = useState<MatrixResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null); // `${role}:${key}` in flight
  const [query, setQuery] = useState('');

  useEffect(() => {
    apiFetch<MatrixResponse>('/admin/role-permissions')
      .then(setData)
      .catch((e) =>
        toast({
          kind: 'error',
          title: 'Failed to load roles & permissions',
          body: apiErrorMessage(e, 'Please try again.'),
        }),
      )
      .finally(() => setLoading(false));
  }, [toast]);

  async function toggle(role: string, key: string, nextGranted: boolean) {
    if (!data) return;
    const cellId = `${role}:${key}`;
    setPending(cellId);
    // Optimistic update — the matrix is small enough that a wrong flash from a
    // rejected PATCH is cheaper than a full reload per click.
    const rolled = data.matrix[role]?.includes(key) ?? false;
    setData({
      ...data,
      matrix: {
        ...data.matrix,
        [role]: nextGranted
          ? [...data.matrix[role], key]
          : data.matrix[role].filter((k) => k !== key),
      },
    });
    try {
      await apiFetch('/admin/role-permissions', {
        method: 'PATCH',
        body: JSON.stringify({ role, permissionKey: key, granted: nextGranted }),
      });
    } catch (e) {
      setData(
        (prev) =>
          prev && {
            ...prev,
            matrix: {
              ...prev.matrix,
              [role]: rolled
                ? [...prev.matrix[role], key]
                : prev.matrix[role].filter((k) => k !== key),
            },
          },
      );
      toast({
        kind: 'error',
        title: 'Failed to update permission',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setPending(null);
    }
  }

  // Groups stay in the order permissions arrive in (already alphabetical by key
  // from the API), so groups fall out naturally without a separate sort pass.
  const groups = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? data.permissions.filter(
          (p) => p.key.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q),
        )
      : data.permissions;

    const byGroup = new Map<string, Permission[]>();
    for (const perm of filtered) {
      const g = groupLabel(perm.key);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)?.push(perm);
    }
    return Array.from(byGroup.entries());
  }, [data, query]);

  if (loading) return <p className="sub">Loading&hellip;</p>;
  if (!data) return null;

  return (
    <div>
      <p className="lede" style={{ marginBottom: 14 }}>
        Super Admin always has every permission and can't be edited here — it's the account that
        recovers access if a role gets misconfigured.
      </p>
      <div className="search" style={{ width: 300, marginBottom: 14 }}>
        <Icon.Search />
        <input
          placeholder="Filter permissions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Permission</th>
              {data.roles.map((role) => (
                <th key={role} style={{ textAlign: 'center' }}>
                  {roleLabel(role)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(([group, perms]) => (
              <Fragment key={group}>
                <tr>
                  <td
                    colSpan={data.roles.length + 1}
                    style={{
                      background: 'var(--surface-2)',
                      padding: '6px 16px',
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: 'var(--muted)',
                    }}
                  >
                    {group}
                  </td>
                </tr>
                {perms.map((perm) => (
                  <tr key={perm.id}>
                    <td>
                      <div>{perm.description ?? perm.key}</div>
                      <div className="mono sub">{perm.key}</div>
                    </td>
                    {data.roles.map((role) => {
                      const editable = data.editableRoles.includes(role);
                      const checked = data.matrix[role]?.includes(perm.key) ?? false;
                      return (
                        <td key={role} style={{ textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            className="cb"
                            checked={checked}
                            disabled={!editable || pending === `${role}:${perm.key}`}
                            onChange={(e) => toggle(role, perm.key, e.target.checked)}
                            title={editable ? undefined : 'Super Admin always has every permission'}
                            style={editable ? undefined : { opacity: 0.55, cursor: 'not-allowed' }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
            {groups.length === 0 && (
              <tr>
                <td colSpan={data.roles.length + 1} className="empty">
                  No permissions match "{query}".
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
