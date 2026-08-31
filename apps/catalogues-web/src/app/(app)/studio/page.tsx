'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, ImagePlusIcon, SparkleIcon, SpinnerIcon, XIcon } from '@/components/icons';
import { C, grad } from '@/components/tokens';
import { TopBar } from '@/components/topbar';
import { ErrorState } from '@/components/ui/error-state';
import { GradBtn } from '@/components/ui/grad-btn';
import { Tooltip } from '@/components/ui/tooltip';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { api } from '@/lib/api';
import { BREAKPOINTS } from '@/lib/breakpoints';
import { ApiError } from '@/lib/errors';
import { isSupportedImageBytes } from '@/lib/image-validation';
import { BatchMode } from './batch/batch-mode';
import { type GenerationJob, GenerationPanel } from './generation-panel';
import { PreviewPanel } from './preview-panel';
import { SelectGridModal } from './select-modal';
import { GenderCard, SectionHead, SelCard, sectionCardStyle } from './shared-cards';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

interface GarmentType {
  id: string;
  slug: string;
  label: string;
  thumbnailUrl?: string | null;
  instructionImageUrl?: string | null;
  requiresLowerUpload: boolean;
  upperUploadLabel?: string | null;
  lowerUploadLabel?: string | null;
  defaultLowerCatalogId?: string | null;
  defaultShoeCatalogId?: string | null;
  requiresMannequinStep?: boolean;
  requiresThirdUpload?: boolean;
  thirdUploadLabel?: string | null;
  mannequinTwoInputWorkflowTemplateId?: string | null;
}
interface FaceItem {
  id: string;
  label: string;
  thumbnailUrl: string;
  gender: string;
  continent?: string | null;
  tags: string[];
}
const CONTINENT_LABELS: Record<string, string> = {
  asia: 'Asia',
  africa: 'Africa',
  europe: 'Europe',
  north_america: 'North America',
  south_america: 'South America',
  oceania: 'Oceania',
};
const CONTINENT_ORDER = ['asia', 'africa', 'europe', 'north_america', 'south_america', 'oceania'];
// Continents are admin-defined slugs (see ContinentSlug in @tryme/types), not a
// fixed set -- fall back to a title-cased label for any slug an admin added that
// isn't in CONTINENT_LABELS above.
function continentLabel(slug: string): string {
  return (
    CONTINENT_LABELS[slug] ??
    slug
      .split('_')
      .filter(Boolean)
      .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
      .join(' ')
  );
}
interface BackgroundItem {
  id: string;
  label: string;
  thumbnailUrl: string;
  previewUrl: string;
  isWhiteBg?: boolean;
  categoryId?: number | null;
  tags?: string[];
  specialTag?: 'featured' | 'trending' | 'popular' | null;
}
interface BackgroundsResponse {
  items: BackgroundItem[];
}
interface BackgroundCategoriesResponse {
  items: {
    id: number;
    slug: string;
    label: string;
    thumbnailUrl: string | null;
  }[];
}
interface PoseItem {
  id: string;
  label: string;
  thumbnailUrl: string;
  hasLower: boolean;
  hasShoes: boolean;
}
interface TemplateLook {
  id: string;
  poseId: string;
  poseLabel: string;
  poseThumbnailUrl: string;
  backgroundId: string;
  backgroundLabel: string;
  backgroundThumbnailUrl: string;
  hasLower: boolean;
  hasShoes: boolean;
}
interface CatalogueTemplateItem {
  id: string;
  mappingId: string;
  label: string;
  thumbnailUrl: string | null;
  looks: TemplateLook[];
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

const TAG_LABELS: Record<string, string> = {
  featured: 'Featured',
  trending: 'Trending',
  popular: 'Popular',
};

function TagBadge({ tag }: { tag?: string | null }) {
  if (!tag || !TAG_LABELS[tag]) return null;
  return (
    <span
      style={{
        position: 'absolute',
        top: 6,
        left: 6,
        fontSize: 10,
        fontWeight: 700,
        color: C.white,
        padding: '2px 7px',
        borderRadius: 999,
        background: grad,
        lineHeight: 1.4,
        zIndex: 1,
      }}
    >
      {TAG_LABELS[tag]}
    </span>
  );
}

function _findNodeForItem(tree: CatalogNode[], itemId: string): CatalogNode | null {
  for (const node of tree) {
    if (flattenNode(node).some((i) => i.id === itemId)) return node;
  }
  return null;
}

const GENDERS = [
  { value: 'women', label: 'Women', img: `${BASE}/assets/seg-women.png` },
  { value: 'men', label: 'Men', img: `${BASE}/assets/seg-men.png` },
  { value: 'boys', label: 'Boys', img: `${BASE}/assets/seg-boy.png` },
  { value: 'girls', label: 'Girls', img: `${BASE}/assets/seg-girl.png` },
];
interface BrandConfig {
  ratios: string[];
  default: string;
}
const BRAND_CONFIG: Record<string, BrandConfig> = {
  Amazon: { ratios: ['1:1', '2:3', '3:4'], default: '1:1' },
  Flipkart: { ratios: ['1:1', '2:3', '3:4'], default: '1:1' },
  Myntra: { ratios: ['2:3', '3:4'], default: '3:4' },
  AJIO: { ratios: ['1:1', '2:3', '3:4'], default: '3:4' },
  Meesho: { ratios: ['1:1', '2:3'], default: '1:1' },
  'Nykaa Fashion': { ratios: ['2:3', '3:4'], default: '3:4' },
  Shopify: { ratios: ['1:1', '2:3', '4:5'], default: '1:1' },
};
const PLATFORMS = Object.keys(BRAND_CONFIG);
const PLATFORM_LOGOS: Record<string, { src: string; h: number }> = {
  Amazon: { src: `${BASE}/assets/platform-logos/amazon-logo.svg`, h: 18 },
  Flipkart: { src: `${BASE}/assets/platform-logos/flipkart-logo-current.png`, h: 18 },
  Myntra: { src: `${BASE}/assets/myntra-logo-official.png`, h: 26 },
  AJIO: {
    src: `data:image/svg+xml;utf8,%3C%3Fxml%20version%3D%221.0%22%20encoding%3D%22utf-8%22%3F%3E%0A%3C!--%20Generator%3A%20Adobe%20Illustrator%2021.1.0%2C%20SVG%20Export%20Plug-In%20.%20SVG%20Version%3A%206.00%20Build%200)%20%20--%3E%0A%3Csvg%20version%3D%221.1%22%20id%3D%22Layer_1%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20x%3D%220px%22%20y%3D%220px%22%0A%09%20viewBox%3D%220%200%20462.4%20134.1%22%20style%3D%22enable-background%3Anew%200%200%20462.4%20134.1%3B%22%20xml%3Aspace%3D%22preserve%22%3E%0A%3Cstyle%20type%3D%22text%2Fcss%22%3E%0A%09.st0%7Bfill%3A%232F4254%3B%7D%0A%3C%2Fstyle%3E%0A%3Cpath%20class%3D%22st0%22%20d%3D%22M160.8%2C105.1c4.4%2C4.4%2C9.6%2C6.6%2C15.6%2C6.6c6.2%2C0%2C11.4-2.1%2C15.7-6.4c4.4-4.4%2C6.6-9.6%2C6.6-15.9V0h22.6v89.5%0A%09c0%2C12.3-4.4%2C22.8-13.1%2C31.7c-9%2C8.6-19.6%2C13-31.7%2C13c-12.4%2C0-22.9-4.3-31.7-13L160.8%2C105.1L160.8%2C105.1z%22%2F%3E%0A%3Cpolygon%20class%3D%22st0%22%20points%3D%22267.3%2C0%20289.5%2C0%20289.5%2C134.1%20267.3%2C134.1%20267.3%2C0%20%22%2F%3E%0A%3Cpath%20class%3D%22st0%22%20d%3D%22M426.7%2C98.8c-8.8%2C8.6-19.3%2C12.9-31.5%2C12.9c-12.2%2C0-22.8-4.3-31.7-12.9c-8.6-8.9-12.9-19.5-12.9-31.7%0A%09c0-12.2%2C4.3-22.7%2C12.9-31.5c8.9-8.8%2C19.5-13.1%2C31.7-13.1c12.2%2C0%2C22.7%2C4.4%2C31.5%2C13.1c8.7%2C8.8%2C13.1%2C19.3%2C13.1%2C31.5%0A%09C439.8%2C79.3%2C435.4%2C89.9%2C426.7%2C98.8L426.7%2C98.8z%20M442.5%2C19.7C429.5%2C6.6%2C413.7%2C0%2C395.2%2C0c-18.7%2C0-34.5%2C6.6-47.3%2C19.7%0A%09c-13.1%2C13.2-19.7%2C28.9-19.7%2C47.4c0%2C18.5%2C6.6%2C34.3%2C19.7%2C47.3c13%2C13.2%2C28.8%2C19.7%2C47.3%2C19.7c18.5%2C0%2C34.3-6.6%2C47.3-19.7%0A%09c13.3-12.9%2C19.9-28.7%2C19.9-47.3C462.4%2C48.6%2C455.8%2C32.9%2C442.5%2C19.7L442.5%2C19.7z%22%2F%3E%0A%3Cpath%20class%3D%22st0%22%20d%3D%22M47.4%2C89.4h39.4L67.1%2C50L47.4%2C89.4L47.4%2C89.4z%20M98%2C111.7H36.3l-11.4%2C22.4H0L67.1-0.1l67.1%2C134.2h-24.9L98%2C111.7%0A%09L98%2C111.7z%22%2F%3E%0A%3C%2Fsvg%3E%0A`,
    h: 13,
  },
  Meesho: { src: `${BASE}/assets/platform-logos/meesho-wordmark.svg`, h: 16 },
  'Nykaa Fashion': { src: `${BASE}/assets/platform-logos/nykaa-logo.svg`, h: 16 },
  Shopify: { src: `${BASE}/assets/platform-logos/shopify-logo.svg`, h: 20 },
};
const ALL_ASPECTS = ['1:1', '2:3', '3:4', '4:5', '9:16', '16:9'];
const ASPECT_DIMS: Record<string, string> = {
  '1:1': '2048 × 2048 px',
  '2:3': '1365 × 2048 px',
  '3:4': '1331 × 1774 px',
  '4:5': '1375 × 1718 px',
  '9:16': '1152 × 2048 px',
  '16:9': '2048 × 1152 px',
};
const ASPECT_PX: Record<string, { w: number; h: number }> = {
  '1:1': { w: 2048, h: 2048 },
  '2:3': { w: 1365, h: 2048 },
  '3:4': { w: 1331, h: 1774 },
  '4:5': { w: 1375, h: 1718 },
};
function resolutionFromOutputDims(w: number, h: number): 'HD' | '2K' | '4K' {
  const longer = Math.max(w, h);
  if (longer <= 1440) return 'HD';
  if (longer <= 2048) return '2K';
  return '4K';
}

/**
 * Tracks .studio-5col-grid's actual column count (see its @media rules below in
 * this file's <style> block: 5 cols above 768px, 4 at <=768px, 3 at <=480px).
 * Batch's garment-type grid uses this to cap visible rows to exactly 2 —
 * unlike single mode's hand-tuned categoryVisibleCount (calibrated for its
 * narrower, two-column layout), batch is full-width so the true column count
 * is what determines how many items fit in a row.
 */
function useGridColumns(): number {
  const [columns, setColumns] = useState(5);
  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      setColumns(w <= 480 ? 3 : w <= 768 ? 4 : 5);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return columns;
}
const OUTFIT_IMG: Record<string, string> = {
  kurta: `${BASE}/assets/outfit-kurta.png`,
  saree: `${BASE}/assets/outfit-saree.png`,
  top: `${BASE}/assets/outfit-top.png`,
};

// ── Visual card (gender / outfit) ──
function VisualCard({
  selected,
  onClick,
  img,
  label,
  imgStyle,
  width = 108.8,
  ratio = 108.8 / 109,
}: {
  selected: boolean;
  onClick: () => void;
  img: string | null;
  label: string;
  imgStyle?: React.CSSProperties;
  width?: number | string;
  ratio?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="visual-card-wrapper"
      style={{
        cursor: 'pointer',
        textAlign: 'center',
        flexShrink: 0,
        width: typeof width === 'string' ? '100%' : width,
        background: selected
          ? `linear-gradient(${C.card}, ${C.card}) padding-box, linear-gradient(135deg, #BD2587 0%, #ff5b94 100%) border-box`
          : `linear-gradient(${C.card}, ${C.card}) padding-box, linear-gradient(${C.border}, ${C.border}) border-box`,
        border: '1.5px solid transparent',
        borderRadius: 12,
        padding: 0,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        transition: 'box-shadow 0.2s, transform 0.2s',
        boxShadow: selected ? '0px 2px 10px rgba(189, 37, 135, 0.1)' : 'none',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: 10,
          background: C.card,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          overflow: 'hidden',
        }}
      >
        <div
          className="visual-card-image"
          style={{
            width: '100%',
            aspectRatio: ratio,
            borderRadius: '10px 10px 0 0',
            overflow: 'hidden',
            position: 'relative',
            background: C.lighter,
            boxSizing: 'border-box',
          }}
        >
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            // biome-ignore lint/performance/noImgElement: small UI thumbnail, Next Image not needed
            <img
              src={img}
              alt={label}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'top center',
                ...imgStyle,
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
              {label}
            </div>
          )}
          {selected && (
            <div
              style={{
                position: 'absolute',
                top: 6,
                right: 6,
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #BD2587 0%, #ff5b94 100%)', // Gradient matching steps!
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 2,
              }}
            >
              <CheckIcon color="#fff" size={11} />
            </div>
          )}
        </div>
        {label && (
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: C.text,
              padding: '8px 4px 6px',
              width: '100%',
              textAlign: 'center',
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
            }}
          >
            {label}
          </div>
        )}
      </div>
    </button>
  );
}

// ── Garment upload tips — hover popover ──

const pill = (active: boolean): React.CSSProperties => ({
  padding: '7px 14px',
  borderRadius: 8,
  border: `1px solid ${active ? C.pink : C.border2}`,
  background: active ? 'rgba(245,92,122,0.08)' : C.white,
  color: active ? C.pink : C.text,
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
});

function AspectRatioIcon({ ratio, active }: { ratio: string; active?: boolean }) {
  if (ratio === 'custom') {
    return (
      <span style={{ fontSize: 16, lineHeight: 1, fontWeight: 300, display: 'inline-flex' }}>
        +
      </span>
    );
  }
  let w = 12;
  let h = 12;
  if (ratio === '2:3' || ratio === '3:4' || ratio === '4:5' || ratio === '9:16') {
    w = 9;
    h = 13;
  } else if (ratio === '16:9') {
    w = 14;
    h = 9;
  }
  return (
    <div
      style={{
        width: w,
        height: h,
        border: `1.5px solid ${active ? C.pink : C.mid}`,
        borderRadius: 2,
        opacity: active ? 1 : 0.6,
      }}
    />
  );
}
export default function StudioPage(): React.ReactElement {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  // Switching the mode ternary unmounts <BatchMode> outright, discarding its
  // garments/rows with no undo. Tracked here so the toggle can confirm before
  // leaving Batch while there's unsaved work.
  const [batchDirty, setBatchDirty] = useState(false);
  const [gender, setGender] = useState('women');
  const [garmentTypeId, setGarmentTypeId] = useState('');
  const [garmentModalOpen, setGarmentModalOpen] = useState(false);
  const [batchGarmentModalOpen, setBatchGarmentModalOpen] = useState(false);
  const [platform, setPlatform] = useState('Amazon');
  const [aspect, setAspect] = useState(BRAND_CONFIG.Amazon?.default ?? '1:1');
  const [customRatio, setCustomRatio] = useState('');
  const [customWStr, setCustomWStr] = useState('');
  const [customHStr, setCustomHStr] = useState('');
  const [amazonPoseModalOpen, setAmazonPoseModalOpen] = useState(false);
  const [amazonMainPoseId, setAmazonMainPoseId] = useState('');
  // Bypassed: Amazon no longer forces white bg. Logic kept dormant for future use.
  const [amazonUseWhiteBg, _setAmazonUseWhiteBg] = useState(false);

  const brandAspects = BRAND_CONFIG[platform]?.ratios ?? ALL_ASPECTS;
  const effectiveAspect = aspect === 'custom' && customRatio ? customRatio : aspect;

  // Prefill platform/aspect from the user's saved Account Preferences (Settings page),
  // once, so switching platforms later doesn't keep re-applying the saved default.
  const appliedUserDefaults = useRef(false);
  const { data: meDefaults } = useQuery<{ defaultPlatform: string; defaultAspectRatio: string }>({
    queryKey: ['me'],
    queryFn: () => api.get('/v1/me'),
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: apply saved defaults exactly once when they arrive, not on every platform/aspect change
  useEffect(() => {
    if (appliedUserDefaults.current || !meDefaults) return;
    appliedUserDefaults.current = true;
    const nextPlatform = BRAND_CONFIG[meDefaults.defaultPlatform]
      ? meDefaults.defaultPlatform
      : platform;
    const ratios = BRAND_CONFIG[nextPlatform]?.ratios ?? ALL_ASPECTS;
    const nextAspect = ratios.includes(meDefaults.defaultAspectRatio)
      ? meDefaults.defaultAspectRatio
      : (BRAND_CONFIG[nextPlatform]?.default ?? aspect);
    setPlatform(nextPlatform);
    setAspect(nextAspect);
  }, [meDefaults]);

  const { data: resolutionConfigData } = useQuery<{
    resolutions: Record<string, { enabled: boolean; creditCost: number }>;
    maxOutputPx: number;
  }>({
    queryKey: ['resolution-configs'],
    queryFn: () => api.get('/v1/config/resolutions'),
    staleTime: 10 * 60 * 1000,
  });
  const resolutionConfig = resolutionConfigData?.resolutions ?? {
    HD: { enabled: true, creditCost: 25 },
    '2K': { enabled: true, creditCost: 35 },
    '4K': { enabled: true, creditCost: 40 },
  };
  // Admin-configured platform ceiling (Settings → Max Output Resolution) — falls back
  // to 2048 only until the query resolves, never as a silent permanent cap.
  const maxOutputPx = resolutionConfigData?.maxOutputPx ?? 2048;

  // Custom dimension validation — computed at component level so handleSubmit and
  // canGenerate can both reference them without re-deriving inside the render IIFE.
  const customWNum = Number(customWStr);
  const customHNum = Number(customHStr);
  const customWErr =
    customWStr !== '' && (Number.isNaN(customWNum) || customWNum < 768 || customWNum > maxOutputPx);
  const customHErr =
    customHStr !== '' && (Number.isNaN(customHNum) || customHNum < 768 || customHNum > maxOutputPx);
  const customDimsReady =
    aspect !== 'custom' ||
    (!!customRatio && !!customWStr && !!customHStr && !customWErr && !customHErr);
  const customParams =
    aspect === 'custom' && customDimsReady
      ? { outputWidth: customWNum, outputHeight: customHNum }
      : {};

  const outputDims: { w: number; h: number } | null = (() => {
    if (aspect === 'custom') {
      return customDimsReady && customWNum > 0 && customHNum > 0
        ? { w: customWNum, h: customHNum }
        : null;
    }
    const d = ASPECT_PX[effectiveAspect];
    return d ?? null;
  })();
  const resolution: 'HD' | '2K' | '4K' | null = outputDims
    ? resolutionFromOutputDims(outputDims.w, outputDims.h)
    : null;

  const handlePlatformChange = (p: string) => {
    setPlatform(p);
    const cfg = BRAND_CONFIG[p];
    if (cfg) setAspect(cfg.default);
  };
  const [garmentFile, setGarmentFile] = useState<File | null>(null);
  const garmentPreviewUrl = useMemo(
    () => (garmentFile ? URL.createObjectURL(garmentFile) : ''),
    [garmentFile],
  );
  useEffect(() => {
    return () => {
      if (garmentPreviewUrl) URL.revokeObjectURL(garmentPreviewUrl);
    };
  }, [garmentPreviewUrl]);
  const [garmentKey, setGarmentKey] = useState('');
  const [lowerGarmentFile, setLowerGarmentFile] = useState<File | null>(null);
  const lowerGarmentPreviewUrl = useMemo(
    () => (lowerGarmentFile ? URL.createObjectURL(lowerGarmentFile) : ''),
    [lowerGarmentFile],
  );
  useEffect(() => {
    return () => {
      if (lowerGarmentPreviewUrl) URL.revokeObjectURL(lowerGarmentPreviewUrl);
    };
  }, [lowerGarmentPreviewUrl]);
  const [lowerGarmentKey, setLowerGarmentKey] = useState('');
  const [isUploadingLower, setIsUploadingLower] = useState(false);
  const [thirdGarmentFile, setThirdGarmentFile] = useState<File | null>(null);
  const thirdGarmentPreviewUrl = useMemo(
    () => (thirdGarmentFile ? URL.createObjectURL(thirdGarmentFile) : ''),
    [thirdGarmentFile],
  );
  useEffect(() => {
    return () => {
      if (thirdGarmentPreviewUrl) URL.revokeObjectURL(thirdGarmentPreviewUrl);
    };
  }, [thirdGarmentPreviewUrl]);
  const [thirdGarmentKey, setThirdGarmentKey] = useState('');
  const [isUploadingThird, setIsUploadingThird] = useState(false);
  const [palluGarmentFile, setPalluGarmentFile] = useState<File | null>(null);
  const palluGarmentPreviewUrl = useMemo(
    () => (palluGarmentFile ? URL.createObjectURL(palluGarmentFile) : ''),
    [palluGarmentFile],
  );
  useEffect(() => {
    return () => {
      if (palluGarmentPreviewUrl) URL.revokeObjectURL(palluGarmentPreviewUrl);
    };
  }, [palluGarmentPreviewUrl]);
  const [palluGarmentKey, setPalluGarmentKey] = useState('');
  const [isUploadingPallu, setIsUploadingPallu] = useState(false);
  // 'single' (Full Saree) is retained as a value only for garment types that never
  // reach two-input capability; saree defaults straight to Body & Pallu and the
  // Full Saree option is no longer user-selectable (see the removed dropdown below).
  const [sareeUploadMode, setSareeUploadMode] = useState<'single' | 'two_input'>('two_input');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lowerFileInputRef = useRef<HTMLInputElement>(null);
  const thirdFileInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const lowerUploadAbortRef = useRef<AbortController | null>(null);
  const thirdUploadAbortRef = useRef<AbortController | null>(null);
  const palluFileInputRef = useRef<HTMLInputElement>(null);
  const palluUploadAbortRef = useRef<AbortController | null>(null);

  // Abort any in-flight XHR uploads when the component unmounts (user navigates away)
  useEffect(() => {
    return () => {
      uploadAbortRef.current?.abort();
      lowerUploadAbortRef.current?.abort();
      thirdUploadAbortRef.current?.abort();
      palluUploadAbortRef.current?.abort();
    };
  }, []);

  const [isMobileParam, setIsMobileParam] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('view') === 'mobile') {
        setIsMobileParam(true);
      }
    }
  }, []);

  const rawBreakpoint = useBreakpoint();
  const breakpoint = isMobileParam ? 'mobile' : rawBreakpoint;
  const _isMobile = breakpoint === 'mobile';
  const isTablet = breakpoint === 'tablet';
  const isSmallLaptop = breakpoint === 'small-laptop';
  const isDesktopView = breakpoint === 'laptop' || breakpoint === 'desktop' || breakpoint === null;

  // Exact 2-row visible count per tier below laptop (≥1280px):
  // Desktop / Laptop (≥1280px): 5 items (1 row of 5 columns)
  // Small Laptop (1024–1279px): 10 items (2 rows of 5 columns)
  // Tablet (640–1023px): 8 items (2 rows of 4 columns)
  // Mobile (<640px): 6 items (2 rows of 3 columns)
  const categoryVisibleCount = isDesktopView ? 5 : isSmallLaptop ? 10 : isTablet ? 8 : 6;

  const garmentVisibleCount = categoryVisibleCount;
  // Batch is full-width (no two-column split), so unlike single mode's
  // categoryVisibleCount (1 row at the desktop tier), its garment-type grid
  // shows exactly 2 rows at every tier — see useGridColumns.
  const batchGarmentGridColumns = useGridColumns();
  const batchGarmentVisibleCount = batchGarmentGridColumns * 2;
  const modelVisibleCount = categoryVisibleCount;
  const backgroundVisibleCount = categoryVisibleCount;
  const templateVisibleCount = categoryVisibleCount;
  const poseVisibleCount = categoryVisibleCount;
  const lowerVisibleCount = categoryVisibleCount;
  const shoeVisibleCount = categoryVisibleCount;
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [backgroundModalOpen, setBackgroundModalOpen] = useState(false);
  const [backgroundItemFilter, setBackgroundItemFilter] = useState<number | ''>('');
  const [backgroundTagFilter, setBackgroundTagFilter] = useState<string>('');
  const [modelTagFilter, setModelTagFilter] = useState<string>('');
  const [modelContinentFilter, setModelContinentFilter] = useState<string>('');
  const [catalogueTemplateId, setCatalogueTemplateId] = useState('custom');
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [poseModalOpen, setPoseModalOpen] = useState(false);

  const [faceId, setFaceId] = useState('');
  const [backgroundId, setBackgroundId] = useState('');
  const [poseIds, setPoseIds] = useState<string[]>([]);
  const [selectedLookIds, setSelectedLookIds] = useState<string[]>([]);
  const [lowerCatalogId, setLowerCatalogId] = useState('');
  const [shoeCatalogId, setShoeCatalogId] = useState('');
  const [lowerItemsOpen, setLowerItemsOpen] = useState(false);
  const [shoeItemsOpen, setShoeItemsOpen] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const [submitError, setSubmitError] = useState('');

  const [activeGeneration, setActiveGeneration] = useState<{
    catalogueId: string;
    jobs: GenerationJob[];
  } | null>(null);
  // True from the moment a batch is enqueued until every job in it settles —
  // keeps Generate disabled while the right panel is still rendering progress.
  const [generationInProgress, setGenerationInProgress] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((m: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(m);
    toastTimerRef.current = setTimeout(() => setToast(''), 5000);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('drive_connected') === '1') {
      qc.invalidateQueries({ queryKey: ['google-drive-status'] });
      showToast('Google Drive connected successfully!');
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete('drive_connected');
      window.history.replaceState(
        {},
        '',
        nextUrl.pathname + (nextUrl.search ? `?${nextUrl.searchParams.toString()}` : ''),
      );
    } else if (params.get('drive_error')) {
      const err = params.get('drive_error');
      showToast(`Google Drive connection failed: ${err}`);
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete('drive_error');
      window.history.replaceState(
        {},
        '',
        nextUrl.pathname + (nextUrl.search ? `?${nextUrl.searchParams.toString()}` : ''),
      );
    }
  }, [qc, showToast]);

  const { data: creditsData } = useQuery<{ balance: number }>({
    queryKey: ['credits'],
    queryFn: () => api.get('/v1/credits'),
  });
  const userCredits = creditsData?.balance ?? 0;

  const { data: garmentTypes } = useQuery<{ items: GarmentType[] }>({
    queryKey: ['garmentTypes', gender],
    queryFn: () => api.get(`/v1/models/garment-types?gender=${gender}`),
    enabled: !!gender,
  });
  const selectedGarmentType = garmentTypes?.items.find((g) => g.id === garmentTypeId);
  const didAutoGarment = useRef('');
  useEffect(() => {
    if (garmentTypes?.items?.length && !garmentTypeId && didAutoGarment.current !== gender) {
      setGarmentTypeId(garmentTypes.items[0]?.id ?? '');
      didAutoGarment.current = gender;
    }
  }, [garmentTypes, garmentTypeId, gender]);
  const defaultsAppliedForGarmentType = useRef('');
  useEffect(() => {
    if (!garmentTypeId || defaultsAppliedForGarmentType.current === garmentTypeId) return;

    const garmentType = garmentTypes?.items.find((item) => item.id === garmentTypeId);
    if (!garmentType) return;

    // Mirror the garment type configuration in the visible pickers. Users can
    // still replace or clear either selection before generating.
    setLowerCatalogId(garmentType.defaultLowerCatalogId ?? '');
    setShoeCatalogId(garmentType.defaultShoeCatalogId ?? '');
    defaultsAppliedForGarmentType.current = garmentTypeId;
  }, [garmentTypeId, garmentTypes]);
  const {
    data: faces,
    isError: facesError,
    refetch: refetchFaces,
  } = useQuery<{ items: FaceItem[] }>({
    queryKey: ['faces', gender],
    queryFn: () => api.get(`/v1/models/faces?gender=${gender}`),
    enabled: !!gender,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const filteredFaces = useMemo(() => faces?.items ?? [], [faces?.items]);
  const faceContinents = useMemo(() => {
    const present = new Set(filteredFaces.map((f) => f.continent || 'global'));
    const known = CONTINENT_ORDER.filter((c) => present.has(c)).map((c) => ({
      id: c,
      label: continentLabel(c),
    }));
    const extra = Array.from(present)
      .filter((c) => c !== 'global' && !CONTINENT_ORDER.includes(c))
      .map((c) => ({ id: c, label: continentLabel(c) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const ordered = [...known, ...extra];
    if (present.has('global')) ordered.push({ id: 'global', label: 'Global' });
    return ordered;
  }, [filteredFaces]);
  useEffect(() => {
    if (!filteredFaces.length) return;
    if (!filteredFaces.some((f) => f.id === faceId)) {
      setFaceId(filteredFaces[0]?.id ?? '');
    }
  }, [filteredFaces, faceId]);
  const {
    data: backgrounds,
    isError: backgroundsError,
    refetch: refetchBackgrounds,
  } = useQuery<BackgroundsResponse>({
    queryKey: ['backgrounds', gender],
    queryFn: () => api.get(`/v1/models/backgrounds?gender=${gender}`),
    enabled: !!gender,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (backgrounds?.items?.length && !backgroundId) {
      setBackgroundId(backgrounds.items[0]?.id ?? '');
    }
  }, [backgrounds, backgroundId]);
  const { data: myBackgrounds, refetch: refetchMyBackgrounds } = useQuery<{
    items: { id: string; label: string; thumbnailUrl: string }[];
  }>({
    queryKey: ['backgrounds', 'mine'],
    queryFn: () => api.get('/v1/backgrounds/mine'),
  });
  const [isUploadingBackground, setIsUploadingBackground] = useState(false);
  const [backgroundUrlInput, setBackgroundUrlInput] = useState('');
  const [isFetchingBackgroundUrl, setIsFetchingBackgroundUrl] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);

  async function handleMyBackgroundUpload(file: File) {
    if (isUploadingBackground) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      showToast('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setIsUploadingBackground(true);
    try {
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        id: string;
        expiresIn: number;
      }>('/v1/backgrounds/mine/presign', { contentType: file.type, contentLength: file.size });
      await api.uploadToR2WithProgress(uploadUrl, file, () => {});
      const created = await api.post<{ id: string; label: string; thumbnailUrl: string }>(
        '/v1/backgrounds/mine/confirm',
        { r2Key },
      );
      await refetchMyBackgrounds();
      setBackgroundId(created.id);
      setUploadModalOpen(false);
    } catch (e) {
      showToast(`Upload failed: ${(e as Error).message || 'please try again'}`);
    } finally {
      setIsUploadingBackground(false);
    }
  }

  async function handleMyBackgroundFromUrl() {
    if (isFetchingBackgroundUrl || !backgroundUrlInput.trim()) return;
    setIsFetchingBackgroundUrl(true);
    try {
      const created = await api.post<{ id: string; label: string; thumbnailUrl: string }>(
        '/v1/backgrounds/mine/from-url',
        { url: backgroundUrlInput.trim() },
      );
      await refetchMyBackgrounds();
      setBackgroundId(created.id);
      setBackgroundUrlInput('');
      setUploadModalOpen(false);
    } catch (e) {
      showToast(`Couldn't load that image: ${(e as Error).message || 'please try again'}`);
    } finally {
      setIsFetchingBackgroundUrl(false);
    }
  }

  async function handleDeleteMyBackground(id: string) {
    try {
      await api.del(`/v1/backgrounds/mine/${id}`);
      if (backgroundId === id) setBackgroundId('');
      await refetchMyBackgrounds();
    } catch (e) {
      showToast(`Couldn't delete: ${(e as Error).message || 'please try again'}`);
    }
  }

  const [isSavingPosePreset, setIsSavingPosePreset] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState('');
  const [presetNameModalOpen, setPresetNameModalOpen] = useState(false);

  function handleApplyPosePreset(preset: { poseIds: string[] }) {
    const availableIds = new Set((poses?.items ?? []).map((p) => p.id));
    const applicable = preset.poseIds.filter((id) => availableIds.has(id));
    const dropped = preset.poseIds.length - applicable.length;
    if (applicable.length === 0) {
      showToast('All poses in this preset are no longer available.');
      return;
    }
    setPoseIds(applicable);
    if (dropped > 0) {
      showToast(
        `${dropped} pose${dropped === 1 ? '' : 's'} no longer available, removed from preset.`,
      );
    }
  }

  async function handleSavePosePreset() {
    const name = presetNameInput.trim();
    if (!name || poseIds.length === 0 || isSavingPosePreset || !garmentTypeId) return;
    setIsSavingPosePreset(true);
    try {
      await api.post('/v1/pose-presets', { name, gender, garmentTypeId, poseIds });
      await refetchPosePresets();
      setPresetNameInput('');
      setPresetNameModalOpen(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PRESET_LIMIT_REACHED') {
        showToast('Max 10 presets — delete one first.');
      } else if (e instanceof ApiError && e.code === 'PRESET_NAME_TAKEN') {
        showToast('Name already used.');
      } else {
        showToast(`Couldn't save preset: ${(e as Error).message || 'please try again'}`);
      }
    } finally {
      setIsSavingPosePreset(false);
    }
  }

  async function handleDeletePosePreset(id: string) {
    try {
      await api.del(`/v1/pose-presets/${id}`);
      await refetchPosePresets();
    } catch (e) {
      showToast(`Couldn't delete preset: ${(e as Error).message || 'please try again'}`);
    }
  }

  const { data: backgroundCategories } = useQuery<BackgroundCategoriesResponse>({
    queryKey: ['background-categories', gender],
    queryFn: () => api.get(`/v1/models/background-categories?gender=${gender}`),
    enabled: !!gender,
    staleTime: 60_000,
  });
  const bgNodes = useMemo<CatalogNode[]>(() => {
    if (!backgrounds) return [];
    const byCat = new Map<number, CatalogItem[]>();
    for (const b of backgrounds.items) {
      if (b.categoryId == null) continue;
      if (!byCat.has(b.categoryId)) byCat.set(b.categoryId, []);
      byCat.get(b.categoryId)?.push(b);
    }
    const nodes: CatalogNode[] = (backgroundCategories?.items ?? [])
      .filter((c) => byCat.has(c.id))
      .map((c) => ({
        id: c.id,
        slug: c.slug,
        label: c.label,
        thumbnailUrl: c.thumbnailUrl,
        children: [],
        items: byCat.get(c.id) ?? [],
      }));
    const uncategorized = backgrounds.items.filter((b) => b.categoryId == null);
    if (uncategorized.length > 0) {
      nodes.push({
        id: 0,
        slug: 'other',
        label: 'Other',
        thumbnailUrl: null,
        children: [],
        items: uncategorized,
      });
    }
    return nodes;
  }, [backgrounds, backgroundCategories]);
  const { data: catalogueTemplatesData } = useQuery<{ items: CatalogueTemplateItem[] }>({
    queryKey: ['catalogue-templates', gender, garmentTypeId],
    queryFn: () =>
      api.get(
        `/v1/models/catalogue-templates?gender=${gender}${garmentTypeId ? `&garmentTypeId=${garmentTypeId}` : ''}`,
      ),
    enabled: !!gender,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const catalogueTemplates = useMemo(
    () => [
      {
        id: 'custom',
        mappingId: '',
        label: 'Custom',
        thumbnailUrl: null,
        looks: [] as TemplateLook[],
      },
      ...(catalogueTemplatesData?.items ?? []),
    ],
    [catalogueTemplatesData],
  );
  const activeTemplate = catalogueTemplates.find((t) => t.id === catalogueTemplateId);
  const selectedLooks = (activeTemplate?.looks ?? []).filter((l) => selectedLookIds.includes(l.id));
  useEffect(() => {
    if (
      catalogueTemplateId !== 'custom' &&
      !(catalogueTemplatesData?.items ?? []).some((t) => t.id === catalogueTemplateId)
    ) {
      setCatalogueTemplateId('custom');
      setSelectedLookIds([]);
    }
  }, [catalogueTemplateId, catalogueTemplatesData]);
  const bgTagsById = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const b of backgrounds?.items ?? []) m.set(b.id, b.tags ?? []);
    return m;
  }, [backgrounds]);
  const bgSpecialTagById = useMemo(() => {
    const m = new Map<string, string | null | undefined>();
    for (const b of backgrounds?.items ?? []) m.set(b.id, b.specialTag);
    return m;
  }, [backgrounds]);
  const bgTags = useMemo(() => {
    const set = new Set<string>();
    for (const b of backgrounds?.items ?? []) for (const t of b.tags ?? []) set.add(t);
    return Array.from(set).sort();
  }, [backgrounds]);
  const faceTags = useMemo(() => {
    const set = new Set<string>();
    for (const f of faces?.items ?? []) for (const t of f.tags ?? []) set.add(t);
    return Array.from(set).sort();
  }, [faces]);
  const {
    data: poses,
    isError: posesError,
    refetch: refetchPoses,
  } = useQuery<{ items: PoseItem[] }>({
    queryKey: ['poses', gender, garmentTypeId],
    queryFn: () =>
      api.get(
        `/v1/models/poses?gender=${gender}${garmentTypeId ? `&garmentTypeId=${garmentTypeId}` : ''}`,
      ),
    enabled: !!gender,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  // Scoped to gender+garmentTypeId — poses are gender-partitioned and have
  // per-garment-type active/inactive overrides, so a preset saved under one
  // context is meaningless under another. Only fetches once both are known
  // (catalogueTemplateId === 'custom' is when the chip row can render at all).
  const { data: posePresets, refetch: refetchPosePresets } = useQuery<{
    lastUsed: { id: string; name: string | null; poseIds: string[] } | null;
    named: { id: string; name: string | null; poseIds: string[] }[];
  }>({
    queryKey: ['pose-presets', gender, garmentTypeId],
    queryFn: () => api.get(`/v1/pose-presets?gender=${gender}&garmentTypeId=${garmentTypeId}`),
    enabled: catalogueTemplateId === 'custom' && !!gender && !!garmentTypeId,
  });

  const selectedPoses = poses?.items.filter((p) => poseIds.includes(p.id)) ?? [];
  const needsLower =
    catalogueTemplateId === 'custom'
      ? selectedPoses.some((p) => p.hasLower)
      : selectedLooks.some((l) => l.hasLower);
  const needsShoes =
    catalogueTemplateId === 'custom'
      ? selectedPoses.some((p) => p.hasShoes)
      : selectedLooks.some((l) => l.hasShoes);
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
  const selectedCount = catalogueTemplateId === 'custom' ? poseIds.length : selectedLookIds.length;
  // Lower/shoe catalog fetch needs the pose IDs behind whatever is currently selected —
  // `poseIds` only ever holds the custom-mode picker's selection, template mode's poses
  // live on the selected looks instead.
  const effectivePoseIds =
    catalogueTemplateId === 'custom' ? poseIds : selectedLooks.map((l) => l.poseId);

  // Find the white background (tagged for Amazon) from loaded backgrounds
  const whiteBg = backgrounds?.items.find((b) => b.isWhiteBg);

  const poseIdsParam = effectivePoseIds.length > 0 ? `poseIds=${effectivePoseIds.join(',')}` : '';
  const { data: lowerCatalog } = useQuery<{ type: string; tree: CatalogNode[] }>({
    queryKey: ['catalog', 'lower', gender, garmentTypeId, effectivePoseIds.join(',')],
    queryFn: () => {
      const params = [
        poseIdsParam,
        gender ? `gender=${gender}` : '',
        garmentTypeId ? `garmentTypeId=${garmentTypeId}` : '',
      ]
        .filter(Boolean)
        .join('&');
      return api.get(`/v1/catalog/lower?${params}`);
    },
    enabled: needsLower,
  });
  const lowerRandomItems = useMemo(() => {
    const allItems = (lowerCatalog?.tree.filter((n) => n.slug !== 'other') ?? []).flatMap(
      flattenNode,
    );
    return [...allItems].sort(() => Math.random() - 0.5).slice(0, lowerVisibleCount);
  }, [lowerCatalog, lowerVisibleCount]);
  const { data: shoesCatalog } = useQuery<{ type: string; tree: CatalogNode[] }>({
    queryKey: ['catalog', 'shoe', gender, garmentTypeId, effectivePoseIds.join(',')],
    queryFn: () => {
      const params = [
        poseIdsParam,
        gender ? `gender=${gender}` : '',
        garmentTypeId ? `garmentTypeId=${garmentTypeId}` : '',
      ]
        .filter(Boolean)
        .join('&');
      return api.get(`/v1/catalog/shoe?${params}`);
    },
    enabled: needsShoes,
  });

  const shoeRandomItems = useMemo(() => {
    const allItems = (shoesCatalog?.tree.filter((n) => n.slug !== 'other') ?? []).flatMap(
      flattenNode,
    );
    return [...allItems].sort(() => Math.random() - 0.5).slice(0, shoeVisibleCount);
  }, [shoesCatalog, shoeVisibleCount]);
  const lowerNodes = useMemo(
    () => lowerCatalog?.tree.filter((node) => node.slug !== 'other') ?? [],
    [lowerCatalog],
  );
  const shoeNodes = useMemo(
    () => shoesCatalog?.tree.filter((node) => node.slug !== 'other') ?? [],
    [shoesCatalog],
  );
  const [lowerItemFilter, setLowerItemFilter] = useState<number | ''>('');
  const [shoeItemFilter, setShoeItemFilter] = useState<number | ''>('');

  async function handleGarmentUpload(file: File) {
    if (isUploading) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      showToast('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setGarmentFile(file);
    setIsUploading(true);
    setUploadProgress(0);
    const abort = new AbortController();
    uploadAbortRef.current = abort;
    try {
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        expiresIn: number;
      }>('/v1/uploads/presign', { contentType: file.type, contentLength: file.size });
      await api.uploadToR2WithProgress(uploadUrl, file, setUploadProgress, abort.signal);
      setGarmentKey(r2Key);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      const msg = (e as Error).message ?? '';
      showToast(
        msg.includes('403')
          ? 'Upload session expired. Please re-select your image and try again.'
          : `Upload failed: ${msg}`,
      );
      setGarmentFile(null);
    } finally {
      setIsUploading(false);
    }
  }

  async function handleLowerGarmentUpload(file: File) {
    if (isUploadingLower) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      showToast('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setLowerGarmentFile(file);
    setIsUploadingLower(true);
    const lowerAbort = new AbortController();
    lowerUploadAbortRef.current = lowerAbort;
    try {
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        expiresIn: number;
      }>('/v1/uploads/presign', { contentType: file.type, contentLength: file.size });
      await api.uploadToR2WithProgress(uploadUrl, file, () => {}, lowerAbort.signal);
      setLowerGarmentKey(r2Key);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      const msg = (e as Error).message ?? '';
      showToast(
        msg.includes('403')
          ? 'Upload session expired. Please re-select your image and try again.'
          : `Lower garment upload failed: ${msg}`,
      );
      setLowerGarmentFile(null);
      setLowerGarmentKey('');
    } finally {
      setIsUploadingLower(false);
    }
  }

  async function handleThirdGarmentUpload(file: File) {
    if (isUploadingThird) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      showToast('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setThirdGarmentFile(file);
    setIsUploadingThird(true);
    const thirdAbort = new AbortController();
    thirdUploadAbortRef.current = thirdAbort;
    try {
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        expiresIn: number;
      }>('/v1/uploads/presign', { contentType: file.type, contentLength: file.size });
      await api.uploadToR2WithProgress(uploadUrl, file, () => {}, thirdAbort.signal);
      setThirdGarmentKey(r2Key);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      const msg = (e as Error).message ?? '';
      showToast(
        msg.includes('403')
          ? 'Upload session expired. Please re-select your image and try again.'
          : `Third garment upload failed: ${msg}`,
      );
      setThirdGarmentFile(null);
      setThirdGarmentKey('');
    } finally {
      setIsUploadingThird(false);
    }
  }

  async function handlePalluGarmentUpload(file: File) {
    if (isUploadingPallu) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      showToast('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setPalluGarmentFile(file);
    setIsUploadingPallu(true);
    const palluAbort = new AbortController();
    palluUploadAbortRef.current = palluAbort;
    try {
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        expiresIn: number;
      }>('/v1/uploads/presign', { contentType: file.type, contentLength: file.size });
      await api.uploadToR2WithProgress(uploadUrl, file, () => {}, palluAbort.signal);
      setPalluGarmentKey(r2Key);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      const msg = (e as Error).message ?? '';
      showToast(
        msg.includes('403')
          ? 'Upload session expired. Please re-select your image and try again.'
          : `Pallu upload failed: ${msg}`,
      );
      setPalluGarmentFile(null);
      setPalluGarmentKey('');
    } finally {
      setIsUploadingPallu(false);
    }
  }

  function handleFaceSelect(id: string) {
    setFaceId(id);
    setCatalogueTemplateId('custom');
    setSelectedLookIds([]);
    setBackgroundId('');
    setPoseIds([]);
  }
  function handleBackgroundSelect(id: string) {
    setCatalogueTemplateId('custom');
    setBackgroundId(id);
    setPoseIds([]);
  }
  function handleCatalogueTemplateSelect(id: string) {
    setCatalogueTemplateId(id);
    // All of the template's looks are selected by default - the customer
    // deselects individual ones they don't want via handleLookToggle. Empty
    // for 'custom' (no looks) and for any not-yet-loaded template.
    const template = catalogueTemplates.find((t) => t.id === id);
    setSelectedLookIds(template ? template.looks.map((look) => look.id) : []);
    setBackgroundId('');
    setPoseIds([]);
  }
  function handleLookToggle(id: string) {
    setSelectedLookIds((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id],
    );
  }
  function handlePoseSelect(id: string) {
    setPoseIds((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
      const nextPoses = poses?.items.filter((p) => next.includes(p.id)) ?? [];
      const nextNeedsLower = nextPoses.some((p) => p.hasLower);
      const nextNeedsShoes = nextPoses.some((p) => p.hasShoes);
      // Clear when no longer needed; leave empty otherwise (default sent at submit time)
      if (!nextNeedsLower) setLowerCatalogId('');
      if (!nextNeedsShoes) setShoeCatalogId('');
      return next;
    });
  }

  const RESOLUTION_COSTS = {
    HD: resolutionConfig.HD?.creditCost ?? 25,
    '2K': resolutionConfig['2K']?.creditCost ?? 35,
    '4K': resolutionConfig['4K']?.creditCost ?? 40,
  } as const;

  async function handleSubmit() {
    if (isSubmittingRef.current) return;
    if (!garmentKey || !faceId || !resolution) return;
    if (sareeTwoInputActive && !palluGarmentKey) return;
    if (catalogueTemplateId === 'custom') {
      if (!backgroundId || poseIds.length === 0) return;
    } else {
      if (selectedLooks.length === 0) return;
    }

    // Amazon main listing + multiple poses → show picker modal to choose main image.
    // Lifestyle mode or single pose → submit directly.
    if (platform === 'Amazon' && amazonUseWhiteBg && poseIds.length > 1) {
      setAmazonMainPoseId('');
      setAmazonPoseModalOpen(true);
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError('');
    try {
      // Send platform:'Amazon' only when white bg override is wanted (main listing).
      // Lifestyle mode: omit platform so the API doesn't force white bg.
      // The aspectRatio (1:1) is already captured in `aspect` independently.
      const effectivePlatform =
        platform === 'Amazon' ? (amazonUseWhiteBg ? 'Amazon' : undefined) : platform;
      const effectiveLowerId =
        lowerCatalogId ||
        (needsLower ? (selectedGarmentType?.defaultLowerCatalogId ?? undefined) : undefined);
      const effectiveShoesId =
        shoeCatalogId ||
        (needsShoes ? (selectedGarmentType?.defaultShoeCatalogId ?? undefined) : undefined);

      const step2InputsBase = {
        faceId,
        garmentTypeId: garmentTypeId || undefined,
        lowerCatalogId: effectiveLowerId,
        lowerGarmentKey: lowerGarmentKey || undefined,
        shoeCatalogId: effectiveShoesId,
        thirdGarmentKey: thirdGarmentKey || undefined,
      };
      const step2Inputs =
        catalogueTemplateId === 'custom'
          ? { ...step2InputsBase, backgroundId, poseIds }
          : {
              ...step2InputsBase,
              catalogueTemplateMappingId: activeTemplate?.mappingId,
              looks: selectedLooks.map((l) => ({ poseId: l.poseId, backgroundId: l.backgroundId })),
            };
      const step2Body = {
        inputs: step2Inputs,
        aspectRatio: effectiveAspect,
        resolution,
        ...(Object.keys(customParams).length ? { params: customParams } : {}),
        ...(effectivePlatform ? { platform: effectivePlatform } : {}),
      };

      let catalogueId: string;
      let jobIds: string[];
      if (selectedGarmentType?.requiresMannequinStep) {
        ({ catalogueId, jobIds } = await api.post<{ catalogueId: string; jobIds: string[] }>(
          '/v1/jobs/saree-mannequin',
          {
            garmentTypeId,
            garmentKey,
            ...(sareeTwoInputActive ? { secondGarmentKey: palluGarmentKey } : {}),
            faceId,
            step2: step2Body,
          },
        ));
      } else {
        const inputs = {
          upperGarmentKey: garmentKey,
          ...step2Inputs,
        };
        ({ catalogueId, jobIds } = await api.post<{ catalogueId: string; jobIds: string[] }>(
          '/v1/jobs/tryon',
          { ...step2Body, inputs },
        ));
      }

      // Credits were deducted server-side — refresh balance + catalogues list.
      qc.invalidateQueries({ queryKey: ['credits'] });
      qc.invalidateQueries({ queryKey: ['catalogues'] });
      qc.invalidateQueries({ queryKey: ['pose-presets'] });
      const submittedLooks =
        catalogueTemplateId === 'custom'
          ? poseIds.map((poseId) => {
              const pose = poses?.items.find((p) => p.id === poseId);
              return {
                poseId,
                label: pose?.label ?? 'Pose',
                thumbnailUrl: pose?.thumbnailUrl ?? '',
              };
            })
          : selectedLooks.map((l) => ({
              poseId: l.poseId,
              label: l.poseLabel,
              thumbnailUrl: l.poseThumbnailUrl,
            }));
      setActiveGeneration({
        catalogueId,
        jobs: jobIds.map((id, i) => ({
          id,
          poseId: submittedLooks[i]?.poseId ?? '',
          label: submittedLooks[i]?.label ?? `Look ${i + 1}`,
          thumbnailUrl: submittedLooks[i]?.thumbnailUrl ?? '',
        })),
      });
      setGenerationInProgress(true);
      if (typeof window !== 'undefined' && window.innerWidth < 1280) {
        setTimeout(() => {
          document.getElementById('studio-right-column')?.scrollIntoView({ behavior: 'smooth' });
        }, 100);
      }
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    } catch (e) {
      setSubmitError((e as Error).message);
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  async function submitAmazonPose(mainPoseId: string) {
    if (isSubmittingRef.current) return;
    setAmazonPoseModalOpen(false);
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError('');
    try {
      const effectiveLowerId =
        lowerCatalogId ||
        (needsLower ? (selectedGarmentType?.defaultLowerCatalogId ?? undefined) : undefined);
      const effectiveShoesId =
        shoeCatalogId ||
        (needsShoes ? (selectedGarmentType?.defaultShoeCatalogId ?? undefined) : undefined);

      // Main image: white Amazon-compliant background
      const { catalogueId, jobIds: mainJobIds } = await api.post<{
        catalogueId: string;
        jobIds: string[];
      }>('/v1/jobs/tryon', {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          backgroundId,
          poseIds: [mainPoseId],
          garmentTypeId: garmentTypeId || undefined,
          lowerCatalogId: effectiveLowerId,
          lowerGarmentKey: lowerGarmentKey || undefined,
          shoeCatalogId: effectiveShoesId,
          thirdGarmentKey: thirdGarmentKey || undefined,
        },
        aspectRatio: effectiveAspect,
        resolution,
        ...(Object.keys(customParams).length ? { params: customParams } : {}),
        platform: 'Amazon',
      });

      // Remaining poses: same catalogue, original background, no Amazon override.
      // NOTE (last-used pose preset tracking limitation): the API tracks
      // "last used" poses per-request (delete+insert, last write wins) keyed off
      // exactly the poseIds each /v1/jobs/tryon call resolves. Because this Amazon
      // flow issues TWO sequential calls — mainPoseId alone, then remainingPoseIds —
      // this second call's last-used write clobbers the first, so the "Last Used"
      // chip ends up missing mainPoseId even though a job for it was created. Fixing
      // this cleanly would need either a "merge" tracking mode on the pose-presets
      // API or a tracking-only poseIds hint decoupled from job creation on the
      // tryon request — both are new API surface beyond this fix wave's scope
      // (Tasks 1-3 are already reviewed/closed), and passing the full poseIds array
      // into this call's `inputs.poseIds` is not a safe workaround: that field
      // drives actual job creation, so it would enqueue a duplicate job for
      // mainPoseId. Left as a known limitation — see final-review-fix-report.md.
      const remainingPoseIds = poseIds.filter((id) => id !== mainPoseId);
      let remainingJobIds: string[] = [];
      if (remainingPoseIds.length > 0) {
        const remaining = await api.post<{ jobIds: string[] }>('/v1/jobs/tryon', {
          catalogueId,
          inputs: {
            upperGarmentKey: garmentKey,
            faceId,
            backgroundId,
            poseIds: remainingPoseIds,
            garmentTypeId: garmentTypeId || undefined,
            lowerCatalogId: effectiveLowerId,
            lowerGarmentKey: lowerGarmentKey || undefined,
            shoeCatalogId: effectiveShoesId,
            thirdGarmentKey: thirdGarmentKey || undefined,
          },
          aspectRatio: effectiveAspect,
          resolution,
          ...(Object.keys(customParams).length ? { params: customParams } : {}),
        });
        remainingJobIds = remaining.jobIds;
      }

      qc.invalidateQueries({ queryKey: ['credits'] });
      qc.invalidateQueries({ queryKey: ['catalogues'] });
      qc.invalidateQueries({ queryKey: ['pose-presets'] });
      const orderedPoseIds = [mainPoseId, ...remainingPoseIds];
      const orderedJobIds = [...mainJobIds, ...remainingJobIds];
      setActiveGeneration({
        catalogueId,
        jobs: orderedPoseIds.map((poseId, i) => {
          const pose = poses?.items.find((p) => p.id === poseId);
          return {
            // biome-ignore lint/style/noNonNullAssertion: orderedJobIds and orderedPoseIds are the same length by construction
            id: orderedJobIds[i]!,
            poseId,
            label: pose?.label ?? `Pose ${i + 1}`,
            thumbnailUrl: pose?.thumbnailUrl ?? '',
          };
        }),
      });
      setGenerationInProgress(true);
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    } catch (e) {
      setSubmitError((e as Error).message);
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  const requiresLowerUpload = selectedGarmentType?.requiresLowerUpload ?? false;
  const requiresThirdUpload = selectedGarmentType?.requiresThirdUpload ?? false;
  const sareeTwoInputCapable =
    !!selectedGarmentType?.requiresMannequinStep &&
    !!selectedGarmentType?.mannequinTwoInputWorkflowTemplateId;
  const sareeTwoInputActive = sareeTwoInputCapable && sareeUploadMode === 'two_input';
  const hasMultipleUploadBoxes = requiresLowerUpload || requiresThirdUpload || sareeTwoInputActive;

  const creditCost = resolution ? RESOLUTION_COSTS[resolution] * selectedCount : 0;
  const canGenerate =
    selectedCount > 0 &&
    !!garmentKey &&
    (!requiresLowerUpload || !!lowerGarmentKey) &&
    (!requiresThirdUpload || !!thirdGarmentKey) &&
    (!sareeTwoInputActive || !!palluGarmentKey) &&
    !!faceId &&
    (catalogueTemplateId === 'custom' ? !!backgroundId : true) &&
    customDimsReady &&
    !!resolution &&
    !isUploading &&
    !isUploadingLower &&
    !isUploadingThird &&
    !isUploadingPallu &&
    !isSubmitting &&
    !generationInProgress;

  const generateBlocker = generationInProgress
    ? 'Generation in progress…'
    : isUploading || isUploadingLower || isUploadingThird || isUploadingPallu
      ? 'Waiting for upload to finish…'
      : !garmentKey
        ? 'Upload a garment image first'
        : requiresLowerUpload && !lowerGarmentKey
          ? 'Upload the lower garment image first'
          : requiresThirdUpload && !thirdGarmentKey
            ? 'Upload the third garment image first'
            : sareeTwoInputActive && !palluGarmentKey
              ? 'Upload the pallu image first'
              : selectedCount === 0
                ? catalogueTemplateId === 'custom'
                  ? 'Select at least one pose'
                  : 'Select at least one look'
                : !customDimsReady
                  ? 'Enter valid width and height for custom size'
                  : '';

  // Sections 1-4 (Create Catalogue For / Outfit Type / Upload / Choose AI Model)
  // are always visible and keep their static stepNumber. Everything after that is
  // conditionally rendered (template mode vs custom mode, optional lower/shoe
  // roles, resolution not yet resolved), so step numbers are assigned dynamically
  // from DOM order to avoid gaps/duplicates depending on what's actually shown.
  const hasCatalogueTemplates = catalogueTemplates.length > 1;
  const extraSectionKeys = [
    hasCatalogueTemplates && 'templates',
    catalogueTemplateId === 'custom' && 'background',
    catalogueTemplateId === 'custom' && 'poses',
    needsLower && !requiresLowerUpload && 'lower',
    needsShoes && 'shoes',
    'platform',
    'aspect',
    resolution && 'resolution',
  ].filter((key): key is string => !!key);
  const stepNumberOf = (key: string) => extraSectionKeys.indexOf(key) + 5;

  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
        :root {
          --c-pink: #BD2587 !important;
          --c-amber: #e044a2 !important;
          --c-studio-bg: #F8F8F8;
        }
        html.dark {
          --c-pink: #BD2587 !important;
          --c-amber: #e044a2 !important;
          --c-studio-bg: #0c101b;
        }

        .studio-section-card {
          transition: box-shadow 0.2s ease-in-out, border-color 0.2s ease-in-out;
        }
        .studio-section-card:hover {
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.05) !important;
          border-color: #BD258733 !important;
        }
        
        .visual-card-wrapper {
          transition: box-shadow 0.2s ease-in-out, transform 0.2s ease-in-out;
        }
        .visual-card-wrapper:hover {
          background: linear-gradient(var(--c-card), var(--c-card)) padding-box,
                      linear-gradient(135deg, #BD2587 0%, #ff5b94 100%) border-box !important;
          box-shadow: 0 4px 12px rgba(189, 37, 135, 0.15) !important;
        }
        
        .garment-card {
          transition: box-shadow 0.2s ease-in-out, transform 0.2s ease-in-out;
        }
        .garment-card:hover {
          background: linear-gradient(var(--c-card), var(--c-card)) padding-box,
                      linear-gradient(135deg, #BD2587 0%, #ff5b94 100%) border-box !important;
          box-shadow: 0 4px 12px rgba(189, 37, 135, 0.15) !important;
        }
        
        .gender-card-hover {
          transition: box-shadow 0.2s ease-in-out, border-color 0.2s ease-in-out;
        }
        .gender-card-hover:hover {
          border-color: #BD2587 !important;
          box-shadow: 0 4px 12px rgba(189, 37, 135, 0.1) !important;
        }

        .studio-audience-section {
          container: studio-audience / inline-size;
        }
        .gender-card-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 12px;
        }
        @container studio-audience (max-width: 600px) {
          .gender-card-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @container studio-audience (max-width: 340px) {
          .gender-card-grid {
            grid-template-columns: minmax(0, 1fr);
          }
        }

        .studio-layout-wrapper {
          flex: 1;
          min-height: 0;
          display: flex;
          gap: 20px;
          padding: 24px 28px;
          background: var(--c-studio-bg);
          box-sizing: border-box;
          overflow-y: auto;
        }
        .studio-left-column {
          flex: 1 1 0;
          min-width: 0;
          max-width: 880px;
          display: flex;
          flex-direction: column;
        }
        .studio-right-column {
          flex: 1 1 0;
          min-width: 0;
          max-width: 880px;
          overflow-y: auto;
          max-height: 100%;
          padding-right: 4px;
        }
        .studio-generate-card {
          background: var(--c-card, #FFFFFF);
          border: 1.5px solid var(--c-border, #E5E7EB);
          border-radius: 16px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.06);
          padding: 16px 20px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          flex-shrink: 0;
          margin-top: 16px;
        }
        .studio-5col-grid {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 16px;
        }
        .sel-card-label-box {
          display: -webkit-box !important;
          -webkit-line-clamp: 2 !important;
          -webkit-box-orient: vertical !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
          font-size: 12px;
          line-height: 1.25 !important;
          height: 36px !important;
          max-height: 36px !important;
          box-sizing: border-box !important;
          width: 100% !important;
          text-align: center !important;
          word-break: break-word !important;
          overflow-wrap: anywhere !important;
        }
        .studio-platforms-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
        }
        .studio-platforms-grid > button:nth-child(7) {
          grid-column: 2;
        }
        .studio-force-mobile-frame {
          max-width: 390px !important;
          margin: 20px auto !important;
          border-radius: 24px !important;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25) !important;
          border: 8px solid #1f2937 !important;
          background: var(--c-studio-bg) !important;
          box-sizing: border-box !important;
        }
        @media (max-width: 1279px) {
          .studio-layout-wrapper {
            flex-direction: column;
            padding: 16px;
            gap: 20px;
          }
          .studio-left-column {
            max-width: 100%;
            width: 100%;
          }
          .studio-right-column {
            max-width: 100%;
            width: 100%;
            max-height: none;
            overflow-y: visible;
            margin-top: 8px;
            padding-top: 20px;
            border-top: 1.5px dashed var(--c-border);
            scroll-margin-top: 20px;
          }
          .studio-generate-card {
            margin-bottom: 12px;
          }
          .studio-5col-grid {
            display: grid;
            grid-template-columns: repeat(5, minmax(0, 1fr));
            gap: 10px;
          }
          .garment-card, .visual-card-wrapper {
            max-width: 100%;
            margin: 0 auto;
            width: 100%;
          }
          .gender-card-hover {
            height: 56px !important;
          }
          .gender-card-content {
            gap: 8px !important;
            padding: 0 10px !important;
          }
          .gender-card-content > div:first-child {
            width: 36px !important;
            height: 36px !important;
          }
          .gender-card-content span, .gender-card-label {
            font-size: 13.5px !important;
            font-weight: 600 !important;
          }
        }
        @media (max-width: ${BREAKPOINTS.md}px) {
          .studio-layout-wrapper {
            padding: 12px;
            gap: 16px;
          }
          .studio-generate-card {
            margin-top: 16px;
            margin-bottom: 16px;
            padding: 14px 16px;
          }
          .studio-5col-grid {
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 8px;
          }
          .garment-card, .visual-card-wrapper {
            max-width: 100%;
          }
          .sel-card-label-box {
            -webkit-line-clamp: 3 !important;
            font-size: 11.5px !important;
            height: 46px !important;
            max-height: 46px !important;
            line-height: 1.25 !important;
          }
          .studio-select-modal-grid {
            grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
            gap: 10px !important;
          }
        }
        @media (max-width: ${BREAKPOINTS.xs}px) {
          .studio-layout-wrapper {
            padding: 10px;
            gap: 12px;
          }
          .studio-generate-card {
            padding: 12px 14px;
            border-radius: 14px;
          }
          .studio-generate-card-row {
            flex-direction: column !important;
            align-items: stretch !important;
            gap: 10px !important;
          }
          .studio-generate-card-row > div {
            justify-content: space-between;
          }
          .studio-generate-btn-wrap {
            width: 100%;
          }
          .studio-generate-btn-wrap button {
            width: 100%;
            justify-content: center;
          }
          .studio-5col-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 6px;
          }
          .studio-select-modal-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
            gap: 8px !important;
          }
          .garment-card, .visual-card-wrapper {
            max-width: 100%;
          }
          .sel-card-label-box {
            -webkit-line-clamp: 3 !important;
            font-size: 11px !important;
            height: 44px !important;
            max-height: 44px !important;
            line-height: 1.25 !important;
          }
          .gender-card-hover {
            height: 52px !important;
          }
          .gender-card-content {
            gap: 6px !important;
            padding: 0 8px !important;
          }
          .gender-card-content > div:first-child {
            width: 32px !important;
            height: 32px !important;
          }
          .gender-card-content span, .gender-card-label {
            font-size: 13px !important;
            font-weight: 600 !important;
          }
        }

        *:focus,
        *:focus-visible,
        button:focus,
        button:focus-visible,
        div:focus,
        div:focus-visible,
        a:focus,
        a:focus-visible {
          outline: none !important;
        }
      `,
        }}
      />
      <TopBar
        title="Studio"
        subtitle="Create premium AI catalogue shoots from flat lay garments in minutes."
      />
      <div style={{ display: 'flex', gap: 8, margin: '0 28px', marginTop: 20 }}>
        {(['single', 'batch'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              if (mode === 'batch' && m !== 'batch' && batchDirty) {
                const ok = window.confirm(
                  'Switching modes will discard your batch grid. Continue?',
                );
                if (!ok) return;
              }
              setMode(m);
            }}
            style={{
              padding: '6px 14px',
              borderRadius: 999,
              border: `1px solid ${mode === m ? C.pink : C.border}`,
              background: mode === m ? C.pink : 'transparent',
              color: mode === m ? C.white : C.text,
              cursor: 'pointer',
            }}
          >
            {m === 'single' ? 'Single' : 'Batch'}
          </button>
        ))}
      </div>
      {mode === 'batch' ? (
        <div
          className="studio-layout-wrapper"
          style={{ padding: '16px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}
        >
          <section className="studio-section-card studio-audience-section" style={sectionCardStyle}>
            <SectionHead
              title="Create Catalogue For"
              subtitle="Choose your target audience"
              stepNumber={1}
            />
            <div className="gender-card-grid">
              {GENDERS.map((g) => (
                <GenderCard
                  key={g.value}
                  img={g.img}
                  label={g.label}
                  selected={gender === g.value}
                  onClick={() => {
                    if (g.value === gender) return;
                    setGender(g.value);
                    // Forces the auto-select effect below to re-pick the first
                    // garment type for the new gender, same as switching gender
                    // in single mode.
                    setGarmentTypeId('');
                  }}
                />
              ))}
            </div>
          </section>

          <section className="studio-section-card" style={sectionCardStyle}>
            <SectionHead
              title="Select Your Garment Type"
              subtitle="Select the garment category"
              stepNumber={2}
              right={
                garmentTypes &&
                garmentTypes.items.length > batchGarmentVisibleCount && (
                  <button
                    type="button"
                    onClick={() => setBatchGarmentModalOpen(true)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      height: 16,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-poppins), Poppins, sans-serif',
                        fontWeight: 600,
                        fontSize: 12,
                        lineHeight: '16px',
                        color: '#626262',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      View More
                    </span>
                  </button>
                )
              }
            />
            {!garmentTypes ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  color: C.mid,
                }}
              >
                <SpinnerIcon size={16} /> Loading…
              </div>
            ) : (
              <div className="studio-5col-grid">
                {(() => {
                  const all = garmentTypes.items;
                  const inFirstN = all
                    .slice(0, batchGarmentVisibleCount)
                    .some((s) => s.id === garmentTypeId);
                  const visible =
                    garmentTypeId && !inFirstN
                      ? [
                          // biome-ignore lint/style/noNonNullAssertion: inFirstN is false here, so the find returns a value
                          all.find((s) => s.id === garmentTypeId)!,
                          ...all
                            .filter((s) => s.id !== garmentTypeId)
                            .slice(0, batchGarmentVisibleCount - 1),
                        ]
                      : all.slice(0, batchGarmentVisibleCount);
                  return visible.map((s) => {
                    const fallbackKey = Object.keys(OUTFIT_IMG).find(
                      (k) => s.slug.toLowerCase().includes(k) || s.label.toLowerCase().includes(k),
                    );
                    const img = s.thumbnailUrl ?? (fallbackKey ? OUTFIT_IMG[fallbackKey] : null);
                    return (
                      <VisualCard
                        key={s.id}
                        img={img ?? null}
                        label={s.label}
                        width="100%"
                        selected={garmentTypeId === s.id}
                        onClick={() => setGarmentTypeId(s.id)}
                      />
                    );
                  });
                })()}
              </div>
            )}
          </section>

          {garmentTypeId ? (
            <BatchMode
              gender={gender}
              garmentTypeId={garmentTypeId}
              aspectRatio={effectiveAspect}
              resolution={resolution ?? 'HD'}
              platform={platform}
              params={
                aspect === 'custom' && customDimsReady
                  ? { outputWidth: customWNum, outputHeight: customHNum }
                  : undefined
              }
              creditCostPerImage={
                resolution ? RESOLUTION_COSTS[resolution] : (resolutionConfig.HD?.creditCost ?? 25)
              }
              balance={userCredits}
              onDirtyChange={setBatchDirty}
            />
          ) : (
            <p style={{ color: C.mid, fontSize: 13 }}>
              Select a garment type above to start uploading garments.
            </p>
          )}
        </div>
      ) : (
        <div
          className={`studio-layout-wrapper ${isMobileParam ? 'studio-force-mobile-frame' : ''}`}
        >
          <div className="studio-left-column">
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                paddingRight: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 20,
              }}
            >
              {/* ── Setup ── */}
              <section
                className="studio-section-card studio-audience-section"
                style={sectionCardStyle}
              >
                <SectionHead
                  title="Create Catalogue For"
                  subtitle="Choose your target audience"
                  stepNumber={1}
                />
                <div className="gender-card-grid">
                  {GENDERS.map((g) => (
                    <GenderCard
                      key={g.value}
                      img={g.img}
                      label={g.label}
                      selected={gender === g.value}
                      onClick={() => {
                        setGender(g.value);
                        setGarmentTypeId('');
                        setCatalogueTemplateId('custom');
                        setGarmentModalOpen(false);
                      }}
                    />
                  ))}
                </div>
              </section>

              <section className="studio-section-card" style={sectionCardStyle}>
                <SectionHead
                  title="Select Your Garment Type"
                  subtitle="Select the garment category"
                  stepNumber={2}
                  right={
                    garmentTypes &&
                    garmentTypes.items.length > garmentVisibleCount && (
                      <button
                        type="button"
                        onClick={() => setGarmentModalOpen(true)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          height: 16,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: 'var(--font-poppins), Poppins, sans-serif',
                            fontWeight: 600,
                            fontSize: 12,
                            lineHeight: '16px',
                            color: '#626262',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          View All
                        </span>
                      </button>
                    )
                  }
                />
                {!gender ? (
                  <p style={{ fontSize: 13, color: C.mid }}>Select a segment first.</p>
                ) : !garmentTypes ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 13,
                      color: C.mid,
                    }}
                  >
                    <SpinnerIcon size={16} /> Loading…
                  </div>
                ) : (
                  <div className="studio-5col-grid">
                    {(() => {
                      const all = garmentTypes.items;
                      const inFirstN = all
                        .slice(0, garmentVisibleCount)
                        .some((s) => s.id === garmentTypeId);
                      const visible =
                        garmentTypeId && !inFirstN
                          ? [
                              // biome-ignore lint/style/noNonNullAssertion: inFirstN is false here, so the find returns a value
                              all.find((s) => s.id === garmentTypeId)!,
                              ...all
                                .filter((s) => s.id !== garmentTypeId)
                                .slice(0, garmentVisibleCount - 1),
                            ]
                          : all.slice(0, garmentVisibleCount);
                      return visible.map((s) => {
                        const fallbackKey = Object.keys(OUTFIT_IMG).find(
                          (k) =>
                            s.slug.toLowerCase().includes(k) || s.label.toLowerCase().includes(k),
                        );
                        const img =
                          s.thumbnailUrl ??
                          // biome-ignore lint/style/noNonNullAssertion: fallbackKey is derived from a key in OUTFIT_IMG
                          (fallbackKey ? OUTFIT_IMG[fallbackKey]! : null);
                        return (
                          <VisualCard
                            key={s.id}
                            img={img}
                            label={s.label}
                            width="100%"
                            selected={garmentTypeId === s.id}
                            onClick={() => {
                              if (s.id !== garmentTypeId) {
                                setGarmentTypeId(s.id);
                                setFaceId('');
                                setCatalogueTemplateId('custom');
                                setBackgroundId('');
                                setPoseIds([]);
                                setLowerCatalogId('');
                                setShoeCatalogId('');
                                setSareeUploadMode('two_input');
                                setPalluGarmentFile(null);
                                setPalluGarmentKey('');
                              }
                            }}
                          />
                        );
                      });
                    })()}
                  </div>
                )}
              </section>

              <section className="studio-section-card" style={sectionCardStyle}>
                <SectionHead
                  title={hasMultipleUploadBoxes ? 'Upload Garment Images' : 'Upload Garment Image'}
                  subtitle="Upload a clean flat lay garment image"
                  stepNumber={3}
                />
                <div
                  style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}
                >
                  {/* Dashed upload box — single zone or split into two */}
                  <div
                    style={{
                      flex: 1,
                      minWidth: 260,
                      height: 238,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      background: C.field,
                      borderRadius: 12,
                      border: `1px dashed ${C.border}`,
                      padding: '0 10px',
                      boxSizing: 'border-box',
                    }}
                  >
                    {/* Upload zone wrapper — stacks vertically when two uploads */}
                    <div
                      style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: hasMultipleUploadBoxes ? 'column' : 'row',
                        gap: hasMultipleUploadBoxes ? 8 : 0,
                        height: 210,
                        minWidth: 0,
                      }}
                    >
                      {/* Upper garment label */}
                      <label
                        style={{
                          flex: 1,
                          minWidth: 0,
                          height: hasMultipleUploadBoxes ? undefined : 210,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 12,
                          background: C.card,
                          border: `1px solid ${C.border}`,
                          borderRadius: 8,
                          padding: 12,
                          cursor: 'pointer',
                          boxSizing: 'border-box',
                          overflow: 'hidden',
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const f = e.dataTransfer.files?.[0];
                          if (f && ['image/jpeg', 'image/png', 'image/webp'].includes(f.type))
                            handleGarmentUpload(f);
                        }}
                      >
                        {garmentFile ? (
                          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {/* biome-ignore lint/performance/noImgElement: static image, Next Image not needed */}
                            <img
                              src={garmentPreviewUrl}
                              alt={garmentFile.name}
                              style={{
                                width: '100%',
                                height: '100%',
                                objectFit: 'cover',
                                borderRadius: 6,
                              }}
                            />
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                setGarmentFile(null);
                                setGarmentKey('');
                              }}
                              style={{
                                position: 'absolute',
                                top: 6,
                                right: 6,
                                width: 24,
                                height: 24,
                                borderRadius: '50%',
                                background: 'rgba(0,0,0,0.5)',
                                border: 'none',
                                color: 'white',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <XIcon size={14} />
                            </button>
                            {isUploading && (
                              <div
                                style={{
                                  position: 'absolute',
                                  bottom: 8,
                                  left: 8,
                                  right: 8,
                                  background: 'rgba(255,255,255,0.95)',
                                  borderRadius: 8,
                                  padding: '6px 10px',
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    fontSize: 12,
                                    color: C.text,
                                  }}
                                >
                                  <SpinnerIcon size={14} /> {uploadProgress}%
                                </div>
                                <div
                                  style={{
                                    marginTop: 4,
                                    height: 4,
                                    borderRadius: 99,
                                    background: C.border,
                                    overflow: 'hidden',
                                  }}
                                >
                                  <div
                                    style={{
                                      height: '100%',
                                      width: `${uploadProgress}%`,
                                      background: grad,
                                      borderRadius: 99,
                                      transition: 'width .3s',
                                    }}
                                  />
                                </div>
                              </div>
                            )}
                            {garmentKey && (
                              <div
                                style={{
                                  position: 'absolute',
                                  top: 8,
                                  left: 8,
                                  background: C.mint,
                                  color: 'white',
                                  borderRadius: 6,
                                  padding: '3px 8px',
                                  fontSize: 11,
                                  fontWeight: 600,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 4,
                                }}
                              >
                                <CheckIcon color="#fff" size={10} /> Uploaded
                              </div>
                            )}
                          </div>
                        ) : (
                          <>
                            <div
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                gap: 4,
                              }}
                            >
                              <span
                                style={{
                                  width: '100%',
                                  fontSize: hasMultipleUploadBoxes ? 11 : 12,
                                  fontWeight: 500,
                                  lineHeight: '100%',
                                  color: C.text,
                                  textAlign: 'center',
                                }}
                              >
                                {sareeTwoInputActive
                                  ? 'Body'
                                  : hasMultipleUploadBoxes
                                    ? selectedGarmentType?.upperUploadLabel ||
                                      `Upload ${selectedGarmentType?.label ?? 'Top Wear'}`
                                    : `Upload ${selectedGarmentType?.label ?? 'Top Wear'}`}
                              </span>
                              <span
                                style={{
                                  width: '100%',
                                  fontSize: 10,
                                  fontWeight: 500,
                                  lineHeight: '140%',
                                  color: C.mid,
                                  textAlign: 'center',
                                }}
                              >
                                {hasMultipleUploadBoxes
                                  ? 'JPG, PNG · Max 10MB'
                                  : 'Drag and drop an image here · JPG, PNG · Max 10MB'}
                              </span>
                            </div>
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 6,
                              }}
                            >
                              <ImagePlusIcon size={14} />
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 500,
                                  lineHeight: '18px',
                                  color: C.text,
                                }}
                              >
                                Browse
                              </span>
                            </div>
                          </>
                        )}
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handleGarmentUpload(f);
                          }}
                        />
                      </label>

                      {sareeTwoInputActive && (
                        <label
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 12,
                            background: C.card,
                            border: `1px solid ${C.border}`,
                            borderRadius: 8,
                            padding: 12,
                            cursor: 'pointer',
                            boxSizing: 'border-box',
                            overflow: 'hidden',
                          }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const f = e.dataTransfer.files?.[0];
                            if (f && ['image/jpeg', 'image/png', 'image/webp'].includes(f.type))
                              handlePalluGarmentUpload(f);
                          }}
                        >
                          {palluGarmentFile ? (
                            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              {/* biome-ignore lint/performance/noImgElement: static image, Next Image not needed */}
                              <img
                                src={palluGarmentPreviewUrl}
                                alt={palluGarmentFile.name}
                                style={{
                                  width: '100%',
                                  height: '100%',
                                  objectFit: 'contain',
                                  borderRadius: 6,
                                }}
                              />
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  setPalluGarmentFile(null);
                                  setPalluGarmentKey('');
                                }}
                                style={{
                                  position: 'absolute',
                                  top: 6,
                                  right: 6,
                                  width: 24,
                                  height: 24,
                                  borderRadius: '50%',
                                  background: 'rgba(0,0,0,0.5)',
                                  border: 'none',
                                  color: 'white',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                <XIcon size={14} />
                              </button>
                              {isUploadingPallu && (
                                <div
                                  style={{
                                    position: 'absolute',
                                    bottom: 8,
                                    left: 8,
                                    right: 8,
                                    background: 'rgba(255,255,255,0.95)',
                                    borderRadius: 8,
                                    padding: '6px 10px',
                                  }}
                                >
                                  <div
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 8,
                                      fontSize: 12,
                                      color: C.text,
                                    }}
                                  >
                                    <SpinnerIcon size={14} /> Uploading…
                                  </div>
                                </div>
                              )}
                              {palluGarmentKey && (
                                <div
                                  style={{
                                    position: 'absolute',
                                    top: 8,
                                    left: 8,
                                    background: C.mint,
                                    color: 'white',
                                    borderRadius: 6,
                                    padding: '3px 8px',
                                    fontSize: 11,
                                    fontWeight: 600,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 4,
                                  }}
                                >
                                  <CheckIcon color="#fff" size={10} /> Uploaded
                                </div>
                              )}
                            </div>
                          ) : (
                            <>
                              <div
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  alignItems: 'center',
                                  gap: 4,
                                }}
                              >
                                <span
                                  style={{
                                    width: '100%',
                                    fontSize: 11,
                                    fontWeight: 500,
                                    lineHeight: '100%',
                                    color: C.text,
                                    textAlign: 'center',
                                  }}
                                >
                                  Pallu
                                </span>
                                <span
                                  style={{
                                    width: '100%',
                                    fontSize: 10,
                                    fontWeight: 500,
                                    lineHeight: '140%',
                                    color: C.mid,
                                    textAlign: 'center',
                                  }}
                                >
                                  JPG, PNG · Max 10MB
                                </span>
                              </div>
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: 6,
                                }}
                              >
                                <ImagePlusIcon size={14} />
                                <span
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 500,
                                    lineHeight: '18px',
                                    color: C.text,
                                  }}
                                >
                                  Browse
                                </span>
                              </div>
                            </>
                          )}
                          <input
                            ref={palluFileInputRef}
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) handlePalluGarmentUpload(f);
                            }}
                          />
                        </label>
                      )}

                      {requiresLowerUpload && (
                        <label
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 12,
                            background: C.card,
                            border: `1px solid ${C.border}`,
                            borderRadius: 8,
                            padding: 12,
                            cursor: 'pointer',
                            boxSizing: 'border-box',
                            overflow: 'hidden',
                          }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const f = e.dataTransfer.files?.[0];
                            if (f && ['image/jpeg', 'image/png', 'image/webp'].includes(f.type))
                              handleLowerGarmentUpload(f);
                          }}
                        >
                          {lowerGarmentFile ? (
                            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              {/* biome-ignore lint/performance/noImgElement: static image, Next Image not needed */}
                              <img
                                src={lowerGarmentPreviewUrl}
                                alt={lowerGarmentFile.name}
                                style={{
                                  width: '100%',
                                  height: '100%',
                                  objectFit: 'contain',
                                  borderRadius: 6,
                                }}
                              />
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  setLowerGarmentFile(null);
                                  setLowerGarmentKey('');
                                }}
                                style={{
                                  position: 'absolute',
                                  top: 6,
                                  right: 6,
                                  width: 24,
                                  height: 24,
                                  borderRadius: '50%',
                                  background: 'rgba(0,0,0,0.5)',
                                  border: 'none',
                                  color: 'white',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                <XIcon size={14} />
                              </button>
                              {isUploadingLower && (
                                <div
                                  style={{
                                    position: 'absolute',
                                    bottom: 8,
                                    left: 8,
                                    right: 8,
                                    background: 'rgba(255,255,255,0.95)',
                                    borderRadius: 8,
                                    padding: '6px 10px',
                                  }}
                                >
                                  <div
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 8,
                                      fontSize: 12,
                                      color: C.text,
                                    }}
                                  >
                                    <SpinnerIcon size={14} /> Uploading…
                                  </div>
                                </div>
                              )}
                              {lowerGarmentKey && (
                                <div
                                  style={{
                                    position: 'absolute',
                                    top: 8,
                                    left: 8,
                                    background: C.mint,
                                    color: 'white',
                                    borderRadius: 6,
                                    padding: '3px 8px',
                                    fontSize: 11,
                                    fontWeight: 600,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 4,
                                  }}
                                >
                                  <CheckIcon color="#fff" size={10} /> Uploaded
                                </div>
                              )}
                            </div>
                          ) : (
                            <>
                              <div
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  alignItems: 'center',
                                  gap: 4,
                                }}
                              >
                                <span
                                  style={{
                                    width: '100%',
                                    fontSize: 11,
                                    fontWeight: 500,
                                    lineHeight: '100%',
                                    color: C.text,
                                    textAlign: 'center',
                                  }}
                                >
                                  {selectedGarmentType?.lowerUploadLabel ?? 'Bottom Wear'}
                                </span>
                                <span
                                  style={{
                                    width: '100%',
                                    fontSize: 10,
                                    fontWeight: 500,
                                    lineHeight: '140%',
                                    color: C.mid,
                                    textAlign: 'center',
                                  }}
                                >
                                  JPG, PNG · Max 10MB
                                </span>
                              </div>
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: 6,
                                }}
                              >
                                <ImagePlusIcon size={14} />
                                <span
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 500,
                                    lineHeight: '18px',
                                    color: C.text,
                                  }}
                                >
                                  Browse
                                </span>
                              </div>
                            </>
                          )}
                          <input
                            ref={lowerFileInputRef}
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) handleLowerGarmentUpload(f);
                            }}
                          />
                        </label>
                      )}

                      {selectedGarmentType?.requiresThirdUpload && (
                        <label
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 12,
                            background: C.card,
                            border: `1px solid ${C.border}`,
                            borderRadius: 8,
                            padding: 12,
                            cursor: 'pointer',
                            boxSizing: 'border-box',
                            overflow: 'hidden',
                          }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const f = e.dataTransfer.files?.[0];
                            if (f && ['image/jpeg', 'image/png', 'image/webp'].includes(f.type))
                              handleThirdGarmentUpload(f);
                          }}
                        >
                          {thirdGarmentFile ? (
                            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              {/* biome-ignore lint/performance/noImgElement: static image, Next Image not needed */}
                              <img
                                src={thirdGarmentPreviewUrl}
                                alt={thirdGarmentFile.name}
                                style={{
                                  width: '100%',
                                  height: '100%',
                                  objectFit: 'contain',
                                  borderRadius: 6,
                                }}
                              />
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  setThirdGarmentFile(null);
                                  setThirdGarmentKey('');
                                }}
                                style={{
                                  position: 'absolute',
                                  top: 6,
                                  right: 6,
                                  width: 24,
                                  height: 24,
                                  borderRadius: '50%',
                                  background: 'rgba(0,0,0,0.5)',
                                  border: 'none',
                                  color: 'white',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                <XIcon size={14} />
                              </button>
                              {isUploadingThird && (
                                <div
                                  style={{
                                    position: 'absolute',
                                    bottom: 8,
                                    left: 8,
                                    right: 8,
                                    background: 'rgba(255,255,255,0.95)',
                                    borderRadius: 8,
                                    padding: '6px 10px',
                                  }}
                                >
                                  <div
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 8,
                                      fontSize: 12,
                                      color: C.text,
                                    }}
                                  >
                                    <SpinnerIcon size={14} /> Uploading…
                                  </div>
                                </div>
                              )}
                              {thirdGarmentKey && (
                                <div
                                  style={{
                                    position: 'absolute',
                                    top: 8,
                                    left: 8,
                                    background: C.mint,
                                    color: 'white',
                                    borderRadius: 6,
                                    padding: '3px 8px',
                                    fontSize: 11,
                                    fontWeight: 600,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 4,
                                  }}
                                >
                                  <CheckIcon color="#fff" size={10} /> Uploaded
                                </div>
                              )}
                            </div>
                          ) : (
                            <>
                              <div
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  alignItems: 'center',
                                  gap: 4,
                                }}
                              >
                                <span
                                  style={{
                                    width: '100%',
                                    fontSize: 11,
                                    fontWeight: 500,
                                    lineHeight: '100%',
                                    color: C.text,
                                    textAlign: 'center',
                                  }}
                                >
                                  {selectedGarmentType?.thirdUploadLabel ?? 'Upload Third Garment'}
                                </span>
                                <span
                                  style={{
                                    width: '100%',
                                    fontSize: 10,
                                    fontWeight: 500,
                                    lineHeight: '140%',
                                    color: C.mid,
                                    textAlign: 'center',
                                  }}
                                >
                                  JPG, PNG · Max 10MB
                                </span>
                              </div>
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: 6,
                                }}
                              >
                                <ImagePlusIcon size={14} />
                                <span
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 500,
                                    lineHeight: '18px',
                                    color: C.text,
                                  }}
                                >
                                  Browse
                                </span>
                              </div>
                            </>
                          )}
                          <input
                            ref={thirdFileInputRef}
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) handleThirdGarmentUpload(f);
                            }}
                          />
                        </label>
                      )}
                    </div>

                    {selectedGarmentType?.instructionImageUrl && (
                      <div
                        style={{
                          flex: 1,
                          height: 210,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          minWidth: 0,
                          borderRadius: 8,
                          overflow: 'hidden',
                        }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {/* biome-ignore lint/performance/noImgElement: dynamic instruction image */}
                        <img
                          src={selectedGarmentType.instructionImageUrl}
                          alt="Upload instructions"
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'contain',
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* ── Model ── */}
              <section className="studio-section-card" style={sectionCardStyle}>
                <SectionHead
                  title="Choose AI Model"
                  subtitle="Select the fashion model for your catalogue"
                  stepNumber={4}
                  right={
                    filteredFaces.length > modelVisibleCount && (
                      <button
                        type="button"
                        onClick={() => setModelModalOpen(true)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          height: 16,
                        }}
                      >
                        <span style={{ fontWeight: 600, fontSize: 12, color: '#626262' }}>
                          View All
                        </span>
                      </button>
                    )
                  }
                />
                {facesError ? (
                  <ErrorState
                    compact
                    title="Couldn't load models"
                    message="There was a problem fetching models. Please try again."
                    onRetry={() => refetchFaces()}
                  />
                ) : !faces ? (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'center',
                      padding: '32px 0',
                      color: C.mid,
                    }}
                  >
                    <SpinnerIcon />
                  </div>
                ) : (
                  <div className="studio-5col-grid">
                    {(() => {
                      const inFirstN = filteredFaces
                        .slice(0, modelVisibleCount)
                        .some((f) => f.id === faceId);
                      const selectedFace = faceId
                        ? filteredFaces.find((f) => f.id === faceId)
                        : undefined;
                      const visibleFaces =
                        selectedFace && !inFirstN
                          ? [
                              selectedFace,
                              ...filteredFaces
                                .filter((f) => f.id !== faceId)
                                .slice(0, modelVisibleCount - 1),
                            ]
                          : filteredFaces.slice(0, modelVisibleCount);
                      return visibleFaces.map((f) => (
                        <SelCard
                          key={f.id}
                          selected={faceId === f.id}
                          onClick={() => handleFaceSelect(f.id)}
                          imageUrl={f.thumbnailUrl}
                          label={f.label}
                          w="100%"
                          ratio={215.2 / 212.67}
                        />
                      ));
                    })()}
                  </div>
                )}
                {modelModalOpen && faces && (
                  <SelectGridModal
                    title="Choose your model"
                    items={filteredFaces}
                    selectedIds={faceId ? [faceId] : []}
                    aspect={1}
                    columns={5}
                    hideLabels
                    tagOptions={faceTags}
                    activeTag={modelTagFilter}
                    onTagChange={setModelTagFilter}
                    groupOptions={faceContinents.length > 1 ? faceContinents : undefined}
                    activeGroup={modelContinentFilter}
                    onGroupChange={setModelContinentFilter}
                    groupOf={(f) => f.continent || 'global'}
                    allGroupsLabel="continents"
                    onSelect={(id) => {
                      handleFaceSelect(id);
                      setModelModalOpen(false);
                    }}
                    onClose={() => setModelModalOpen(false)}
                  />
                )}
              </section>

              {/* ── Ready-made catalogue templates ── */}
              {hasCatalogueTemplates && (
                <section className="studio-section-card" style={sectionCardStyle}>
                  <SectionHead
                    title="Create Your Look or Choose From Ready Made Poses"
                    stepNumber={stepNumberOf('templates')}
                    right={
                      catalogueTemplates.length > templateVisibleCount && (
                        <button
                          type="button"
                          onClick={() => setTemplateModalOpen(true)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            height: 16,
                          }}
                        >
                          <span style={{ fontWeight: 600, fontSize: 12, color: '#626262' }}>
                            View more
                          </span>
                        </button>
                      )
                    }
                  />
                  <div className="studio-5col-grid">
                    {(() => {
                      // "Create your own look" (catalogueTemplates[0], id 'custom') is always
                      // pinned first - a selected template that isn't already visible is
                      // inserted right after it, never displacing it from the front.
                      const [custom, ...rest] = catalogueTemplates;
                      const firstNRest = rest.slice(0, templateVisibleCount - 1);
                      const selected = rest.find((template) => template.id === catalogueTemplateId);
                      const visibleRest =
                        selected && !firstNRest.some((template) => template.id === selected.id)
                          ? [selected, ...firstNRest].slice(0, templateVisibleCount - 1)
                          : firstNRest;
                      const visibleTemplates = custom ? [custom, ...visibleRest] : visibleRest;
                      return visibleTemplates.map((template) => (
                        <SelCard
                          key={template.id}
                          selected={catalogueTemplateId === template.id}
                          onClick={() => handleCatalogueTemplateSelect(template.id)}
                          imageUrl={template.thumbnailUrl}
                          label={template.id === 'custom' ? undefined : template.label}
                          w="100%"
                          ratio={3 / 4}
                          imageObjectPosition="top center"
                          fillHeight={template.id === 'custom'}
                          emptyContent={
                            template.id === 'custom' ? (
                              <div
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: 10,
                                  padding: 16,
                                  color: C.text,
                                  width: '100%',
                                  height: '100%',
                                  boxSizing: 'border-box',
                                  position: 'absolute',
                                  inset: 0,
                                }}
                              >
                                <span
                                  style={{
                                    width: 44,
                                    height: 44,
                                    borderRadius: 10,
                                    display: 'grid',
                                    placeItems: 'center',
                                    background: C.white,
                                    border: `1px solid ${C.border}`,
                                    color: C.pink,
                                  }}
                                >
                                  <ImagePlusIcon size={22} />
                                </span>
                                <span
                                  style={{
                                    maxWidth: 110,
                                    fontSize: 12,
                                    fontWeight: 600,
                                    lineHeight: 1.35,
                                    textAlign: 'center',
                                  }}
                                >
                                  Create your own look
                                </span>
                              </div>
                            ) : undefined
                          }
                        />
                      ));
                    })()}
                  </div>
                  {templateModalOpen && (
                    <SelectGridModal
                      title="Select a Ready-Made Catalogue Template"
                      items={catalogueTemplates.filter((template) => template.id !== 'custom')}
                      selectedIds={[catalogueTemplateId]}
                      aspect={3 / 4}
                      columns={5}
                      onSelect={(id) => {
                        handleCatalogueTemplateSelect(id);
                        setTemplateModalOpen(false);
                      }}
                      onClose={() => setTemplateModalOpen(false)}
                    />
                  )}
                  {/* ── Choose Looks (template mode only) ── */}
                  {catalogueTemplateId !== 'custom' && (
                    <div style={{ marginTop: 16 }}>
                      <SectionHead
                        title=""
                        titleSuffix={
                          selectedLookIds.length > 0 && (
                            <span
                              style={{ fontWeight: 500, fontSize: 12, color: C.mid, marginLeft: 6 }}
                            >
                              {selectedLookIds.length} poses selected
                            </span>
                          )
                        }
                      />
                      {(activeTemplate?.looks.length ?? 0) === 0 ? (
                        <p style={{ fontSize: 14, color: C.mid }}>
                          No looks available for this garment type yet.
                        </p>
                      ) : (
                        <div className="studio-5col-grid">
                          {(activeTemplate?.looks ?? []).map((look) => (
                            <SelCard
                              key={look.id}
                              selected={selectedLookIds.includes(look.id)}
                              onClick={() => handleLookToggle(look.id)}
                              imageUrl={look.poseThumbnailUrl}
                              w="100%"
                              ratio={3 / 4}
                              imageObjectPosition="top center"
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}

              {/* ── Background (custom mode only) ── */}
              {catalogueTemplateId === 'custom' && (
                <section className="studio-section-card" style={sectionCardStyle}>
                  <SectionHead
                    title="Select Background"
                    stepNumber={stepNumberOf('background')}
                    right={
                      (backgrounds?.items.length ?? 0) > backgroundVisibleCount && (
                        <button
                          type="button"
                          onClick={() => {
                            setBackgroundItemFilter('');
                            setBackgroundTagFilter('');
                            setBackgroundModalOpen(true);
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            height: 16,
                          }}
                        >
                          <span style={{ fontWeight: 600, fontSize: 12, color: '#626262' }}>
                            View All
                          </span>
                        </button>
                      )
                    }
                  />
                  <div style={{ marginBottom: 20 }}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: C.mid, marginBottom: 8 }}>
                      My backgrounds
                    </p>
                    <div className="studio-5col-grid">
                      <button
                        type="button"
                        onClick={() => setUploadModalOpen(true)}
                        style={{
                          width: '100%',
                          borderRadius: 12,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          cursor: 'pointer',
                          color: C.text,
                          textAlign: 'center',
                          padding: 0,
                          background: 'none',
                          border: 'none',
                        }}
                      >
                        <span
                          style={{
                            width: '100%',
                            aspectRatio: 215.2 / 212.67,
                            borderRadius: 10,
                            border: `1.5px dashed ${C.border}`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            boxSizing: 'border-box',
                          }}
                        >
                          <span
                            style={{
                              width: 36,
                              height: 36,
                              borderRadius: 10,
                              display: 'grid',
                              placeItems: 'center',
                              background: C.card,
                              border: `1px solid ${C.border}`,
                              color: C.pink,
                            }}
                          >
                            <ImagePlusIcon size={18} />
                          </span>
                        </span>
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            padding: '8px 4px 6px',
                            width: '100%',
                          }}
                        >
                          Add background
                        </span>
                      </button>
                      {(myBackgrounds?.items ?? []).map((b) => (
                        <div key={b.id} style={{ position: 'relative' }}>
                          <SelCard
                            selected={backgroundId === b.id}
                            onClick={() => handleBackgroundSelect(b.id)}
                            imageUrl={b.thumbnailUrl}
                            label={b.label}
                            w="100%"
                            ratio={215.2 / 212.67}
                          />
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteMyBackground(b.id);
                            }}
                            style={{
                              position: 'absolute',
                              top: 4,
                              right: 4,
                              width: 22,
                              height: 22,
                              borderRadius: '50%',
                              border: 'none',
                              background: 'rgba(0,0,0,0.55)',
                              color: C.white,
                              cursor: 'pointer',
                              fontSize: 12,
                              lineHeight: 1,
                            }}
                            aria-label={`Delete ${b.label}`}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  {uploadModalOpen && (
                    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop; click outside dismisses
                    <div
                      role="presentation"
                      style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0,0,0,0.4)',
                        zIndex: 1000,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      onClick={() => setUploadModalOpen(false)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setUploadModalOpen(false);
                      }}
                    >
                      {/* biome-ignore lint/a11y/noStaticElementInteractions: modal panel; click swallowed to prevent backdrop dismiss */}
                      <div
                        style={{
                          background: C.white,
                          borderRadius: 12,
                          padding: 24,
                          width: 420,
                          maxWidth: '90vw',
                          boxSizing: 'border-box',
                          boxShadow: '0 10px 40px rgba(0,0,0,0.15)',
                        }}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={() => {}}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            marginBottom: 20,
                          }}
                        >
                          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: 0 }}>
                            Add a background
                          </h2>
                          <button
                            type="button"
                            onClick={() => setUploadModalOpen(false)}
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
                        <label
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 8,
                            padding: '32px 16px',
                            borderRadius: 12,
                            border: `1.5px dashed ${C.border}`,
                            cursor: isUploadingBackground ? 'wait' : 'pointer',
                            fontSize: 13,
                            fontWeight: 600,
                            color: C.text,
                            textAlign: 'center',
                          }}
                        >
                          <ImagePlusIcon size={22} />
                          {isUploadingBackground ? 'Uploading…' : 'Upload an image'}
                          <span style={{ fontSize: 11, fontWeight: 400, color: C.mid }}>
                            JPEG, PNG, or WebP — up to 10 MB
                          </span>
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            style={{ display: 'none' }}
                            disabled={isUploadingBackground}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) handleMyBackgroundUpload(file);
                              e.target.value = '';
                            }}
                          />
                        </label>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            margin: '20px 0',
                            color: C.mid,
                            fontSize: 12,
                          }}
                        >
                          <div style={{ flex: 1, height: 1, background: C.border }} />
                          or paste an image URL
                          <div style={{ flex: 1, height: 1, background: C.border }} />
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input
                            type="text"
                            value={backgroundUrlInput}
                            onChange={(e) => setBackgroundUrlInput(e.target.value)}
                            placeholder="https://example.com/image.jpg"
                            disabled={isFetchingBackgroundUrl}
                            style={{
                              flex: 1,
                              padding: '8px 12px',
                              borderRadius: 8,
                              border: `1px solid ${C.border}`,
                              fontSize: 13,
                              background: C.card,
                              color: C.text,
                            }}
                          />
                          <button
                            type="button"
                            onClick={handleMyBackgroundFromUrl}
                            disabled={isFetchingBackgroundUrl || !backgroundUrlInput.trim()}
                            style={{
                              padding: '8px 16px',
                              borderRadius: 8,
                              border: 'none',
                              background: grad,
                              color: C.white,
                              fontWeight: 600,
                              fontSize: 13,
                              cursor: isFetchingBackgroundUrl ? 'wait' : 'pointer',
                              opacity:
                                isFetchingBackgroundUrl || !backgroundUrlInput.trim() ? 0.6 : 1,
                            }}
                          >
                            {isFetchingBackgroundUrl ? 'Loading…' : 'Add'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  {backgroundsError ? (
                    <ErrorState
                      compact
                      title="Couldn't load backgrounds"
                      message="There was a problem fetching backgrounds. Please try again."
                      onRetry={() => refetchBackgrounds()}
                    />
                  ) : !backgrounds ? (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'center',
                        padding: '32px 0',
                        color: C.mid,
                      }}
                    >
                      <SpinnerIcon />
                    </div>
                  ) : backgrounds.items.length === 0 ? (
                    <p style={{ fontSize: 14, color: C.mid }}>
                      No backgrounds available for this model yet. Try a different model.
                    </p>
                  ) : (
                    <div className="studio-5col-grid">
                      {(() => {
                        const frontIds = new Set(
                          backgrounds.items.filter((b) => b.specialTag).map((b) => b.id),
                        );
                        const allItems = [...backgrounds.items].sort(
                          (a, b) => (frontIds.has(a.id) ? 0 : 1) - (frontIds.has(b.id) ? 0 : 1),
                        );
                        const firstN = allItems.slice(0, backgroundVisibleCount);
                        const inFirstN = firstN.some((b) => b.id === backgroundId);
                        const selected = allItems.find((b) => b.id === backgroundId);
                        const visibleItems =
                          selected && !inFirstN
                            ? [selected, ...firstN].slice(0, backgroundVisibleCount)
                            : firstN;
                        return visibleItems.map((b) => (
                          <SelCard
                            key={b.id}
                            selected={backgroundId === b.id}
                            onClick={() => handleBackgroundSelect(b.id)}
                            imageUrl={b.thumbnailUrl}
                            label={b.label}
                            w="100%"
                            ratio={215.2 / 212.67}
                            badges={<TagBadge tag={b.specialTag} />}
                          />
                        ));
                      })()}
                    </div>
                  )}
                  {backgroundModalOpen &&
                    (() => {
                      const byCategory =
                        backgroundItemFilter === ''
                          ? bgNodes.flatMap(flattenNode)
                          : flattenNode(
                              bgNodes.find((n) => n.id === backgroundItemFilter) ?? {
                                id: 0,
                                slug: '',
                                label: '',
                                thumbnailUrl: null,
                                children: [],
                                items: [],
                              },
                            );
                      const filteredItems =
                        backgroundTagFilter === ''
                          ? byCategory
                          : byCategory.filter((i) =>
                              (bgTagsById.get(i.id) ?? []).includes(backgroundTagFilter),
                            );
                      return (
                        // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop; click outside dismisses
                        <div
                          role="presentation"
                          style={{
                            position: 'fixed',
                            inset: 0,
                            background: 'rgba(0,0,0,0.4)',
                            zIndex: 1000,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                          onClick={() => setBackgroundModalOpen(false)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setBackgroundModalOpen(false);
                          }}
                        >
                          {/* biome-ignore lint/a11y/noStaticElementInteractions: modal panel; click swallowed to prevent backdrop dismiss */}
                          <div
                            style={{
                              background: C.white,
                              borderRadius: 12,
                              padding: 24,
                              width: 1180,
                              height: 857,
                              maxWidth: '90vw',
                              maxHeight: '90vh',
                              overflowY: 'auto',
                              boxSizing: 'border-box',
                              boxShadow: '0 10px 40px rgba(0,0,0,0.15)',
                            }}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={() => {}}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                marginBottom: 16,
                              }}
                            >
                              <h2
                                style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: 0 }}
                              >
                                Select Background
                              </h2>
                              <button
                                type="button"
                                onClick={() => setBackgroundModalOpen(false)}
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
                            <div
                              style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: 8,
                                marginBottom: 20,
                              }}
                            >
                              <button
                                type="button"
                                onClick={() => setBackgroundItemFilter('')}
                                style={pill(backgroundItemFilter === '')}
                              >
                                All
                              </button>
                              {bgNodes.map((node) => (
                                <button
                                  type="button"
                                  key={node.id}
                                  onClick={() => setBackgroundItemFilter(node.id)}
                                  style={pill(backgroundItemFilter === node.id)}
                                >
                                  {node.label}
                                </button>
                              ))}
                            </div>
                            {bgTags.length > 0 && (
                              <div
                                style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: 8,
                                  marginBottom: 20,
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={() => setBackgroundTagFilter('')}
                                  style={pill(backgroundTagFilter === '')}
                                >
                                  All tags
                                </button>
                                {bgTags.map((tag) => (
                                  <button
                                    type="button"
                                    key={tag}
                                    onClick={() => setBackgroundTagFilter(tag)}
                                    style={pill(backgroundTagFilter === tag)}
                                  >
                                    {tag}
                                  </button>
                                ))}
                              </div>
                            )}
                            {filteredItems.length === 0 ? (
                              <p style={{ fontSize: 14, color: C.mid }}>
                                No backgrounds in this category yet.
                              </p>
                            ) : (
                              <div className="studio-5col-grid">
                                {filteredItems.map((i) => (
                                  <SelCard
                                    key={i.id}
                                    selected={backgroundId === i.id}
                                    onClick={() => {
                                      handleBackgroundSelect(i.id);
                                      setBackgroundModalOpen(false);
                                    }}
                                    imageUrl={i.thumbnailUrl}
                                    w="100%"
                                    ratio={215.2 / 212.67}
                                    borderWidth={3}
                                    badges={<TagBadge tag={bgSpecialTagById.get(i.id)} />}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                </section>
              )}

              {/* ── Poses (custom mode only) ── */}
              {catalogueTemplateId === 'custom' && (
                <section className="studio-section-card" style={sectionCardStyle}>
                  <SectionHead
                    title="Choose Poses"
                    stepNumber={stepNumberOf('poses')}
                    titleSuffix={
                      poseIds.length > 0 && (
                        <span
                          style={{ fontWeight: 500, fontSize: 12, color: C.mid, marginLeft: 6 }}
                        >
                          ({poseIds.length} selected)
                        </span>
                      )
                    }
                    right={
                      (poses?.items.length ?? 0) > poseVisibleCount && (
                        <button
                          type="button"
                          onClick={() => setPoseModalOpen(true)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            height: 16,
                          }}
                        >
                          <span style={{ fontWeight: 600, fontSize: 12, color: '#626262' }}>
                            View All
                          </span>
                        </button>
                      )
                    }
                  />
                  {((posePresets?.named.length ?? 0) > 0 || posePresets?.lastUsed) && (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 8,
                        marginBottom: 12,
                      }}
                    >
                      {posePresets?.lastUsed && (
                        <button
                          type="button"
                          onClick={() => handleApplyPosePreset(posePresets.lastUsed!)}
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            padding: '6px 12px',
                            borderRadius: 999,
                            border: `1px solid ${C.border}`,
                            background: '#fff',
                            color: C.text,
                            cursor: 'pointer',
                          }}
                        >
                          Last Used
                        </button>
                      )}
                      {posePresets?.named.map((preset) => (
                        <div
                          key={preset.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            borderRadius: 999,
                            border: `1px solid ${C.border}`,
                            background: '#fff',
                            paddingRight: 6,
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => handleApplyPosePreset(preset)}
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              padding: '6px 8px',
                              border: 'none',
                              background: 'none',
                              color: C.text,
                              cursor: 'pointer',
                            }}
                          >
                            {preset.name}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeletePosePreset(preset.id)}
                            aria-label={`Delete preset ${preset.name}`}
                            style={{
                              display: 'flex',
                              border: 'none',
                              background: 'none',
                              cursor: 'pointer',
                              color: C.mid,
                              padding: 2,
                            }}
                          >
                            <XIcon size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {poseIds.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      {presetNameModalOpen ? (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <input
                            type="text"
                            value={presetNameInput}
                            onChange={(e) => setPresetNameInput(e.target.value)}
                            placeholder="Preset name"
                            maxLength={40}
                            style={{
                              fontSize: 12,
                              padding: '6px 10px',
                              borderRadius: 6,
                              border: `1px solid ${C.border}`,
                            }}
                          />
                          <button
                            type="button"
                            onClick={handleSavePosePreset}
                            disabled={
                              isSavingPosePreset || !presetNameInput.trim() || !garmentTypeId
                            }
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              padding: '6px 12px',
                              borderRadius: 6,
                              border: 'none',
                              background: grad,
                              color: '#fff',
                              cursor: 'pointer',
                            }}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setPresetNameModalOpen(false);
                              setPresetNameInput('');
                            }}
                            style={{
                              fontSize: 12,
                              padding: '6px 10px',
                              border: 'none',
                              background: 'none',
                              color: C.mid,
                              cursor: 'pointer',
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPresetNameModalOpen(true)}
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            padding: 0,
                            border: 'none',
                            background: 'none',
                            color: C.pink,
                            cursor: 'pointer',
                          }}
                        >
                          + Save as preset
                        </button>
                      )}
                    </div>
                  )}
                  {posesError ? (
                    <ErrorState
                      compact
                      title="Couldn't load poses"
                      message="There was a problem fetching poses. Please try again."
                      onRetry={() => refetchPoses()}
                    />
                  ) : !poses ? (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'center',
                        padding: '32px 0',
                        color: C.mid,
                      }}
                    >
                      <SpinnerIcon />
                    </div>
                  ) : poses.items.length === 0 ? (
                    <p style={{ fontSize: 14, color: C.mid }}>
                      No poses for this combination. Go back and try a different background.
                    </p>
                  ) : (
                    <div className="studio-5col-grid">
                      {(() => {
                        const firstN = poses.items.slice(0, poseVisibleCount);
                        const offScreenSelected = poseIds
                          .filter((id) => !firstN.some((p) => p.id === id))
                          .map((id) => poses.items.find((p) => p.id === id))
                          .filter((p): p is PoseItem => !!p);
                        const visiblePoses = [...offScreenSelected, ...firstN].slice(
                          0,
                          poseVisibleCount,
                        );
                        return visiblePoses.map((p) => (
                          <SelCard
                            key={p.id}
                            selected={poseIds.includes(p.id)}
                            onClick={() => handlePoseSelect(p.id)}
                            imageUrl={p.thumbnailUrl}
                            w="100%"
                            // No label shown, but the image still fills the same total
                            // card height other sections get from image + label row
                            // (~28px) combined - so pose cards stay the same height as
                            // the rest of the grid without leaving blank space below.
                            ratio={3 / 4}
                            // Center-crop was cutting off heads/hair on portrait pose
                            // shots - anchor the crop to the top instead.
                            imageObjectPosition="top"
                          />
                        ));
                      })()}
                    </div>
                  )}
                  {poseModalOpen && poses && (
                    <SelectGridModal
                      title="Choose Poses"
                      items={poses.items}
                      selectedIds={poseIds}
                      multiSelect
                      hideLabels
                      aspect={3 / 4}
                      columns={5}
                      onSelect={(id) => handlePoseSelect(id)}
                      onClose={() => setPoseModalOpen(false)}
                      continueLabel="Continue with {count} poses"
                    />
                  )}
                </section>
              )}

              {needsLower &&
                !requiresLowerUpload &&
                (() => {
                  const lowerNodes =
                    lowerCatalog?.tree.filter((node) => node.slug !== 'other') ?? [];
                  const totalItems = lowerNodes.reduce(
                    (n, node) => n + flattenNode(node).length,
                    0,
                  );
                  return (
                    <section className="studio-section-card" style={sectionCardStyle}>
                      <SectionHead
                        title="Lower Garment"
                        stepNumber={stepNumberOf('lower')}
                        right={
                          totalItems > lowerVisibleCount && (
                            <button
                              type="button"
                              onClick={() => {
                                setLowerItemFilter('');
                                setLowerItemsOpen(true);
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                background: 'none',
                                border: 'none',
                                padding: 0,
                                cursor: 'pointer',
                                height: 16,
                              }}
                            >
                              <span style={{ fontWeight: 600, fontSize: 12, color: '#626262' }}>
                                View more
                              </span>
                            </button>
                          )
                        }
                      />
                      {!lowerCatalog ? (
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'center',
                            padding: '24px 0',
                            color: C.mid,
                          }}
                        >
                          <SpinnerIcon />
                        </div>
                      ) : totalItems === 0 ? (
                        <p style={{ fontSize: 14, color: C.mid }}>
                          No lower garment options available yet.
                        </p>
                      ) : (
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(5, 1fr)',
                            gap: 16,
                          }}
                        >
                          {(() => {
                            const allItems = lowerNodes.flatMap(flattenNode);
                            const selectedItem = lowerCatalogId
                              ? allItems.find((i) => i.id === lowerCatalogId)
                              : null;
                            const inFirstN =
                              !!selectedItem &&
                              lowerRandomItems.some((i) => i.id === selectedItem.id);
                            const visibleItems =
                              selectedItem && !inFirstN
                                ? [
                                    selectedItem,
                                    ...lowerRandomItems.filter((i) => i.id !== selectedItem.id),
                                  ].slice(0, lowerVisibleCount)
                                : lowerRandomItems;
                            return visibleItems.map((i) => (
                              <SelCard
                                key={i.id}
                                selected={lowerCatalogId === i.id}
                                onClick={() =>
                                  setLowerCatalogId(lowerCatalogId === i.id ? '' : i.id)
                                }
                                imageUrl={i.thumbnailUrl}
                                w="100%"
                                ratio={3 / 4}
                              />
                            ));
                          })()}
                        </div>
                      )}
                    </section>
                  );
                })()}

              {needsShoes &&
                (() => {
                  const shoeNodes =
                    shoesCatalog?.tree.filter((node) => node.slug !== 'other') ?? [];
                  const totalItems = shoeNodes.reduce((n, node) => n + flattenNode(node).length, 0);
                  return (
                    <section className="studio-section-card" style={sectionCardStyle}>
                      <SectionHead
                        title="Footwear"
                        stepNumber={stepNumberOf('shoes')}
                        right={
                          totalItems > shoeVisibleCount && (
                            <button
                              type="button"
                              onClick={() => {
                                setShoeItemFilter('');
                                setShoeItemsOpen(true);
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                background: 'none',
                                border: 'none',
                                padding: 0,
                                cursor: 'pointer',
                                height: 16,
                              }}
                            >
                              <span style={{ fontWeight: 600, fontSize: 12, color: '#626262' }}>
                                View more
                              </span>
                            </button>
                          )
                        }
                      />
                      {!shoesCatalog ? (
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'center',
                            padding: '24px 0',
                            color: C.mid,
                          }}
                        >
                          <SpinnerIcon />
                        </div>
                      ) : totalItems === 0 ? (
                        <p style={{ fontSize: 14, color: C.mid }}>No shoe options available yet.</p>
                      ) : (
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(5, 1fr)',
                            gap: 16,
                          }}
                        >
                          {(() => {
                            const allItems = shoeNodes.flatMap(flattenNode);
                            const selectedItem = shoeCatalogId
                              ? allItems.find((i) => i.id === shoeCatalogId)
                              : null;
                            const inFirstN =
                              !!selectedItem &&
                              shoeRandomItems.some((i) => i.id === selectedItem.id);
                            const visibleItems =
                              selectedItem && !inFirstN
                                ? [
                                    selectedItem,
                                    ...shoeRandomItems.filter((i) => i.id !== selectedItem.id),
                                  ].slice(0, shoeVisibleCount)
                                : shoeRandomItems;
                            return visibleItems.map((i) => (
                              <SelCard
                                key={i.id}
                                selected={shoeCatalogId === i.id}
                                onClick={() => setShoeCatalogId(shoeCatalogId === i.id ? '' : i.id)}
                                imageUrl={i.thumbnailUrl}
                                w="100%"
                                ratio={215.2 / 212.67}
                              />
                            ));
                          })()}
                        </div>
                      )}
                    </section>
                  );
                })()}

              <section className="studio-section-card" style={sectionCardStyle}>
                <SectionHead title="Publishing Platform" stepNumber={stepNumberOf('platform')} />
                <div className="studio-platforms-grid">
                  {PLATFORMS.map((p, idx) => (
                    <button
                      type="button"
                      key={p}
                      onClick={() => handlePlatformChange(p)}
                      style={{
                        ...pill(platform === p),
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        width: '100%',
                        height: 44,
                        boxSizing: 'border-box',
                        justifyContent: 'center',
                        ...(idx === 6 ? { gridColumn: 2 } : {}),
                      }}
                    >
                      {PLATFORM_LOGOS[p] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          className="dark-logo-bg"
                          src={PLATFORM_LOGOS[p].src}
                          alt={p}
                          style={{
                            height: PLATFORM_LOGOS[p].h,
                            width: 'auto',
                            maxWidth: 80,
                            objectFit: 'contain',
                            display: 'block',
                          }}
                        />
                      ) : (
                        p
                      )}
                    </button>
                  ))}
                </div>
              </section>

              <section className="studio-section-card" style={sectionCardStyle}>
                <SectionHead
                  title="Aspect Ratio"
                  subtitle="Match your platform requirements"
                  stepNumber={stepNumberOf('aspect')}
                />

                {/* ── Pill row: hide presets when custom is active ── */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {aspect !== 'custom' &&
                    ALL_ASPECTS.map((r) => {
                      const supported = brandAspects.includes(r);
                      return (
                        <button
                          type="button"
                          key={r}
                          onClick={supported ? () => setAspect(r) : undefined}
                          style={{
                            ...pill(aspect === r),
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            ...(!supported ? { opacity: 0.35, cursor: 'not-allowed' } : {}),
                          }}
                        >
                          <AspectRatioIcon ratio={r} active={aspect === r} />
                          {r}
                        </button>
                      );
                    })}
                  <button
                    type="button"
                    onClick={() => {
                      setAspect('custom');
                      setCustomRatio('');
                      setCustomWStr('');
                      setCustomHStr('');
                    }}
                    style={{
                      ...pill(aspect === 'custom'),
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <AspectRatioIcon ratio="custom" active={aspect === 'custom'} />
                    Custom Ratio
                  </button>

                  {/* ── Custom inline options ── */}
                  {aspect === 'custom' &&
                    (() => {
                      const [rW, rH] = customRatio ? customRatio.split(':').map(Number) : [0, 0];
                      const wErr = customWErr;
                      const hErr = customHErr;

                      const handleWChange = (val: string) => {
                        setCustomWStr(val);
                        if (rW && rH && val !== '') {
                          const n = Math.round((Number(val) * rH) / rW);
                          setCustomHStr(String(n));
                        }
                      };
                      const handleHChange = (val: string) => {
                        setCustomHStr(val);
                        if (rW && rH && val !== '') {
                          const n = Math.round((Number(val) * rW) / rH);
                          setCustomWStr(String(n));
                        }
                      };

                      const inputBase: React.CSSProperties = {
                        width: 86,
                        padding: '6px 8px',
                        borderRadius: 6,
                        fontSize: 13,
                        color: C.text,
                        background: C.bg,
                        outline: 'none',
                      };

                      return (
                        <>
                          <span
                            style={{ fontSize: 13, color: C.mid, marginLeft: 4, marginRight: 4 }}
                          >
                            Select aspect ratio
                          </span>
                          {ALL_ASPECTS.map((r) => (
                            <button
                              type="button"
                              key={r}
                              onClick={() => {
                                setCustomRatio(r);
                                setCustomWStr('');
                                setCustomHStr('');
                              }}
                              style={{ ...pill(customRatio === r), flexShrink: 0 }}
                            >
                              {r}
                            </button>
                          ))}

                          {customRatio && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div
                                style={{
                                  width: 1,
                                  height: 24,
                                  background: C.border,
                                  flexShrink: 0,
                                  margin: '0 4px',
                                }}
                              />

                              <input
                                type="number"
                                placeholder="Width"
                                value={customWStr}
                                onChange={(e) => handleWChange(e.target.value)}
                                style={{
                                  ...inputBase,
                                  border: `1px solid ${wErr ? '#F55C7A' : C.border}`,
                                }}
                              />

                              <span style={{ fontSize: 13, color: C.light, flexShrink: 0 }}>×</span>

                              <input
                                type="number"
                                placeholder="Height"
                                value={customHStr}
                                onChange={(e) => handleHChange(e.target.value)}
                                style={{
                                  ...inputBase,
                                  border: `1px solid ${hErr ? '#F55C7A' : C.border}`,
                                }}
                              />
                            </div>
                          )}
                        </>
                      );
                    })()}
                </div>

                {aspect === 'custom' && customRatio && (
                  <p
                    style={{
                      fontSize: 11,
                      color: customWErr || customHErr ? '#F55C7A' : C.light,
                      margin: '8px 0 0',
                    }}
                  >
                    {customWErr || customHErr
                      ? `${(customWErr && customWNum < 768) || (customHErr && customHNum < 768) ? 'Min 768px' : `Max ${maxOutputPx}px`}`
                      : `Min 768px · Max ${maxOutputPx}px`}
                  </p>
                )}

                {/* ── Dimension hint ── */}
                {aspect !== 'custom' && (
                  <div style={{ marginTop: 8, fontSize: 11, color: C.light }}>
                    {ASPECT_DIMS[aspect]}
                  </div>
                )}
              </section>

              {/* ── Resolution (read-only, auto-derived from output dims) ── */}
              {resolution && (
                <section className="studio-section-card" style={sectionCardStyle}>
                  <SectionHead
                    title="Output Resolution"
                    stepNumber={stepNumberOf('resolution')}
                    right={
                      <span style={{ fontSize: 11, color: C.light, fontWeight: 400 }}>Auto</span>
                    }
                  />
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    {(
                      [
                        { key: 'HD' as const, label: 'HD' },
                        { key: '2K' as const, label: '2K' },
                        { key: '4K' as const, label: '4K' },
                      ] as const
                    )
                      .filter((r) => resolutionConfig[r.key]?.enabled !== false)
                      .map((r) => {
                        const credits =
                          resolutionConfig[r.key]?.creditCost ?? RESOLUTION_COSTS[r.key];
                        const active = resolution === r.key;
                        return (
                          <div
                            key={r.key}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '8px 16px',
                              borderRadius: 99,
                              border: active ? `1.5px solid ${C.pink}` : `1.5px solid ${C.border2}`,
                              background: active ? 'rgba(245,92,122,0.04)' : C.white,
                              boxSizing: 'border-box',
                              userSelect: 'none',
                              opacity: active ? 1 : 0.45,
                            }}
                          >
                            <div
                              style={{
                                width: 16,
                                height: 16,
                                borderRadius: '50%',
                                border: active ? `5px solid ${C.pink}` : `1.5px solid #BDBDBD`,
                                background: C.white,
                                flexShrink: 0,
                                boxSizing: 'border-box',
                              }}
                            />
                            <span
                              style={{
                                fontSize: 14,
                                fontWeight: 600,
                                color: active ? C.pink : C.text,
                              }}
                            >
                              {r.label}
                            </span>
                            <span
                              style={{
                                fontSize: 13,
                                color: active ? C.pink : C.mid,
                                fontWeight: 400,
                              }}
                            >
                              ({credits} credits)
                            </span>
                          </div>
                        );
                      })}
                  </div>
                </section>
              )}
            </div>

            {/* Footer (pinned, left column only, block effect) */}
            <div className="studio-generate-card">
              {submitError && (
                <div
                  style={{
                    padding: '8px 14px',
                    borderRadius: 8,
                    border: `1px solid ${C.pink}`,
                    background: 'rgba(245,92,122,0.06)',
                    fontSize: 13,
                    color: C.pink,
                  }}
                >
                  {submitError}
                </div>
              )}
              <div
                className="studio-generate-card-row"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 16,
                }}
              >
                {/* Left side: Credit Info */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {/* Credit Icon */}
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 8,
                      border: '1.5px solid rgba(189, 37, 135, 0.15)', // light pink border using new theme
                      background: 'rgba(189, 37, 135, 0.05)', // light pink background
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {/* biome-ignore lint/performance/noImgElement: credit icon */}
                    <img src={`${BASE}/assets/credit.png`} alt="" width={20} height={20} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
                      {creditCost} credits required
                    </span>
                    <span style={{ fontSize: 12, color: C.mid }}>
                      You have {userCredits} credits (
                      {creditCost > 0 ? Math.floor(userCredits / creditCost) : 0} generations)
                    </span>
                  </div>
                </div>

                {/* Right side: Button + ETA */}
                <div
                  className="studio-generate-btn-wrap"
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}
                >
                  <Tooltip tip={generateBlocker || undefined}>
                    <GradBtn
                      onClick={handleSubmit}
                      disabled={!canGenerate}
                      style={{
                        padding: '12px 32px',
                        gap: 8,
                        fontSize: 15,
                        borderRadius: 8,
                        background: canGenerate
                          ? 'linear-gradient(135deg, #7c3aed 0%, #BD2587 100%)'
                          : '#d1d1d6',
                        boxShadow: canGenerate ? '0 4px 12px rgba(124, 58, 237, 0.2)' : 'none',
                      }}
                    >
                      {isSubmitting || generationInProgress ? (
                        <>
                          <SpinnerIcon size={16} /> Generating…
                        </>
                      ) : isUploading ? (
                        <>
                          <SpinnerIcon size={16} /> Uploading…
                        </>
                      ) : (
                        <>
                          <SparkleIcon /> Generate Catalogue
                        </>
                      )}
                    </GradBtn>
                  </Tooltip>
                  <span style={{ fontSize: 11, color: C.light }}>Estimated Time:- 25 seconds</span>
                </div>
              </div>
            </div>
          </div>

          <div className="studio-right-column" id="studio-right-column">
            {activeGeneration ? (
              <GenerationPanel
                catalogueId={activeGeneration.catalogueId}
                jobs={activeGeneration.jobs}
                garmentPreviewUrl={garmentPreviewUrl}
                onAllSettled={() => setGenerationInProgress(false)}
                onCancel={() => {
                  setActiveGeneration(null);
                  setGenerationInProgress(false);
                }}
              />
            ) : (
              <PreviewPanel />
            )}
          </div>
        </div>
      )}

      {/* Garment Type Modal */}
      {garmentModalOpen && garmentTypes && (
        <SelectGridModal
          title="Select Your Garment Type"
          aspect={1}
          columns={5}
          items={garmentTypes.items.map((s) => ({
            id: s.id,
            label: s.label,
            thumbnailUrl:
              s.thumbnailUrl ??
              (() => {
                const fallbackKey = Object.keys(OUTFIT_IMG).find(
                  (k) => s.slug.toLowerCase().includes(k) || s.label.toLowerCase().includes(k),
                );
                return fallbackKey ? OUTFIT_IMG[fallbackKey] : null;
              })(),
          }))}
          selectedIds={garmentTypeId ? [garmentTypeId] : []}
          onSelect={(id) => {
            const changed = id !== garmentTypeId;
            setGarmentTypeId(id);
            setGarmentModalOpen(false);
            if (changed) {
              setFaceId('');
              setCatalogueTemplateId('custom');
              setBackgroundId('');
              setPoseIds([]);
              setLowerCatalogId('');
              setShoeCatalogId('');
            }
          }}
          onClose={() => setGarmentModalOpen(false)}
        />
      )}

      {batchGarmentModalOpen && garmentTypes && (
        <SelectGridModal
          title="Select Your Garment Type"
          aspect={1}
          columns={5}
          items={garmentTypes.items.map((s) => ({
            id: s.id,
            label: s.label,
            thumbnailUrl:
              s.thumbnailUrl ??
              (() => {
                const fallbackKey = Object.keys(OUTFIT_IMG).find(
                  (k) => s.slug.toLowerCase().includes(k) || s.label.toLowerCase().includes(k),
                );
                return fallbackKey ? OUTFIT_IMG[fallbackKey] : null;
              })(),
          }))}
          selectedIds={garmentTypeId ? [garmentTypeId] : []}
          onSelect={(id) => {
            setGarmentTypeId(id);
            setBatchGarmentModalOpen(false);
          }}
          onClose={() => setBatchGarmentModalOpen(false)}
        />
      )}

      {/* Lower Garment items modal — categories act as filters */}
      {lowerItemsOpen &&
        (() => {
          const filteredItems =
            lowerItemFilter === ''
              ? lowerNodes.flatMap(flattenNode)
              : flattenNode(
                  lowerNodes.find((n) => n.id === lowerItemFilter) ?? {
                    id: 0,
                    slug: '',
                    label: '',
                    thumbnailUrl: null,
                    children: [],
                    items: [],
                  },
                );
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop; click outside dismisses
            <div
              role="presentation"
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.4)',
                zIndex: 1000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onClick={() => setLowerItemsOpen(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setLowerItemsOpen(false);
              }}
            >
              {/* biome-ignore lint/a11y/noStaticElementInteractions: modal panel; click swallowed to prevent backdrop dismiss */}
              <div
                style={{
                  background: C.white,
                  borderRadius: 12,
                  padding: 24,
                  width: 1180,
                  height: 857,
                  maxWidth: '90vw',
                  maxHeight: '90vh',
                  overflowY: 'auto',
                  boxSizing: 'border-box',
                  boxShadow: '0 10px 40px rgba(0,0,0,0.15)',
                }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={() => {}}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 16,
                  }}
                >
                  <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: 0 }}>
                    Lower Garment
                  </h2>
                  <button
                    type="button"
                    onClick={() => setLowerItemsOpen(false)}
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
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                  <button
                    type="button"
                    onClick={() => setLowerItemFilter('')}
                    style={pill(lowerItemFilter === '')}
                  >
                    All
                  </button>
                  {lowerNodes.map((node) => (
                    <button
                      type="button"
                      key={node.id}
                      onClick={() => setLowerItemFilter(node.id)}
                      style={pill(lowerItemFilter === node.id)}
                    >
                      {node.label}
                    </button>
                  ))}
                </div>
                {filteredItems.length === 0 ? (
                  <p style={{ fontSize: 14, color: C.mid }}>No items in this category yet.</p>
                ) : (
                  <div className="studio-5col-grid">
                    {filteredItems.map((i) => (
                      <SelCard
                        key={i.id}
                        selected={lowerCatalogId === i.id}
                        onClick={() => {
                          setLowerCatalogId(lowerCatalogId === i.id ? '' : i.id);
                          setLowerItemsOpen(false);
                        }}
                        imageUrl={i.thumbnailUrl}
                        w="100%"
                        ratio={3 / 4}
                        borderWidth={3}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

      {/* Footwear items modal — categories act as filters */}
      {shoeItemsOpen &&
        (() => {
          const filteredItems =
            shoeItemFilter === ''
              ? shoeNodes.flatMap(flattenNode)
              : flattenNode(
                  shoeNodes.find((n) => n.id === shoeItemFilter) ?? {
                    id: 0,
                    slug: '',
                    label: '',
                    thumbnailUrl: null,
                    children: [],
                    items: [],
                  },
                );
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop; click outside dismisses
            <div
              role="presentation"
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.4)',
                zIndex: 1000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onClick={() => setShoeItemsOpen(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setShoeItemsOpen(false);
              }}
            >
              {/* biome-ignore lint/a11y/noStaticElementInteractions: modal panel; click swallowed to prevent backdrop dismiss */}
              <div
                style={{
                  background: C.white,
                  borderRadius: 12,
                  padding: 24,
                  width: 1180,
                  height: 857,
                  maxWidth: '90vw',
                  maxHeight: '90vh',
                  overflowY: 'auto',
                  boxSizing: 'border-box',
                  boxShadow: '0 10px 40px rgba(0,0,0,0.15)',
                }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={() => {}}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 16,
                  }}
                >
                  <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: 0 }}>
                    Footwear
                  </h2>
                  <button
                    type="button"
                    onClick={() => setShoeItemsOpen(false)}
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
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                  <button
                    type="button"
                    onClick={() => setShoeItemFilter('')}
                    style={pill(shoeItemFilter === '')}
                  >
                    All
                  </button>
                  {shoeNodes.map((node) => (
                    <button
                      type="button"
                      key={node.id}
                      onClick={() => setShoeItemFilter(node.id)}
                      style={pill(shoeItemFilter === node.id)}
                    >
                      {node.label}
                    </button>
                  ))}
                </div>
                {filteredItems.length === 0 ? (
                  <p style={{ fontSize: 14, color: C.mid }}>No items in this category yet.</p>
                ) : (
                  <div className="studio-5col-grid">
                    {filteredItems.map((i) => (
                      <SelCard
                        key={i.id}
                        selected={shoeCatalogId === i.id}
                        onClick={() => {
                          setShoeCatalogId(shoeCatalogId === i.id ? '' : i.id);
                          setShoeItemsOpen(false);
                        }}
                        imageUrl={i.thumbnailUrl}
                        w="100%"
                        ratio={215.2 / 212.67}
                        borderWidth={3}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

      {/* Amazon Pose Picker Modal */}
      {amazonPoseModalOpen && (
        // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop; click outside dismisses
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={() => setAmazonPoseModalOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setAmazonPoseModalOpen(false);
          }}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: modal panel; click swallowed to prevent backdrop dismiss */}
          <div
            style={{
              background: C.white,
              borderRadius: 16,
              padding: 32,
              maxWidth: 600,
              width: 'calc(100vw - 40px)',
              maxHeight: '80vh',
              overflowY: 'auto',
              boxShadow: '0 8px 40px rgba(0,0,0,0.15)',
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={() => {}}
          >
            <h2
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: C.text,
                marginBottom: 6,
              }}
            >
              Select Amazon main image pose
            </h2>
            <p style={{ fontSize: 13, color: C.mid, marginBottom: 16 }}>
              All {selectedPoses.length} poses will be generated. Pick which one gets the white
              Amazon-compliant background as the main listing image.
            </p>

            {whiteBg && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 14px',
                  borderRadius: 10,
                  border: `1px solid ${C.border2}`,
                  background: '#fafafa',
                  marginBottom: 20,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {/* biome-ignore lint/performance/noImgElement: static image, Next Image not needed */}
                <img
                  src={whiteBg.previewUrl}
                  alt="White background"
                  style={{
                    width: 64,
                    height: 48,
                    objectFit: 'cover',
                    borderRadius: 6,
                    border: `1px solid ${C.border}`,
                  }}
                />
                <div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>
                    {whiteBg.label}
                  </span>
                  <span style={{ fontSize: 11, color: C.light, display: 'block', marginTop: 2 }}>
                    White background will replace original
                  </span>
                </div>
              </div>
            )}

            <p style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 12 }}>
              Selected poses:
            </p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, 152.57px)',
                gap: 12,
                justifyContent: 'center',
              }}
            >
              {selectedPoses.map((p) => (
                <SelCard
                  key={p.id}
                  selected={amazonMainPoseId === p.id}
                  onClick={() => setAmazonMainPoseId(p.id)}
                  imageUrl={p.thumbnailUrl}
                  label={p.label}
                  w={152.57}
                  h={200}
                />
              ))}
            </div>
            <div style={{ marginTop: 24, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setAmazonPoseModalOpen(false)}
                style={{
                  padding: '10px 24px',
                  borderRadius: 8,
                  border: `1px solid ${C.border2}`,
                  background: C.white,
                  fontFamily: 'inherit',
                  fontSize: 14,
                  cursor: 'pointer',
                  color: C.mid,
                }}
              >
                Cancel
              </button>
              <GradBtn
                onClick={() => submitAmazonPose(amazonMainPoseId)}
                disabled={!amazonMainPoseId || isSubmitting}
                style={{ padding: '10px 28px', gap: 8 }}
              >
                {isSubmitting ? (
                  <>
                    <SpinnerIcon size={16} /> Generating…
                  </>
                ) : (
                  <>
                    <SparkleIcon /> Generate
                  </>
                )}
              </GradBtn>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: C.dark,
            color: C.onDark,
            padding: '10px 16px',
            borderRadius: 8,
            fontSize: 13,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            maxWidth: 480,
          }}
        >
          <span>{toast}</span>
          <button
            type="button"
            onClick={() => setToast('')}
            style={{
              background: 'none',
              border: 'none',
              color: 'rgba(255,255,255,0.6)',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: 0,
              flexShrink: 0,
            }}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}
