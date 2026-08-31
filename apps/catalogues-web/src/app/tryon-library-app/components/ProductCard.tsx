'use client';
import type { MerchantCatalogItem } from '@tryme/types';
import { ChevronRight, GarmentIcon, TrashIcon } from '@/components/icons';
import { LIGHT } from '../theme';

export function ProductCard({
  product,
  onOpen,
  onDelete,
}: {
  product: MerchantCatalogItem;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        border: `1px solid ${LIGHT.border}`,
        borderRadius: 14,
        overflow: 'hidden',
        background: LIGHT.card,
        position: 'relative',
      }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label={`Delete ${product.label}`}
        className="focus-ring hover-surface"
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          width: 32,
          height: 32,
          borderRadius: 8,
          background: LIGHT.card,
          border: `1px solid ${LIGHT.border2}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#f55c7a',
          cursor: 'pointer',
          zIndex: 1,
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        }}
      >
        <TrashIcon />
      </button>

      {/* biome-ignore lint/a11y/useSemanticElements: contains a nested interactive <button> (delete) — real <button> here would be invalid HTML (no nesting) */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
        className="focus-ring"
        style={{ display: 'flex', flexDirection: 'column', cursor: 'pointer', outline: 'none' }}
      >
        <div
          style={{
            aspectRatio: '3/4',
            background: LIGHT.field,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          }}
        >
          {product.thumbnailUrl || product.imageUrl ? (
            // biome-ignore lint/performance/noImgElement: presigned R2 URL
            <img
              src={product.thumbnailUrl ?? product.imageUrl ?? undefined}
              alt={product.label}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'top center',
              }}
            />
          ) : (
            <GarmentIcon size={40} />
          )}
          {!product.isActive && product.actualPrice === 0 && (
            <div
              style={{
                position: 'absolute',
                top: 6,
                left: 6,
                background: '#f55c7a',
                color: '#ffffff',
                fontSize: 10,
                fontWeight: 700,
                padding: '2px 6px',
                borderRadius: 4,
                textTransform: 'uppercase',
              }}
            >
              Needs details
            </div>
          )}
        </div>
        <div
          style={{ padding: '12px 12px 14px', display: 'flex', flexDirection: 'column', gap: 3 }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: LIGHT.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {product.label}
          </div>
          {product.sku && (
            <div
              style={{
                fontSize: 11,
                color: LIGHT.mid,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              SKU: {product.sku}
            </div>
          )}
          <div
            style={{
              marginTop: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: '#f55c7a' }}>
                ₹{product.offerPrice}
              </span>
              {product.offerPrice < product.actualPrice && (
                <span style={{ fontSize: 11, color: LIGHT.mid, textDecoration: 'line-through' }}>
                  ₹{product.actualPrice}
                </span>
              )}
            </div>
            <div
              style={{
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                padding: '4px 10px',
                borderRadius: 999,
                background: 'rgba(245, 92, 122, 0.1)',
                color: '#f55c7a',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              View
              <ChevronRight />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
