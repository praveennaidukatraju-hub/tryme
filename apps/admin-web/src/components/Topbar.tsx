import { Fragment } from 'react';
import { useAuth } from '../context/AuthContext';
import { Icon } from './Icons';

interface TopbarProps {
  trail: string[];
  onNavTrail: (i: number) => void;
  theme: 'light' | 'dark' | 'system';
  onToggleTheme: () => void;
  onOpenMobileNav: () => void;
}

export function Topbar({ trail, onNavTrail, theme, onToggleTheme, onOpenMobileNav }: TopbarProps) {
  const { email, role } = useAuth();
  const emailUser = email ? email.split('@')[0] : 'Admin';
  const initials = emailUser.slice(0, 2).toUpperCase();
  const displayEmail = email ?? '';

  return (
    <div className="topbar">
      <button
        type="button"
        className="mobile-only topbar-menu-btn"
        onClick={onOpenMobileNav}
        aria-label="Open navigation menu"
      >
        <Icon.Menu />
      </button>
      <div className="crumbs">
        {trail.map((crumb, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb trail has no stable id
          <Fragment key={i}>
            {i > 0 && <span className="sep">/</span>}
            {i < trail.length - 1 ? (
              <button className="crumb-link" onClick={() => onNavTrail(i)}>
                {crumb}
              </button>
            ) : (
              <b>{crumb}</b>
            )}
          </Fragment>
        ))}
      </div>
      <div className="topbar-tools">
        <button
          className="iconbtn"
          onClick={onToggleTheme}
          title={`Theme: ${theme === 'system' ? 'System' : theme === 'dark' ? 'Dark' : 'Light'} (click to cycle)`}
          aria-label={`Theme: ${theme === 'system' ? 'System' : theme === 'dark' ? 'Dark' : 'Light'}; click to cycle`}
        >
          {theme === 'system' ? <Icon.Monitor /> : theme === 'dark' ? <Icon.Moon /> : <Icon.Sun />}
        </button>
        <div className="topbar-user">
          <div className="who">
            <b>{emailUser}</b>
            <span className="role-pill">{role}</span>
          </div>
          <span className="avatar" title={displayEmail}>
            {initials}
          </span>
        </div>
      </div>
    </div>
  );
}
