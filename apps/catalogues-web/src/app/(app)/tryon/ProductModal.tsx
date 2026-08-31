'use client';
import type { MerchantCatalogItem } from '@tryme/types';
import { useEffect, useRef, useState } from 'react';
import { SpinnerIcon, UploadIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { GradBtn } from '@/components/ui/grad-btn';
import { api } from '@/lib/api';
import { deleteProduct, finalizeGeneratedProduct, pollGenerateJob, presignAndUpload } from './api';

interface ProductModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  subcategoryId: string | null;
  supportsTwoInputMannequin: boolean;
  supportsTwoInputDirectTryon: boolean;
  initialData?: MerchantCatalogItem;
}

export function ProductModal({
  open,
  onClose,
  onSaved,
  subcategoryId,
  supportsTwoInputMannequin,
  supportsTwoInputDirectTryon,
  initialData,
}: ProductModalProps) {
  const [label, setLabel] = useState('');
  const [sku, setSku] = useState('');
  const [actualPrice, setActualPrice] = useState('');
  const [offerPrice, setOfferPrice] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | undefined>(undefined);

  const [imageMode, setImageMode] = useState<'catalogue' | 'flat'>('catalogue');
  const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);
  // Pallu is only relevant in 'flat' imageMode for a two-input-capable subcategory —
  // mirrors Studio's Body/Pallu pair (studio/page.tsx's palluGarmentFile/palluGarmentKey).
  const [palluFile, setPalluFile] = useState<File | undefined>(undefined);
  const [palluPreviewUrl, setPalluPreviewUrl] = useState<string | undefined>(undefined);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  // The product row created by the generate+import flow, still awaiting the
  // user's SKU/price entry before the final Save PATCH. If the modal closes
  // before that PATCH happens, it's a $0 orphan and gets best-effort deleted.
  const [generatedItem, setGeneratedItem] = useState<MerchantCatalogItem | undefined>(undefined);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const palluInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previewUrlRef = useRef<string | undefined>(undefined);
  previewUrlRef.current = previewUrl;
  const palluPreviewUrlRef = useRef<string | undefined>(undefined);
  palluPreviewUrlRef.current = palluPreviewUrl;
  const generatedItemRef = useRef<MerchantCatalogItem | undefined>(undefined);
  generatedItemRef.current = generatedItem;

  // Reset state
  useEffect(() => {
    if (open) {
      if (initialData) {
        setLabel(initialData.label);
        setSku(initialData.sku ?? '');
        setActualPrice(initialData.actualPrice.toString());
        setOfferPrice(initialData.offerPrice.toString());
      } else {
        setLabel('');
        setSku('');
        setActualPrice('');
        setOfferPrice('');
        setImageMode('catalogue');
      }
      setSelectedFile(undefined);
      setPreviewUrl(undefined);
      setPalluFile(undefined);
      setPalluPreviewUrl(undefined);
      setGeneratedItem(undefined);
      setErrorMsg(undefined);
      setIsGenerating(false);
      setIsSaving(false);
    }
  }, [open, initialData]);

  // Revoke the object URL and clean up an unsaved generated product on close.
  useEffect(() => {
    if (open) return;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (palluPreviewUrlRef.current) URL.revokeObjectURL(palluPreviewUrlRef.current);
    if (generatedItemRef.current) void deleteProduct(generatedItemRef.current.id);
  }, [open]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Focus trap
  useEffect(() => {
    if (!open) return;
    const el = dialogRef.current;
    if (!el) return;
    const FOCUSABLE =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = el.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (focusable.length > 0) {
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      first?.focus();

      const trap = (e: KeyboardEvent) => {
        if (e.key !== 'Tab') return;
        if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
        }
      };
      document.addEventListener('keydown', trap);
      return () => document.removeEventListener('keydown', trap);
    }
  }, [open]);

  if (!open) return null;

  const isEditing = !!initialData;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setErrorMsg(undefined);
    if (imageMode === 'flat' && generatedItem) {
      void deleteProduct(generatedItem.id);
      setGeneratedItem(undefined);
    }
  };

  const handlePalluFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (palluPreviewUrl) URL.revokeObjectURL(palluPreviewUrl);
    setPalluFile(file);
    setPalluPreviewUrl(URL.createObjectURL(file));
    setErrorMsg(undefined);
    if (generatedItem) {
      void deleteProduct(generatedItem.id);
      setGeneratedItem(undefined);
    }
  };

  const requiresPallu = imageMode === 'flat' && supportsTwoInputMannequin;
  const requiresCataloguePallu = imageMode === 'catalogue' && supportsTwoInputDirectTryon;

  const handleGenerate = async () => {
    if (!selectedFile || !subcategoryId) return;
    if (requiresPallu && !palluFile) return;
    setIsGenerating(true);
    setErrorMsg(undefined);
    try {
      if (generatedItem) {
        await deleteProduct(generatedItem.id);
        setGeneratedItem(undefined);
      }
      const { r2Key: flatImageKey } = await presignAndUpload(selectedFile, 'flat');
      const secondFlatImageKey = requiresPallu
        ? (await presignAndUpload(palluFile as File, 'flat')).r2Key
        : undefined;
      const { jobId } = await api.post<{ jobId: string }>('/v1/merchant/catalog/generate', {
        subcategoryId,
        flatImageKey,
        ...(secondFlatImageKey ? { secondFlatImageKey } : {}),
      });
      const status = await pollGenerateJob(jobId);
      if (status.status !== 'COMPLETED') {
        throw new Error(
          status.errorCode
            ? `Generation failed (${status.errorCode})`
            : 'Generation failed. Please try again.',
        );
      }
      const item = await finalizeGeneratedProduct(jobId, subcategoryId);
      setGeneratedItem(item);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Generation failed.');
    } finally {
      setIsGenerating(false);
    }
  };

  const actualPriceNum = actualPrice ? parseInt(actualPrice, 10) : 0;
  const offerPriceNum = offerPrice ? parseInt(offerPrice, 10) : 0;
  const hasPriceError = offerPriceNum > actualPriceNum;
  const missingImage =
    !isEditing &&
    ((imageMode === 'catalogue' && (!selectedFile || (requiresCataloguePallu && !palluFile))) ||
      (imageMode === 'flat' && !generatedItem && (!selectedFile || (requiresPallu && !palluFile))));
  const isSaveDisabled = hasPriceError || isGenerating || isSaving || missingImage;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    if (isSaveDisabled || !subcategoryId) return;

    setIsSaving(true);
    setErrorMsg(undefined);
    try {
      const priceFields = {
        label: label.trim(),
        sku: sku.trim(),
        actualPrice: actualPriceNum,
        offerPrice: offerPriceNum,
      };

      if (isEditing && initialData) {
        await api.patch(`/v1/merchant/catalog/${initialData.id}`, priceFields);
      } else if (imageMode === 'flat') {
        if (!generatedItem) throw new Error('Generate the catalogue image first.');
        await api.patch(`/v1/merchant/catalog/${generatedItem.id}`, priceFields);
      } else {
        if (!selectedFile) throw new Error('Upload a product image first.');
        if (requiresCataloguePallu && !palluFile) throw new Error('Upload the pallu photo first.');
        const [{ r2Key }, { r2Key: thumbnailKey }] = await Promise.all([
          presignAndUpload(selectedFile, 'image'),
          presignAndUpload(selectedFile, 'thumbnail'),
        ]);
        let secondR2Key: string | undefined;
        let secondThumbnailKey: string | undefined;
        if (requiresCataloguePallu) {
          const [secondUpload, secondThumbUpload] = await Promise.all([
            presignAndUpload(palluFile as File, 'image'),
            presignAndUpload(palluFile as File, 'thumbnail'),
          ]);
          secondR2Key = secondUpload.r2Key;
          secondThumbnailKey = secondThumbUpload.r2Key;
        }
        await api.post('/v1/merchant/catalog', {
          subcategoryId,
          r2Key,
          thumbnailKey,
          ...(secondR2Key ? { secondR2Key } : {}),
          ...(secondThumbnailKey ? { secondThumbnailKey } : {}),
          ...priceFields,
        });
      }

      setGeneratedItem(undefined); // saved — don't clean it up on unmount
      onSaved();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save product.');
    } finally {
      setIsSaving(false);
    }
  };

  const busy = isGenerating || isSaving;
  const displayImageUrl = previewUrl ?? initialData?.imageUrl ?? undefined;

  return (
    <div
      role="presentation"
      onClick={busy ? undefined : onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 1100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.white,
          borderRadius: 14,
          padding: 24,
          width: 480,
          maxWidth: '100%',
          boxShadow: '0 12px 48px rgba(0,0,0,0.18)',
        }}
      >
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: 0 }}>
            {isEditing ? 'Edit Product' : 'Add Product'}
          </h3>

          {isEditing ? (
            <div
              style={{
                height: 140,
                borderRadius: 8,
                border: `1px solid ${C.border2}`,
                background: C.field,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              {displayImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                // biome-ignore lint/performance/noImgElement: presigned R2 preview
                <img
                  src={displayImageUrl}
                  alt={label || 'Product'}
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              ) : (
                <UploadIcon size={28} />
              )}
            </div>
          ) : (
            <>
              {/* Flat Image's AI-generate step isn't needed for two-input (body+pallu)
                  products — try-on already works directly off the body+pallu pair without
                  an AI-generated mannequin photo — so it's hidden (not removed) for
                  two-input-capable subcategories; Catalogue Image (direct upload) only. */}
              {!supportsTwoInputMannequin && (
                <div
                  style={{
                    display: 'flex',
                    borderRadius: 8,
                    border: `1px solid ${C.border2}`,
                    overflow: 'hidden',
                    background: C.white,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setImageMode('catalogue')}
                    disabled={busy}
                    style={{
                      flex: 1,
                      padding: '12px 16px',
                      border: 'none',
                      background:
                        imageMode === 'catalogue' ? 'rgba(245, 92, 122, 0.08)' : 'transparent',
                      color: imageMode === 'catalogue' ? C.pink : C.text,
                      fontWeight: imageMode === 'catalogue' ? 600 : 500,
                      fontSize: 14,
                      cursor: busy ? 'not-allowed' : 'pointer',
                      transition: 'all 0.15s ease',
                      borderRight: `1px solid ${C.border2}`,
                    }}
                  >
                    Catalogue Image
                  </button>
                  <button
                    type="button"
                    onClick={() => setImageMode('flat')}
                    disabled={busy}
                    style={{
                      flex: 1,
                      padding: '12px 16px',
                      border: 'none',
                      background: imageMode === 'flat' ? 'rgba(245, 92, 122, 0.08)' : 'transparent',
                      color: imageMode === 'flat' ? C.pink : C.text,
                      fontWeight: imageMode === 'flat' ? 600 : 500,
                      fontSize: 14,
                      cursor: busy ? 'not-allowed' : 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    Flat Image
                  </button>
                </div>
              )}

              {imageMode === 'catalogue' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div
                    onClick={() => !busy && fileInputRef.current?.click()}
                    style={{
                      height: 140,
                      borderRadius: 8,
                      border: `1px dashed ${C.border2}`,
                      background: 'transparent',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: busy ? 'not-allowed' : 'pointer',
                      overflow: 'hidden',
                      position: 'relative',
                      gap: 8,
                    }}
                    className="hover-surface"
                  >
                    {previewUrl ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {/* biome-ignore lint/performance/noImgElement: local preview */}
                        <img
                          src={previewUrl}
                          alt="Preview"
                          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            background: 'rgba(0,0,0,0.6)',
                            color: '#fff',
                            fontSize: 12,
                            textAlign: 'center',
                            padding: '6px 0',
                            fontWeight: 500,
                          }}
                        >
                          Click to change image
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ color: C.mid }}>
                          <UploadIcon size={28} />
                        </div>
                        <div style={{ fontSize: 13, color: C.mid, fontWeight: 500 }}>
                          {requiresCataloguePallu
                            ? 'Click to upload the body (front) photo'
                            : 'Click to upload product image'}
                        </div>
                      </>
                    )}
                  </div>
                  {requiresCataloguePallu && (
                    <div
                      onClick={() => !busy && palluInputRef.current?.click()}
                      style={{
                        height: 140,
                        borderRadius: 8,
                        border: `1px dashed ${C.border2}`,
                        background: palluPreviewUrl ? C.field : 'transparent',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: busy ? 'not-allowed' : 'pointer',
                        overflow: 'hidden',
                        position: 'relative',
                        gap: 8,
                      }}
                      className="hover-surface"
                    >
                      {palluPreviewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        // biome-ignore lint/performance/noImgElement: local preview
                        <img
                          src={palluPreviewUrl}
                          alt="Pallu Preview"
                          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                        />
                      ) : (
                        <>
                          <div style={{ color: C.mid }}>
                            <UploadIcon size={28} />
                          </div>
                          <div style={{ fontSize: 13, color: C.mid, fontWeight: 500 }}>
                            Click to upload the pallu photo
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {!previewUrl ? (
                    <div
                      onClick={() => !busy && fileInputRef.current?.click()}
                      style={{
                        height: 140,
                        borderRadius: 8,
                        border: `1px dashed ${C.border2}`,
                        background: 'transparent',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: busy ? 'not-allowed' : 'pointer',
                        overflow: 'hidden',
                        position: 'relative',
                        gap: 8,
                      }}
                      className="hover-surface"
                    >
                      <div style={{ color: C.mid }}>
                        <UploadIcon size={28} />
                      </div>
                      <div style={{ fontSize: 13, color: C.mid, fontWeight: 500 }}>
                        {requiresPallu
                          ? 'Upload the body (front) photo'
                          : 'Upload flat garment photo'}
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        // Two fixed-width 104px preview boxes plus a wide action button
                        // don't fit side by side in this modal's 480px width — stack
                        // images above actions instead of squeezing the button into
                        // whatever space is left over.
                        flexDirection: requiresPallu ? 'column' : 'row',
                        gap: requiresPallu ? 16 : 20,
                        alignItems: requiresPallu ? 'stretch' : 'center',
                        padding: 16,
                        borderRadius: 8,
                        border: `1px solid ${C.border2}`,
                        background: 'transparent',
                      }}
                    >
                      <div style={{ display: 'flex', gap: 12 }}>
                        <div
                          style={{
                            width: 104,
                            height: 130,
                            borderRadius: 8,
                            border: `1px solid ${C.border2}`,
                            background: C.field,
                            position: 'relative',
                            overflow: 'hidden',
                            flexShrink: 0,
                          }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          {/* biome-ignore lint/performance/noImgElement: local/generated preview */}
                          <img
                            src={generatedItem?.imageUrl ?? previewUrl}
                            alt="Flat Garment"
                            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                          />
                          {generatedItem && (
                            <div
                              style={{
                                position: 'absolute',
                                top: 6,
                                right: 6,
                                background: C.pink,
                                color: C.white,
                                fontSize: 10,
                                fontWeight: 700,
                                padding: '2px 6px',
                                borderRadius: 4,
                                textTransform: 'uppercase',
                              }}
                            >
                              Generated
                            </div>
                          )}
                        </div>
                        {requiresPallu && (
                          <div
                            onClick={() => !busy && palluInputRef.current?.click()}
                            style={{
                              width: 104,
                              height: 130,
                              borderRadius: 8,
                              border: `1px dashed ${C.border2}`,
                              background: palluPreviewUrl ? C.field : 'transparent',
                              position: 'relative',
                              overflow: 'hidden',
                              flexShrink: 0,
                              cursor: busy ? 'not-allowed' : 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            {palluPreviewUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              // biome-ignore lint/performance/noImgElement: local preview
                              <img
                                src={palluPreviewUrl}
                                alt="Pallu"
                                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                              />
                            ) : (
                              <div style={{ textAlign: 'center', padding: 8 }}>
                                <UploadIcon size={20} />
                                <div style={{ fontSize: 11, color: C.mid, marginTop: 4 }}>
                                  Upload Pallu
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div
                        style={{
                          flex: 1,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: 12,
                        }}
                      >
                        {!generatedItem ? (
                          <>
                            <GradBtn
                              type="button"
                              onClick={handleGenerate}
                              disabled={isGenerating || (requiresPallu && !palluFile)}
                            >
                              {isGenerating && <SpinnerIcon size={14} />}
                              {isGenerating ? 'Generating...' : 'Generate Catalogue Image'}
                            </GradBtn>
                            <button
                              type="button"
                              onClick={() => {
                                if (previewUrl) URL.revokeObjectURL(previewUrl);
                                if (palluPreviewUrl) URL.revokeObjectURL(palluPreviewUrl);
                                setSelectedFile(undefined);
                                setPreviewUrl(undefined);
                                setPalluFile(undefined);
                                setPalluPreviewUrl(undefined);
                              }}
                              disabled={isGenerating}
                              style={{
                                background: 'none',
                                border: 'none',
                                padding: 0,
                                color: C.mid,
                                fontSize: 13,
                                fontWeight: 500,
                                cursor: isGenerating ? 'not-allowed' : 'pointer',
                                textDecoration: 'underline',
                              }}
                            >
                              Choose a different image
                            </button>
                          </>
                        ) : (
                          <>
                            <div style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>
                              Ready to use!
                            </div>
                            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                              <button
                                type="button"
                                onClick={handleGenerate}
                                disabled={busy}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: 0,
                                  color: C.text,
                                  fontSize: 13,
                                  fontWeight: 600,
                                  cursor: busy ? 'not-allowed' : 'pointer',
                                  textDecoration: 'underline',
                                }}
                              >
                                Regenerate
                              </button>
                              <span style={{ color: C.border2 }}>|</span>
                              <button
                                type="button"
                                onClick={() => {
                                  if (previewUrl) URL.revokeObjectURL(previewUrl);
                                  if (palluPreviewUrl) URL.revokeObjectURL(palluPreviewUrl);
                                  if (generatedItem) void deleteProduct(generatedItem.id);
                                  setSelectedFile(undefined);
                                  setPreviewUrl(undefined);
                                  setPalluFile(undefined);
                                  setPalluPreviewUrl(undefined);
                                  setGeneratedItem(undefined);
                                }}
                                disabled={busy}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: 0,
                                  color: C.mid,
                                  fontSize: 13,
                                  fontWeight: 500,
                                  cursor: busy ? 'not-allowed' : 'pointer',
                                  textDecoration: 'underline',
                                }}
                              >
                                Change image
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
            tabIndex={-1}
          />
          <input
            type="file"
            ref={palluInputRef}
            onChange={handlePalluFileChange}
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
            tabIndex={-1}
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
              Product Name <span style={{ color: C.pink }}>*</span>
            </label>
            <input
              required
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Slim Fit Cotton Shirt"
              style={{
                width: '100%',
                height: 40,
                borderRadius: 8,
                border: `1px solid ${C.border2}`,
                padding: '0 14px',
                fontSize: 14,
                fontFamily: 'inherit',
                outline: 'none',
                background: C.field,
                color: C.text,
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: C.text }}>SKU</label>
            <input
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="e.g. SH-COT-BLU-S"
              style={{
                width: '100%',
                height: 40,
                borderRadius: 8,
                border: `1px solid ${C.border2}`,
                padding: '0 14px',
                fontSize: 14,
                fontFamily: 'inherit',
                outline: 'none',
                background: C.field,
                color: C.text,
              }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Actual Price</label>
              <div style={{ position: 'relative' }}>
                <span
                  style={{
                    position: 'absolute',
                    left: 14,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    fontSize: 14,
                    color: C.mid,
                    fontWeight: 600,
                  }}
                >
                  ₹
                </span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={actualPrice}
                  onChange={(e) => setActualPrice(e.target.value)}
                  placeholder="0"
                  style={{
                    width: '100%',
                    height: 40,
                    borderRadius: 8,
                    border: `1px solid ${C.border2}`,
                    padding: '0 14px 0 28px',
                    fontSize: 14,
                    fontFamily: 'inherit',
                    outline: 'none',
                    background: C.field,
                    color: C.text,
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Offer Price</label>
              <div style={{ position: 'relative' }}>
                <span
                  style={{
                    position: 'absolute',
                    left: 14,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    fontSize: 14,
                    color: C.mid,
                    fontWeight: 600,
                  }}
                >
                  ₹
                </span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={offerPrice}
                  onChange={(e) => setOfferPrice(e.target.value)}
                  placeholder="0"
                  style={{
                    width: '100%',
                    height: 40,
                    borderRadius: 8,
                    border: `1px solid ${hasPriceError ? C.pink : C.border2}`,
                    padding: '0 14px 0 28px',
                    fontSize: 14,
                    fontFamily: 'inherit',
                    outline: 'none',
                    background: C.field,
                    color: C.text,
                  }}
                />
              </div>
            </div>
          </div>

          {hasPriceError && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                background: 'rgba(245,92,122,0.06)',
                border: `1px solid ${C.pink}`,
                fontSize: 13,
                color: C.pink,
              }}
            >
              Offer price cannot be greater than the actual price.
            </div>
          )}

          {errorMsg && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                background: 'rgba(245,92,122,0.06)',
                border: `1px solid ${C.pink}`,
                fontSize: 13,
                color: C.pink,
              }}
            >
              {errorMsg}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              style={{
                height: 40,
                padding: '0 18px',
                borderRadius: 8,
                border: `1px solid ${C.border2}`,
                background: C.white,
                color: C.text,
                fontFamily: 'inherit',
                fontSize: 14,
                fontWeight: 600,
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: busy ? 0.7 : 1,
              }}
            >
              Cancel
            </button>
            <GradBtn type="submit" disabled={isSaveDisabled}>
              {isSaving ? 'Saving...' : 'Save'}
            </GradBtn>
          </div>
        </form>
      </div>
    </div>
  );
}
