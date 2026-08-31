import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/data';
import { Icon } from './Icons';

interface SidebarProps {
  page: string;
  onNav: (page: string) => void;
  role: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

interface NavItem {
  k: string;
  label: string;
  icon: () => ReactElement;
  perm?: string | null; // null = always visible to any active admin (dashboard-style items use 'admin.me' instead)
  roles?: string[]; // present only on the one item still gated by hard-coded roles — see `payments` below
  count?: number;
  alert?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const groups: NavGroup[] = [
  {
    label: '',
    items: [
      {
        k: 'dashboard',
        label: 'Dashboard',
        icon: Icon.Dashboard,
        perm: 'admin.me',
      },
    ],
  },
  {
    label: 'Content',
    items: [
      {
        k: 'assets',
        label: 'Assets',
        icon: Icon.Image,
        perm: 'assets.read',
      },
      {
        k: 'workflows',
        label: 'Workflows',
        icon: Icon.Workflow,
        perm: 'workflows.write',
      },
      {
        k: 'tryon',
        label: 'Try-on',
        icon: Icon.Replace,
        perm: 'tryon.write',
      },
      {
        k: 'demo-catalog',
        label: 'Kiosk Demo Data',
        icon: Icon.Image,
        perm: 'demo_catalog.read',
      },
      {
        k: 'dev-api',
        label: 'Dev API',
        icon: Icon.Workflow,
        perm: 'dev_api.write',
      },
      {
        k: 'saree',
        label: 'Saree',
        icon: Icon.Workflow,
        perm: 'saree.write',
      },
      {
        k: 'shopify-funnels',
        label: 'Shopify',
        icon: Icon.Workflow,
        perm: 'shopify_funnels.write',
      },
    ],
  },
  {
    label: 'Clients',
    items: [
      {
        k: 'users',
        label: 'Users',
        icon: Icon.Users,
        perm: 'users.read',
      },
    ],
  },
  {
    label: 'Operations',
    items: [
      {
        k: 'jobs',
        label: 'Jobs',
        icon: Icon.Jobs,
        perm: 'jobs.write',
      },
      {
        k: 'held-batches',
        label: 'Held Batches',
        icon: Icon.Jobs,
        perm: 'held_jobs.manage',
      },
      {
        k: 'workers',
        label: 'Workers',
        icon: Icon.Server,
        perm: 'workers.write',
      },
      {
        k: 'recycle-bin',
        label: 'Recycle bin',
        icon: Icon.Trash,
        perm: 'assets.read',
      },
      {
        k: 'credit-analysis',
        label: 'Credit Analysis',
        icon: Icon.Coin,
        perm: 'credit_analysis.read',
      },
      {
        k: 'payments',
        label: 'Payments',
        icon: Icon.Credit,
        // Not migrated to a permission key yet — payments.routes.ts still uses
        // requireAdmin([...]) directly (see docs/superpowers/plans/2026-08-20-admin-role-permission-matrix.md,
        // Context). Revisit once that route is migrated to requirePermission.
        roles: ['SUPER_ADMIN', 'SUPPORT', 'ADMIN'],
      },
      {
        k: 'telemetry',
        label: 'Telemetry',
        icon: Icon.Clock,
        perm: 'telemetry.read',
      },
      {
        k: 'shopify-stores',
        label: 'Shopify Stores',
        icon: Icon.Coin,
        perm: 'shopify_stores.read',
      },
      {
        k: 'audit-logs',
        label: 'Team Activity',
        icon: Icon.Clock,
        perm: 'audit.read',
      },
    ],
  },
  {
    label: 'Sales & Support',
    items: [
      {
        k: 'chat-inbox',
        label: 'Chat Inbox',
        icon: Icon.MessageSquare,
        perm: 'chatbot.read',
      },
      {
        k: 'contacts',
        label: 'Contacts',
        icon: Icon.Bell,
        perm: 'contact.read',
      },
      {
        k: 'chatbot-qna',
        label: 'Chatbot Q&A',
        icon: Icon.MessageSquare,
        perm: 'chatbot.manage',
      },
    ],
  },
];

export function Sidebar({
  page,
  onNav,
  role,
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const { token, hasPermission } = useAuth();
  const [contactBadge, setContactBadge] = useState(0);

  useEffect(() => {
    if (!token) return;
    const fetchCount = () =>
      apiFetch<{ count: number }>('/admin/contact-requests/unread-count')
        .then(({ count }) => setContactBadge(count))
        .catch(() => {});
    void fetchCount();
    const t = setInterval(fetchCount, 5_000);
    return () => clearInterval(t);
  }, [token]);

  const isVisible = (item: NavItem) =>
    item.perm ? hasPermission(item.perm) : (item.roles ?? []).includes(role);

  // Flat list for collapsed view; grouped for expanded view
  const allItems = groups.flatMap((g) => g.items);
  const visible = allItems.filter(isVisible);
  const visibleGroups = groups
    .map((g) => ({ ...g, items: g.items.filter(isVisible) }))
    .filter((g) => g.items.length > 0);

  const showSettings = hasPermission('admin_users.manage');

  if (collapsed) {
    return (
      <aside
        className={`sidebar sidebar--collapsed${mobileOpen ? ' sidebar--mobile-open' : ''}`}
        onClick={onToggleCollapse}
        style={{ cursor: 'pointer' }}
      >
        <div className="brand brand--collapsed">
          <button
            className="brand-mark brand-mark--logo"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse();
            }}
            title="Expand sidebar"
          >
            <span className="collapsed-logo-icon">
              {/* biome-ignore lint/performance/noImgElement: admin panel */}
              <img
                className="collapsed-logo-icon--on"
                src={`${import.meta.env.BASE_URL}assets/logo.svg`}
                alt="Ai Vastra"
              />
              {/* biome-ignore lint/performance/noImgElement: admin panel */}
              <img
                className="collapsed-logo-icon--off"
                src={`${import.meta.env.BASE_URL}assets/dock-to-right.svg`}
                alt="Expand"
              />
            </span>
          </button>
        </div>
        <nav>
          {visible.map((item) => {
            const badge = item.k === 'contacts' ? contactBadge : (item.count ?? 0);
            return (
              <button
                key={item.k}
                className={`nav-item nav-item--icon ${item.alert || (item.k === 'contacts' && contactBadge > 0) ? 'alert' : ''} ${page === item.k ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onNav(item.k);
                  onCloseMobile();
                }}
                title={item.label}
              >
                <item.icon />
                {badge > 0 && <span className="count">{badge}</span>}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-spacer" />
        {showSettings && (
          <button
            className={`nav-item nav-item--icon ${page === 'settings' ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onNav('settings');
              onCloseMobile();
            }}
            title="Settings"
          >
            <Icon.Settings />
          </button>
        )}
      </aside>
    );
  }

  return (
    <aside className={`sidebar${mobileOpen ? ' sidebar--mobile-open' : ''}`}>
      <div className="brand">
        <span className="brand-mark brand-mark--logo">
          {/* biome-ignore lint/performance/noImgElement: admin panel */}
          <img src={`${import.meta.env.BASE_URL}assets/logo.svg`} alt="Ai Vastra" />
        </span>
        {/* biome-ignore lint/performance/noImgElement: admin panel */}
        <img
          className="brand-word--logo"
          src={`${import.meta.env.BASE_URL}assets/logo-text.svg`}
          alt="Ai Vastra"
        />
        <button
          className="sidebar-collapse-btn"
          onClick={onToggleCollapse}
          title="Collapse sidebar"
        >
          {/* biome-ignore lint/performance/noImgElement: admin panel */}
          <img
            src={`${import.meta.env.BASE_URL}assets/dock-to-right.svg`}
            alt="Collapse"
            style={{ width: 22, height: 22 }}
          />
        </button>
      </div>
      <nav>
        {visibleGroups.map((group) => (
          <div key={group.label || '__top__'}>
            {group.label && <div className="nav-label">{group.label}</div>}
            {group.items.map((item) => {
              const badge = item.k === 'contacts' ? contactBadge : (item.count ?? 0);
              return (
                <button
                  key={item.k}
                  className={`nav-item ${item.alert || (item.k === 'contacts' && contactBadge > 0) ? 'alert' : ''} ${page === item.k ? 'active' : ''}`}
                  onClick={() => {
                    onNav(item.k);
                    onCloseMobile();
                  }}
                >
                  <item.icon />
                  <span>{item.label}</span>
                  {badge > 0 && <span className="count">{badge}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-spacer" />
      {showSettings && (
        <button
          className={`nav-item ${page === 'settings' ? 'active' : ''}`}
          onClick={() => {
            onNav('settings');
            onCloseMobile();
          }}
        >
          <Icon.Settings />
          <span>Settings</span>
        </button>
      )}
    </aside>
  );
}
