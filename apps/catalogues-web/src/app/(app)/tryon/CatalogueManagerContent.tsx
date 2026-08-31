'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MerchantCatalogCategory as Category,
  MerchantCatalogItem,
  MerchantCatalogListResponse,
  MerchantCatalogSubcategory,
  MerchantCatalogSubcategoryListResponse,
} from '@tryme/types';
import { useEffect, useState } from 'react';
import { ArrowLeft, PlusIcon, TrashIcon, UploadIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { TopBar } from '@/components/topbar';
import { DemoVideoSection, GetAppButton } from '@/components/try-on-promo';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { GradBtn } from '@/components/ui/grad-btn';
import { api } from '@/lib/api';
import { BREAKPOINTS } from '@/lib/breakpoints';
import { DEFAULT_GARMENT_ICON as DefaultGarmentIcon, getGarmentIcon } from '@/lib/garment-icons';
import { reconcileHeldProducts } from './api';
import { BulkUploadModal } from './BulkUploadModal';
import { ProductModal } from './ProductModal';
import { SubcategoryModal } from './SubcategoryModal';

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'men', label: 'Men' },
  { id: 'women', label: 'Women' },
  { id: 'boys', label: 'Boys' },
  { id: 'girls', label: 'Girls' },
];

// "not a merchant account" / "merchant account inactive" — thrown by requireMerchant
// (apps/api/src/plugins/portal-auth.ts) when the logged-in user has no merchants row.
function isMerchantGateError(err: unknown): boolean {
  return err instanceof Error && /merchant account/i.test(err.message);
}

export function CatalogueManagerContent() {
  const qc = useQueryClient();
  const [selectedCategory, setSelectedCategory] = useState<Category>('men');
  const [selectedSubcategoryId, setSelectedSubcategoryId] = useState<string | null>(null);

  // Modals state
  const [subModalOpen, setSubModalOpen] = useState(false);
  const [editingSub, setEditingSub] = useState<MerchantCatalogSubcategory | undefined>(undefined);
  const [deleteSub, setDeleteSub] = useState<MerchantCatalogSubcategory | undefined>(undefined);

  const [prodModalOpen, setProdModalOpen] = useState(false);
  const [editingProd, setEditingProd] = useState<MerchantCatalogItem | undefined>(undefined);
  const [deleteProd, setDeleteProd] = useState<MerchantCatalogItem | undefined>(undefined);

  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [reconcileFailedCount, setReconcileFailedCount] = useState(0);

  const subcategoriesQuery = useQuery({
    queryKey: ['merchant-catalog-subcategories'],
    queryFn: () =>
      api.get<MerchantCatalogSubcategoryListResponse>(
        '/v1/merchant/catalog/subcategories?includeDemo=false',
      ),
  });
  const subcategories = subcategoriesQuery.data?.items ?? [];

  const garmentTypesQuery = useQuery({
    queryKey: ['garment-types', selectedCategory],
    queryFn: () =>
      api.get<{ items: { id: string; label: string }[] }>(
        `/v1/models/garment-types?gender=${selectedCategory}`,
      ),
    enabled: !isMerchantGateError(subcategoriesQuery.error),
  });
  const garmentTypes = garmentTypesQuery.data?.items ?? [];

  const productsQuery = useQuery({
    queryKey: ['merchant-catalog-products', selectedSubcategoryId],
    queryFn: () =>
      api.get<MerchantCatalogListResponse>(
        `/v1/merchant/catalog?includeDemo=false&subcategoryId=${selectedSubcategoryId}`,
      ),
    enabled: !!selectedSubcategoryId,
  });
  const products = productsQuery.data?.items ?? [];

  // Pull in any held batches that finished while the merchant was away. This
  // is merchant-wide (not scoped to selectedSubcategoryId), so it runs once
  // on mount rather than per-subcategory selection.
  useEffect(() => {
    let cancelled = false;
    void reconcileHeldProducts().then(({ created, failed }) => {
      if (cancelled) return;
      if (created.length > 0) {
        qc.invalidateQueries({ queryKey: ['merchant-catalog-products'] });
        qc.invalidateQueries({ queryKey: ['merchant-catalog-subcategories'] });
      }
      // failed === -1 means the reconcile request itself never completed (network
      // error, 5xx, session expiry) — distinct from failed > 0, a partial failure
      // the server already logged. See reconcileHeldProducts' doc comment.
      setReconcileFailedCount(failed);
    });
    return () => {
      cancelled = true;
    };
  }, [qc]);

  const invalidateSubcategories = () =>
    qc.invalidateQueries({ queryKey: ['merchant-catalog-subcategories'] });
  const invalidateProducts = () =>
    qc.invalidateQueries({ queryKey: ['merchant-catalog-products', selectedSubcategoryId] });

  const createSubMutation = useMutation({
    mutationFn: (vars: { name: string; garmentSubcategoryId: string }) =>
      api.post<MerchantCatalogSubcategory>('/v1/merchant/catalog/subcategories', {
        category: selectedCategory,
        name: vars.name,
        garmentSubcategoryId: vars.garmentSubcategoryId,
      }),
    onSuccess: () => {
      invalidateSubcategories();
      setSubModalOpen(false);
      setEditingSub(undefined);
    },
  });

  const updateSubMutation = useMutation({
    mutationFn: (vars: { id: string; name: string; garmentSubcategoryId: string }) =>
      api.patch<MerchantCatalogSubcategory>(`/v1/merchant/catalog/subcategories/${vars.id}`, {
        name: vars.name,
        garmentSubcategoryId: vars.garmentSubcategoryId,
      }),
    onSuccess: () => {
      invalidateSubcategories();
      setSubModalOpen(false);
      setEditingSub(undefined);
    },
  });

  const deleteSubMutation = useMutation({
    mutationFn: (id: string) => api.del<void>(`/v1/merchant/catalog/subcategories/${id}`),
    onSuccess: (_data, id) => {
      invalidateSubcategories();
      if (selectedSubcategoryId === id) setSelectedSubcategoryId(null);
      setDeleteSub(undefined);
    },
  });

  const deleteProductMutation = useMutation({
    mutationFn: (id: string) => api.del<void>(`/v1/merchant/catalog/${id}`),
    onSuccess: () => {
      invalidateProducts();
      invalidateSubcategories(); // productCount changed
      setDeleteProd(undefined);
    },
  });

  const isMounted = !subcategoriesQuery.isLoading;
  const merchantGated = isMerchantGateError(subcategoriesQuery.error);

  // --- Handlers ---
  const handleSaveSubcategory = (name: string, garmentSubcategoryId: string) => {
    if (editingSub) updateSubMutation.mutate({ id: editingSub.id, name, garmentSubcategoryId });
    else createSubMutation.mutate({ name, garmentSubcategoryId });
  };

  const handleDeleteSubcategory = () => {
    if (deleteSub) deleteSubMutation.mutate(deleteSub.id);
  };

  const handleDeleteProduct = () => {
    if (deleteProd) deleteProductMutation.mutate(deleteProd.id);
  };

  const handleProductSaved = () => {
    invalidateProducts();
    invalidateSubcategories();
    setProdModalOpen(false);
    setEditingProd(undefined);
  };

  const handleBulkSaved = () => {
    invalidateProducts();
    invalidateSubcategories();
    setBulkModalOpen(false);
  };

  const openAddSubcategory = () => {
    setEditingSub(undefined);
    setSubModalOpen(true);
  };

  const openAddProduct = () => {
    setEditingProd(undefined);
    setProdModalOpen(true);
  };

  // Shortcut from a category card: jump straight to its upload form instead
  // of navigating in and clicking Add Product as a second step.
  const openUploadForSubcategory = (subId: string) => {
    setSelectedSubcategoryId(subId);
    openAddProduct();
  };

  if (!isMounted) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: C.mid, fontSize: 14 }}>Loading catalogue...</div>
      </div>
    );
  }

  if (merchantGated) {
    return (
      <>
        <TopBar title="Try-On" subtitle="Organize your products by category and garment type." />
        <div
          style={{
            flex: 1,
            padding: '64px 24px',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <h3 style={{ fontSize: 16, fontWeight: 600, color: C.text, margin: 0 }}>
            Merchant account required
          </h3>
          <p style={{ color: C.light, fontSize: 14, margin: 0, maxWidth: 360 }}>
            This account isn't enabled for virtual try-on yet. Contact support to get your merchant
            account activated.
          </p>
        </div>
      </>
    );
  }

  const selectedSub = subcategories.find((s) => s.id === selectedSubcategoryId);
  const visibleSubs = subcategories.filter((s) => s.category === selectedCategory);
  const selectedGarmentTypeLabel = selectedSub
    ? garmentTypes.find((g) => g.id === selectedSub.garmentSubcategoryId)?.label
    : undefined;
  const addProductLabel = selectedGarmentTypeLabel
    ? `Add ${selectedGarmentTypeLabel}`
    : 'Add Product';

  // --- Views ---
  const renderCategoryTabs = () => (
    <div
      className="tryon-hpad tryon-cat-tabs"
      style={{
        display: 'flex',
        gap: 10,
        marginBottom: 24,
        padding: '0 28px',
        marginTop: 24,
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        // `overflow-x: auto` opts this row out of flexbox's automatic
        // minimum-size protection — without flexShrink: 0 the column flex
        // container (squeezed by the grid + demo video below) shrinks this
        // row down to near-zero height instead of ever showing a scrollbar.
        flexShrink: 0,
      }}
    >
      {CATEGORIES.map((cat) => {
        const isSelected = selectedCategory === cat.id;
        return (
          <button
            type="button"
            key={cat.id}
            onClick={() => {
              setSelectedCategory(cat.id);
              setSelectedSubcategoryId(null);
            }}
            style={{
              padding: '8px 20px',
              borderRadius: 8,
              border: `1px solid ${isSelected ? C.pink : C.border2}`,
              background: isSelected ? 'rgba(245, 92, 122, 0.05)' : C.card,
              color: isSelected ? C.pink : C.text,
              fontWeight: isSelected ? 600 : 500,
              fontSize: 14,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              outline: 'none',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
            className="focus-ring hover-surface"
          >
            {cat.label}
          </button>
        );
      })}
    </div>
  );

  const renderSubcategoryGrid = () => {
    if (visibleSubs.length === 0) {
      return (
        <div
          className="tryon-hpad tryon-empty-pad"
          style={{
            padding: '64px 24px',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <div style={{ color: C.pink, opacity: 0.8, marginBottom: 4 }}>
            <DefaultGarmentIcon size={48} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <h3
              className="tryon-empty-title"
              style={{ fontSize: 16, fontWeight: 600, color: C.text, margin: 0 }}
            >
              No categories yet
            </h3>
            <p
              className="tryon-empty-text"
              style={{ color: C.light, fontSize: 14, margin: 0, maxWidth: 300 }}
            >
              Create your first category to start organizing your products.
            </p>
          </div>
        </div>
      );
    }

    return (
      <div
        className="tryon-hpad tryon-sub-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 16,
          padding: '0 28px 40px',
        }}
      >
        {visibleSubs.map((sub) => {
          const garmentTypeLabel =
            garmentTypes.find((g) => g.id === sub.garmentSubcategoryId)?.label || 'Unknown';
          const GarmentTypeIcon = getGarmentIcon(garmentTypeLabel);

          return (
            // biome-ignore lint/a11y/useSemanticElements: contains nested interactive <button>s (delete, upload) — real <button> here would be invalid HTML (no nesting)
            <div
              key={sub.id}
              className="prod-card focus-ring"
              tabIndex={0}
              role="button"
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedSubcategoryId(sub.id);
                }
              }}
              onClick={() => setSelectedSubcategoryId(sub.id)}
              style={{
                position: 'relative',
                padding: '24px 20px 20px',
                border: `1px solid ${C.border}`,
                borderRadius: 14,
                background: C.card,
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                transition: 'transform 0.15s, border-color 0.15s',
                outline: 'none',
              }}
            >
              {/* Delete button */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteSub(sub);
                }}
                style={{
                  position: 'absolute',
                  top: 14,
                  right: 14,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: C.light,
                  padding: 6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 6,
                  transition: 'color 0.12s, background 0.12s',
                  zIndex: 10,
                }}
                className="hover-surface"
                title="Delete category"
              >
                <TrashIcon />
              </button>

              <div
                style={{
                  color: C.pink,
                  width: 40,
                  height: 40,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(245, 92, 122, 0.1)',
                  backdropFilter: 'blur(6px)',
                  WebkitBackdropFilter: 'blur(6px)',
                  borderRadius: 10,
                }}
              >
                <GarmentTypeIcon size={20} />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <div
                  className="tryon-card-title"
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    color: C.text,
                    wordBreak: 'break-word',
                    paddingRight: 24,
                  }}
                >
                  {sub.name}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      background: C.border2,
                      color: C.text,
                      padding: '2px 8px',
                      borderRadius: 6,
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                    }}
                  >
                    {garmentTypeLabel}
                  </span>
                  <span style={{ fontSize: 12, color: C.mid }}>
                    • {sub.productCount} {sub.productCount === 1 ? 'item' : 'items'}
                  </span>
                </div>
              </div>

              {/* Upload shortcut — skips navigating in first */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openUploadForSubcategory(sub.id);
                }}
                style={{
                  marginTop: 4,
                  paddingTop: 12,
                  background: 'none',
                  border: 'none',
                  borderTop: `1px solid ${C.border2}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  color: C.pink,
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
                className="hover-surface"
              >
                <UploadIcon size={14} />
                Add {garmentTypeLabel}
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  const renderProductGrid = () => {
    if (!selectedSub) return null;

    if (productsQuery.isLoading) {
      return (
        <div style={{ padding: '40px', textAlign: 'center', color: C.light, fontSize: 14 }}>
          Loading products...
        </div>
      );
    }

    if (products.length === 0) {
      return (
        <div
          className="tryon-hpad tryon-empty-pad"
          style={{
            padding: '64px 24px',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <div style={{ color: C.pink, opacity: 0.8, marginBottom: 4 }}>
            <DefaultGarmentIcon size={48} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <h3
              className="tryon-empty-title"
              style={{ fontSize: 16, fontWeight: 600, color: C.text, margin: 0 }}
            >
              No products yet
            </h3>
            <p
              className="tryon-empty-text"
              style={{ color: C.light, fontSize: 14, margin: 0, maxWidth: 300 }}
            >
              Add your first product to this category.
            </p>
          </div>
        </div>
      );
    }

    return (
      <div
        className="tryon-hpad tryon-prod-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 16,
          padding: '24px 28px 40px',
        }}
      >
        {products.map((product) => (
          <div
            key={product.id}
            className="prod-card"
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              border: `1px solid ${C.border}`,
              borderRadius: 14,
              overflow: 'hidden',
              background: C.card,
              position: 'relative',
            }}
          >
            {/* Action Buttons */}
            <div
              style={{
                position: 'absolute',
                top: 10,
                right: 10,
                display: 'flex',
                gap: 6,
                zIndex: 10,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setEditingProd(product);
                  setProdModalOpen(true);
                }}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: C.card,
                  border: `1px solid ${C.border2}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: C.text,
                  cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                }}
                className="hover-surface"
                title="Edit Product"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setDeleteProd(product)}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: C.card,
                  border: `1px solid ${C.border2}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: C.pink,
                  cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                }}
                className="hover-surface"
                title="Delete Product"
              >
                <TrashIcon />
              </button>
            </div>

            {/* Image Area */}
            <div
              style={{
                aspectRatio: '3/4',
                background: C.lighter,
                position: 'relative',
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div className="prod-card-img" style={{ width: '100%', height: '100%' }}>
                {product.thumbnailUrl || product.imageUrl ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {/* biome-ignore lint/performance/noImgElement: presigned R2 URL */}
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
                  </>
                ) : (
                  <div
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: C.mid,
                      opacity: 0.35,
                    }}
                  >
                    <DefaultGarmentIcon size={48} />
                  </div>
                )}
              </div>
              {!product.isActive && product.actualPrice === 0 && (
                <div
                  style={{
                    position: 'absolute',
                    top: 10,
                    left: 10,
                    background: C.pink,
                    color: C.white,
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '2px 6px',
                    borderRadius: 4,
                    textTransform: 'uppercase',
                    zIndex: 5,
                  }}
                >
                  Needs details
                </div>
              )}
            </div>

            {/* Details Area */}
            <div
              style={{
                padding: '14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: C.text,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {product.label}
              </div>

              <div
                style={{
                  fontSize: 12,
                  color: C.mid,
                  fontFamily: 'monospace',
                }}
              >
                SKU: {product.sku ?? '—'}
              </div>

              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: C.pink }}>
                  ₹{product.offerPrice}
                </span>
                {product.offerPrice < product.actualPrice && (
                  <span style={{ fontSize: 13, color: C.mid, textDecoration: 'line-through' }}>
                    ₹{product.actualPrice}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div
      style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `
            .tryon-cat-tabs::-webkit-scrollbar {
              display: none;
            }
            @media (max-width: ${BREAKPOINTS.sm - 1}px) {
              .tryon-hpad {
                padding-left: 16px !important;
                padding-right: 16px !important;
              }
              .tryon-hmargin {
                margin-left: 16px !important;
                margin-right: 16px !important;
              }
              .tryon-empty-pad {
                padding-top: 40px !important;
                padding-bottom: 40px !important;
              }
              .tryon-empty-title {
                font-size: 15px !important;
              }
              .tryon-empty-text {
                font-size: 13px !important;
              }
              .tryon-card-title {
                font-size: 15px !important;
              }
              .tryon-detail-title {
                font-size: 17px !important;
                line-height: 24px !important;
              }
              .tryon-detail-sub {
                font-size: 13px !important;
              }
              .tryon-cat-tabs button {
                font-size: 13px !important;
                padding: 6px 14px !important;
              }
              .tryon-bulk-btn {
                height: 40px !important;
                padding: 0 14px !important;
                font-size: 13px !important;
              }
              .tryon-add-cat-btn {
                height: 40px !important;
                padding: 0 16px !important;
                font-size: 13px !important;
                gap: 6px !important;
              }
              .tryon-sub-grid {
                grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)) !important;
                gap: 12px !important;
              }
              .tryon-prod-grid {
                grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)) !important;
                gap: 12px !important;
              }
            }
            @media (min-width: ${BREAKPOINTS.sm}px) and (max-width: ${BREAKPOINTS.lg - 1}px) {
              .tryon-hpad {
                padding-left: 20px !important;
                padding-right: 20px !important;
              }
              .tryon-hmargin {
                margin-left: 20px !important;
                margin-right: 20px !important;
              }
              .tryon-detail-title {
                font-size: 18px !important;
              }
              .tryon-add-cat-btn {
                height: 42px !important;
                padding: 0 20px !important;
              }
              .tryon-sub-grid {
                grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)) !important;
              }
              .tryon-prod-grid {
                grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)) !important;
              }
            }
          `,
        }}
      />
      {!selectedSub ? (
        <>
          <TopBar title="Try-On" right={<GetAppButton />} />
          <div
            style={{
              flex: 1,
              minWidth: 0,
              overflowY: 'auto',
              overflowX: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {renderCategoryTabs()}
            <div
              className="tryon-hpad"
              style={{ display: 'flex', justifyContent: 'flex-start', padding: '8px 28px 32px' }}
            >
              <GradBtn
                onClick={openAddSubcategory}
                className="tryon-add-cat-btn"
                style={{ height: 44, padding: '0 26px' }}
              >
                <PlusIcon size={14} />
                Add Category
              </GradBtn>
            </div>
            {renderSubcategoryGrid()}
            {/* marginTop: auto pins this to the bottom of the viewport when the
                grid above is short, instead of it jumping up right under a
                sparse category — with more subcategories it just flows below
                them like normal content. minWidth: 0 stops this flex item's
                content (the fixed-width video box) from forcing the column
                — and the whole page — wider than the viewport on mobile. */}
            <div style={{ marginTop: 'auto', minWidth: 0 }}>
              <DemoVideoSection />
            </div>
          </div>
        </>
      ) : (
        <>
          <TopBar
            lead={
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
                <button
                  type="button"
                  onClick={() => setSelectedSubcategoryId(null)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 6,
                    color: C.text,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '50%',
                    transition: 'background 0.15s',
                    flexShrink: 0,
                  }}
                  className="hover-surface"
                  title="Back to categories"
                >
                  <ArrowLeft />
                </button>
                <div style={{ minWidth: 0, overflow: 'hidden' }}>
                  <div
                    className="tryon-detail-title"
                    style={{
                      fontWeight: 600,
                      fontSize: 20,
                      lineHeight: '32px',
                      color: C.text,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {selectedSub.name}
                  </div>
                  <div
                    className="tryon-detail-sub"
                    style={{
                      fontWeight: 500,
                      fontSize: 14,
                      lineHeight: '20px',
                      color: C.mid,
                      marginTop: 2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {garmentTypes.find((g) => g.id === selectedSub.garmentSubcategoryId)?.label ||
                      'Unknown'}
                  </div>
                </div>
              </div>
            }
          />
          {reconcileFailedCount !== 0 && (
            <div
              className="tryon-hmargin"
              style={{
                margin: '16px 28px 0',
                padding: '8px 12px',
                borderRadius: 8,
                background: 'rgba(245,92,122,0.06)',
                border: `1px solid ${C.pink}`,
                fontSize: 13,
                color: C.pink,
              }}
            >
              {reconcileFailedCount > 0
                ? `${reconcileFailedCount} generated image${reconcileFailedCount === 1 ? '' : 's'} failed to load — try reloading this page.`
                : "Couldn't check for newly generated products — try reloading this page."}
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            <div
              className="tryon-hpad"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 12,
                alignItems: 'center',
                padding: '20px 28px 4px',
              }}
            >
              <button
                type="button"
                onClick={() => setBulkModalOpen(true)}
                className="hover-surface focus-ring tryon-bulk-btn"
                style={{
                  height: 44,
                  padding: '0 20px',
                  borderRadius: 8,
                  border: `1px solid ${C.border2}`,
                  background: C.card,
                  color: C.text,
                  fontWeight: 600,
                  fontSize: 14,
                  cursor: 'pointer',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.02)',
                  whiteSpace: 'nowrap',
                }}
              >
                Bulk Upload
              </button>
              <GradBtn
                onClick={openAddProduct}
                className="tryon-add-cat-btn"
                style={{ height: 44, padding: '0 26px' }}
              >
                <PlusIcon size={14} />
                {addProductLabel}
              </GradBtn>
            </div>
            {renderProductGrid()}
          </div>
        </>
      )}

      {/* Modals & Dialogs */}
      <SubcategoryModal
        open={subModalOpen}
        onClose={() => {
          setSubModalOpen(false);
          setEditingSub(undefined);
        }}
        onSave={handleSaveSubcategory}
        initialData={
          editingSub
            ? {
                id: editingSub.id,
                name: editingSub.name,
                garmentSubcategoryId: editingSub.garmentSubcategoryId,
              }
            : undefined
        }
        garmentTypes={garmentTypes}
        isSaving={createSubMutation.isPending || updateSubMutation.isPending}
      />

      <ProductModal
        open={prodModalOpen}
        onClose={() => {
          setProdModalOpen(false);
          setEditingProd(undefined);
        }}
        onSaved={handleProductSaved}
        subcategoryId={selectedSubcategoryId}
        supportsTwoInputMannequin={selectedSub?.supportsTwoInputMannequin ?? false}
        supportsTwoInputDirectTryon={selectedSub?.supportsTwoInputDirectTryon ?? false}
        initialData={editingProd}
      />

      <BulkUploadModal
        open={bulkModalOpen}
        onClose={() => setBulkModalOpen(false)}
        onSaved={handleBulkSaved}
        subcategoryId={selectedSubcategoryId}
      />

      <ConfirmDialog
        open={!!deleteSub}
        title="Delete Category"
        message={`Are you sure you want to delete "${deleteSub?.name}"? All products inside it will also be deleted.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDeleteSubcategory}
        onCancel={() => setDeleteSub(undefined)}
      />

      <ConfirmDialog
        open={!!deleteProd}
        title="Delete Product"
        message={`Are you sure you want to delete "${deleteProd?.label}"?`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDeleteProduct}
        onCancel={() => setDeleteProd(undefined)}
      />
    </div>
  );
}
