'use client';
import { CheckIcon, XIcon } from '@/components/icons';
import { C } from '@/components/tokens';

interface SelectableItem {
  id: string;
  label: string;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
  tags?: string[];
}

interface SelectGridModalProps<T extends SelectableItem> {
  title: string;
  items: T[];
  selectedIds: string[];
  multiSelect?: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  cardHeight?: number;
  aspect?: number;
  columns?: number;
  continueLabel?: string;
  hideLabels?: boolean;
  tagOptions?: string[];
  activeTag?: string;
  onTagChange?: (tag: string) => void;
  // Second, independent filter row shown above the tag row (e.g. continent for
  // faces). Unlike tags (free-text, self-labeling), group ids can differ from
  // their display label (e.g. a slug vs "North America"), so options carry both,
  // and groupOf tells the modal how to read the group value off an item.
  groupOptions?: { id: string; label: string }[];
  activeGroup?: string;
  onGroupChange?: (id: string) => void;
  groupOf?: (item: T) => string;
  allGroupsLabel?: string;
}

export function SelectGridModal<T extends SelectableItem>({
  title,
  items,
  selectedIds,
  multiSelect = false,
  onSelect,
  onClose,
  cardHeight = 148,
  aspect,
  columns = 5,
  continueLabel,
  hideLabels = false,
  tagOptions,
  activeTag = '',
  onTagChange,
  groupOptions,
  activeGroup = '',
  onGroupChange,
  groupOf,
  allGroupsLabel = 'groups',
}: SelectGridModalProps<T>) {
  const groupFiltered =
    !activeGroup || !groupOptions?.length || !groupOf
      ? items
      : items.filter((item) => groupOf(item) === activeGroup);
  const visibleItems =
    !activeTag || !tagOptions?.length
      ? groupFiltered
      : groupFiltered.filter((item) => (item.tags ?? []).includes(activeTag));
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-outside-to-dismiss backdrop; keyboard users have the visible Close button below
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation only, not itself interactive */}
      <div
        role="presentation"
        style={{
          background: C.white,
          borderRadius: 12,
          padding: 24,
          width: 1180,
          height: 857,
          maxWidth: '90vw',
          maxHeight: '90vh',
          boxSizing: 'border-box',
          boxShadow: '0 10px 40px rgba(0,0,0,0.15)',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 20,
            flexShrink: 0,
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: 0 }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: C.mid,
            }}
          >
            <XIcon size={20} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {groupOptions && groupOptions.length > 0 && onGroupChange && groupOf && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
              <button
                type="button"
                onClick={() => onGroupChange('')}
                style={{
                  padding: '7px 14px',
                  borderRadius: 8,
                  border: `1px solid ${activeGroup === '' ? C.pink : C.border2}`,
                  background: activeGroup === '' ? 'rgba(245,92,122,0.08)' : C.white,
                  color: activeGroup === '' ? C.pink : C.text,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                All {allGroupsLabel}
              </button>
              {groupOptions.map((g) => (
                <button
                  type="button"
                  key={g.id}
                  onClick={() => onGroupChange(g.id)}
                  style={{
                    padding: '7px 14px',
                    borderRadius: 8,
                    border: `1px solid ${activeGroup === g.id ? C.pink : C.border2}`,
                    background: activeGroup === g.id ? 'rgba(245,92,122,0.08)' : C.white,
                    color: activeGroup === g.id ? C.pink : C.text,
                    fontFamily: 'inherit',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {g.label}
                </button>
              ))}
            </div>
          )}
          {tagOptions && tagOptions.length > 0 && onTagChange && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
              <button
                type="button"
                onClick={() => onTagChange('')}
                style={{
                  padding: '7px 14px',
                  borderRadius: 8,
                  border: `1px solid ${activeTag === '' ? C.pink : C.border2}`,
                  background: activeTag === '' ? 'rgba(245,92,122,0.08)' : C.white,
                  color: activeTag === '' ? C.pink : C.text,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                All tags
              </button>
              {tagOptions.map((tag) => (
                <button
                  type="button"
                  key={tag}
                  onClick={() => onTagChange(tag)}
                  style={{
                    padding: '7px 14px',
                    borderRadius: 8,
                    border: `1px solid ${activeTag === tag ? C.pink : C.border2}`,
                    background: activeTag === tag ? 'rgba(245,92,122,0.08)' : C.white,
                    color: activeTag === tag ? C.pink : C.text,
                    fontFamily: 'inherit',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
          {visibleItems.length === 0 ? (
            <p style={{ fontSize: 14, color: C.mid }}>Nothing available yet.</p>
          ) : (
            <div
              className="studio-select-modal-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gap: 16,
              }}
            >
              {visibleItems.map((item) => {
                const selected = selectedIds.includes(item.id);
                const img = item.previewUrl || item.thumbnailUrl;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelect(item.id)}
                    style={{
                      cursor: 'pointer',
                      textAlign: 'center',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      font: 'inherit',
                      color: 'inherit',
                    }}
                  >
                    <div
                      style={{
                        width: '100%',
                        height: aspect ? undefined : cardHeight,
                        aspectRatio: aspect,
                        background: selected
                          ? `linear-gradient(${C.card}, ${C.card}) padding-box, linear-gradient(135deg, #BD2587 0%, #ff5b94 100%) border-box`
                          : `linear-gradient(${C.card}, ${C.card}) padding-box, linear-gradient(${C.border}, ${C.border}) border-box`,
                        border: '3px solid transparent',
                        borderRadius: 12,
                        padding: 0,
                        boxSizing: 'border-box',
                        position: 'relative',
                        overflow: 'hidden',
                        display: 'flex',
                        flexDirection: 'column',
                      }}
                    >
                      <div
                        style={{
                          width: '100%',
                          height: '100%',
                          borderRadius: 10,
                          overflow: 'hidden',
                          background: C.lighter,
                        }}
                      >
                        {img ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          // biome-ignore lint/performance/noImgElement: studio select modal preview
                          <img
                            src={img}
                            alt={item.label}
                            style={{
                              width: '100%',
                              height: '100%',
                              objectFit: 'cover',
                              objectPosition: 'top center',
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              width: '100%',
                              height: '100%',
                              background: C.field,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: C.light,
                              fontSize: 11,
                            }}
                          >
                            {item.label}
                          </div>
                        )}
                      </div>
                      {selected && (
                        <div
                          style={{
                            position: 'absolute',
                            top: 6,
                            right: 6,
                            width: 20,
                            height: 20,
                            borderRadius: '50%',
                            background: 'linear-gradient(135deg, #BD2587 0%, #ff5b94 100%)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <CheckIcon color={C.white} size={11} />
                        </div>
                      )}
                    </div>
                    {!hideLabels && (
                      <div
                        title={item.label}
                        className="sel-card-label-box"
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          lineHeight: 1.25,
                          color: C.text,
                          marginTop: 4,
                          height: 38,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          width: '100%',
                          textAlign: 'center',
                          boxSizing: 'border-box',
                          wordBreak: 'break-word',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {item.label}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {multiSelect && continueLabel && selectedIds.length > 0 && (
          <div
            style={{
              flexShrink: 0,
              marginTop: 16,
              paddingTop: 16,
              borderTop: `1px solid ${C.border}`,
              display: 'flex',
              justifyContent: 'flex-end',
            }}
          >
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'linear-gradient(135deg, #7c3aed 0%, #BD2587 100%)',
                color: C.white,
                border: 'none',
                borderRadius: 8,
                padding: '10px 20px',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {continueLabel.replace('{count}', String(selectedIds.length))}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
