'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MerchantCatalogSubcategoryListResponse } from '@tryme/types';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  GarmentIcon,
  ImagesIcon,
  SpinnerIcon,
  TrashIcon,
  UploadIcon,
  XIcon,
} from '@/components/icons';
import { GradBtn } from '@/components/ui/grad-btn';
import { catalogAppApi as api } from '../../../catalog-app-api';
import { deleteProduct, presignAndUpload } from '../../../catalog-app-helpers';
import { ScreenHeader } from '../../../components/ScreenHeader';
import { StickyBottomBar } from '../../../components/StickyBottomBar';
import { GENDER_OPTIONS, LIGHT } from '../../../theme';
import { useSessionExpiryMessage } from '../../../use-session-expiry-message';

interface QueueItem {
  id: string;
  file: File;
  fileUrl: string;
  // 'uploaded' is catalogue mode's counterpart to 'generated': the merchant
  // supplied a finished product photo, so there is nothing to generate and the
  // detail fields open immediately. No server row exists until Save.
  // 'sent' — a flat-mode batch that was successfully handed off to the held-job pipeline; nothing more happens in this screen for it.
  status: 'queued' | 'uploading' | 'generating' | 'sent' | 'generated' | 'uploaded' | 'failed';
  jobId?: string;
  itemId?: string;
  name: string;
  sku: string;
  actualPrice: string;
  offerPrice: string;
  hasError: boolean;
  errorMessage?: string;
}

const generateId = () => Math.random().toString(36).substring(2, 9);
const SUCCESS_GREEN = '#10b981';

const HOW_IT_WORKS = [
  {
    title: 'Upload Catalogue Images',
    description: 'Select multiple catalogue images of your products.',
  },
  {
    title: 'Add Product Details',
    description: 'Fill in product name, SKU, price and other details for each image.',
  },
  {
    title: 'Review & Upload',
    description: 'Review all details and upload. Products will be added to your store.',
  },
];

function BulkUploadScreenInner() {
  const params = useParams<{ id: string }>();
  const subcategoryId = params.id;
  const router = useRouter();
  const qc = useQueryClient();
  const searchParams = useSearchParams();

  const getErrorMessage = useSessionExpiryMessage();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [showDetails, setShowDetails] = useState(false);
  const [showInfoBanner, setShowInfoBanner] = useState(true);
  const [isDragOver, setIsDragOver] = useState(false);
  // The "+" menu links here with ?mode=catalogue|flat to skip the in-page toggle.
  // Falls back to catalogue for a bare /bulk-upload visit or an unrecognized value.
  const [imageMode, setImageMode] = useState<'catalogue' | 'flat'>(
    searchParams.get('mode') === 'flat' ? 'flat' : 'catalogue',
  );
  // Which status means "details editable, ready to save" in the current mode.
  const readyStatus = imageMode === 'catalogue' ? 'uploaded' : 'generated';
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [sentForProcessing, setSentForProcessing] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef<QueueItem[]>([]);
  itemsRef.current = items;

  const [globalActual, setGlobalActual] = useState('');
  const [globalOffer, setGlobalOffer] = useState('');
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

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

  useEffect(() => {
    return () => {
      for (const item of itemsRef.current) {
        URL.revokeObjectURL(item.fileUrl);
        if (item.status === 'generated' && item.itemId) void deleteProduct(item.itemId);
      }
    };
  }, []);

  const busy = isGeneratingAll || isSaving;

  function goBackToProducts() {
    router.push(`/tryon-library-app/subcategory/${subcategoryId}`);
  }

  const processFiles = (files: FileList | File[]) => {
    const newItems: QueueItem[] = Array.from(files)
      .filter((file) => file.type.startsWith('image/'))
      .map((file) => ({
        id: generateId(),
        file,
        fileUrl: URL.createObjectURL(file),
        // Catalogue images are already final — no generate step to wait through.
        status: imageMode === 'catalogue' ? 'uploaded' : 'queued',
        name: '',
        sku: '',
        actualPrice: '',
        offerPrice: '',
        hasError: false,
      }));
    setItems((prev) => [...prev, ...newItems]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(e.target.files);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files);
  };

  const handleGenerateAll = async () => {
    const queued = items.filter((i) => i.status === 'queued');
    if (queued.length === 0) return;
    setIsGeneratingAll(true);
    setItems((prev) =>
      prev.map((i) => (i.status === 'queued' ? { ...i, status: 'uploading' } : i)),
    );

    const uploaded: { id: string; flatImageKey: string }[] = [];
    for (const item of queued) {
      try {
        const { r2Key } = await presignAndUpload(item.file, 'flat');
        uploaded.push({ id: item.id, flatImageKey: r2Key });
      } catch (err) {
        setItems((prev) =>
          prev.map((p) =>
            p.id === item.id
              ? {
                  ...p,
                  status: 'failed',
                  hasError: true,
                  errorMessage: getErrorMessage(err, 'Upload failed'),
                }
              : p,
          ),
        );
      }
    }

    if (uploaded.length === 0) {
      setIsGeneratingAll(false);
      return;
    }

    setItems((prev) =>
      prev.map((p) => (uploaded.some((u) => u.id === p.id) ? { ...p, status: 'generating' } : p)),
    );

    let jobIds: string[] = [];
    let failures: Array<{ flatImageKey: string; error: string }> = [];
    try {
      const res = await api.post<{
        jobIds: string[];
        failures: Array<{ flatImageKey: string; error: string }>;
      }>('/v1/merchant/catalog/generate-bulk', {
        subcategoryId,
        flatImageKeys: uploaded.map((u) => u.flatImageKey),
      });
      jobIds = res.jobIds;
      failures = res.failures;
    } catch (err) {
      setItems((prev) =>
        prev.map((p) =>
          uploaded.some((u) => u.id === p.id)
            ? {
                ...p,
                status: 'failed',
                hasError: true,
                errorMessage: getErrorMessage(err, 'Failed to enqueue'),
              }
            : p,
        ),
      );
      setIsGeneratingAll(false);
      return;
    }

    const failedKeys = new Map(failures.map((f) => [f.flatImageKey, f.error]));
    const succeeded = uploaded.filter((u) => !failedKeys.has(u.flatImageKey));
    // generate-bulk returns jobIds in the same order as the flatImageKeys that succeeded.
    const jobIdByLocalId = new Map(succeeded.map((u, idx) => [u.id, jobIds[idx]]));

    setItems((prev) =>
      prev.map((p) => {
        const jobId = jobIdByLocalId.get(p.id);
        if (jobId) return { ...p, jobId };
        const uploadedEntry = uploaded.find((u) => u.id === p.id);
        const error = uploadedEntry ? failedKeys.get(uploadedEntry.flatImageKey) : undefined;
        if (error) return { ...p, status: 'failed', hasError: true, errorMessage: error };
        return p;
      }),
    );

    // Held batches run only when an admin releases them, so there is nothing to
    // poll here. The images land in the products list (marked "Needs details")
    // once generation finishes — see reconcileHeldProducts on that screen.
    setItems((prev) => prev.map((p) => (jobIdByLocalId.get(p.id) ? { ...p, status: 'sent' } : p)));
    setIsGeneratingAll(false);
    setSentForProcessing((prev) => prev + jobIds.length);
  };

  const handleApplyGlobalPrice = () => {
    if (!globalActual && !globalOffer) return;
    setItems((prev) =>
      prev.map((item) =>
        item.status === readyStatus
          ? {
              ...item,
              actualPrice: globalActual || item.actualPrice,
              offerPrice: globalOffer || item.offerPrice,
              hasError: false,
            }
          : item,
      ),
    );
  };

  const handleUpdateItem = (id: string, updates: Partial<QueueItem>) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...updates, hasError: false } : item)),
    );
  };

  const handleRemoveItem = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (item) {
      URL.revokeObjectURL(item.fileUrl);
      if (item.status === 'generated' && item.itemId) void deleteProduct(item.itemId);
    }
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const handleClearAll = () => {
    for (const item of items) {
      URL.revokeObjectURL(item.fileUrl);
      if (item.status === 'generated' && item.itemId) void deleteProduct(item.itemId);
    }
    setItems([]);
    setShowDetails(false);
  };

  const handleAddCatalogue = async () => {
    let hasValidationError = false;
    const validated = items.map((item) => {
      if (item.status !== readyStatus) return item;
      const act = parseInt(item.actualPrice, 10) || 0;
      const off = parseInt(item.offerPrice, 10) || 0;
      const isValid =
        item.sku.trim() !== '' && item.actualPrice !== '' && item.offerPrice !== '' && off <= act;
      if (!isValid) hasValidationError = true;
      return { ...item, hasError: !isValid };
    });
    setItems(validated);
    if (hasValidationError) return;

    const ready = validated.filter((i) => i.status === readyStatus);
    if (ready.length === 0) return;

    setIsSaving(true);
    setSaveError(undefined);
    try {
      if (imageMode === 'catalogue') {
        // No job, no generation — upload each finished photo and create the row.
        await Promise.all(
          ready.map(async (item) => {
            const [{ r2Key }, { r2Key: thumbnailKey }] = await Promise.all([
              presignAndUpload(item.file, 'image'),
              presignAndUpload(item.file, 'thumbnail'),
            ]);
            await api.post('/v1/merchant/catalog', {
              subcategoryId,
              r2Key,
              thumbnailKey,
              label: item.name.trim() || `Product ${item.sku.trim().toUpperCase()}`,
              sku: item.sku.trim(),
              actualPrice: parseInt(item.actualPrice, 10),
              offerPrice: parseInt(item.offerPrice, 10),
            });
          }),
        );
      } else {
        await Promise.all(
          ready
            .filter((i): i is QueueItem & { itemId: string } => !!i.itemId)
            .map((item) =>
              api.patch(`/v1/merchant/catalog/${item.itemId}`, {
                label: item.name.trim() || `Product ${item.sku.toUpperCase()}`,
                sku: item.sku.trim(),
                actualPrice: parseInt(item.actualPrice, 10),
                offerPrice: parseInt(item.offerPrice, 10),
              }),
            ),
        );
      }
      qc.invalidateQueries({ queryKey: ['merchant-catalog-products', subcategoryId] });
      qc.invalidateQueries({ queryKey: ['merchant-catalog-subcategories'] });
      goBackToProducts();
    } catch (err) {
      setSaveError(getErrorMessage(err, 'Failed to save some items. Please try again.'));
    } finally {
      setIsSaving(false);
    }
  };

  const hasQueued = items.some((i) => i.status === 'queued');
  const hasGenerated = items.some((i) => i.status === readyStatus);
  const generatedCount = items.filter((i) => i.status === readyStatus).length;
  const isAnyGenerating = items.some((i) => i.status === 'uploading' || i.status === 'generating');
  const filledCount = items.filter(
    (i) => i.sku.trim() !== '' && i.actualPrice !== '' && i.offerPrice !== '',
  ).length;
  const readyToUploadCount = items.filter(
    (i) => i.status === 'queued' || i.status === 'uploaded',
  ).length;
  const productsAddedCount = items.filter((i) => i.status === 'sent').length;

  const modeNoun = imageMode === 'catalogue' ? 'catalogue images' : 'flat images';

  return (
    <div
      style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: LIGHT.bg }}
    >
      <ScreenHeader
        variant="back"
        title={showDetails ? 'Bulk Upload' : 'Bulk Upload Products'}
        subtitle={breadcrumb}
        onBack={showDetails ? () => setShowDetails(false) : goBackToProducts}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, padding: 16 }}>
        <div
          style={{
            display: 'flex',
            borderRadius: 8,
            border: `1px solid ${LIGHT.border2}`,
            overflow: 'hidden',
            background: LIGHT.card,
          }}
        >
          <button
            type="button"
            onClick={() => setImageMode('catalogue')}
            disabled={busy || items.length > 0}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '12px 16px',
              border: 'none',
              background: imageMode === 'catalogue' ? 'rgba(245, 92, 122, 0.08)' : 'transparent',
              color: imageMode === 'catalogue' ? '#f55c7a' : LIGHT.text,
              fontWeight: imageMode === 'catalogue' ? 600 : 500,
              fontSize: 14,
              fontFamily: 'inherit',
              cursor: busy || items.length > 0 ? 'not-allowed' : 'pointer',
              borderRight: `1px solid ${LIGHT.border2}`,
            }}
          >
            <ImagesIcon size={15} />
            Catalogue Images
          </button>
          <button
            type="button"
            onClick={() => setImageMode('flat')}
            disabled={busy || items.length > 0}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '12px 16px',
              border: 'none',
              background: imageMode === 'flat' ? 'rgba(245, 92, 122, 0.08)' : 'transparent',
              color: imageMode === 'flat' ? '#f55c7a' : LIGHT.text,
              fontWeight: imageMode === 'flat' ? 600 : 500,
              fontSize: 14,
              fontFamily: 'inherit',
              cursor: busy || items.length > 0 ? 'not-allowed' : 'pointer',
            }}
          >
            <GarmentIcon size={15} />
            Flat Images
          </button>
        </div>

        {!showDetails && (
          <>
            {showInfoBanner && (
              <div
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  padding: '12px 14px',
                  borderRadius: 8,
                  background: 'rgba(245, 92, 122, 0.06)',
                  border: '1px solid rgba(245, 92, 122, 0.2)',
                }}
              >
                <div
                  style={{
                    flexShrink: 0,
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    background: 'rgba(245, 92, 122, 0.12)',
                    color: '#f55c7a',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <ImagesIcon size={16} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: LIGHT.text }}>
                    Upload multiple {modeNoun} at once
                  </div>
                  <div style={{ fontSize: 12, color: LIGHT.mid, marginTop: 2 }}>
                    Add several product images together. You can add details individually or use a
                    CSV file.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowInfoBanner(false)}
                  aria-label="Dismiss"
                  style={{
                    flexShrink: 0,
                    background: 'none',
                    border: 'none',
                    color: LIGHT.mid,
                    cursor: 'pointer',
                    padding: 2,
                  }}
                >
                  <XIcon size={16} />
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragOver(true);
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
              className="hover-surface"
              style={{
                minHeight: 220,
                borderRadius: 8,
                border: `2px dashed ${isDragOver ? '#f55c7a' : LIGHT.border2}`,
                background: isDragOver ? 'rgba(245, 92, 122, 0.04)' : LIGHT.field,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                gap: 8,
                padding: 20,
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  background: 'rgba(245, 92, 122, 0.1)',
                  color: '#f55c7a',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 4,
                }}
              >
                <UploadIcon size={24} />
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: LIGHT.text }}>
                Drag and drop images here
              </div>
              <div style={{ fontSize: 13, color: LIGHT.mid }}>
                or click the button below to browse
              </div>
              <div style={{ fontSize: 11, color: LIGHT.mid, marginBottom: 8 }}>
                Supports: JPG, PNG, WEBP &bull; Max file size: 5MB per image
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 38,
                  padding: '0 18px',
                  borderRadius: 8,
                  border: '1px solid #f55c7a',
                  color: '#f55c7a',
                  fontWeight: 700,
                  fontSize: 13,
                }}
              >
                <ImagesIcon size={14} />
                Choose Images
              </div>
              <input
                type="file"
                multiple
                ref={fileInputRef}
                onChange={handleFileChange}
                accept="image/jpeg,image/png,image/webp"
                style={{ display: 'none' }}
                tabIndex={-1}
              />
            </button>

            <div style={{ display: 'flex', gap: 12 }}>
              {[
                { label: 'Images Selected', value: items.length },
                { label: 'Ready to Upload', value: readyToUploadCount },
                { label: 'Products Added', value: productsAddedCount },
              ].map((stat) => (
                <div
                  key={stat.label}
                  style={{
                    flex: 1,
                    border: `1px solid ${LIGHT.border}`,
                    borderRadius: 8,
                    padding: '14px 8px',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: 20, fontWeight: 800, color: LIGHT.text }}>
                    {stat.value}
                  </div>
                  <div style={{ fontSize: 11, color: LIGHT.mid, marginTop: 2 }}>{stat.label}</div>
                </div>
              ))}
            </div>

            <div
              style={{
                border: `1px solid ${LIGHT.border}`,
                borderRadius: 8,
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700, color: LIGHT.text }}>How it works</div>
              {HOW_IT_WORKS.map((step, i) => (
                <div
                  key={step.title}
                  style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}
                >
                  <div
                    style={{
                      flexShrink: 0,
                      width: 26,
                      height: 26,
                      borderRadius: '50%',
                      background: 'rgba(245, 92, 122, 0.1)',
                      color: '#f55c7a',
                      fontSize: 13,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {i + 1}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: LIGHT.text }}>
                      {step.title}
                    </div>
                    <div style={{ fontSize: 12, color: LIGHT.mid, marginTop: 2 }}>
                      {step.description}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {showDetails && items.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              background: LIGHT.field,
              padding: '12px 14px',
              borderRadius: 8,
              border: `1px solid ${LIGHT.border}`,
            }}
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              {imageMode === 'flat' && (
                <GradBtn type="button" onClick={handleGenerateAll} disabled={!hasQueued || busy}>
                  {isGeneratingAll && <SpinnerIcon size={14} />}
                  {isGeneratingAll ? 'Sending…' : 'Send for Processing'}
                </GradBtn>
              )}
              <span style={{ fontSize: 13, color: LIGHT.mid, fontWeight: 500 }}>
                {items.length} item{items.length !== 1 && 's'} ({generatedCount} ready)
              </span>
            </div>

            {hasGenerated && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: LIGHT.text }}>
                  Set price for all:
                </span>
                <input
                  type="number"
                  placeholder="Actual"
                  value={globalActual}
                  onChange={(e) => setGlobalActual(e.target.value)}
                  style={{
                    width: 80,
                    height: 32,
                    fontSize: 12,
                    borderRadius: 4,
                    border: `1px solid ${LIGHT.border2}`,
                    padding: '0 8px',
                  }}
                />
                <input
                  type="number"
                  placeholder="Offer"
                  value={globalOffer}
                  onChange={(e) => setGlobalOffer(e.target.value)}
                  style={{
                    width: 80,
                    height: 32,
                    fontSize: 12,
                    borderRadius: 4,
                    border: `1px solid ${LIGHT.border2}`,
                    padding: '0 8px',
                  }}
                />
                <button
                  type="button"
                  onClick={handleApplyGlobalPrice}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    background: 'none',
                    border: 'none',
                    color: '#f55c7a',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 4,
                      background: '#f55c7a',
                      color: '#ffffff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                    }}
                  >
                    ✓
                  </span>
                  Apply price to all
                </button>
              </div>
            )}
          </div>
        )}

        {showDetails && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {items.map((item, idx) => (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  gap: 14,
                  padding: 14,
                  border: `1px solid ${item.hasError || item.status === 'failed' ? '#f55c7a' : LIGHT.border}`,
                  borderRadius: 12,
                  background:
                    item.hasError || item.status === 'failed'
                      ? 'rgba(245,92,122,0.03)'
                      : LIGHT.card,
                  position: 'relative',
                }}
              >
                <div
                  style={{
                    flexShrink: 0,
                    width: 100,
                    height: 130,
                    borderRadius: 8,
                    overflow: 'hidden',
                    background: LIGHT.field,
                    position: 'relative',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: 6,
                      left: 6,
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: 'rgba(245, 92, 122, 0.9)',
                      color: '#ffffff',
                      fontSize: 11,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      zIndex: 1,
                    }}
                  >
                    {idx + 1}
                  </div>

                  {/* biome-ignore lint/performance/noImgElement: local/generated preview */}
                  <img
                    src={item.fileUrl}
                    alt="Upload preview"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                  <div style={{ position: 'absolute', bottom: 6, left: 6 }}>
                    {item.status === 'queued' && (
                      <span
                        style={{
                          background: LIGHT.mid,
                          color: '#ffffff',
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 4,
                          textTransform: 'uppercase',
                        }}
                      >
                        Queued
                      </span>
                    )}
                    {(item.status === 'uploading' || item.status === 'generating') && (
                      <span
                        style={{
                          background: LIGHT.card,
                          color: '#f55c7a',
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: 4,
                          textTransform: 'uppercase',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          border: `1px solid ${LIGHT.border2}`,
                        }}
                      >
                        <SpinnerIcon size={10} />{' '}
                        {item.status === 'uploading' ? 'Uploading' : 'Generating'}
                      </span>
                    )}
                    {item.status === readyStatus && (
                      <span
                        style={{
                          background: SUCCESS_GREEN,
                          color: '#ffffff',
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 4,
                          textTransform: 'uppercase',
                        }}
                      >
                        ✓ Ready
                      </span>
                    )}
                    {item.status === 'failed' && (
                      <span
                        style={{
                          background: '#f55c7a',
                          color: '#ffffff',
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 4,
                          textTransform: 'uppercase',
                        }}
                      >
                        Failed
                      </span>
                    )}
                    {item.status === 'sent' && (
                      <span
                        style={{
                          background: LIGHT.mid,
                          color: '#ffffff',
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 4,
                          textTransform: 'uppercase',
                        }}
                      >
                        Sent
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  {item.status === readyStatus && (
                    <div
                      style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 40 }}
                    >
                      <label style={{ fontSize: 10, fontWeight: 700, color: LIGHT.text }}>
                        Product Name
                      </label>
                      <input
                        placeholder="e.g. Slim Fit Cotton Shirt"
                        value={item.name}
                        onChange={(e) => handleUpdateItem(item.id, { name: e.target.value })}
                        style={{
                          width: '100%',
                          height: 32,
                          fontSize: 12,
                          borderRadius: 6,
                          border: `1px solid ${LIGHT.border2}`,
                          padding: '0 8px',
                          background: LIGHT.field,
                          color: LIGHT.text,
                        }}
                      />
                      <label style={{ fontSize: 10, fontWeight: 700, color: LIGHT.text }}>
                        SKU
                      </label>
                      <input
                        placeholder="SKU"
                        value={item.sku}
                        onChange={(e) => handleUpdateItem(item.id, { sku: e.target.value })}
                        style={{
                          width: '100%',
                          height: 32,
                          fontSize: 12,
                          borderRadius: 6,
                          border: `1px solid ${item.hasError && !item.sku ? '#f55c7a' : LIGHT.border2}`,
                          padding: '0 8px',
                          background: LIGHT.field,
                          color: LIGHT.text,
                        }}
                      />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 10, fontWeight: 700, color: LIGHT.text }}>
                            Actual Price
                          </label>
                          <input
                            type="number"
                            placeholder="₹ Actual"
                            value={item.actualPrice}
                            onChange={(e) =>
                              handleUpdateItem(item.id, { actualPrice: e.target.value })
                            }
                            style={{
                              width: '100%',
                              height: 32,
                              fontSize: 12,
                              borderRadius: 6,
                              border: `1px solid ${item.hasError && (!item.actualPrice || parseInt(item.offerPrice, 10) > parseInt(item.actualPrice, 10)) ? '#f55c7a' : LIGHT.border2}`,
                              padding: '0 8px',
                              background: LIGHT.field,
                              color: LIGHT.text,
                            }}
                          />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 10, fontWeight: 700, color: LIGHT.text }}>
                            Offer Price
                          </label>
                          <input
                            type="number"
                            placeholder="₹ Offer"
                            value={item.offerPrice}
                            onChange={(e) =>
                              handleUpdateItem(item.id, { offerPrice: e.target.value })
                            }
                            style={{
                              width: '100%',
                              height: 32,
                              fontSize: 12,
                              borderRadius: 6,
                              border: `1px solid ${item.hasError && (!item.offerPrice || parseInt(item.offerPrice, 10) > parseInt(item.actualPrice, 10)) ? '#f55c7a' : LIGHT.border2}`,
                              padding: '0 8px',
                              background: LIGHT.field,
                              color: LIGHT.text,
                            }}
                          />
                        </div>
                      </div>
                      {item.hasError && (
                        <div style={{ fontSize: 10, color: '#f55c7a', lineHeight: 1.2 }}>
                          Please fill valid SKU and ensure Offer ≤ Actual Price.
                        </div>
                      )}
                    </div>
                  )}

                  {item.status === 'failed' && item.errorMessage && (
                    <div style={{ padding: 10, fontSize: 10, color: '#f55c7a', lineHeight: 1.3 }}>
                      {item.errorMessage}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => handleRemoveItem(item.id)}
                  disabled={item.status === 'uploading' || item.status === 'generating'}
                  aria-label="Remove item"
                  style={{
                    position: 'absolute',
                    top: 10,
                    right: 10,
                    background: LIGHT.card,
                    color: LIGHT.mid,
                    border: `1px solid ${LIGHT.border2}`,
                    borderRadius: 8,
                    width: 32,
                    height: 32,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        )}

        {showDetails && items.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 4px',
              borderTop: `1px solid ${LIGHT.border}`,
              fontSize: 13,
            }}
          >
            <div style={{ display: 'flex', gap: 16 }}>
              <span style={{ color: '#f55c7a', fontWeight: 700 }}>{items.length} Products</span>
              <span style={{ color: LIGHT.text, fontWeight: 700 }}>{filledCount} Filled</span>
              <span style={{ color: SUCCESS_GREEN, fontWeight: 700 }}>
                {items.length - filledCount} Remaining
              </span>
            </div>
            <button
              type="button"
              onClick={handleClearAll}
              style={{
                background: 'none',
                border: 'none',
                color: '#f55c7a',
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Clear All
            </button>
          </div>
        )}

        {sentForProcessing > 0 && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              background: LIGHT.field,
              border: `1px solid ${LIGHT.border}`,
              fontSize: 13,
              color: LIGHT.text,
              lineHeight: 1.4,
            }}
          >
            {sentForProcessing} image{sentForProcessing === 1 ? '' : 's'} sent for processing.
            They&apos;re queued for the next processing window — you&apos;ll find them in this
            category once they&apos;re ready, waiting for SKU and pricing.
          </div>
        )}

        {saveError && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              background: 'rgba(245,92,122,0.06)',
              border: '1px solid #f55c7a',
              fontSize: 13,
              color: '#f55c7a',
            }}
          >
            {saveError}
          </div>
        )}
      </div>

      <StickyBottomBar>
        <button
          type="button"
          onClick={showDetails ? () => setShowDetails(false) : goBackToProducts}
          disabled={busy}
          style={{
            flex: 1,
            height: 48,
            borderRadius: 8,
            border: `1px solid ${LIGHT.border2}`,
            background: LIGHT.card,
            color: LIGHT.text,
            fontFamily: 'inherit',
            fontSize: 15,
            fontWeight: 600,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          {showDetails ? 'Back' : 'Cancel'}
        </button>
        <div style={{ flex: 1 }}>
          {!showDetails ? (
            <GradBtn
              type="button"
              disabled={items.length === 0}
              onClick={() => setShowDetails(true)}
              style={{ width: '100%', height: 48 }}
            >
              Continue to Details
              <ChevronRight />
            </GradBtn>
          ) : imageMode === 'catalogue' ? (
            <GradBtn
              type="button"
              disabled={generatedCount === 0 || isAnyGenerating || isSaving}
              onClick={() => void handleAddCatalogue()}
              style={{ width: '100%', height: 48 }}
            >
              {isSaving ? 'Saving…' : 'Review & Upload'}
            </GradBtn>
          ) : (
            <GradBtn
              type="button"
              disabled={busy}
              onClick={goBackToProducts}
              style={{ width: '100%', height: 48 }}
            >
              Done
            </GradBtn>
          )}
        </div>
      </StickyBottomBar>
    </div>
  );
}

export default function BulkUploadScreen() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: LIGHT.bg }} />}>
      <BulkUploadScreenInner />
    </Suspense>
  );
}
