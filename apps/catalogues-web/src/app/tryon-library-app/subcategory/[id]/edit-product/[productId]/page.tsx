'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MerchantCatalogListResponse,
  MerchantCatalogSubcategoryListResponse,
} from '@tryme/types';
import { useParams, useRouter } from 'next/navigation';
import { catalogAppApi as api } from '../../../../catalog-app-api';
import { ProductForm } from '../../../../components/ProductForm';
import { ScreenHeader } from '../../../../components/ScreenHeader';
import { GENDER_OPTIONS, LIGHT } from '../../../../theme';

export default function EditProductScreen() {
  const params = useParams<{ id: string; productId: string }>();
  const subcategoryId = params.id;
  const productId = params.productId;
  const router = useRouter();
  const qc = useQueryClient();

  const productsQuery = useQuery({
    queryKey: ['merchant-catalog-products', subcategoryId],
    queryFn: () =>
      api.get<MerchantCatalogListResponse>(
        `/v1/merchant/catalog?includeDemo=false&subcategoryId=${subcategoryId}`,
      ),
  });
  const product = productsQuery.data?.items.find((p) => p.id === productId);

  const subcategoriesQuery = useQuery({
    queryKey: ['merchant-catalog-subcategories'],
    queryFn: () =>
      api.get<MerchantCatalogSubcategoryListResponse>(
        '/v1/merchant/catalog/subcategories?includeDemo=false',
      ),
  });
  const subcategory = subcategoriesQuery.data?.items.find((s) => s.id === subcategoryId);
  const categoryLabel = GENDER_OPTIONS.find((g) => g.id === subcategory?.category)?.label;
  const breadcrumb =
    categoryLabel && subcategory ? `${categoryLabel} > ${subcategory.name}` : undefined;

  function goBackToProducts() {
    router.push(`/tryon-library-app/subcategory/${subcategoryId}`);
  }

  function handleSaved() {
    qc.invalidateQueries({ queryKey: ['merchant-catalog-products', subcategoryId] });
    qc.invalidateQueries({ queryKey: ['merchant-catalog-subcategories'] });
    goBackToProducts();
  }

  if (productsQuery.isLoading) {
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
          title="Edit Product"
          subtitle={breadcrumb}
          onBack={goBackToProducts}
        />
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '40vh',
          }}
        >
          <div style={{ color: LIGHT.mid, fontSize: 14 }}>Loading product…</div>
        </div>
      </div>
    );
  }

  if (!product) {
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
          title="Edit Product"
          subtitle={breadcrumb}
          onBack={goBackToProducts}
        />
        <div style={{ padding: '64px 24px', textAlign: 'center' }}>
          <p style={{ color: LIGHT.mid, fontSize: 14 }}>
            This product couldn't be found. It may have been deleted.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: LIGHT.bg }}
    >
      <ScreenHeader
        variant="back"
        title="Edit Product"
        subtitle={breadcrumb}
        onBack={goBackToProducts}
      />
      <ProductForm
        subcategoryId={subcategoryId}
        initialData={product}
        supportsTwoInputMannequin={subcategory?.supportsTwoInputMannequin ?? false}
        supportsTwoInputDirectTryon={subcategory?.supportsTwoInputDirectTryon ?? false}
        onSaved={handleSaved}
        onCancel={goBackToProducts}
      />
    </div>
  );
}
