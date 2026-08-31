import type { ReactNode } from 'react';
import { AssetThumb } from './AssetThumb';
import { Icon } from './Icons';

export interface EditDrawerSection {
  title: string;
  children: ReactNode;
  flush?: boolean;
}

export interface EditDrawerTag {
  label: string;
  tone?: 'accent' | 'dot-accent';
}

export interface EditDrawerProps {
  onClose: () => void;
  title: string;
  subtitle?: string;
  tags?: EditDrawerTag[];
  thumbnail?: { thumbnailUrl?: string | null; fullUrl?: string | null };
  width?: string;
  sections?: EditDrawerSection[];
  children?: ReactNode;
  saving?: boolean;
  onSave: () => void;
  saveLabel?: string;
  saveDisabled?: boolean;
}

export function EditDrawer({
  onClose,
  title,
  subtitle,
  tags,
  thumbnail,
  width,
  sections,
  children,
  saving,
  onSave,
  saveLabel,
  saveDisabled,
}: EditDrawerProps) {
  return (
    <div className="modal-overlay" onClick={saving ? undefined : onClose}>
      <div
        className="drawer"
        onClick={(e) => e.stopPropagation()}
        style={width ? { width } : undefined}
      >
        <div className="drawer-head">
          {thumbnail && (
            <AssetThumb
              thumbnailUrl={thumbnail.thumbnailUrl}
              fullUrl={thumbnail.fullUrl}
              label={title}
              w={40}
              h={40}
            />
          )}
          <div style={{ minWidth: 0 }}>
            <h2>{title}</h2>
            {(subtitle || (tags && tags.length > 0)) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                {tags?.map((t) => (
                  <span
                    key={t.label}
                    className={`badge ${t.tone === 'dot-accent' ? 'dot accent' : t.tone === 'accent' ? 'accent' : ''}`}
                  >
                    {t.label}
                  </span>
                ))}
                {subtitle && <span className="mono sub">{subtitle}</span>}
              </div>
            )}
          </div>
          <button
            className="btn sm ghost"
            onClick={onClose}
            disabled={saving}
            style={{ marginLeft: 'auto' }}
          >
            <Icon.Close />
          </button>
        </div>

        <div className="drawer-body" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {sections
            ? sections.map((s) => (
                <div className="card" key={s.title}>
                  <div className="card-head">
                    <h3>{s.title}</h3>
                  </div>
                  <div className={`card-body${s.flush ? ' flush' : ''}`}>{s.children}</div>
                </div>
              ))
            : children}
        </div>

        <div className="drawer-foot">
          <button className="btn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn primary" onClick={onSave} disabled={saving || saveDisabled}>
            {saving ? 'Saving…' : (saveLabel ?? 'Save changes')}
          </button>
        </div>
      </div>
    </div>
  );
}
