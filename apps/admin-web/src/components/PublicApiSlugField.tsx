interface Props {
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
  /** What kind of asset this is, used in the placeholder (e.g. "model", "pose"). */
  kind: string;
}

/**
 * Publishes an admin asset to the public developer API.
 *
 * Empty means the asset is not reachable from /v1/dev/* at all — the same column
 * carries both the on/off state and the public name, so there is no separate toggle
 * to fall out of sync with it.
 *
 * The warning is not decorative: third-party integrations hard-code these slugs, so
 * renaming one breaks every caller already using it.
 */
export function PublicApiSlugField({ value, disabled, onChange, kind }: Props) {
  const invalid = value !== '' && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);
  return (
    <div className="field">
      <label>Public API slug</label>
      <input
        className="input"
        value={value}
        disabled={disabled}
        placeholder={`e.g. women-${kind}-01 — leave empty to hide from the public API`}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="hint" style={{ color: invalid ? 'var(--danger, #d33)' : undefined }}>
        {invalid
          ? 'Lowercase letters, numbers and single hyphens only.'
          : 'Empty = not exposed on the developer API. Renaming an existing slug breaks integrations already using it.'}
      </div>
    </div>
  );
}
