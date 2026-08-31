'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type GenerationJob, GenerationPanel } from '@/app/(app)/studio/generation-panel';
import { SelectGridModal } from '@/app/(app)/studio/select-modal';
import { SectionHead, SelCard, sectionCardStyle } from '@/app/(app)/studio/shared-cards';
import { SpinnerIcon } from '@/components/icons';
import { C, grad } from '@/components/tokens';
import { Tooltip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { postImageSelectedToParent } from '@/lib/sellio-embed-protocol';

const GENDERS = [
  { value: 'women', label: 'Women' },
  { value: 'men', label: 'Men' },
  { value: 'boys', label: 'Boys' },
  { value: 'girls', label: 'Girls' },
];

// A subset of the fields Studio's GarmentType carries. Mannequin/two-pass
// garment types (saree flow) stay filtered out per the design spec's Scope
// Boundaries section — that's a separate, larger feature — but two/three-
// upload garment types are fully supported, matching Studio.
interface EmbedGarmentType {
  id: string;
  label: string;
  thumbnailUrl?: string | null;
  requiresLowerUpload: boolean;
  requiresThirdUpload?: boolean;
  requiresMannequinStep?: boolean;
  defaultLowerCatalogId?: string | null;
  defaultShoeCatalogId?: string | null;
  upperUploadLabel?: string | null;
  lowerUploadLabel?: string | null;
  thirdUploadLabel?: string | null;
}
interface FaceItem {
  id: string;
  label: string;
  thumbnailUrl: string;
  gender: string;
}
interface BackgroundItem {
  id: string;
  label: string;
  thumbnailUrl: string;
}
interface PoseItem {
  id: string;
  label: string;
  thumbnailUrl: string;
  hasLower: boolean;
  hasShoes: boolean;
}
interface CatalogItem {
  id: string;
  label: string;
  thumbnailUrl: string;
}
interface CatalogNode {
  id: number;
  slug: string;
  label: string;
  thumbnailUrl?: string | null;
  children: CatalogNode[];
  items: CatalogItem[];
}

function flattenNode(node: CatalogNode): CatalogItem[] {
  return [...node.items, ...node.children.flatMap((c) => flattenNode(c))];
}

async function isSupportedImageBytes(file: File): Promise<boolean> {
  const buf = await file.slice(0, 12).arrayBuffer();
  const b = new Uint8Array(buf);
  const isJpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const isPng =
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a;
  const isWebp =
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50;
  return isJpeg || isPng || isWebp;
}

export function EmbedStudioWizard() {
  const [gender, setGender] = useState('women');
  const [garmentTypeId, setGarmentTypeId] = useState('');
  const [garmentFile, setGarmentFile] = useState<File | null>(null);
  const [garmentKey, setGarmentKey] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');
  const [lowerGarmentFile, setLowerGarmentFile] = useState<File | null>(null);
  const [lowerGarmentKey, setLowerGarmentKey] = useState('');
  const [isUploadingLower, setIsUploadingLower] = useState(false);
  const [thirdGarmentFile, setThirdGarmentFile] = useState<File | null>(null);
  const [thirdGarmentKey, setThirdGarmentKey] = useState('');
  const [isUploadingThird, setIsUploadingThird] = useState(false);
  const [faceId, setFaceId] = useState('');
  const [backgroundId, setBackgroundId] = useState('');
  const [poseIds, setPoseIds] = useState<string[]>([]);
  const [faceModalOpen, setFaceModalOpen] = useState(false);
  const [backgroundModalOpen, setBackgroundModalOpen] = useState(false);
  const [poseModalOpen, setPoseModalOpen] = useState(false);
  const [lowerCatalogId, setLowerCatalogId] = useState('');
  const [shoeCatalogId, setShoeCatalogId] = useState('');
  const [lowerModalOpen, setLowerModalOpen] = useState(false);
  const [shoeModalOpen, setShoeModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [activeGeneration, setActiveGeneration] = useState<{
    catalogueId: string;
    jobs: GenerationJob[];
  } | null>(null);

  const { data: facesData } = useQuery<{ items: FaceItem[] }>({
    queryKey: ['embed-faces', gender],
    queryFn: () => api.get(`/v1/models/faces?gender=${gender}`),
  });
  const faces = facesData?.items ?? [];
  // Mirrors the real Studio page's auto-select behavior (studio/page.tsx) so a
  // face is already picked by the time the merchant reaches this step, rather
  // than forcing an extra manual click Studio itself doesn't require.
  useEffect(() => {
    if (!faces.length) return;
    if (!faces.some((f) => f.id === faceId)) {
      setFaceId(faces[0]?.id ?? '');
    }
  }, [faces, faceId]);

  const { data: backgroundsData } = useQuery<{ items: BackgroundItem[] }>({
    queryKey: ['embed-backgrounds', gender],
    queryFn: () => api.get(`/v1/models/backgrounds?gender=${gender}`),
  });
  const backgrounds = backgroundsData?.items ?? [];
  // Same auto-select parity with Studio's page.tsx for backgrounds.
  useEffect(() => {
    if (backgrounds.length && !backgroundId) {
      setBackgroundId(backgrounds[0]?.id ?? '');
    }
  }, [backgrounds, backgroundId]);

  const { data: posesData } = useQuery<{ items: PoseItem[] }>({
    queryKey: ['embed-poses', gender, garmentTypeId],
    queryFn: () =>
      api.get(
        `/v1/models/poses?gender=${gender}${garmentTypeId ? `&garmentTypeId=${garmentTypeId}` : ''}`,
      ),
    enabled: !!garmentTypeId,
  });
  const poses = posesData?.items ?? [];

  const selectedPoses = poses.filter((p) => poseIds.includes(p.id));
  const needsLower = selectedPoses.some((p) => p.hasLower);
  const needsShoes = selectedPoses.some((p) => p.hasShoes);

  const poseIdsParam = poseIds.length > 0 ? `poseIds=${poseIds.join(',')}` : '';
  const { data: lowerCatalogData } = useQuery<{ type: string; tree: CatalogNode[] }>({
    queryKey: ['embed-catalog-lower', gender, garmentTypeId, poseIds.join(',')],
    queryFn: () => {
      const params = [
        poseIdsParam,
        `gender=${gender}`,
        garmentTypeId ? `garmentTypeId=${garmentTypeId}` : '',
      ]
        .filter(Boolean)
        .join('&');
      return api.get(`/v1/catalog/lower?${params}`);
    },
    enabled: needsLower,
  });
  const lowerItems = useMemo(() => {
    const all = (lowerCatalogData?.tree.filter((n) => n.slug !== 'other') ?? []).flatMap(
      flattenNode,
    );
    return [...all].sort(() => Math.random() - 0.5);
  }, [lowerCatalogData]);

  const { data: shoeCatalogData } = useQuery<{ type: string; tree: CatalogNode[] }>({
    queryKey: ['embed-catalog-shoe', gender, garmentTypeId, poseIds.join(',')],
    queryFn: () => {
      const params = [
        poseIdsParam,
        `gender=${gender}`,
        garmentTypeId ? `garmentTypeId=${garmentTypeId}` : '',
      ]
        .filter(Boolean)
        .join('&');
      return api.get(`/v1/catalog/shoe?${params}`);
    },
    enabled: needsShoes,
  });
  const shoeItems = useMemo(() => {
    const all = (shoeCatalogData?.tree.filter((n) => n.slug !== 'other') ?? []).flatMap(
      flattenNode,
    );
    return [...all].sort(() => Math.random() - 0.5);
  }, [shoeCatalogData]);
  const lowerPreviewItems = useMemo(() => {
    const selectedItem = lowerItems.find((item) => item.id === lowerCatalogId);
    const firstItems = lowerItems.slice(0, 4);
    if (!selectedItem || firstItems.some((item) => item.id === selectedItem.id)) return firstItems;
    return [selectedItem, ...firstItems.filter((item) => item.id !== selectedItem.id)].slice(0, 4);
  }, [lowerCatalogId, lowerItems]);
  const shoePreviewItems = useMemo(() => {
    const selectedItem = shoeItems.find((item) => item.id === shoeCatalogId);
    const firstItems = shoeItems.slice(0, 4);
    if (!selectedItem || firstItems.some((item) => item.id === selectedItem.id)) return firstItems;
    return [selectedItem, ...firstItems.filter((item) => item.id !== selectedItem.id)].slice(0, 4);
  }, [shoeCatalogId, shoeItems]);

  function togglePose(id: string) {
    setPoseIds((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
      const nextPoses = poses.filter((p) => next.includes(p.id));
      const nextNeedsLower = nextPoses.some((p) => p.hasLower);
      const nextNeedsShoes = nextPoses.some((p) => p.hasShoes);
      // Clear a stale selection once it's no longer needed — mirrors Studio's
      // handlePoseSelect. Left empty otherwise; the default catalog item (if
      // any) is resolved at submit time in handleGenerate.
      if (!nextNeedsLower) setLowerCatalogId('');
      if (!nextNeedsShoes) setShoeCatalogId('');
      return next;
    });
  }

  async function handleGenerate() {
    if (!canGenerate || isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError('');
    try {
      // Prefer the merchant's manual pick; only fall back to the garment type's
      // own default catalog item when a selected pose needs one and nothing was
      // picked — same precedence Studio's page.tsx uses at submit time.
      const effectiveLowerId =
        lowerCatalogId ||
        (needsLower ? (selectedGarmentType?.defaultLowerCatalogId ?? undefined) : undefined);
      const effectiveShoesId =
        shoeCatalogId ||
        (needsShoes ? (selectedGarmentType?.defaultShoeCatalogId ?? undefined) : undefined);
      const { catalogueId, jobIds } = await api.post<{ catalogueId: string; jobIds: string[] }>(
        '/v1/jobs/tryon',
        {
          inputs: {
            upperGarmentKey: garmentKey,
            faceId,
            backgroundId,
            poseIds,
            garmentTypeId: garmentTypeId || undefined,
            lowerCatalogId: effectiveLowerId,
            lowerGarmentKey: lowerGarmentKey || undefined,
            shoeCatalogId: effectiveShoesId,
            thirdGarmentKey: thirdGarmentKey || undefined,
          },
          aspectRatio: '1:1',
          resolution: 'HD',
          platform: 'Shopify',
        },
      );
      const submittedLooks = poseIds.map((poseId) => {
        const pose = poses.find((p) => p.id === poseId);
        return { poseId, label: pose?.label ?? 'Pose', thumbnailUrl: pose?.thumbnailUrl ?? '' };
      });
      setActiveGeneration({
        catalogueId,
        jobs: jobIds.map((id, i) => ({
          id,
          poseId: submittedLooks[i]?.poseId ?? '',
          label: submittedLooks[i]?.label ?? `Look ${i + 1}`,
          thumbnailUrl: submittedLooks[i]?.thumbnailUrl ?? '',
        })),
      });
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleStartOver() {
    setActiveGeneration(null);
    setPoseIds([]);
    setLowerCatalogId('');
    setShoeCatalogId('');
  }

  function handleUseImage(args: { url: string; jobId: string; poseLabel: string }) {
    postImageSelectedToParent({
      imageUrl: args.url,
      jobId: args.jobId,
      poseLabel: args.poseLabel,
    });
  }

  const garmentPreviewUrl = useMemo(
    () => (garmentFile ? URL.createObjectURL(garmentFile) : ''),
    [garmentFile],
  );
  useEffect(() => {
    return () => {
      if (garmentPreviewUrl) URL.revokeObjectURL(garmentPreviewUrl);
    };
  }, [garmentPreviewUrl]);

  const lowerGarmentPreviewUrl = useMemo(
    () => (lowerGarmentFile ? URL.createObjectURL(lowerGarmentFile) : ''),
    [lowerGarmentFile],
  );
  useEffect(() => {
    return () => {
      if (lowerGarmentPreviewUrl) URL.revokeObjectURL(lowerGarmentPreviewUrl);
    };
  }, [lowerGarmentPreviewUrl]);

  const thirdGarmentPreviewUrl = useMemo(
    () => (thirdGarmentFile ? URL.createObjectURL(thirdGarmentFile) : ''),
    [thirdGarmentFile],
  );
  useEffect(() => {
    return () => {
      if (thirdGarmentPreviewUrl) URL.revokeObjectURL(thirdGarmentPreviewUrl);
    };
  }, [thirdGarmentPreviewUrl]);

  const { data: garmentTypesData } = useQuery<{ items: EmbedGarmentType[] }>({
    queryKey: ['embed-garment-types', gender],
    queryFn: () => api.get(`/v1/models/garment-types?gender=${gender}`),
  });
  const garmentTypes = useMemo(
    () => (garmentTypesData?.items ?? []).filter((g) => !g.requiresMannequinStep),
    [garmentTypesData],
  );
  const didAutoGarmentType = useMemo(() => ({ current: '' }), []);
  useEffect(() => {
    if (garmentTypes.length && !garmentTypeId && didAutoGarmentType.current !== gender) {
      setGarmentTypeId(garmentTypes[0]?.id ?? '');
      didAutoGarmentType.current = gender;
    }
  }, [garmentTypes, garmentTypeId, gender, didAutoGarmentType]);

  const defaultsAppliedForGarmentType = useRef('');
  useEffect(() => {
    if (!garmentTypeId || defaultsAppliedForGarmentType.current === garmentTypeId) return;

    const garmentType = garmentTypes.find((item) => item.id === garmentTypeId);
    if (!garmentType) return;

    setLowerCatalogId(garmentType.defaultLowerCatalogId ?? '');
    setShoeCatalogId(garmentType.defaultShoeCatalogId ?? '');
    defaultsAppliedForGarmentType.current = garmentTypeId;
  }, [garmentTypeId, garmentTypes]);

  const selectedGarmentType = garmentTypes.find((g) => g.id === garmentTypeId);
  const previousCatalogNeeds = useRef({ lower: false, shoes: false });
  useEffect(() => {
    if (needsLower && !previousCatalogNeeds.current.lower && !lowerCatalogId) {
      setLowerCatalogId(selectedGarmentType?.defaultLowerCatalogId ?? '');
    }
    if (needsShoes && !previousCatalogNeeds.current.shoes && !shoeCatalogId) {
      setShoeCatalogId(selectedGarmentType?.defaultShoeCatalogId ?? '');
    }
    previousCatalogNeeds.current = { lower: needsLower, shoes: needsShoes };
  }, [
    lowerCatalogId,
    needsLower,
    needsShoes,
    selectedGarmentType?.defaultLowerCatalogId,
    selectedGarmentType?.defaultShoeCatalogId,
    shoeCatalogId,
  ]);
  const requiresLowerUpload = selectedGarmentType?.requiresLowerUpload ?? false;
  const requiresThirdUpload = selectedGarmentType?.requiresThirdUpload ?? false;
  const hasMultipleUploadBoxes = requiresLowerUpload || requiresThirdUpload;

  // Lower Garment / Footwear are conditional steps — number them relative to
  // the fixed steps (1-6) only when they're actually shown, same pattern as
  // Studio's page.tsx stepNumberOf for its own optional sections.
  const extraStepKeys = [
    needsLower && !requiresLowerUpload && 'lower',
    needsShoes && 'shoes',
  ].filter((key): key is string => !!key);
  const stepNumberOf = (key: string) => 7 + extraStepKeys.indexOf(key);

  const canGenerate =
    !!garmentKey &&
    (!requiresLowerUpload || !!lowerGarmentKey) &&
    (!requiresThirdUpload || !!thirdGarmentKey) &&
    !!faceId &&
    !!backgroundId &&
    poseIds.length > 0 &&
    !isUploading &&
    !isUploadingLower &&
    !isUploadingThird &&
    !isSubmitting;

  const generateBlocker = isSubmitting
    ? 'Generating…'
    : isUploading || isUploadingLower || isUploadingThird
      ? 'Waiting for upload to finish…'
      : !garmentKey
        ? 'Please upload a garment image'
        : requiresLowerUpload && !lowerGarmentKey
          ? 'Please upload the lower garment image'
          : requiresThirdUpload && !thirdGarmentKey
            ? 'Please upload the third garment image'
            : !faceId
              ? 'Please select a model face'
              : !backgroundId
                ? 'Please select a background'
                : poseIds.length === 0
                  ? 'Please select at least one pose'
                  : '';

  function handleGenderSelect(value: string) {
    setGender(value);
    setGarmentTypeId('');
    setPoseIds([]);
    setLowerCatalogId('');
    setShoeCatalogId('');
    setLowerGarmentFile(null);
    setLowerGarmentKey('');
    setThirdGarmentFile(null);
    setThirdGarmentKey('');
  }

  function handleGarmentTypeSelect(id: string) {
    setGarmentTypeId(id);
    // Pose availability is scoped to garmentTypeId — a stale poseIds selection
    // from the previous garment type could point at poses that no longer
    // exist or have different hasLower/hasShoes flags for the new type.
    setPoseIds([]);
    setLowerCatalogId('');
    setShoeCatalogId('');
    // A different garment type may not want (or may want a different) second/
    // third upload — don't carry a stale file across the switch.
    setLowerGarmentFile(null);
    setLowerGarmentKey('');
    setThirdGarmentFile(null);
    setThirdGarmentKey('');
  }

  async function handleGarmentUpload(file: File) {
    if (isUploading) return;
    if (file.size > 10 * 1024 * 1024) {
      setUploadError('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      setUploadError('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setUploadError('');
    setGarmentFile(file);
    setIsUploading(true);
    setUploadProgress(0);
    try {
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        expiresIn: number;
      }>('/v1/uploads/presign', { contentType: file.type, contentLength: file.size });
      await api.uploadToR2WithProgress(uploadUrl, file, setUploadProgress);
      setGarmentKey(r2Key);
    } catch (e) {
      setUploadError(`Upload failed: ${(e as Error).message}`);
      setGarmentFile(null);
    } finally {
      setIsUploading(false);
    }
  }

  async function handleLowerGarmentUpload(file: File) {
    if (isUploadingLower) return;
    if (file.size > 10 * 1024 * 1024) {
      setUploadError('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      setUploadError('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setUploadError('');
    setLowerGarmentFile(file);
    setIsUploadingLower(true);
    try {
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        expiresIn: number;
      }>('/v1/uploads/presign', { contentType: file.type, contentLength: file.size });
      await api.uploadToR2WithProgress(uploadUrl, file, () => {});
      setLowerGarmentKey(r2Key);
    } catch (e) {
      setUploadError(`Lower garment upload failed: ${(e as Error).message}`);
      setLowerGarmentFile(null);
      setLowerGarmentKey('');
    } finally {
      setIsUploadingLower(false);
    }
  }

  async function handleThirdGarmentUpload(file: File) {
    if (isUploadingThird) return;
    if (file.size > 10 * 1024 * 1024) {
      setUploadError('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      setUploadError('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setUploadError('');
    setThirdGarmentFile(file);
    setIsUploadingThird(true);
    try {
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        expiresIn: number;
      }>('/v1/uploads/presign', { contentType: file.type, contentLength: file.size });
      await api.uploadToR2WithProgress(uploadUrl, file, () => {});
      setThirdGarmentKey(r2Key);
    } catch (e) {
      setUploadError(`Third garment upload failed: ${(e as Error).message}`);
      setThirdGarmentFile(null);
      setThirdGarmentKey('');
    } finally {
      setIsUploadingThird(false);
    }
  }

  return (
    <div
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '24px 20px 40px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>
          Generate a product photo with Sellio
        </h2>
      </div>

      <div style={sectionCardStyle}>
        <SectionHead title="Who is this product for?" stepNumber={1} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {GENDERS.map((g) => {
            const selected = gender === g.value;
            return (
              <button
                key={g.value}
                type="button"
                onClick={() => handleGenderSelect(g.value)}
                style={{
                  cursor: 'pointer',
                  height: 40,
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 500,
                  border: `1.5px solid ${selected ? C.pink : C.border2}`,
                  background: selected ? 'rgba(189,37,135,0.08)' : C.white,
                  color: selected ? C.pink : C.text,
                }}
              >
                {g.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={sectionCardStyle}>
        <SectionHead title="Garment type" stepNumber={2} />
        {garmentTypes.length === 0 ? (
          <span style={{ fontSize: 12, color: C.mid }}>Loading garment types…</span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {garmentTypes.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => handleGarmentTypeSelect(g.id)}
                style={{
                  cursor: 'pointer',
                  padding: '8px 14px',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 500,
                  border: `1.5px solid ${g.id === garmentTypeId ? C.pink : C.border2}`,
                  background: g.id === garmentTypeId ? 'rgba(189,37,135,0.08)' : C.white,
                  color: g.id === garmentTypeId ? C.pink : C.text,
                }}
              >
                {g.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={sectionCardStyle}>
        <SectionHead
          title={hasMultipleUploadBoxes ? 'Upload garment photos' : 'Upload the garment photo'}
          stepNumber={3}
        />
        <div style={{ display: 'flex', gap: 10 }}>
          <label
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              height: 160,
              border: `1.5px dashed ${C.border2}`,
              borderRadius: 12,
              cursor: 'pointer',
              overflow: 'hidden',
              position: 'relative',
              background: C.lighter,
              boxSizing: 'border-box',
            }}
          >
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleGarmentUpload(file);
              }}
            />
            {garmentPreviewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              // biome-ignore lint/performance/noImgElement: uncontrolled preview
              <img
                src={garmentPreviewUrl}
                alt="Garment"
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              <>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: C.text,
                    textAlign: 'center',
                    padding: '0 8px',
                  }}
                >
                  {hasMultipleUploadBoxes
                    ? (selectedGarmentType?.upperUploadLabel ?? 'Upload Top Wear')
                    : 'Click to choose a garment photo'}
                </span>
                <span style={{ fontSize: 11, color: C.mid }}>JPG, PNG, WebP · Max 10MB</span>
              </>
            )}
            {isUploading && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(255,255,255,0.75)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  color: C.pink,
                }}
              >
                <SpinnerIcon size={16} /> Uploading… {uploadProgress}%
              </div>
            )}
          </label>

          {requiresLowerUpload && (
            <label
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                height: 160,
                border: `1.5px dashed ${C.border2}`,
                borderRadius: 12,
                cursor: 'pointer',
                overflow: 'hidden',
                position: 'relative',
                background: C.lighter,
                boxSizing: 'border-box',
              }}
            >
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleLowerGarmentUpload(file);
                }}
              />
              {lowerGarmentPreviewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                // biome-ignore lint/performance/noImgElement: uncontrolled preview
                <img
                  src={lowerGarmentPreviewUrl}
                  alt="Lower garment"
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              ) : (
                <>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: C.text,
                      textAlign: 'center',
                      padding: '0 8px',
                    }}
                  >
                    {selectedGarmentType?.lowerUploadLabel ?? 'Bottom Wear'}
                  </span>
                  <span style={{ fontSize: 11, color: C.mid }}>JPG, PNG, WebP · Max 10MB</span>
                </>
              )}
              {isUploadingLower && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'rgba(255,255,255,0.75)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    fontSize: 12,
                    fontWeight: 600,
                    color: C.pink,
                  }}
                >
                  <SpinnerIcon size={16} /> Uploading…
                </div>
              )}
            </label>
          )}

          {requiresThirdUpload && (
            <label
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                height: 160,
                border: `1.5px dashed ${C.border2}`,
                borderRadius: 12,
                cursor: 'pointer',
                overflow: 'hidden',
                position: 'relative',
                background: C.lighter,
                boxSizing: 'border-box',
              }}
            >
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleThirdGarmentUpload(file);
                }}
              />
              {thirdGarmentPreviewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                // biome-ignore lint/performance/noImgElement: uncontrolled preview
                <img
                  src={thirdGarmentPreviewUrl}
                  alt="Third garment"
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              ) : (
                <>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: C.text,
                      textAlign: 'center',
                      padding: '0 8px',
                    }}
                  >
                    {selectedGarmentType?.thirdUploadLabel ?? 'Upload Third Garment'}
                  </span>
                  <span style={{ fontSize: 11, color: C.mid }}>JPG, PNG, WebP · Max 10MB</span>
                </>
              )}
              {isUploadingThird && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'rgba(255,255,255,0.75)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    fontSize: 12,
                    fontWeight: 600,
                    color: C.pink,
                  }}
                >
                  <SpinnerIcon size={16} /> Uploading…
                </div>
              )}
            </label>
          )}
        </div>
        {uploadError && (
          <span style={{ fontSize: 12, color: C.pink, marginTop: 8 }}>{uploadError}</span>
        )}
      </div>

      {activeGeneration ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button
            type="button"
            onClick={handleStartOver}
            style={{
              alignSelf: 'flex-start',
              background: 'none',
              border: 'none',
              color: C.pink,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            ← Start a new photo
          </button>
          <GenerationPanel
            catalogueId={activeGeneration.catalogueId}
            jobs={activeGeneration.jobs}
            garmentPreviewUrl={garmentPreviewUrl}
            onUseImage={handleUseImage}
            hideCatalogueLink
            hideDownload
            hideProcessingPreview
          />
        </div>
      ) : (
        <>
          <div style={sectionCardStyle}>
            <SectionHead
              title="Model face"
              stepNumber={4}
              right={
                faces.length > 4 && (
                  <button
                    type="button"
                    onClick={() => setFaceModalOpen(true)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: C.pink,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    View all
                  </button>
                )
              }
            />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {faces.slice(0, 4).map((f) => (
                <SelCard
                  key={f.id}
                  selected={faceId === f.id}
                  onClick={() => setFaceId(f.id)}
                  imageUrl={f.thumbnailUrl}
                  w={100}
                  h={130}
                />
              ))}
            </div>
          </div>

          <div style={sectionCardStyle}>
            <SectionHead
              title="Background"
              stepNumber={5}
              right={
                backgrounds.length > 4 && (
                  <button
                    type="button"
                    onClick={() => setBackgroundModalOpen(true)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: C.pink,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    View all
                  </button>
                )
              }
            />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {backgrounds.slice(0, 4).map((b) => (
                <SelCard
                  key={b.id}
                  selected={backgroundId === b.id}
                  onClick={() => setBackgroundId(b.id)}
                  imageUrl={b.thumbnailUrl}
                  w={100}
                  h={130}
                />
              ))}
            </div>
          </div>

          <div style={sectionCardStyle}>
            <SectionHead
              title="Pose(s)"
              subtitle="Select one or more — each becomes its own generated photo"
              stepNumber={6}
              right={
                poses.length > 4 && (
                  <button
                    type="button"
                    onClick={() => setPoseModalOpen(true)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: C.pink,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    View all
                  </button>
                )
              }
            />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {poses.slice(0, 4).map((p) => (
                <SelCard
                  key={p.id}
                  selected={poseIds.includes(p.id)}
                  onClick={() => togglePose(p.id)}
                  imageUrl={p.thumbnailUrl}
                  w={100}
                  h={130}
                />
              ))}
            </div>
          </div>

          {needsLower && !requiresLowerUpload && (
            <div style={sectionCardStyle}>
              <SectionHead
                title="Lower Garment"
                stepNumber={stepNumberOf('lower')}
                right={
                  lowerItems.length > 4 && (
                    <button
                      type="button"
                      onClick={() => setLowerModalOpen(true)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: C.pink,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      View all
                    </button>
                  )
                }
              />
              {!lowerCatalogData ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0' }}>
                  <SpinnerIcon />
                </div>
              ) : lowerItems.length === 0 ? (
                <span style={{ fontSize: 12, color: C.mid }}>
                  No lower garment options available yet.
                </span>
              ) : (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {lowerPreviewItems.map((i) => (
                    <SelCard
                      key={i.id}
                      selected={lowerCatalogId === i.id}
                      onClick={() => setLowerCatalogId(lowerCatalogId === i.id ? '' : i.id)}
                      imageUrl={i.thumbnailUrl}
                      w={100}
                      h={130}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {needsShoes && (
            <div style={sectionCardStyle}>
              <SectionHead
                title="Footwear"
                stepNumber={stepNumberOf('shoes')}
                right={
                  shoeItems.length > 4 && (
                    <button
                      type="button"
                      onClick={() => setShoeModalOpen(true)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: C.pink,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      View all
                    </button>
                  )
                }
              />
              {!shoeCatalogData ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0' }}>
                  <SpinnerIcon />
                </div>
              ) : shoeItems.length === 0 ? (
                <span style={{ fontSize: 12, color: C.mid }}>
                  No footwear options available yet.
                </span>
              ) : (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {shoePreviewItems.map((i) => (
                    <SelCard
                      key={i.id}
                      selected={shoeCatalogId === i.id}
                      onClick={() => setShoeCatalogId(shoeCatalogId === i.id ? '' : i.id)}
                      imageUrl={i.thumbnailUrl}
                      w={100}
                      h={130}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          <div
            style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}
          >
            <Tooltip tip={generateBlocker || undefined}>
              <button
                type="button"
                disabled={!canGenerate}
                onClick={handleGenerate}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  height: 44,
                  padding: '0 24px',
                  borderRadius: 10,
                  border: 'none',
                  fontSize: 14,
                  fontWeight: 700,
                  color: '#fff',
                  background: canGenerate ? grad : C.border2,
                  cursor: canGenerate ? 'pointer' : 'not-allowed',
                }}
              >
                {isSubmitting ? <SpinnerIcon size={16} /> : null}
                Generate product image{poseIds.length > 1 ? 's' : ''}
              </button>
            </Tooltip>
            {submitError && <span style={{ fontSize: 12, color: C.pink }}>{submitError}</span>}
          </div>
        </>
      )}

      {faceModalOpen && (
        <SelectGridModal
          title="Choose a model face"
          items={faces}
          selectedIds={faceId ? [faceId] : []}
          hideLabels
          onSelect={(id) => {
            setFaceId(id);
            setFaceModalOpen(false);
          }}
          onClose={() => setFaceModalOpen(false)}
        />
      )}
      {backgroundModalOpen && (
        <SelectGridModal
          title="Choose a background"
          items={backgrounds}
          selectedIds={backgroundId ? [backgroundId] : []}
          hideLabels
          onSelect={(id) => {
            setBackgroundId(id);
            setBackgroundModalOpen(false);
          }}
          onClose={() => setBackgroundModalOpen(false)}
        />
      )}
      {poseModalOpen && (
        <SelectGridModal
          title="Choose pose(s)"
          items={poses}
          selectedIds={poseIds}
          multiSelect
          hideLabels
          continueLabel="Use {count} pose(s)"
          onSelect={togglePose}
          onClose={() => setPoseModalOpen(false)}
        />
      )}
      {lowerModalOpen && (
        <SelectGridModal
          title="Choose a lower garment"
          items={lowerItems}
          selectedIds={lowerCatalogId ? [lowerCatalogId] : []}
          hideLabels
          onSelect={(id) => {
            setLowerCatalogId(lowerCatalogId === id ? '' : id);
            setLowerModalOpen(false);
          }}
          onClose={() => setLowerModalOpen(false)}
        />
      )}
      {shoeModalOpen && (
        <SelectGridModal
          title="Choose footwear"
          items={shoeItems}
          selectedIds={shoeCatalogId ? [shoeCatalogId] : []}
          hideLabels
          onSelect={(id) => {
            setShoeCatalogId(shoeCatalogId === id ? '' : id);
            setShoeModalOpen(false);
          }}
          onClose={() => setShoeModalOpen(false)}
        />
      )}
    </div>
  );
}
