'use client';
import { RotateCw, UploadCloud, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { C } from '@/components/tokens';
import type { TrayGarment } from './types';

/**
 * Uploads several garments at once and lets one row per file get created
 * automatically (see BatchMode.onBulkUploadGarments / addRowsForGarments),
 * instead of the user uploading one garment per row. Full-size and worded as
 * the primary call to action when the tray is empty; once garments exist it
 * shrinks to a compact "add more" strip so the thumbnails below (in the same
 * bordered box — see GarmentTray) get the room.
 */
function BulkUploadControl({
  onFiles,
  compact,
}: {
  onFiles: (files: File[]) => void;
  compact: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length > 0) onFiles(files);
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        style={{
          display: 'flex',
          flexDirection: compact ? 'row' : 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: compact ? 10 : 8,
          padding: compact ? '16px 20px' : '40px 20px',
          minHeight: compact ? 'auto' : 160,
          borderRadius: 14,
          border: `2px dashed ${dragOver ? C.pink : C.border}`,
          background: dragOver ? 'rgba(245,92,122,0.06)' : C.white,
          color: C.text,
          cursor: 'pointer',
          width: '100%',
          boxSizing: 'border-box',
          transition: 'border-color 0.15s ease, background 0.15s ease',
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: compact ? 32 : 48,
            height: compact ? 32 : 48,
            flexShrink: 0,
            borderRadius: '50%',
            background:
              'linear-gradient(135deg, rgba(124,58,237,0.12) 0%, rgba(189,37,135,0.12) 100%)',
            color: C.pink,
          }}
        >
          <UploadCloud size={compact ? 16 : 24} />
        </span>
        {compact ? (
          <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
            Add more garments — click or drop images
          </span>
        ) : (
          <>
            <span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>
              Click to upload, or drag and drop
            </span>
            <span style={{ fontSize: 13, color: C.mid }}>
              Select multiple garment photos at once — one row is added per image
            </span>
            <span style={{ fontSize: 12, color: C.light }}>JPG, PNG or WEBP · up to 10MB each</span>
          </>
        )}
      </button>
    </div>
  );
}

/** Shows one uploaded garment's progress/error, a remove affordance, and — on error — retry. */
function GarmentThumb({
  garment,
  onRemove,
  onRetry,
}: {
  garment: TrayGarment;
  onRemove: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      style={{
        position: 'relative',
        borderRadius: 10,
        overflow: 'hidden',
        border: `1px solid ${garment.error ? C.danger : C.border}`,
        aspectRatio: '1',
      }}
    >
      {/* biome-ignore lint/performance/noImgElement: object URLs cannot go through next/image */}
      <img
        src={garment.previewUrl}
        alt={garment.fileName}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
      {!garment.r2Key && !garment.error && (
        <span
          style={{
            position: 'absolute',
            inset: 'auto 0 0 0',
            fontSize: 12,
            padding: '3px 0',
            textAlign: 'center',
            background: 'rgba(0,0,0,0.55)',
            color: C.white,
          }}
        >
          {garment.progress}%
        </span>
      )}
      {garment.error && (
        <button
          type="button"
          onClick={onRetry}
          title={`${garment.error} — click to retry`}
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            border: 'none',
            padding: 6,
            background: 'rgba(0,0,0,0.6)',
            color: C.white,
            cursor: 'pointer',
          }}
        >
          <RotateCw size={22} />
          <span style={{ fontSize: 12, textAlign: 'center' }}>Retry</span>
        </button>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        title="Remove"
        style={{
          position: 'absolute',
          top: 4,
          right: 4,
          display: 'flex',
          padding: 4,
          borderRadius: '50%',
          border: 'none',
          background: 'rgba(0,0,0,0.55)',
          cursor: 'pointer',
        }}
      >
        <X size={14} color={C.white} />
      </button>
    </div>
  );
}

export function GarmentTray({
  garments,
  rowCount,
  onFilesSelected,
  onRemoveGarment,
  onRetryGarment,
  onOpenConfigure,
}: {
  garments: TrayGarment[];
  rowCount: number;
  onFilesSelected: (files: File[]) => void;
  onRemoveGarment: (id: string) => void;
  onRetryGarment: (id: string) => void;
  onOpenConfigure: () => void;
}) {
  const hasGarments = garments.length > 0;

  return (
    <div style={{ marginTop: 16 }}>
      {/* One bordered box holds both the upload control and everything that's
          been uploaded, so the tray reads as a single upload area instead of a
          dropzone with a separate list floating below it. */}
      <div
        style={{
          border: `1px solid ${C.border}`,
          borderRadius: 16,
          padding: 20,
          background: C.field,
        }}
      >
        <BulkUploadControl onFiles={onFilesSelected} compact={hasGarments} />

        {hasGarments && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: 14,
              marginTop: 16,
            }}
          >
            {garments.map((g) => (
              <GarmentThumb
                key={g.id}
                garment={g}
                onRemove={() => onRemoveGarment(g.id)}
                onRetry={() => onRetryGarment(g.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 20 }}>
        <button
          type="button"
          onClick={onOpenConfigure}
          disabled={garments.length === 0}
          style={{
            minWidth: 320,
            padding: '16px 32px',
            borderRadius: 10,
            border: 'none',
            background:
              garments.length === 0 ? C.field : 'linear-gradient(135deg, #7c3aed 0%, #BD2587 100%)',
            color: garments.length === 0 ? C.mid : C.white,
            fontWeight: 700,
            fontSize: 16,
            cursor: garments.length === 0 ? 'not-allowed' : 'pointer',
            boxShadow: garments.length === 0 ? 'none' : '0 6px 20px rgba(189,37,135,0.28)',
          }}
        >
          Configure{rowCount > 0 ? ` (${rowCount} row${rowCount > 1 ? 's' : ''})` : ''}
        </button>
      </div>
    </div>
  );
}
