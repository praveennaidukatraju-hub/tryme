'use client';
import { useEffect, useRef, useState } from 'react';
import { SpinnerIcon, TrashIcon, UploadIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { GradBtn } from '@/components/ui/grad-btn';
import { api } from '@/lib/api';
import { presignAndUpload } from './api';

interface QueueItem {
  id: string;
  file: File;
  fileUrl: string;
  // 'uploaded' — catalogue mode: a finished product photo, nothing to
  // generate, details are editable immediately. No server row until Save.
  // 'sent' — flat mode: handed off to the held-job pipeline. Nothing more
  // happens in this modal for it; it shows up in the catalogue once an admin
  // releases the batch and reconcile-held picks up the result.
  status: 'queued' | 'uploading' | 'generating' | 'uploaded' | 'sent' | 'failed';
  jobId?: string;
  itemId?: string;
  sku: string;
  actualPrice: string;
  offerPrice: string;
  hasError: boolean;
  errorMessage?: string;
}

interface BulkUploadModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  subcategoryId: string | null;
}

const generateId = () => Math.random().toString(36).substring(2, 9);

export function BulkUploadModal({ open, onClose, onSaved, subcategoryId }: BulkUploadModalProps) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [imageMode, setImageMode] = useState<'catalogue' | 'flat'>('catalogue');
  const [isDragging, setIsDragging] = useState(false);
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [sentForProcessing, setSentForProcessing] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<QueueItem[]>([]);
  itemsRef.current = items;

  const [globalActual, setGlobalActual] = useState('');
  const [globalOffer, setGlobalOffer] = useState('');

  // Reset state
  useEffect(() => {
    if (open) {
      setItems([]);
      setImageMode('catalogue');
      setGlobalActual('');
      setGlobalOffer('');
      setIsDragging(false);
      setIsGeneratingAll(false);
      setIsSaving(false);
      setSentForProcessing(0);
    }
  }, [open]);

  // Clean up local previews on close. Catalogue-mode 'uploaded' items and
  // flat-mode 'sent' items never create a server row inside this modal, so
  // there's nothing to delete — only relevant if a future path re-introduces
  // an inline generate step.
  useEffect(() => {
    if (open) return;
    for (const item of itemsRef.current) {
      URL.revokeObjectURL(item.fileUrl);
    }
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

  const busy = isGeneratingAll || isSaving;

  const processFiles = (files: FileList | File[]) => {
    const newItems: QueueItem[] = Array.from(files)
      .filter((file) => file.type.startsWith('image/'))
      .map((file) => ({
        id: generateId(),
        file,
        fileUrl: URL.createObjectURL(file),
        // Catalogue images are already final — no generate step to wait through.
        status: imageMode === 'catalogue' ? 'uploaded' : 'queued',
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

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) processFiles(e.dataTransfer.files);
  };

  const handleSendForProcessing = async () => {
    const queued = items.filter((i) => i.status === 'queued');
    if (queued.length === 0 || !subcategoryId) return;
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
                  errorMessage: err instanceof Error ? err.message : 'Upload failed',
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
                errorMessage: err instanceof Error ? err.message : 'Failed to enqueue',
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
    // poll here. The images land in the catalogue (marked "Needs details") once
    // generation finishes — see reconcileHeldProducts in CatalogueManagerContent.
    setItems((prev) => prev.map((p) => (jobIdByLocalId.get(p.id) ? { ...p, status: 'sent' } : p)));
    setIsGeneratingAll(false);
    setSentForProcessing((prev) => prev + jobIds.length);
  };

  const handleApplyGlobalPrice = () => {
    if (!globalActual && !globalOffer) return;
    setItems((prev) =>
      prev.map((item) => {
        if (item.status === 'uploaded') {
          return {
            ...item,
            actualPrice: globalActual || item.actualPrice,
            offerPrice: globalOffer || item.offerPrice,
            hasError: false,
          };
        }
        return item;
      }),
    );
  };

  const handleUpdateItem = (id: string, updates: Partial<QueueItem>) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...updates, hasError: false } : item)),
    );
  };

  const handleRemoveItem = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (item) URL.revokeObjectURL(item.fileUrl);
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const handleAddCatalogue = async () => {
    if (!subcategoryId) return;
    let hasValidationError = false;
    const validated = items.map((item) => {
      if (item.status !== 'uploaded') return item;
      const act = parseInt(item.actualPrice, 10) || 0;
      const off = parseInt(item.offerPrice, 10) || 0;
      const isValid =
        item.sku.trim() !== '' && item.actualPrice !== '' && item.offerPrice !== '' && off <= act;
      if (!isValid) hasValidationError = true;
      return { ...item, hasError: !isValid };
    });
    setItems(validated);
    if (hasValidationError) return;

    const ready = validated.filter((i) => i.status === 'uploaded');
    if (ready.length === 0) return;

    setIsSaving(true);
    try {
      // No job, no generation — upload each finished photo and create the row directly.
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
            label: `Product ${item.sku.trim().toUpperCase()}`,
            sku: item.sku.trim(),
            actualPrice: parseInt(item.actualPrice, 10),
            offerPrice: parseInt(item.offerPrice, 10),
          });
        }),
      );
      onSaved();
    } finally {
      setIsSaving(false);
    }
  };

  const hasQueued = items.some((i) => i.status === 'queued');
  const hasUploaded = items.some((i) => i.status === 'uploaded');
  const uploadedCount = items.filter((i) => i.status === 'uploaded').length;
  const isAnyGenerating = items.some((i) => i.status === 'uploading' || i.status === 'generating');

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
          width: 920,
          maxWidth: '90vw',
          height: '85vh',
          maxHeight: 800,
          boxShadow: '0 12px 48px rgba(0,0,0,0.18)',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: 0 }}>
              {imageMode === 'catalogue'
                ? 'Bulk Upload Catalogue Images'
                : 'Bulk Upload Flat Images'}
            </h3>
            <div style={{ fontSize: 13, color: C.mid, marginTop: 4 }}>
              {imageMode === 'catalogue'
                ? 'Upload multiple finished product photos directly to your catalogue.'
                : 'Upload multiple flat garment photos. They’ll be processed during the next GPU window, then appear in your catalogue once ready.'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 24,
              color: C.mid,
              cursor: busy ? 'not-allowed' : 'pointer',
              lineHeight: 1,
            }}
          >
            &times;
          </button>
        </div>

        {/* Mode toggle */}
        <div
          style={{
            display: 'flex',
            borderRadius: 8,
            border: `1px solid ${C.border2}`,
            overflow: 'hidden',
            background: C.white,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={() => setImageMode('catalogue')}
            disabled={busy || items.length > 0}
            style={{
              flex: 1,
              padding: '12px 16px',
              border: 'none',
              background: imageMode === 'catalogue' ? 'rgba(245, 92, 122, 0.08)' : 'transparent',
              color: imageMode === 'catalogue' ? C.pink : C.text,
              fontWeight: imageMode === 'catalogue' ? 600 : 500,
              fontSize: 14,
              cursor: busy || items.length > 0 ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
              borderRight: `1px solid ${C.border2}`,
            }}
          >
            Catalogue Images
          </button>
          <button
            type="button"
            onClick={() => setImageMode('flat')}
            disabled={busy || items.length > 0}
            style={{
              flex: 1,
              padding: '12px 16px',
              border: 'none',
              background: imageMode === 'flat' ? 'rgba(245, 92, 122, 0.08)' : 'transparent',
              color: imageMode === 'flat' ? C.pink : C.text,
              fontWeight: imageMode === 'flat' ? 600 : 500,
              fontSize: 14,
              cursor: busy || items.length > 0 ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            Flat Images
          </button>
        </div>

        {/* Dropzone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            height: 100,
            borderRadius: 8,
            border: `2px dashed ${isDragging ? C.pink : C.border2}`,
            background: isDragging ? 'rgba(245, 92, 122, 0.05)' : C.field,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            flexShrink: 0,
            transition: 'all 0.15s ease',
            gap: 8,
          }}
          className="hover-surface"
        >
          <div style={{ color: isDragging ? C.pink : C.mid }}>
            <UploadIcon size={24} />
          </div>
          <div style={{ fontSize: 13, color: isDragging ? C.pink : C.mid, fontWeight: 500 }}>
            {imageMode === 'catalogue'
              ? 'Drop product photos here or click to browse'
              : 'Drop flat images here or click to browse'}
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
        </div>

        {/* Queue Actions */}
        {items.length > 0 && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              background: C.lighter,
              padding: '12px 16px',
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              {imageMode === 'flat' && (
                <GradBtn
                  type="button"
                  onClick={() => void handleSendForProcessing()}
                  disabled={!hasQueued || busy}
                >
                  {isGeneratingAll && <SpinnerIcon size={14} />}
                  {isGeneratingAll ? 'Sending...' : 'Send for Processing'}
                </GradBtn>
              )}
              <span style={{ fontSize: 13, color: C.mid, fontWeight: 500 }}>
                {items.length} item{items.length !== 1 && 's'}
                {imageMode === 'catalogue' ? ` (${uploadedCount} ready)` : ''}
              </span>
            </div>

            {hasUploaded && (
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  background: C.card,
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: `1px solid ${C.border2}`,
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>
                  Set price for all:
                </span>
                <input
                  type="number"
                  placeholder="Actual"
                  value={globalActual}
                  onChange={(e) => setGlobalActual(e.target.value)}
                  style={{
                    width: 70,
                    height: 28,
                    fontSize: 12,
                    borderRadius: 4,
                    border: `1px solid ${C.border2}`,
                    padding: '0 8px',
                  }}
                />
                <input
                  type="number"
                  placeholder="Offer"
                  value={globalOffer}
                  onChange={(e) => setGlobalOffer(e.target.value)}
                  style={{
                    width: 70,
                    height: 28,
                    fontSize: 12,
                    borderRadius: 4,
                    border: `1px solid ${C.border2}`,
                    padding: '0 8px',
                  }}
                />
                <button
                  type="button"
                  onClick={handleApplyGlobalPrice}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: C.pink,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    padding: 0,
                    marginLeft: 4,
                  }}
                >
                  Apply
                </button>
              </div>
            )}
          </div>
        )}

        {/* Scroll wrapper — a plain block element, not a grid container. Keeping
            scrolling and grid layout on separate elements (rather than one div
            that is simultaneously `flex: 1`, `display: grid`, and the overflow
            container) avoids browser edge cases where a grid container's own
            intrinsic-height calculation fights with its ancestor's flex sizing.
            minHeight: 0 is required so this flex child actually shrinks instead
            of growing and pushing the whole modal past its fixed height. */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
          }}
        >
          <div
            style={{
              padding: '4px',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: 16,
              alignContent: 'start',
            }}
          >
            {items.map((item) => (
              <div
                key={item.id}
                style={{
                  border: `1px solid ${item.hasError || item.status === 'failed' ? C.pink : C.border}`,
                  borderRadius: 12,
                  background:
                    item.hasError || item.status === 'failed' ? 'rgba(245,92,122,0.03)' : C.card,
                  overflow: 'hidden',
                  position: 'relative',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <button
                  type="button"
                  onClick={() => handleRemoveItem(item.id)}
                  disabled={item.status === 'uploading' || item.status === 'generating'}
                  style={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    background: 'rgba(0,0,0,0.5)',
                    color: C.white,
                    border: 'none',
                    borderRadius: 6,
                    width: 24,
                    height: 24,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    zIndex: 10,
                  }}
                  title="Remove item"
                >
                  <TrashIcon />
                </button>

                <div
                  style={{
                    height: 220,
                    flexShrink: 0,
                    background: C.lighter,
                    position: 'relative',
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {/* biome-ignore lint/performance/noImgElement: local/generated preview */}
                  <img
                    src={item.fileUrl}
                    alt="Upload preview"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />

                  {/* Status Badge overlay */}
                  <div style={{ position: 'absolute', bottom: 6, left: 6 }}>
                    {item.status === 'queued' && (
                      <div
                        style={{
                          background: C.mid,
                          color: C.white,
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 4,
                          textTransform: 'uppercase',
                        }}
                      >
                        Queued
                      </div>
                    )}
                    {(item.status === 'uploading' || item.status === 'generating') && (
                      <div
                        style={{
                          background: C.card,
                          color: C.pink,
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: 4,
                          textTransform: 'uppercase',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          border: `1px solid ${C.border2}`,
                          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                        }}
                      >
                        <SpinnerIcon size={10} />{' '}
                        {item.status === 'uploading' ? 'Uploading' : 'Generating'}
                      </div>
                    )}
                    {item.status === 'uploaded' && (
                      <div
                        style={{
                          background: '#10b981',
                          color: C.white,
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 4,
                          textTransform: 'uppercase',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        ✓ Ready
                      </div>
                    )}
                    {item.status === 'sent' && (
                      <div
                        style={{
                          background: C.mid,
                          color: C.white,
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 4,
                          textTransform: 'uppercase',
                        }}
                      >
                        Sent
                      </div>
                    )}
                    {item.status === 'failed' && (
                      <div
                        style={{
                          background: C.pink,
                          color: C.white,
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 4,
                          textTransform: 'uppercase',
                        }}
                      >
                        Failed
                      </div>
                    )}
                  </div>
                </div>

                {/* Fixed height regardless of status/content so every tile in the grid
                  matches — a validation error or a long failure message used to
                  make individual tiles taller than their neighbors. */}
                <div
                  style={{
                    height: 96,
                    boxSizing: 'border-box',
                    padding: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    overflow: 'hidden',
                  }}
                >
                  {item.status === 'uploaded' && (
                    <>
                      <input
                        placeholder="SKU"
                        value={item.sku}
                        onChange={(e) => handleUpdateItem(item.id, { sku: e.target.value })}
                        style={{
                          width: '100%',
                          height: 30,
                          fontSize: 12,
                          borderRadius: 6,
                          border: `1px solid ${item.hasError && !item.sku ? C.pink : C.border2}`,
                          padding: '0 8px',
                          background: C.field,
                          color: C.text,
                        }}
                      />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <div style={{ position: 'relative', flex: 1 }}>
                          <span
                            style={{
                              position: 'absolute',
                              left: 6,
                              top: '50%',
                              transform: 'translateY(-50%)',
                              fontSize: 11,
                              color: C.mid,
                              fontWeight: 600,
                            }}
                          >
                            ₹
                          </span>
                          <input
                            type="number"
                            placeholder="Actual"
                            value={item.actualPrice}
                            onChange={(e) =>
                              handleUpdateItem(item.id, { actualPrice: e.target.value })
                            }
                            style={{
                              width: '100%',
                              height: 30,
                              fontSize: 12,
                              borderRadius: 6,
                              border: `1px solid ${item.hasError && (!item.actualPrice || parseInt(item.offerPrice, 10) > parseInt(item.actualPrice, 10)) ? C.pink : C.border2}`,
                              padding: '0 4px 0 17px',
                              background: C.field,
                              color: C.text,
                            }}
                          />
                        </div>
                        <div style={{ position: 'relative', flex: 1 }}>
                          <span
                            style={{
                              position: 'absolute',
                              left: 6,
                              top: '50%',
                              transform: 'translateY(-50%)',
                              fontSize: 11,
                              color: C.mid,
                              fontWeight: 600,
                            }}
                          >
                            ₹
                          </span>
                          <input
                            type="number"
                            placeholder="Offer"
                            value={item.offerPrice}
                            onChange={(e) =>
                              handleUpdateItem(item.id, { offerPrice: e.target.value })
                            }
                            style={{
                              width: '100%',
                              height: 30,
                              fontSize: 12,
                              borderRadius: 6,
                              border: `1px solid ${item.hasError && (!item.offerPrice || parseInt(item.offerPrice, 10) > parseInt(item.actualPrice, 10)) ? C.pink : C.border2}`,
                              padding: '0 4px 0 17px',
                              background: C.field,
                              color: C.text,
                            }}
                          />
                        </div>
                      </div>
                      <div style={{ fontSize: 10, color: C.pink, lineHeight: 1.2 }}>
                        {item.hasError
                          ? 'Please fill valid SKU and ensure Offer ≤ Actual Price.'
                          : ''}
                      </div>
                    </>
                  )}

                  {item.status === 'failed' && item.errorMessage && (
                    <div
                      style={{
                        fontSize: 11,
                        color: C.pink,
                        lineHeight: 1.3,
                        display: '-webkit-box',
                        WebkitLineClamp: 4,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {item.errorMessage}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {sentForProcessing > 0 && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              background: C.lighter,
              border: `1px solid ${C.border}`,
              fontSize: 13,
              color: C.text,
              lineHeight: 1.4,
              flexShrink: 0,
            }}
          >
            {sentForProcessing} image{sentForProcessing === 1 ? '' : 's'} sent for processing.
            They&apos;re queued for the next processing window — you&apos;ll find them in this
            catalogue once they&apos;re ready, waiting for SKU and pricing.
          </div>
        )}

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            paddingTop: 16,
            borderTop: `1px solid ${C.border2}`,
            flexShrink: 0,
          }}
        >
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
            }}
          >
            Cancel
          </button>
          {imageMode === 'catalogue' ? (
            <GradBtn
              type="button"
              disabled={uploadedCount === 0 || isAnyGenerating || isSaving}
              onClick={() => void handleAddCatalogue()}
            >
              {isSaving ? 'Saving...' : `Add ${uploadedCount} to Catalogue`}
            </GradBtn>
          ) : (
            <GradBtn type="button" disabled={busy} onClick={onClose}>
              Done
            </GradBtn>
          )}
        </div>
      </div>
    </div>
  );
}
