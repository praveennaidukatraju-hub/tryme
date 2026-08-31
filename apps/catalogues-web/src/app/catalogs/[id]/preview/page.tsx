'use client';
import { useQueries, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { use, useEffect, useRef, useState } from 'react';
import { ArrowLeft, MonitorIcon, SmartphoneIcon, SpinnerIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { api } from '@/lib/api';
import {
  AmazonDesktopTemplate,
  AmazonMobileTemplate,
  aspectToCss,
  BrowserShell,
  FramedAjioDesktopTemplate,
  FramedAjioMobileTemplate,
  FramedFlipkartDesktopTemplate,
  FramedFlipkartMobileTemplate,
  FramedMeeshoDesktopTemplate,
  FramedMeeshoMobileTemplate,
  FramedMyntraDesktopTemplate,
  FramedMyntraMobileTemplate,
  FramedNykaaDesktopTemplate,
  FramedNykaaMobileTemplate,
  FramedShopifyDesktopTemplate,
  FramedShopifyMobileTemplate,
  PhoneShell,
} from '../../../(app)/catalogs/[id]/preview/templates';

interface Job {
  id: string;
  status: string;
  createdAt: string;
  creditsCharged: number;
}

interface CatalogueDetail {
  catalogueId: string;
  jobs: Job[];
  aspectRatio: string | null;
  platform?: string | null;
  gender?: string | null;
  garmentName?: string | null;
}

type ViewMode = 'web' | 'mobile';
type PreviewTemplateProps = {
  images: Array<string | undefined>;
  activeIndex: number;
  onActiveChange: (i: number) => void;
  ratio: string;
  gender?: string | null;
  garmentName?: string | null;
};

const PLATFORM_DOMAINS: Record<string, string> = {
  Amazon: 'amazon.in',
  Flipkart: 'flipkart.com',
  Myntra: 'myntra.com',
  AJIO: 'ajio.com',
  Meesho: 'meesho.com',
  'Nykaa Fashion': 'nykaafashion.com',
  Shopify: 'store.myshopify.com',
};

function DesktopPlatformTemplate({
  platform,
  ...props
}: PreviewTemplateProps & { platform?: string | null }) {
  switch (platform) {
    case 'Flipkart':
      return <FramedFlipkartDesktopTemplate {...props} />;
    case 'Myntra':
      return <FramedMyntraDesktopTemplate {...props} />;
    case 'AJIO':
      return <FramedAjioDesktopTemplate {...props} />;
    case 'Meesho':
      return <FramedMeeshoDesktopTemplate {...props} />;
    case 'Nykaa Fashion':
      return <FramedNykaaDesktopTemplate {...props} />;
    case 'Shopify':
      return <FramedShopifyDesktopTemplate {...props} />;
    default:
      return <AmazonDesktopTemplate {...props} />;
  }
}

function MobilePlatformTemplate({
  platform,
  ...props
}: PreviewTemplateProps & { platform?: string | null }) {
  switch (platform) {
    case 'Flipkart':
      return <FramedFlipkartMobileTemplate {...props} />;
    case 'Myntra':
      return <FramedMyntraMobileTemplate {...props} />;
    case 'AJIO':
      return <FramedAjioMobileTemplate {...props} />;
    case 'Meesho':
      return <FramedMeeshoMobileTemplate {...props} />;
    case 'Nykaa Fashion':
      return <FramedNykaaMobileTemplate {...props} />;
    case 'Shopify':
      return <FramedShopifyMobileTemplate {...props} />;
    default:
      return <AmazonMobileTemplate {...props} />;
  }
}

function PreviewToolbar({
  id,
  platform,
  viewMode,
  onViewModeChange,
}: {
  id: string;
  platform: string;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}) {
  return (
    <header
      style={{
        height: 78,
        padding: '0 32px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: `1px solid ${C.border}`,
        background: '#fff',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
        <Link
          href={`/catalogs/${id}`}
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            border: `1px solid ${C.border}`,
            color: C.text,
            display: 'grid',
            placeItems: 'center',
            textDecoration: 'none',
            background: '#fff',
          }}
          aria-label="Back to catalogue"
        >
          <ArrowLeft />
        </Link>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 19, color: C.text, letterSpacing: 0 }}>
            Live Platform Preview
          </div>
          <div
            style={{
              fontSize: 12,
              color: C.mid,
              marginTop: 3,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            Framed {platform} marketplace preview for your generated catalogue output.
          </div>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Preview device"
        style={{
          display: 'flex',
          gap: 4,
          padding: 4,
          borderRadius: 12,
          border: `1px solid ${C.border}`,
          background: '#fff',
          boxShadow: '0 1px 2px rgba(20,20,20,0.04)',
        }}
      >
        {(['web', 'mobile'] as const).map((mode) => {
          const isActive = viewMode === mode;
          return (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onViewModeChange(mode)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '0 16px',
                height: 36,
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                background: isActive ? C.pink : 'transparent',
                color: isActive ? '#fff' : C.mid,
                fontFamily: 'inherit',
                fontSize: 14,
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              {mode === 'web' ? <MonitorIcon size={16} /> : <SmartphoneIcon size={16} />}
              {mode === 'web' ? 'Web View' : 'Mobile View'}
            </button>
          );
        })}
      </div>
    </header>
  );
}

function PreviewStage({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{
        flex: 1,
        overflow: 'auto',
        background: '#f5f6f8',
        padding: '30px clamp(18px, 4vw, 56px)',
      }}
    >
      <section
        aria-label="Marketplace preview canvas"
        style={{
          minHeight: 'calc(100vh - 138px)',
          border: `1px solid ${C.border}`,
          borderRadius: 18,
          background: 'linear-gradient(180deg, #ffffff 0%, #f8f9fb 100%)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9)',
          padding: 'clamp(20px, 3vw, 42px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {children}
      </section>
    </main>
  );
}

function BrowserFrame({
  children,
  scrollRef,
  domain,
}: {
  children: React.ReactNode;
  scrollRef: React.Ref<HTMLDivElement>;
  domain: string;
}) {
  return (
    <div
      style={{
        width: 'min(1180px, 100%)',
        transformOrigin: 'top center',
      }}
    >
      <BrowserShell scrollRef={scrollRef} domain={domain}>
        {children}
      </BrowserShell>
    </div>
  );
}

function DeviceFrame({
  viewMode,
  children,
  scrollRef,
  domain,
}: {
  viewMode: ViewMode;
  children: React.ReactNode;
  scrollRef: React.Ref<HTMLDivElement>;
  domain: string;
}) {
  if (viewMode === 'mobile') {
    return <PhoneShell scrollRef={scrollRef}>{children}</PhoneShell>;
  }

  return (
    <BrowserFrame scrollRef={scrollRef} domain={domain}>
      {children}
    </BrowserFrame>
  );
}

function PlatformPreviewRenderer({
  viewMode,
  platform,
  domain,
  templateProps,
  scrollRef,
}: {
  viewMode: ViewMode;
  platform: string;
  domain: string;
  templateProps: PreviewTemplateProps;
  scrollRef: React.Ref<HTMLDivElement>;
}) {
  return (
    <DeviceFrame viewMode={viewMode} scrollRef={scrollRef} domain={domain}>
      {viewMode === 'web' ? (
        <DesktopPlatformTemplate platform={platform} {...templateProps} />
      ) : (
        <MobilePlatformTemplate platform={platform} {...templateProps} />
      )}
    </DeviceFrame>
  );
}

function EmptyPreview({ id }: { id: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '64px 24px', color: C.mid }}>
      <p style={{ fontWeight: 700, fontSize: 18, color: C.text, marginBottom: 8 }}>
        Nothing to preview yet
      </p>
      <p style={{ fontSize: 14, marginBottom: 24 }}>
        This catalogue has no completed images. Once generation finishes, you can preview them here.
      </p>
      <Link
        href={`/catalogues/${id}`}
        style={{ fontSize: 14, color: C.pink, textDecoration: 'none', fontWeight: 600 }}
      >
        Back to catalogue
      </Link>
    </div>
  );
}

function LivePlatformPreviewPage({ id }: { id: string }): React.ReactElement {
  const searchParams = useSearchParams();
  const jobId = searchParams.get('jobId');
  const [viewMode, setViewMode] = useState<ViewMode>('web');
  const [activeIndex, setActiveIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: catalogue, isLoading } = useQuery<CatalogueDetail>({
    queryKey: ['catalogue', id],
    queryFn: () => api.get(`/v1/catalogues/${id}`),
  });

  const completedJobs = (catalogue?.jobs ?? []).filter((j) => j.status === 'COMPLETED');

  useEffect(() => {
    if (jobId && completedJobs.length > 0) {
      const idx = completedJobs.findIndex((j) => j.id === jobId);
      if (idx !== -1) {
        setActiveIndex(idx);
      }
    }
  }, [jobId, completedJobs]);

  const resultQueries = useQueries({
    queries: completedJobs.map((job) => ({
      queryKey: ['job-result', job.id],
      queryFn: () => api.get<{ url: string }>(`/v1/jobs/${job.id}/result`),
      staleTime: 4 * 60 * 1000,
    })),
  });

  const imageSlots = resultQueries.map((q) => q.data?.url);
  const cssRatio = aspectToCss(catalogue?.aspectRatio);
  const hasImages = completedJobs.length > 0;
  const clampedIndex = Math.min(activeIndex, Math.max(0, imageSlots.length - 1));
  const platform = catalogue?.platform ?? 'Amazon';
  const browserDomain = PLATFORM_DOMAINS[platform] ?? PLATFORM_DOMAINS.Amazon ?? 'amazon.in';

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll position reset on view change
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [viewMode, platform]);

  useEffect(() => {
    if (activeIndex > 0 && activeIndex >= completedJobs.length) setActiveIndex(0);
  }, [completedJobs.length, activeIndex]);

  const templateProps: PreviewTemplateProps = {
    images: imageSlots,
    activeIndex: clampedIndex,
    onActiveChange: setActiveIndex,
    ratio: cssRatio,
    gender: catalogue?.gender,
    garmentName: catalogue?.garmentName,
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#f5f6f8',
        color: C.text,
      }}
    >
      <PreviewToolbar
        id={id}
        platform={platform}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />

      <PreviewStage>
        {isLoading && (
          <div
            style={{ display: 'flex', justifyContent: 'center', padding: '64px 0', color: C.mid }}
          >
            <SpinnerIcon />
          </div>
        )}

        {!isLoading && !hasImages && <EmptyPreview id={id} />}

        {!isLoading && hasImages && (
          <PlatformPreviewRenderer
            viewMode={viewMode}
            platform={platform}
            domain={browserDomain}
            templateProps={templateProps}
            scrollRef={scrollRef}
          />
        )}
      </PreviewStage>
    </div>
  );
}

export default function PreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.ReactElement {
  const { id } = use(params);
  return <LivePlatformPreviewPage id={id} />;
}
