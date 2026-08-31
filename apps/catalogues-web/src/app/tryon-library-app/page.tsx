'use client';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MerchantCatalogCategory as Category,
  MerchantCatalogItem,
  MerchantCatalogSubcategoryListResponse,
} from '@tryme/types';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ChevronRight } from '@/components/icons';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { catalogAppApi as api, CatalogAppSessionExpiredError } from './catalog-app-api';
import { ScreenHeader } from './components/ScreenHeader';
import { SubcategoryCard } from './components/SubcategoryCard';
import { useLoggedOut } from './logged-out-context';
import { GENDER_OPTIONS, LIGHT } from './theme';

// "not a merchant account" / "merchant account inactive" — thrown by requireMerchant
// (apps/api/src/plugins/portal-auth.ts) when the logged-in user has no merchants row.
function isMerchantGateError(err: unknown): boolean {
  return err instanceof Error && /merchant account/i.test(err.message);
}

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

function GenderPicker({ onSelect }: { onSelect: (category: Category) => void }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-start',
        gap: 16,
        padding: '32px 16px 16px',
        maxWidth: 420,
        width: '100%',
        margin: '0 auto',
      }}
    >
      <div style={{ marginBottom: 4 }}>
        <div style={{ fontSize: 26, fontWeight: 800, color: LIGHT.text, lineHeight: 1.25 }}>
          Select a <span style={{ color: '#f55c7a' }}>Category</span>
        </div>
        <p style={{ fontSize: 14, color: LIGHT.mid, marginTop: 8, lineHeight: 1.5 }}>
          Choose a category to upload and manage your fashion products.
        </p>
      </div>

      {GENDER_OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onSelect(opt.id)}
          className="focus-ring hover-surface"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            border: `1px solid ${LIGHT.border}`,
            borderRadius: 16,
            background: LIGHT.card,
            padding: '20px',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: LIGHT.text }}>{opt.label}</div>
            <p style={{ fontSize: 13, color: LIGHT.mid, marginTop: 4, lineHeight: 1.4 }}>
              {opt.description}
            </p>
          </div>
          <div
            style={{
              flexShrink: 0,
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: opt.tint,
              color: opt.accent,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <ChevronRight />
          </div>
        </button>
      ))}
    </div>
  );
}

// Docked at the bottom of the starting screen only — once the user drills
// into a category the credit breakdown isn't relevant, so this unmounts along
// with GenderPicker rather than living in ScreenHeader (empty on that screen).
function CreditSummaryBar() {
  const { data: me } = useQuery<{ balance: number; used: number }>({
    queryKey: ['catalog-app-me'],
    queryFn: () => api.get('/v1/merchant/me'),
    retry: false,
  });

  const available = me?.balance ?? 0;
  const used = me?.used ?? 0;

  return (
    // Floating card, not an edge-to-edge flush bar — inset on all sides and
    // raised 48px clear of the true viewport bottom, since this screen is
    // embedded in the Android app's WebView, which reserves its own bottom
    // chrome that would otherwise cover a flush-docked bar.
    <div
      style={{
        position: 'sticky',
        bottom: 'calc(48px + env(safe-area-inset-bottom))',
        margin: '0 16px',
      }}
    >
      <div
        style={{
          background: LIGHT.card,
          border: `1px solid ${LIGHT.border}`,
          borderRadius: 16,
          boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
          padding: '14px 20px',
          display: 'flex',
          alignItems: 'stretch',
          gap: 16,
        }}
      >
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'flex', flexShrink: 0 }}>
            {/* biome-ignore lint/performance/noImgElement: credit icon, standalone page not using next/image */}
            <img src={`${BASE}/assets/credit.png`} alt="" width={20} height={20} />
          </span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: LIGHT.text, lineHeight: 1.2 }}>
              {available}
            </div>
            <div style={{ fontSize: 11, color: LIGHT.mid }}>Credits Available</div>
          </div>
        </div>

        <div style={{ width: 1, background: LIGHT.border }} />

        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: LIGHT.text, lineHeight: 1.2 }}>
              {used}
            </div>
            <div style={{ fontSize: 11, color: LIGHT.mid }}>Credits Used</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SubcategoriesScreenInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const onLoggedOut = useLoggedOut();

  const selectedCategory = searchParams.get('category') as Category | null;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  function selectGender(category: Category) {
    router.push(`/tryon-library-app?category=${category}`);
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    setSelectedIds(new Set());
  }, [selectedCategory]);

  const subcategoriesQuery = useQuery({
    queryKey: ['merchant-catalog-subcategories'],
    queryFn: () =>
      api.get<MerchantCatalogSubcategoryListResponse>(
        '/v1/merchant/catalog/subcategories?includeDemo=false',
      ),
  });

  const merchantGated = isMerchantGateError(subcategoriesQuery.error);

  useEffect(() => {
    if (subcategoriesQuery.error instanceof CatalogAppSessionExpiredError) {
      onLoggedOut();
    }
  }, [subcategoriesQuery.error, onLoggedOut]);

  const subcategories = subcategoriesQuery.data?.items ?? [];
  const selectedCategorySubs = subcategories.filter((s) => s.category === selectedCategory);

  // Same garment-type catalog Studio's picker uses (id/label/thumbnailUrl) —
  // reused here purely for its admin-curated thumbnail, as a stand-in photo
  // for subcategories that don't have a real product photo yet.
  const garmentTypesQuery = useQuery({
    queryKey: ['garment-types', selectedCategory],
    queryFn: () =>
      api.get<{ items: { id: string; label: string; thumbnailUrl?: string | null }[] }>(
        `/v1/models/garment-types?gender=${selectedCategory}`,
      ),
    enabled: !merchantGated && !!selectedCategory,
  });
  const garmentTypes = garmentTypesQuery.data?.items ?? [];

  // One product-list fetch per visible subcategory, just to grab a real photo
  // for its card (the subcategory list response itself carries no thumbnail
  // field). Skipped entirely for subcategories with zero products. Must run
  // unconditionally (before any early return below) per the Rules of Hooks —
  // it's a no-op when selectedCategory is null, since selectedCategorySubs is
  // empty in that case.
  const thumbnailQueries = useQueries({
    queries: selectedCategorySubs.map((sub) => ({
      queryKey: ['merchant-catalog-first-product', sub.id],
      queryFn: () =>
        api.get<{ items: MerchantCatalogItem[] }>(
          `/v1/merchant/catalog?includeDemo=false&subcategoryId=${sub.id}`,
        ),
      enabled: !merchantGated && sub.productCount > 0,
      staleTime: 60_000,
    })),
  });
  const thumbnailBySubcategoryId = new Map(
    selectedCategorySubs.map((sub, i) => {
      const first = thumbnailQueries[i]?.data?.items?.[0];
      const productThumb = first?.thumbnailUrl ?? first?.imageUrl ?? null;
      const garmentThumb =
        garmentTypes.find((g) => g.id === sub.garmentSubcategoryId)?.thumbnailUrl ?? null;
      return [sub.id, productThumb ?? garmentThumb];
    }),
  );

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map((id) => api.del<void>(`/v1/merchant/catalog/subcategories/${id}`))),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merchant-catalog-subcategories'] });
      setSelectedIds(new Set());
      setBulkDeleteOpen(false);
    },
  });

  if (subcategoriesQuery.isLoading) {
    return (
      <>
        <ScreenHeader variant="root" />
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '60vh',
            background: LIGHT.bg,
          }}
        >
          <div style={{ color: LIGHT.mid, fontSize: 14 }}>Loading catalogue…</div>
        </div>
      </>
    );
  }

  if (merchantGated) {
    return (
      <>
        <ScreenHeader variant="root" />
        <div
          style={{
            padding: '64px 24px',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
            minHeight: '60vh',
            background: LIGHT.bg,
          }}
        >
          <h3 style={{ fontSize: 16, fontWeight: 600, color: LIGHT.text, margin: 0 }}>
            Merchant account required
          </h3>
          <p style={{ color: LIGHT.mid, fontSize: 14, margin: 0, maxWidth: 320 }}>
            This account isn't enabled for virtual try-on yet. Contact support to get your merchant
            account activated.
          </p>
        </div>
      </>
    );
  }

  if (!selectedCategory) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          background: LIGHT.bg,
        }}
      >
        <ScreenHeader variant="root" />
        <GenderPicker onSelect={selectGender} />
        <CreditSummaryBar />
      </div>
    );
  }

  const genderOption = GENDER_OPTIONS.find((g) => g.id === selectedCategory);
  const categoryLabel = genderOption?.label ?? '';
  const addSubcategoryHref = `/tryon-library-app/add-subcategory?category=${selectedCategory}`;

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: LIGHT.bg,
      }}
    >
      <ScreenHeader
        variant="back"
        title={categoryLabel}
        subtitle="Manage categories"
        onBack={() => router.push('/tryon-library-app')}
        actions={[
          {
            label: 'Add Category',
            onClick: () => router.push(addSubcategoryHref),
          },
        ]}
      />

      {selectedIds.size > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            margin: '12px 16px 0',
            padding: '10px 14px',
            borderRadius: 10,
            background: LIGHT.card,
            border: `1px solid ${LIGHT.border}`,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: LIGHT.text }}>
            {selectedIds.size} selected
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="focus-ring"
              style={{
                border: 'none',
                background: 'none',
                color: LIGHT.mid,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => setBulkDeleteOpen(true)}
              className="focus-ring hover-surface"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 32,
                padding: '0 14px',
                borderRadius: 8,
                border: 'none',
                background: '#e53939',
                color: '#fff',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {selectedCategorySubs.length === 0 ? (
        <div
          style={{
            flex: 1,
            minHeight: '60vh',
            padding: '24px',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
          }}
        >
          {/* biome-ignore lint/performance/noImgElement: standalone page not using next/image */}
          <img
            src={`${BASE}/assets/empty-subcategories.png`}
            alt=""
            width={120}
            height={122}
            style={{ marginBottom: 4 }}
          />
          <h3 style={{ fontSize: 17, fontWeight: 700, color: LIGHT.text, margin: 0 }}>
            No Categories Yet
          </h3>
          <p style={{ color: LIGHT.mid, fontSize: 14, margin: 0, maxWidth: 280 }}>
            Add your first category to start organizing your products.
          </p>
        </div>
      ) : (
        <>
          <h2
            style={{
              fontSize: 18,
              fontWeight: 800,
              color: LIGHT.text,
              margin: 0,
              padding: '20px 16px 8px',
            }}
          >
            Categories ({selectedCategorySubs.length})
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 12,
              padding: '4px 16px 100px',
            }}
          >
            {selectedCategorySubs.map((sub) => (
              <SubcategoryCard
                key={sub.id}
                subcategory={sub}
                thumbnailUrl={thumbnailBySubcategoryId.get(sub.id) ?? null}
                onOpen={() => router.push(`/tryon-library-app/subcategory/${sub.id}`)}
                selected={selectedIds.has(sub.id)}
                onToggleSelect={() => toggleSelect(sub.id)}
              />
            ))}
          </div>
        </>
      )}

      <ConfirmDialog
        open={bulkDeleteOpen}
        title="Delete Categories"
        message={`Are you sure you want to delete ${selectedIds.size} selected ${
          selectedIds.size === 1 ? 'category' : 'categories'
        }? All products inside ${selectedIds.size === 1 ? 'it' : 'them'} will also be deleted.`}
        confirmLabel="Delete"
        danger
        busy={bulkDeleteMutation.isPending}
        onConfirm={() => bulkDeleteMutation.mutate(Array.from(selectedIds))}
        onCancel={() => setBulkDeleteOpen(false)}
      />
    </div>
  );
}

export default function SubcategoriesScreen() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: LIGHT.bg }} />}>
      <SubcategoriesScreenInner />
    </Suspense>
  );
}
