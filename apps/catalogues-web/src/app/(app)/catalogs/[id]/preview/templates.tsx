'use client';
import { useState } from 'react';

// ─── template content ─────────────────────────────────────────────────────────
// Hardcoded for v1. Future: accept user-supplied product metadata.

const TC = {
  store: 'FURBO',
  title: 'Women Solid Puff Sleeve Peplum Top - Stylish Ruched Square Neck Casual Top for Women',
  rating: 3.9,
  ratingCount: 44,
  price: '999',
  mrp: '1,999',
  discount: '50%',
  sizes: ['S', 'M', 'L', 'XL', 'XXL'],
  defaultSize: 'M',
};

// ─── helpers ──────────────────────────────────────────────────────────────────

// Convert pipeline ratio string ("3:4") → CSS aspect-ratio ("3 / 4").
export function aspectToCss(ratio: string | null | undefined): string {
  if (!ratio) return '1 / 1';
  const [w, h] = ratio.split(':');
  return w && h ? `${w} / ${h}` : '1 / 1';
}

interface TemplateProps {
  images: Array<string | undefined>;
  activeIndex: number;
  onActiveChange: (i: number) => void;
  ratio: string;
  gender?: string | null;
  garmentName?: string | null;
}

const PLATFORM_LOGO_ASSETS = {
  amazon: {
    default: '/assets/platform-logos/amazon-logo.svg',
    light: '/assets/platform-logos/amazon-logo-light.svg',
    alt: 'Amazon',
  },
  flipkart: {
    default: '/assets/platform-logos/flipkart-logo-current.png',
    alt: 'Flipkart',
  },
  ajio: {
    default: '/assets/platform-logos/ajio-logo.svg',
    alt: 'AJIO',
  },
  meesho: {
    default: '/assets/platform-logos/meesho-wordmark.svg',
    alt: 'Meesho',
  },
  nykaa: {
    default: '/assets/platform-logos/nykaa-logo.svg',
    alt: 'Nykaa',
  },
} as const;

type PlatformLogoName = keyof typeof PLATFORM_LOGO_ASSETS;

const MARKETPLACE_FONTS = {
  amazon: 'Arial, Helvetica, sans-serif',
  flipkart: 'Roboto, Arial, sans-serif',
  myntra:
    'Assistant, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  ajio: '"Source Sans Pro", Inter, Arial, Helvetica, sans-serif',
  meesho: '"Mier Book", Inter, Arial, Helvetica, sans-serif',
  nykaa: 'Inter, Roboto, Arial, Helvetica, sans-serif',
  shopifyBody: 'Inter, Arial, Helvetica, sans-serif',
  shopifyHeading: 'Georgia, "Times New Roman", serif',
} as const;

function MarketplaceLogo({
  platform,
  variant = 'default',
  width,
  height,
  style,
}: {
  platform: PlatformLogoName;
  variant?: 'default' | 'light';
  width: number;
  height: number;
  style?: React.CSSProperties;
}) {
  const config = PLATFORM_LOGO_ASSETS[platform];
  const src = variant === 'light' && 'light' in config ? config.light : config.default;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    // biome-ignore lint/performance/noImgElement: local marketplace logos are fixed preview assets
    <img
      src={src}
      alt={config.alt}
      width={width}
      height={height}
      style={{
        width,
        height,
        objectFit: 'contain',
        display: 'block',
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

// ─── product image ─────────────────────────────────────────────────────────────
// Reserves space via aspect-ratio (no CLS). Warm #f7f7f7 background mirrors
// marketplace image zones. Shimmer skeleton fades to image on load.

function ProductImage({ src, ratio }: { src?: string; ratio: string }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: ratio,
        background: '#f7f7f7',
        overflow: 'hidden',
      }}
    >
      {(!src || !loaded) && (
        <div className="av-shimmer" style={{ position: 'absolute', inset: 0 }} aria-hidden="true" />
      )}
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        // biome-ignore lint/performance/noImgElement: generated catalogue preview image
        <img
          src={src}
          alt="Generated catalogue preview"
          onLoad={() => setLoaded(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            objectPosition: 'center',
            opacity: loaded ? 1 : 0,
            transition: 'opacity 240ms ease',
          }}
        />
      )}
    </div>
  );
}

// ─── star rating ──────────────────────────────────────────────────────────────

function Stars({ rating, size = 14 }: { rating: number; size?: number }) {
  const pct = (rating / 5) * 100;
  return (
    <span
      role="img"
      aria-label={`${rating} out of 5 stars`}
      style={{ position: 'relative', display: 'inline-block', fontSize: size, lineHeight: 1 }}
    >
      <span style={{ color: '#d5d9d9', letterSpacing: 1 }}>★★★★★</span>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${pct}%`,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          color: '#de7921',
          letterSpacing: 1,
        }}
      >
        ★★★★★
      </span>
    </span>
  );
}

// ─── offer / coupon block ──────────────────────────────────────────────────────
// The single highest-recognition Amazon fidelity signal.

function OfferBlock({ compact = false }: { compact?: boolean }) {
  const offers = [
    {
      label: 'Bank Offer',
      text: compact
        ? 'Upto ₹3,000 off on HDFC Credit Cards'
        : 'Upto ₹3,000 instant discount on HDFC Bank Credit/Debit Cards',
      count: '3 offers',
    },
    {
      label: 'No Cost EMI',
      text: compact ? 'from ₹167/month' : 'No Cost EMI available on select cards from ₹167/month',
      count: '2 offers',
    },
    {
      label: 'Cashback',
      text: compact ? 'Get ₹10 on Amazon Pay' : 'Get ₹10 cashback when you pay via Amazon Pay',
      count: '1 offer',
    },
  ];
  return (
    <div
      style={{
        border: '1px solid #e4e4e4',
        borderRadius: 4,
        overflow: 'hidden',
        marginTop: compact ? 10 : 14,
      }}
    >
      <div
        style={{
          background: '#f4f6f8',
          padding: compact ? '5px 10px' : '6px 12px',
          borderBottom: '1px solid #e4e4e4',
          fontSize: 11,
          fontWeight: 700,
          color: '#0f1111',
        }}
      >
        Applicable Offers
      </div>
      {offers.map((o, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static offer list — index is stable
          key={i}
          style={{
            padding: compact ? '7px 10px' : '8px 12px',
            borderBottom: i < offers.length - 1 ? '1px solid #f0f0f0' : 'none',
            fontSize: 11,
            lineHeight: 1.4,
            display: 'flex',
            gap: 6,
          }}
        >
          <b style={{ color: '#cc0c39', flexShrink: 0 }}>{o.label}</b>
          <span style={{ color: '#565959' }}>
            {o.text}
            {!compact && <span style={{ color: '#007185', marginLeft: 4 }}>· {o.count}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── decorative glyphs (marketplace chrome, all aria-hidden) ─────────────────

const gp = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const MenuG = ({ color = '#fff' }: { color?: string }) => (
  // biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden set via {...gp} spread above
  <svg width="20" height="20" viewBox="0 0 24 24" style={{ color }} {...gp}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </svg>
);
const CartG = ({ color = '#fff', size = 22 }: { color?: string; size?: number }) => (
  // biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden set via {...gp} spread above
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ color }} {...gp}>
    <circle cx="9" cy="21" r="1" />
    <circle cx="20" cy="21" r="1" />
    <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
  </svg>
);
const SearchG = ({ color = '#0f1111' }: { color?: string }) => (
  // biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden set via {...gp} spread above
  <svg width="18" height="18" viewBox="0 0 24 24" style={{ color }} {...gp}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.34-4.34" />
  </svg>
);
const LockG = () => (
  // biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden set via {...gp} spread above
  <svg width="11" height="11" viewBox="0 0 24 24" style={{ color: '#5f6368' }} {...gp}>
    <rect width="18" height="11" x="3" y="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

// ─── device shells ─────────────────────────────────────────────────────────────

// Generic premium Android phone — no OEM branding, no status bar clutter.
// Punch-hole camera + slim bezels is recognisable as modern flagship without trademark.
export function PhoneShell({
  children,
  scrollRef,
}: {
  children: React.ReactNode;
  scrollRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      style={{
        width: 360,
        maxWidth: '100%',
        background: '#0d0d0f',
        borderRadius: 46,
        padding: 12,
        boxShadow: '0 30px 60px rgba(0,0,0,0.28), 0 8px 20px rgba(0,0,0,0.14)',
        position: 'relative',
        flexShrink: 0,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 22,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: '#000',
          border: '1.5px solid #23232a',
          zIndex: 3,
        }}
      />
      <div
        ref={scrollRef}
        className="preview-phone-scroll"
        style={{
          height: 720,
          maxHeight: '72vh',
          background: '#fff',
          borderRadius: 36,
          position: 'relative',
          paddingRight: 2,
        }}
      >
        {children}
      </div>
    </div>
  );
}

// Generic browser window — domain-only URL, no Apple hardware.
export function BrowserShell({
  children,
  scrollRef,
  domain = 'amazon.in',
}: {
  children: React.ReactNode;
  scrollRef?: React.Ref<HTMLDivElement>;
  domain?: string;
}) {
  return (
    <div
      style={{
        width: 1020,
        maxWidth: '100%',
        background: '#fff',
        borderRadius: 10,
        overflow: 'hidden',
        border: '1px solid #ddd',
        boxShadow: '0 30px 70px rgba(0,0,0,0.18), 0 8px 24px rgba(0,0,0,0.07)',
      }}
    >
      {/* chrome bar */}
      <div
        style={{
          height: 34,
          background: '#f1f1f2',
          borderBottom: '1px solid #dadada',
          display: 'flex',
          alignItems: 'center',
          padding: '0 10px',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', gap: 5 }} aria-hidden="true">
          {['#ff5f57', '#febc2e', '#28c840'].map((bg) => (
            <span
              key={bg}
              style={{
                width: 11,
                height: 11,
                borderRadius: '50%',
                background: bg,
                display: 'block',
              }}
            />
          ))}
        </div>
        <div
          style={{
            flex: 1,
            maxWidth: 460,
            margin: '0 auto',
            height: 22,
            background: '#fff',
            borderRadius: 11,
            border: '1px solid #dadada',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 10px',
            fontSize: 11.5,
            color: '#5f6368',
          }}
        >
          <LockG />
          {domain}
        </div>
        <div style={{ width: 40 }} aria-hidden="true" />
      </div>
      <div
        ref={scrollRef}
        style={{ height: 640, maxHeight: '68vh', overflow: 'auto', background: '#fff' }}
      >
        {children}
      </div>
    </div>
  );
}

// ─── Amazon mobile template ───────────────────────────────────────────────────

export function AmazonMobileTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
}: TemplateProps) {
  const [size, setSize] = useState(TC.defaultSize);
  const active = images[activeIndex];

  return (
    <div style={{ fontFamily: MARKETPLACE_FONTS.amazon, fontSize: 13, color: '#0f1111' }}>
      {/* header — slim */}
      <div
        style={{
          background: '#131921',
          padding: '8px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <MenuG />
        <MarketplaceLogo platform="amazon" variant="light" width={78} height={24} />
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: '#fff',
          }}
        >
          <span style={{ fontSize: 11 }}>Sign in ›</span>
          <CartG size={19} />
        </div>
      </div>

      {/* search */}
      <div style={{ background: '#232f3e', padding: '6px 8px', display: 'flex' }}>
        <div
          style={{
            flex: 1,
            background: '#fff',
            borderRadius: '4px 0 0 4px',
            display: 'flex',
            alignItems: 'center',
            padding: '0 10px',
            fontSize: 12,
            color: '#888',
            height: 30,
          }}
        >
          Search Amazon.in
        </div>
        <div
          style={{
            width: 38,
            background: '#febd69',
            borderRadius: '0 4px 4px 0',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <SearchG />
        </div>
      </div>

      {/* delivery strip — compressed */}
      <div style={{ background: '#37475a', color: '#fff', fontSize: 10.5, padding: '4px 10px' }}>
        Delivering to Hyderabad 500032 · <span style={{ color: '#febd69' }}>Update location</span>
      </div>

      {/* product image — appears immediately with no nav clutter above */}
      <ProductImage src={active} ratio={ratio} />

      {/* carousel dots — only show for resolved image slots */}
      {(() => {
        const resolved = images.map((url, i) => ({ url, i })).filter(({ url }) => Boolean(url));
        if (resolved.length <= 1) return null;
        return (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 4, padding: '7px 0 3px' }}>
            {resolved.map(({ i }) => (
              <button
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                aria-label={`Show image ${i + 1}`}
                style={{
                  width: i === activeIndex ? 9 : 7,
                  height: i === activeIndex ? 9 : 7,
                  borderRadius: '50%',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  background: i === activeIndex ? '#007185' : '#c7cdd1',
                }}
              />
            ))}
          </div>
        );
      })()}

      {/* details */}
      <div style={{ padding: '10px 12px 28px' }}>
        {/* Amazon's Choice — mobile sizing */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            background: '#232f3e',
            borderRadius: 3,
            padding: '2px 6px',
            marginBottom: 4,
          }}
        >
          <span style={{ color: '#fff', fontSize: 9, fontWeight: 700 }}>Amazon's</span>
          <span style={{ color: '#ff9900', fontSize: 9, fontWeight: 700 }}>Choice</span>
          <span style={{ color: '#ccc', fontSize: 8.5, marginLeft: 1 }}>in Women's Tops</span>
        </div>
        <div style={{ color: '#007185', fontSize: 11, marginBottom: 3 }}>
          Visit the {TC.store} Store
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.2, marginBottom: 6 }}>{TC.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 8 }}>
          <span style={{ fontSize: 12 }}>{TC.rating}</span>
          <Stars rating={TC.rating} />
          <span style={{ color: '#007185', fontSize: 11 }}>({TC.ratingCount})</span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {[
            { label: 'Add to Wish List', icon: <HeartIcon size={14} color="#007185" /> },
            { label: 'Share', icon: <ShareIcon size={14} color="#007185" /> },
          ].map((action) => (
            <button
              key={action.label}
              type="button"
              style={{
                flex: 1,
                height: 30,
                borderRadius: 15,
                border: '1px solid #d5d9d9',
                background: '#fff',
                color: '#007185',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>

        {/* price */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ color: '#cc0c39', fontSize: 16 }}>-{TC.discount}</span>
          <span style={{ fontSize: 11, marginTop: 1 }}>
            ₹<span style={{ fontSize: 22, fontWeight: 500 }}>{TC.price}</span>
            <sup>00</sup>
          </span>
        </div>
        <div style={{ fontSize: 11, color: '#565959', marginBottom: 2 }}>
          M.R.P.: <span style={{ textDecoration: 'line-through' }}>₹{TC.mrp}</span>
        </div>
        <div style={{ fontSize: 10.5, color: '#565959', marginBottom: 8 }}>
          Inclusive of all taxes
        </div>

        {/* delivery */}
        <div
          style={{
            border: '1px solid #eee',
            borderRadius: 6,
            padding: '8px 10px',
            fontSize: 11,
            marginBottom: 10,
            lineHeight: 1.45,
          }}
        >
          <div>
            <b>FREE delivery</b> Saturday, 31 May ·{' '}
            <span style={{ color: '#007185' }}>Details</span>
          </div>
          <div>
            Or fastest delivery <b>Thursday, 29 May</b>
          </div>
        </div>

        <div style={{ color: '#007600', fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
          In stock
        </div>

        {/* size */}
        <div style={{ fontSize: 11.5, marginBottom: 5 }}>
          Size: <b>{size}</b>
        </div>
        <div style={{ display: 'flex', gap: 7, marginBottom: 14, flexWrap: 'wrap' }}>
          {TC.sizes.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSize(s)}
              style={{
                width: 40,
                height: 32,
                borderRadius: 5,
                border: `1px solid ${s === size ? '#007185' : '#d5d9d9'}`,
                boxShadow: s === size ? '0 0 0 1px #007185' : 'none',
                background: '#fff',
                fontSize: 12,
                cursor: 'pointer',
                color: '#0f1111',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        <button
          type="button"
          style={{
            width: '100%',
            height: 34,
            borderRadius: 18,
            border: 'none',
            background: '#ffd814',
            fontWeight: 500,
            fontSize: 13,
            marginBottom: 6,
            cursor: 'pointer',
          }}
        >
          Add to cart
        </button>
        <button
          type="button"
          style={{
            width: '100%',
            height: 34,
            borderRadius: 18,
            border: 'none',
            background: '#ffa41c',
            fontWeight: 500,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Buy Now
        </button>

        {/* offers — highest-recognition commerce signal */}
        <OfferBlock compact />

        <section style={{ marginTop: 10, borderTop: '1px solid #e7e7e7', paddingTop: 9 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 5 }}>About this item</div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 17,
              color: '#0f1111',
              fontSize: 11.5,
              lineHeight: 1.5,
            }}
          >
            <li>Regular fit fashion style from {TC.store}</li>
            <li>Soft cotton blend fabric with machine-wash care</li>
            <li>Secure Amazon checkout with easy returns</li>
          </ul>
        </section>

        {/* returns trust signal */}
        <div style={{ marginTop: 6, fontSize: 10.5, color: '#565959' }}>
          ✓ <b style={{ color: '#0f1111' }}>10 days</b> returnable · Secure transaction
        </div>

        {/* sold by */}
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            display: 'grid',
            gridTemplateColumns: '70px 1fr',
            rowGap: 2,
            color: '#565959',
          }}
        >
          <span>Sold by</span>
          <span style={{ color: '#007185' }}>Furbo Fashion</span>
          <span>Ships from</span>
          <span>Amazon</span>
          <span>Payment</span>
          <span>Secure transaction</span>
        </div>
      </div>
    </div>
  );
}

// ─── Amazon desktop template ──────────────────────────────────────────────────

export function AmazonDesktopTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
}: TemplateProps) {
  const [size, setSize] = useState(TC.defaultSize);
  const active = images[activeIndex];

  return (
    <div style={{ fontFamily: MARKETPLACE_FONTS.amazon, fontSize: 13, color: '#0f1111' }}>
      {/* top nav */}
      <div
        style={{
          background: '#131921',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '7px 14px',
        }}
      >
        <MarketplaceLogo platform="amazon" variant="light" width={96} height={30} />
        <span style={{ color: '#fff', fontSize: 10.5, lineHeight: 1.2, flexShrink: 0 }}>
          <span style={{ color: '#ccc' }}>Deliver to</span>
          <br />
          <b>Hyderabad 500032</b>
        </span>
        <div style={{ flex: 1, display: 'flex', height: 32 }}>
          <div
            style={{
              width: 44,
              background: '#e6e6e6',
              borderRadius: '4px 0 0 4px',
              display: 'grid',
              placeItems: 'center',
              fontSize: 10.5,
              color: '#555',
            }}
          >
            All
          </div>
          <div style={{ flex: 1, background: '#fff' }} />
          <div
            style={{
              width: 42,
              background: '#febd69',
              borderRadius: '0 4px 4px 0',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <SearchG />
          </div>
        </div>
        <span style={{ color: '#fff', fontSize: 10.5, lineHeight: 1.2, flexShrink: 0 }}>
          Hello, sign in
          <br />
          <b>Account & Lists</b>
        </span>
        <span style={{ color: '#fff', fontSize: 10.5, lineHeight: 1.2, flexShrink: 0 }}>
          Returns
          <br />
          <b>& Orders</b>
        </span>
        <CartG size={20} />
      </div>

      {/* subnav */}
      <div
        style={{
          background: '#232f3e',
          color: '#fff',
          fontSize: 11.5,
          padding: '6px 14px',
          display: 'flex',
          gap: 14,
          overflow: 'hidden',
        }}
      >
        {[
          '☰ All',
          'Fresh',
          'Sell',
          'Bestsellers',
          'Mobiles',
          "Today's Deals",
          'Prime',
          'Customer Service',
          'Fashion',
          'Electronics',
          'Home & Kitchen',
        ].map((x) => (
          <span key={x} style={{ whiteSpace: 'nowrap' }}>
            {x}
          </span>
        ))}
      </div>

      {/* breadcrumb */}
      <div style={{ fontSize: 11, color: '#565959', padding: '8px 18px 2px' }}>
        Home &amp; Kitchen › Fashion › Women › Tops, T-Shirts &amp; Shirts › Tops &amp; Tunics
      </div>

      {/* 3-column: 42% image | flex details | 190px buy box */}
      <div
        style={{ display: 'flex', gap: 18, padding: '10px 18px 32px', alignItems: 'flex-start' }}
      >
        {/* col 1: thumbnail rail + zoomable main image */}
        <div style={{ flex: '0 0 42%', display: 'flex', gap: 10, minWidth: 0 }}>
          {/* thumbnail rail — hover swaps main image */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, flexShrink: 0 }}>
            {images.slice(0, 7).map((url, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: gallery index is stable
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                onMouseEnter={() => onActiveChange(i)}
                aria-label={`Show image ${i + 1}`}
                style={{
                  width: 44,
                  height: 56,
                  borderRadius: 4,
                  border: `1px solid ${i === activeIndex ? '#e77600' : '#d5d9d9'}`,
                  boxShadow: i === activeIndex ? '0 0 0 2px #e77600' : 'none',
                  overflow: 'hidden',
                  padding: 0,
                  cursor: 'pointer',
                  background: '#f7f7f7',
                  flexShrink: 0,
                }}
              >
                {url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  // biome-ignore lint/performance/noImgElement: preview panel image
                  <img
                    src={url}
                    alt=""
                    aria-hidden="true"
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  />
                ) : (
                  <div
                    className="av-shimmer"
                    style={{ width: '100%', height: '100%' }}
                    aria-hidden="true"
                  />
                )}
              </button>
            ))}
            {images.length > 7 && (
              <div
                style={{
                  width: 44,
                  height: 20,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  color: '#007185',
                  cursor: 'pointer',
                }}
              >
                {images.length - 7}+ more
              </div>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <ProductImage src={active} ratio={ratio} />
            <div style={{ textAlign: 'center', fontSize: 10.5, color: '#565959', marginTop: 6 }}>
              Roll over image to zoom in
            </div>
          </div>
        </div>

        {/* col 2: product details */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Amazon's Choice badge — high-recognition trust signal */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              background: '#232f3e',
              borderRadius: 3,
              padding: '3px 8px',
              marginBottom: 6,
            }}
          >
            <span style={{ color: '#fff', fontSize: 10, fontWeight: 700, letterSpacing: 0.3 }}>
              Amazon's
            </span>
            <span style={{ color: '#ff9900', fontSize: 10, fontWeight: 700, letterSpacing: 0.3 }}>
              Choice
            </span>
            <span style={{ color: '#ccc', fontSize: 9.5, marginLeft: 2 }}>in Women's Tops</span>
          </div>
          <div style={{ fontSize: 18, lineHeight: 1.25, color: '#0f1111', marginBottom: 4 }}>
            {TC.title}
          </div>
          <div style={{ color: '#007185', fontSize: 11.5, marginBottom: 5 }}>
            Visit the {TC.store} Store
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
            <span style={{ fontSize: 12.5 }}>{TC.rating}</span>
            <Stars rating={TC.rating} size={13} />
            <span style={{ color: '#007185', fontSize: 11.5 }}>({TC.ratingCount} ratings)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8 }}>
            {[
              { label: 'Share', icon: <ShareIcon size={14} color="#007185" /> },
              { label: 'Add to Wish List', icon: <HeartIcon size={14} color="#007185" /> },
            ].map((action) => (
              <button
                key={action.label}
                type="button"
                style={{
                  border: 0,
                  background: 'transparent',
                  color: '#007185',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: 0,
                  fontSize: 11.5,
                  cursor: 'pointer',
                }}
              >
                {action.icon}
                {action.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: '#565959', marginBottom: 8 }}>
            1,204 bought in past month
          </div>

          <div style={{ height: 1, background: '#e7e7e7', marginBottom: 10 }} />

          {/* price */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
            <span style={{ color: '#cc0c39', fontSize: 16 }}>-{TC.discount}</span>
            <span>
              ₹<span style={{ fontSize: 24, fontWeight: 500 }}>{TC.price}</span>
              <sup>00</sup>
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#565959', marginBottom: 10 }}>
            M.R.P.: <span style={{ textDecoration: 'line-through' }}>₹{TC.mrp}</span> · Inclusive of
            all taxes
          </div>

          {/* EMI teaser */}
          <div style={{ fontSize: 11, color: '#565959', marginBottom: 10 }}>
            EMI starts at <b style={{ color: '#0f1111' }}>₹167</b>. No Cost EMI available ·{' '}
            <span style={{ color: '#007185' }}>EMI options</span>
          </div>

          {/* offers block */}
          <OfferBlock />

          <div style={{ height: 1, background: '#e7e7e7', margin: '14px 0 10px' }} />

          {/* size */}
          <div style={{ fontSize: 12, marginBottom: 7 }}>
            Size: <b>{size}</b>
          </div>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 14 }}>
            {TC.sizes.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSize(s)}
                style={{
                  minWidth: 44,
                  height: 34,
                  borderRadius: 6,
                  border: `1px solid ${s === size ? '#007185' : '#d5d9d9'}`,
                  boxShadow: s === size ? '0 0 0 1px #007185' : 'none',
                  background: '#fff',
                  cursor: 'pointer',
                  color: '#0f1111',
                  fontSize: 13,
                }}
              >
                {s}
              </button>
            ))}
          </div>

          {/* returns + trust metadata */}
          <div style={{ fontSize: 11, color: '#565959', lineHeight: 1.6 }}>
            <div>
              ✓ <b style={{ color: '#0f1111' }}>10 days</b> returnable · Ships from Amazon
            </div>
            <div>✓ Secure transaction · Packaging doesn't reveal contents</div>
          </div>
          <section style={{ borderTop: '1px solid #e7e7e7', marginTop: 12, paddingTop: 11 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>About this item</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
              <li>Regular fit fashion essential by {TC.store}</li>
              <li>Soft cotton blend fabric with easy machine-wash care</li>
              <li>Suitable for casual, office and catalogue styling</li>
              <li>Secure transaction with Amazon delivery and returns</li>
            </ul>
          </section>
        </div>

        {/* col 3: buy box — 190px */}
        <div
          style={{
            flex: '0 0 190px',
            border: '1px solid #d5d9d9',
            borderRadius: 8,
            padding: '14px 12px',
            fontSize: 12,
            boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
          }}
        >
          <div style={{ marginBottom: 4 }}>
            ₹<span style={{ fontSize: 22, fontWeight: 500 }}>{TC.price}</span>
          </div>
          <div style={{ fontSize: 11, marginBottom: 4 }}>
            <span style={{ color: '#007185' }}>FREE delivery</span> Saturday, 31 May
          </div>
          <div style={{ fontSize: 11, marginBottom: 10, color: '#565959' }}>
            Or fastest delivery <b style={{ color: '#0f1111' }}>Thu, 29 May</b>
          </div>
          <div style={{ color: '#007600', fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
            In stock
          </div>
          <div style={{ fontSize: 11, marginBottom: 8 }}>
            <label
              htmlFor="qty-select"
              style={{ display: 'block', marginBottom: 3, color: '#565959' }}
            >
              Quantity
            </label>
            <select
              id="qty-select"
              style={{
                width: '100%',
                padding: '4px 6px',
                borderRadius: 4,
                border: '1px solid #d5d9d9',
                fontSize: 12,
              }}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            style={{
              width: '100%',
              height: 30,
              borderRadius: 16,
              border: 'none',
              background: '#ffd814',
              cursor: 'pointer',
              marginBottom: 7,
              fontSize: 12,
            }}
          >
            Add to Cart
          </button>
          <button
            type="button"
            style={{
              width: '100%',
              height: 30,
              borderRadius: 16,
              border: 'none',
              background: '#ffa41c',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Buy Now
          </button>
          <button
            type="button"
            style={{
              width: '100%',
              height: 28,
              borderRadius: 14,
              border: '1px solid #d5d9d9',
              background: '#fff',
              color: '#0f1111',
              cursor: 'pointer',
              fontSize: 11.5,
              marginTop: 8,
            }}
          >
            Add to List
          </button>
          <div
            style={{
              marginTop: 8,
              fontSize: 11,
              display: 'grid',
              gridTemplateColumns: '62px 1fr',
              rowGap: 2,
              color: '#565959',
            }}
          >
            <span>Sold by</span>
            <span style={{ color: '#007185' }}>Furbo Fashion</span>
            <span>Ships from</span>
            <span>Amazon</span>
            <span>Payment</span>
            <span style={{ color: '#007185' }}>Secure transaction</span>
          </div>
          <div
            style={{
              marginTop: 12,
              border: '1px solid #eee',
              borderRadius: 6,
              padding: '7px 9px',
              fontSize: 11,
              color: '#565959',
            }}
          >
            <div style={{ fontWeight: 600, color: '#0f1111', marginBottom: 3 }}>
              Add a Protection Plan:
            </div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" style={{ marginTop: 2 }} />
              1-Year Fashion Protection Plan — ₹99
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Flipkart templates ────────────────────────────────────────────────────────

const TagG = ({ color = '#388e3c', size = 16 }: { color?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flexShrink: 0 }}
  >
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
    <line x1="7" y1="7" x2="7.01" y2="7" />
  </svg>
);

export function FlipkartMobileTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
}: TemplateProps) {
  const [size, setSize] = useState(TC.defaultSize);
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily: MARKETPLACE_FONTS.flipkart,
        fontSize: 13,
        color: '#212121',
        background: '#fff',
      }}
    >
      {/* Header */}
      <div
        style={{
          background: '#2874f0',
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          height: 52,
          boxSizing: 'border-box',
        }}
      >
        <MenuG color="#fff" />
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
          <span style={{ color: '#fff', fontWeight: 700, fontSize: 16, fontStyle: 'italic' }}>
            Flipkart
          </span>
          <span style={{ color: '#ffe11b', fontSize: 9, fontWeight: 500, fontStyle: 'italic' }}>
            Explore <span style={{ fontWeight: 700 }}>Plus</span>{' '}
            <span style={{ color: '#ffe11b' }}>✦</span>
          </span>
        </div>
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            color: '#fff',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 500 }}>Login</span>
          <ShareIcon size={18} color="#fff" />
          <CartG size={20} color="#fff" />
        </div>
      </div>

      {/* Search Bar */}
      <div style={{ background: '#2874f0', padding: '0 8px 8px' }}>
        <div
          style={{
            background: '#fff',
            borderRadius: 2,
            display: 'flex',
            alignItems: 'center',
            padding: '0 10px',
            fontSize: 12,
            color: '#878787',
            height: 34,
            boxShadow: '0 1px 2px 0 rgba(0,0,0,0.1)',
          }}
        >
          <span style={{ marginRight: 6, display: 'flex' }}>
            <SearchG color="#878787" />
          </span>
          Search for Products, Brands and More
        </div>
      </div>

      {/* Product Image */}
      <ProductImage src={active} ratio={ratio} />

      {/* Carousel dots */}
      {(() => {
        const resolved = images.map((url, i) => ({ url, i })).filter(({ url }) => Boolean(url));
        if (resolved.length <= 1) return null;
        return (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 5, padding: '8px 0 4px' }}>
            {resolved.map(({ i }) => (
              <button
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                aria-label={`Show image ${i + 1}`}
                style={{
                  width: i === activeIndex ? 8 : 6,
                  height: i === activeIndex ? 8 : 6,
                  borderRadius: '50%',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  background: i === activeIndex ? '#2874f0' : '#c2c2c2',
                }}
              />
            ))}
          </div>
        );
      })()}

      {/* Details */}
      <div style={{ padding: 12 }}>
        <div
          style={{
            color: '#878787',
            fontSize: 12,
            fontWeight: 500,
            textTransform: 'uppercase',
            marginBottom: 2,
          }}
        >
          {TC.store}
        </div>
        <div style={{ fontSize: 14, color: '#212121', lineHeight: 1.3, marginBottom: 6 }}>
          {TC.title}
        </div>

        {/* Ratings */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span
            style={{
              background: '#388e3c',
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              padding: '1px 5px',
              borderRadius: 3,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
            }}
          >
            {TC.rating} ★
          </span>
          <span style={{ color: '#878787', fontSize: 12 }}>{TC.ratingCount} ratings</span>
        </div>

        {/* Price */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 20, fontWeight: 600, color: '#212121' }}>₹{TC.price}</span>
          <span style={{ color: '#878787', textDecoration: 'line-through', fontSize: 13 }}>
            ₹{TC.mrp}
          </span>
          <span style={{ color: '#388e3c', fontWeight: 600, fontSize: 13 }}>{TC.discount} off</span>
        </div>
        <div style={{ fontSize: 11, color: '#388e3c', fontWeight: 500, marginBottom: 10 }}>
          Special Price
        </div>

        <div style={{ height: 1, background: '#f0f0f0', marginBottom: 10 }} />

        {/* Size Selection */}
        <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, color: '#878787' }}>
          Select Size
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {TC.sizes.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSize(s)}
              style={{
                width: 44,
                height: 34,
                borderRadius: 4,
                border: `1px solid ${s === size ? '#2874f0' : '#e0e0e0'}`,
                background: s === size ? '#f0f5ff' : '#fff',
                fontSize: 12,
                fontWeight: s === size ? 600 : 400,
                cursor: 'pointer',
                color: s === size ? '#2874f0' : '#212121',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Flipkart Offers */}
        <div
          style={{
            border: '1px solid #f0f0f0',
            borderRadius: 4,
            padding: 10,
            marginBottom: 14,
            background: '#f9f9f9',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: '#212121', marginBottom: 6 }}>
            Available Offers
          </div>
          {[
            'Bank Offer: 5% Cashback on Flipkart Axis Bank Card',
            'Special Price: Get extra 10% off (price inclusive of discount)',
            'Partner Offer: Sign up for Flipkart Pay Later & get free benefits',
          ].map((o, idx) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static offer list — index is stable
              key={idx}
              style={{
                display: 'flex',
                gap: 6,
                fontSize: 11,
                color: '#212121',
                lineHeight: 1.4,
                marginBottom: 4,
              }}
            >
              <TagG size={14} />
              <span>{o}</span>
            </div>
          ))}
        </div>

        {/* Buy Action Buttons */}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button
            type="button"
            style={{
              flex: 1,
              height: 44,
              borderRadius: 2,
              border: '1px solid #e0e0e0',
              background: '#fff',
              color: '#212121',
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            ADD TO CART
          </button>
          <button
            type="button"
            style={{
              flex: 1,
              height: 44,
              borderRadius: 2,
              border: 'none',
              background: '#ff9f00',
              color: '#fff',
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            BUY NOW
          </button>
        </div>
      </div>
    </div>
  );
}

export function FlipkartDesktopTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
}: TemplateProps) {
  const [size, setSize] = useState(TC.defaultSize);
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily: MARKETPLACE_FONTS.flipkart,
        fontSize: 14,
        color: '#212121',
        background: '#fff',
      }}
    >
      {/* Top Navigation */}
      <div
        style={{
          background: '#2874f0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 24,
          padding: '0 24px',
          height: 56,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1, cursor: 'pointer' }}>
          <span style={{ color: '#fff', fontWeight: 700, fontSize: 20, fontStyle: 'italic' }}>
            Flipkart
          </span>
          <span
            style={{
              color: '#ffe11b',
              fontSize: 11,
              fontWeight: 500,
              fontStyle: 'italic',
              textAlign: 'right',
            }}
          >
            Explore <span style={{ fontWeight: 700 }}>Plus</span>{' '}
            <span style={{ color: '#ffe11b' }}>✦</span>
          </span>
        </div>

        <div style={{ flex: 1, maxWidth: 560, display: 'flex', position: 'relative' }}>
          <input
            type="text"
            placeholder="Search for products, brands and more"
            style={{
              width: '100%',
              height: 36,
              padding: '0 16px 0 12px',
              border: 'none',
              borderRadius: 2,
              fontSize: 14,
              outline: 'none',
            }}
          />
          <span
            style={{
              position: 'absolute',
              right: 12,
              top: 8,
              color: '#2874f0',
              cursor: 'pointer',
              display: 'flex',
            }}
          >
            <SearchG color="#2874f0" />
          </span>
        </div>

        <button
          type="button"
          style={{
            background: '#fff',
            color: '#2874f0',
            border: '1px solid #dbdbdb',
            borderRadius: 2,
            padding: '4px 40px',
            height: 32,
            fontWeight: 600,
            fontSize: 15,
            cursor: 'pointer',
          }}
        >
          Login
        </button>

        <span style={{ color: '#fff', fontWeight: 600, fontSize: 15, cursor: 'pointer' }}>
          Become a Seller
        </span>

        <span style={{ color: '#fff', fontWeight: 600, fontSize: 15, cursor: 'pointer' }}>
          More
        </span>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            color: '#fff',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <CartG size={20} color="#fff" />
          <span>Cart</span>
        </div>
      </div>

      {/* Main product columns */}
      <div style={{ display: 'flex', gap: 24, padding: '24px 10% 40px', alignItems: 'flex-start' }}>
        {/* Left Column: Thumbnails + Main Image + Action Buttons */}
        <div style={{ flex: '0 0 400px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            {/* Thumbnail strip */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
              {images.slice(0, 6).map((url, i) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: gallery index is stable
                  key={i}
                  type="button"
                  onClick={() => onActiveChange(i)}
                  onMouseEnter={() => onActiveChange(i)}
                  style={{
                    width: 50,
                    height: 64,
                    borderRadius: 2,
                    border: `2px solid ${i === activeIndex ? '#2874f0' : '#e0e0e0'}`,
                    padding: 2,
                    cursor: 'pointer',
                    background: '#fff',
                    overflow: 'hidden',
                  }}
                >
                  {url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    // biome-ignore lint/performance/noImgElement: generated catalogue preview image
                    <img
                      src={url}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    />
                  ) : (
                    <div className="av-shimmer" style={{ width: '100%', height: '100%' }} />
                  )}
                </button>
              ))}
            </div>

            {/* Main Image */}
            <div
              style={{
                flex: 1,
                border: '1px solid #f0f0f0',
                padding: 4,
                borderRadius: 2,
                overflow: 'hidden',
              }}
            >
              <ProductImage src={active} ratio={ratio} />
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: 12 }}>
            <button
              type="button"
              style={{
                flex: 1,
                height: 52,
                background: '#ff9f00',
                color: '#fff',
                fontWeight: 600,
                fontSize: 15,
                border: 'none',
                borderRadius: 2,
                cursor: 'pointer',
              }}
            >
              ADD TO CART
            </button>
            <button
              type="button"
              style={{
                flex: 1,
                height: 52,
                background: '#fb641b',
                color: '#fff',
                fontWeight: 600,
                fontSize: 15,
                border: 'none',
                borderRadius: 2,
                cursor: 'pointer',
              }}
            >
              BUY NOW
            </button>
          </div>
        </div>

        {/* Right Column: Info details */}
        <div style={{ flex: 1 }}>
          {/* Breadcrumb */}
          <div style={{ fontSize: 12, color: '#878787', marginBottom: 12 }}>
            Home &gt; Clothing &gt; Women's Western Wear &gt; Tops &gt; {TC.store} Tops
          </div>

          <div style={{ fontSize: 18, color: '#878787', fontWeight: 500, marginBottom: 6 }}>
            {TC.store}
          </div>
          <div style={{ fontSize: 18, color: '#212121', lineHeight: 1.4, marginBottom: 8 }}>
            {TC.title}
          </div>

          {/* Rating */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span
              style={{
                background: '#388e3c',
                color: '#fff',
                fontSize: 12,
                fontWeight: 600,
                padding: '2px 6px',
                borderRadius: 3,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
              }}
            >
              {TC.rating} ★
            </span>
            <span style={{ color: '#878787', fontWeight: 500, fontSize: 13 }}>
              {TC.ratingCount} Ratings &amp; 5 Reviews
            </span>
          </div>

          {/* Pricing */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
            <span style={{ fontSize: 28, fontWeight: 500, color: '#212121' }}>₹{TC.price}</span>
            <span style={{ color: '#878787', textDecoration: 'line-through', fontSize: 16 }}>
              ₹{TC.mrp}
            </span>
            <span style={{ color: '#388e3c', fontWeight: 600, fontSize: 16 }}>
              {TC.discount} Off
            </span>
          </div>

          <div style={{ height: 1, background: '#f0f0f0', margin: '16px 0' }} />

          {/* Sizes */}
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8, color: '#878787' }}>
            Size
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            {TC.sizes.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSize(s)}
                style={{
                  width: 44,
                  height: 40,
                  borderRadius: 4,
                  border: `1px solid ${s === size ? '#2874f0' : '#e0e0e0'}`,
                  background: s === size ? '#f0f5ff' : '#fff',
                  fontSize: 13,
                  fontWeight: s === size ? 600 : 400,
                  cursor: 'pointer',
                  color: s === size ? '#2874f0' : '#212121',
                }}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Available Offers */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#212121', marginBottom: 10 }}>
              Available Offers
            </div>
            {[
              'Bank Offer: 5% Cashback on Flipkart Axis Bank Card',
              'Special Price: Get extra 10% off (price inclusive of discount)',
              'Partner Offer: Sign up for Flipkart Pay Later & get free Times Prime benefits',
              'Buy 3 get 10% off; Buy 5 get 15% off',
            ].map((o, idx) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: static offer list — index is stable
                key={idx}
                style={{
                  display: 'flex',
                  gap: 8,
                  fontSize: 13,
                  color: '#212121',
                  lineHeight: 1.5,
                  marginBottom: 6,
                }}
              >
                <TagG size={16} />
                <span>{o}</span>
              </div>
            ))}
          </div>

          {/* Flipkart Assured */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              background: '#f5f5f5',
              padding: '6px 12px',
              borderRadius: 4,
            }}
          >
            <span style={{ fontWeight: 600, color: '#2874f0', fontSize: 12, fontStyle: 'italic' }}>
              F-Assured
            </span>
            <span style={{ color: '#878787', fontSize: 12 }}>
              Quality Products &amp; Fast Shipping
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Framed live-preview Flipkart templates. These are tuned for the embedded
// browser/phone mockups rather than full application pages.

type FramedFlipkartProduct = {
  brand: string;
  title: string;
  breadcrumb: string[];
  rating: string;
  ratingCount: string;
  reviewCount: string;
  price: string;
  mrp: string;
  discount: string;
  sizes: string[];
  seller: string;
  delivery: string;
  highlights: string[];
  offers: string[];
};

const FK_THEME = {
  blue: '#2874f0',
  yellow: '#ffe500',
  green: '#388e3c',
  orange: '#fb641b',
  amber: '#ff9f00',
  text: '#111112',
  muted: '#717478',
  border: '#e0e0e0',
  searchBackground: '#f0f5ff',
  page: '#f1f2f4',
};

function framedFlipkartGarmentName(garmentName?: string | null): string {
  if (!garmentName) return 'Casual Shirt';
  return garmentName
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function framedFlipkartProduct(
  gender?: string | null,
  garmentName?: string | null,
): FramedFlipkartProduct {
  const normalizedGender = (gender ?? '').toLowerCase();
  const isWomen = normalizedGender.includes('women') || normalizedGender.includes('girl');
  const audience = isWomen ? 'Women' : 'Men';
  const garment = framedFlipkartGarmentName(garmentName);
  const clothing = isWomen ? "Women's Clothing" : "Men's Clothing";
  const category = garment.toLowerCase().includes('tshirt') ? 'T-shirts' : 'Shirts';

  return {
    brand: 'FURBO',
    title: `${audience} Regular Fit Solid ${garment}`,
    breadcrumb: ['Home', 'Clothing and Accessories', clothing, category],
    rating: '4.1',
    ratingCount: '1,284',
    reviewCount: '126',
    price: '999',
    mrp: '1,999',
    discount: '50%',
    sizes: isWomen ? ['S', 'M', 'L', 'XL', 'XXL'] : ['38', '40', '42', '44', '46'],
    seller: 'TRYME Retail',
    delivery: 'Delivery by Tomorrow, 8 AM',
    highlights: [
      `Ideal for ${audience.toLowerCase()} casual styling`,
      'Premium fabric with clean catalogue finish',
      'Regular fit with a polished marketplace look',
      'Machine wash as per care label',
    ],
    offers: [
      'Bank Offer 5% cashback on Flipkart Axis Bank Card',
      'Special Price extra 10% off on selected styles',
      'Partner Offer sign up for Flipkart Pay Later and get rewards',
      'Buy together and save more on fashion essentials',
    ],
  };
}

function FramedFlipkartLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1, flexShrink: 0 }}>
      <span
        style={{
          color: '#fff',
          fontWeight: 700,
          fontSize: compact ? 16 : 20,
          fontStyle: 'italic',
          letterSpacing: -0.2,
        }}
      >
        Flipkart
      </span>
      <span
        style={{
          color: '#fff',
          fontSize: compact ? 9 : 11,
          fontWeight: 500,
          fontStyle: 'italic',
          textAlign: 'right',
          marginTop: 1,
        }}
      >
        Explore <span style={{ color: FK_THEME.yellow, fontWeight: 700 }}>Plus</span>{' '}
        <span style={{ color: FK_THEME.yellow }}>✦</span>
      </span>
    </div>
  );
}

function FramedFlipkartRating({
  product,
  compact = false,
}: {
  product: FramedFlipkartProduct;
  compact?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span
        style={{
          background: FK_THEME.green,
          color: '#fff',
          fontSize: compact ? 11 : 12,
          fontWeight: 700,
          padding: compact ? '2px 6px' : '3px 7px',
          borderRadius: 3,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          lineHeight: 1,
        }}
      >
        {product.rating} *
      </span>
      <span style={{ color: FK_THEME.muted, fontWeight: 600, fontSize: compact ? 12 : 14 }}>
        {product.ratingCount} Ratings &amp; {product.reviewCount} Reviews
      </span>
      {!compact && (
        <span
          style={{
            color: FK_THEME.blue,
            fontSize: 12,
            fontWeight: 700,
            fontStyle: 'italic',
            letterSpacing: -0.2,
          }}
        >
          assured
        </span>
      )}
    </div>
  );
}

function FramedFlipkartPrice({
  product,
  compact = false,
}: {
  product: FramedFlipkartProduct;
  compact?: boolean;
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: compact ? 22 : 28,
            fontWeight: 600,
            color: FK_THEME.text,
            whiteSpace: 'nowrap',
          }}
        >
          Rs. {product.price}
        </span>
        <span
          style={{
            color: FK_THEME.muted,
            textDecoration: 'line-through',
            fontSize: compact ? 13 : 16,
          }}
        >
          Rs. {product.mrp}
        </span>
        <span style={{ color: FK_THEME.green, fontWeight: 700, fontSize: compact ? 13 : 15 }}>
          {product.discount} off
        </span>
      </div>
      <div
        style={{
          color: FK_THEME.green,
          fontSize: compact ? 12 : 13,
          fontWeight: 600,
          marginTop: 4,
        }}
      >
        Special price
      </div>
    </div>
  );
}

function FramedFlipkartOffers({
  product,
  compact = false,
}: {
  product: FramedFlipkartProduct;
  compact?: boolean;
}) {
  return (
    <section>
      <div
        style={{
          fontSize: compact ? 13 : 14,
          fontWeight: 700,
          color: FK_THEME.text,
          marginBottom: 10,
        }}
      >
        Available offers
      </div>
      {product.offers.slice(0, compact ? 3 : 4).map((offer) => (
        <div
          key={offer}
          style={{
            display: 'flex',
            gap: 8,
            fontSize: compact ? 12 : 13,
            color: FK_THEME.text,
            lineHeight: 1.45,
            marginBottom: 7,
          }}
        >
          <TagG size={compact ? 14 : 16} />
          <span>{offer}</span>
        </div>
      ))}
    </section>
  );
}

function FramedFlipkartHeader() {
  return (
    <>
      <header
        style={{
          height: 56,
          background: FK_THEME.blue,
          display: 'flex',
          alignItems: 'center',
          padding: '0 48px',
          gap: 24,
          color: '#fff',
        }}
      >
        <FramedFlipkartLogo />
        <div style={{ flex: 1, maxWidth: 560, position: 'relative' }}>
          <input
            aria-label="Search Flipkart"
            placeholder="Search for products, brands and more"
            style={{
              width: '100%',
              height: 36,
              border: 0,
              outline: 'none',
              borderRadius: 2,
              background: '#fff',
              padding: '0 44px 0 14px',
              color: FK_THEME.text,
              fontSize: 14,
              fontFamily: MARKETPLACE_FONTS.flipkart,
              boxShadow: '0 2px 4px rgba(0,0,0,0.18)',
            }}
          />
          <span
            style={{
              position: 'absolute',
              right: 13,
              top: 8,
              color: FK_THEME.blue,
              display: 'flex',
            }}
          >
            <SearchG color={FK_THEME.blue} />
          </span>
        </div>
        <button
          type="button"
          style={{
            height: 32,
            minWidth: 120,
            border: '1px solid #dbdbdb',
            borderRadius: 2,
            background: '#fff',
            color: FK_THEME.blue,
            fontWeight: 600,
            fontSize: 15,
            fontFamily: MARKETPLACE_FONTS.flipkart,
            cursor: 'pointer',
          }}
        >
          Login
        </button>
        {['Become a Seller', 'More'].map((item) => (
          <button
            key={item}
            type="button"
            style={{
              border: 0,
              background: 'transparent',
              color: '#fff',
              fontWeight: 600,
              fontSize: 15,
              fontFamily: MARKETPLACE_FONTS.flipkart,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {item}
          </button>
        ))}
        <button
          type="button"
          style={{
            border: 0,
            background: 'transparent',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontWeight: 600,
            fontSize: 15,
            fontFamily: MARKETPLACE_FONTS.flipkart,
            cursor: 'pointer',
          }}
        >
          <CartG size={19} color="#fff" />
          Cart
        </button>
      </header>
      <nav
        aria-label="Flipkart categories"
        style={{
          height: 42,
          borderBottom: `1px solid ${FK_THEME.border}`,
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 34,
          color: FK_THEME.text,
          fontSize: 13,
          fontWeight: 500,
          fontFamily: MARKETPLACE_FONTS.flipkart,
          boxShadow: '0 1px 1px rgba(0,0,0,0.04)',
        }}
      >
        {[
          'Electronics',
          'TVs & Appliances',
          'Men',
          'Women',
          'Baby & Kids',
          'Home & Furniture',
          'Sports, Books & More',
        ].map((item) => (
          <span key={item}>{item}</span>
        ))}
      </nav>
    </>
  );
}

function FramedFlipkartImageGallery({
  images,
  activeIndex,
  onActiveChange,
  ratio,
  product,
}: TemplateProps & { product: FramedFlipkartProduct }) {
  const active = images[activeIndex];
  const gallery = Array.from({ length: 5 }, (_, i) => images[i]);

  return (
    <aside
      style={{
        width: 404,
        flexShrink: 0,
        position: 'sticky',
        top: 18,
        alignSelf: 'flex-start',
      }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ width: 64, display: 'flex', flexDirection: 'column' }}>
          {gallery.map((url, i) => (
            <button
              key={`${url ?? 'slot'}-${i}`}
              type="button"
              onClick={() => onActiveChange(i)}
              onMouseEnter={() => onActiveChange(i)}
              aria-label={`Show ${product.title} image ${i + 1}`}
              style={{
                width: 64,
                height: 76,
                border: `1px solid ${i === activeIndex ? FK_THEME.blue : '#e0e0e0'}`,
                borderLeft: i === activeIndex ? `3px solid ${FK_THEME.blue}` : '1px solid #e0e0e0',
                background: '#fff',
                padding: 4,
                cursor: 'pointer',
                overflow: 'hidden',
              }}
            >
              {url ? (
                <img
                  src={url}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  loading={i > 1 ? 'lazy' : undefined}
                />
              ) : (
                <div className="av-shimmer" style={{ width: '100%', height: '100%' }} />
              )}
            </button>
          ))}
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 430,
            border: '1px solid #e0e0e0',
            background: '#fff',
            padding: 18,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'zoom-in',
          }}
        >
          <ProductImage src={active} ratio={ratio} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
        <button
          type="button"
          style={{
            height: 52,
            border: 0,
            borderRadius: 2,
            background: FK_THEME.amber,
            color: '#fff',
            fontWeight: 700,
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          ADD TO CART
        </button>
        <button
          type="button"
          style={{
            height: 52,
            border: 0,
            borderRadius: 2,
            background: FK_THEME.orange,
            color: '#fff',
            fontWeight: 700,
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          BUY NOW
        </button>
      </div>
    </aside>
  );
}

function FramedFlipkartInfoPanel({ product }: { product: FramedFlipkartProduct }) {
  return (
    <section style={{ flex: 1, minWidth: 0, padding: '2px 10px 32px 0' }}>
      <div style={{ fontSize: 12, color: FK_THEME.muted, marginBottom: 12 }}>
        {product.breadcrumb.join(' > ')}
      </div>
      <h1
        style={{
          fontSize: 18,
          lineHeight: 1.35,
          fontWeight: 400,
          color: FK_THEME.text,
          marginBottom: 8,
        }}
      >
        <span style={{ color: FK_THEME.muted, fontWeight: 600, marginRight: 6 }}>
          {product.brand}
        </span>
        {product.title}
      </h1>
      <FramedFlipkartRating product={product} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 10 }}>
        {[
          { label: 'Share', icon: <ShareIcon size={15} color={FK_THEME.blue} /> },
          { label: 'Wishlist', icon: <HeartIcon size={15} color={FK_THEME.blue} /> },
        ].map((action) => (
          <button
            key={action.label}
            type="button"
            style={{
              border: 0,
              background: 'transparent',
              color: FK_THEME.blue,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: 0,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {action.icon}
            {action.label}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 18 }}>
        <FramedFlipkartPrice product={product} />
      </div>
      <div style={{ height: 1, background: FK_THEME.border, margin: '18px 0' }} />
      <FramedFlipkartOffers product={product} />
      <div style={{ height: 1, background: FK_THEME.border, margin: '18px 0' }} />

      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, marginBottom: 12 }}>
          <div style={{ color: FK_THEME.muted, fontSize: 14, fontWeight: 700, width: 76 }}>
            Size
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {product.sizes.map((size, index) => (
              <button
                key={size}
                type="button"
                style={{
                  minWidth: 46,
                  height: 38,
                  borderRadius: 2,
                  border: `1px solid ${index === 1 ? FK_THEME.blue : '#d7d7d7'}`,
                  background: index === 1 ? '#f0f5ff' : '#fff',
                  color: index === 1 ? FK_THEME.blue : FK_THEME.text,
                  fontWeight: index === 1 ? 700 : 500,
                  cursor: 'pointer',
                }}
              >
                {size}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start', marginBottom: 14 }}>
          <div style={{ color: FK_THEME.muted, fontSize: 14, fontWeight: 700, width: 76 }}>
            Delivery
          </div>
          <div style={{ flex: 1 }}>
            <div
              style={{ display: 'flex', maxWidth: 280, borderBottom: `2px solid ${FK_THEME.blue}` }}
            >
              <input
                aria-label="Enter delivery pincode"
                defaultValue="560001"
                style={{
                  flex: 1,
                  border: 0,
                  outline: 'none',
                  height: 32,
                  fontSize: 14,
                  color: FK_THEME.text,
                }}
              />
              <button
                type="button"
                style={{
                  border: 0,
                  background: 'transparent',
                  color: FK_THEME.blue,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Check
              </button>
            </div>
            <div style={{ fontSize: 13, color: FK_THEME.text, marginTop: 10 }}>
              {product.delivery} | <span style={{ color: FK_THEME.green }}>Free</span>
            </div>
            <div style={{ fontSize: 12, color: FK_THEME.muted, marginTop: 4 }}>
              7 Days Replacement Policy. Cash on Delivery available.
            </div>
          </div>
        </div>
      </section>

      <section style={{ marginTop: 14, borderTop: `1px solid ${FK_THEME.border}`, paddingTop: 14 }}>
        <div style={{ color: FK_THEME.muted, fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
          Services
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
            fontSize: 12.5,
            color: FK_THEME.text,
          }}
        >
          {[
            'Cash on Delivery available',
            '7 Days Replacement Policy',
            'GST invoice available',
            'Flipkart assured quality check',
          ].map((item) => (
            <div key={item} style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: FK_THEME.blue,
                  flexShrink: 0,
                }}
              />
              {item}
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 18, borderTop: `1px solid ${FK_THEME.border}`, paddingTop: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 14 }}>Product Details</div>
        <div
          style={{ display: 'grid', gridTemplateColumns: '160px 1fr', rowGap: 10, fontSize: 13 }}
        >
          <span style={{ color: FK_THEME.muted }}>Brand</span>
          <span>{product.brand}</span>
          <span style={{ color: FK_THEME.muted }}>Ideal For</span>
          <span>{product.title.startsWith('Women') ? 'Women' : 'Men'}</span>
          <span style={{ color: FK_THEME.muted }}>Fabric</span>
          <span>Cotton blend</span>
          <span style={{ color: FK_THEME.muted }}>Fit</span>
          <span>Regular</span>
        </div>
        <div style={{ marginTop: 16, fontSize: 14, fontWeight: 700 }}>Highlights</div>
        <ul
          style={{
            marginTop: 8,
            paddingLeft: 18,
            color: FK_THEME.text,
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          {product.highlights.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    </section>
  );
}

function FramedFlipkartPurchaseBox({ product }: { product: FramedFlipkartProduct }) {
  return (
    <aside
      style={{
        width: 220,
        flexShrink: 0,
        border: '1px solid #e0e0e0',
        background: '#fff',
        padding: 16,
        alignSelf: 'flex-start',
        position: 'sticky',
        top: 18,
      }}
    >
      <div style={{ color: FK_THEME.muted, fontSize: 12, marginBottom: 4 }}>Seller</div>
      <div style={{ color: FK_THEME.blue, fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
        {product.seller}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
        <span
          style={{
            background: FK_THEME.blue,
            color: '#fff',
            borderRadius: 10,
            padding: '2px 6px',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          4.4 *
        </span>
        <span style={{ color: FK_THEME.muted, fontSize: 12 }}>Trusted seller</span>
      </div>
      <div style={{ height: 1, background: FK_THEME.border, margin: '14px 0' }} />
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>
        <strong>Secure transaction</strong>
        <br />
        Free delivery, easy returns and Flipkart assured quality checks.
      </div>
      <button
        type="button"
        style={{
          width: '100%',
          height: 44,
          marginTop: 16,
          border: 0,
          borderRadius: 2,
          background: FK_THEME.orange,
          color: '#fff',
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        BUY NOW
      </button>
    </aside>
  );
}

export function FramedFlipkartDesktopTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
  gender,
  garmentName,
}: TemplateProps) {
  const product = framedFlipkartProduct(gender, garmentName);

  return (
    <div
      style={{
        fontFamily: MARKETPLACE_FONTS.flipkart,
        fontSize: 14,
        color: FK_THEME.text,
        background: FK_THEME.page,
        minHeight: 720,
      }}
    >
      <FramedFlipkartHeader />
      <div
        style={{
          maxWidth: 1180,
          margin: '10px auto 28px',
          background: '#fff',
          display: 'flex',
          gap: 22,
          padding: 16,
          border: '1px solid #e5e5e5',
        }}
      >
        <FramedFlipkartImageGallery
          images={images}
          activeIndex={activeIndex}
          onActiveChange={onActiveChange}
          ratio={ratio}
          product={product}
        />
        <FramedFlipkartInfoPanel product={product} />
        <FramedFlipkartPurchaseBox product={product} />
      </div>
    </div>
  );
}

export function FramedFlipkartMobileTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
  gender,
  garmentName,
}: TemplateProps) {
  const product = framedFlipkartProduct(gender, garmentName);
  const [size, setSize] = useState(product.sizes[1] ?? product.sizes[0]);
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily: MARKETPLACE_FONTS.flipkart,
        fontSize: 13,
        color: FK_THEME.text,
        background: '#fff',
      }}
    >
      <div
        style={{
          background: FK_THEME.blue,
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          height: 52,
          boxSizing: 'border-box',
        }}
      >
        <MenuG color="#fff" />
        <FramedFlipkartLogo compact />
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            color: '#fff',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 500 }}>Login</span>
          <CartG size={20} color="#fff" />
        </div>
      </div>

      <div style={{ background: FK_THEME.blue, padding: '0 8px 8px' }}>
        <div
          style={{
            background: '#fff',
            borderRadius: 2,
            display: 'flex',
            alignItems: 'center',
            padding: '0 10px',
            fontSize: 12,
            color: FK_THEME.muted,
            height: 34,
            boxShadow: '0 1px 2px 0 rgba(0,0,0,0.1)',
          }}
        >
          <span style={{ marginRight: 6, display: 'flex' }}>
            <SearchG color={FK_THEME.muted} />
          </span>
          Search for Products, Brands and More
        </div>
      </div>

      <div style={{ padding: 10, background: '#fff' }}>
        <ProductImage src={active} ratio={ratio} />
      </div>

      {(() => {
        const resolved = images.map((url, i) => ({ url, i })).filter(({ url }) => Boolean(url));
        if (resolved.length <= 1) return null;
        return (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 5, padding: '8px 0 4px' }}>
            {resolved.map(({ i }) => (
              <button
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                aria-label={`Show image ${i + 1}`}
                style={{
                  width: i === activeIndex ? 8 : 6,
                  height: i === activeIndex ? 8 : 6,
                  borderRadius: '50%',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  background: i === activeIndex ? FK_THEME.blue : '#c2c2c2',
                }}
              />
            ))}
          </div>
        );
      })()}

      <div style={{ padding: 12 }}>
        <div
          style={{
            color: FK_THEME.muted,
            fontSize: 12,
            fontWeight: 700,
            textTransform: 'uppercase',
            marginBottom: 2,
          }}
        >
          {product.brand}
        </div>
        <div style={{ fontSize: 14, color: FK_THEME.text, lineHeight: 1.3, marginBottom: 8 }}>
          {product.title}
        </div>
        <div style={{ marginBottom: 10 }}>
          <FramedFlipkartRating product={product} compact />
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {[
            { label: 'Wishlist', icon: <HeartIcon size={14} color={FK_THEME.blue} /> },
            { label: 'Share', icon: <ShareIcon size={14} color={FK_THEME.blue} /> },
          ].map((action) => (
            <button
              key={action.label}
              type="button"
              style={{
                flex: 1,
                height: 32,
                border: `1px solid ${FK_THEME.border}`,
                background: '#fff',
                color: FK_THEME.blue,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
        <FramedFlipkartPrice product={product} compact />
        <div style={{ height: 1, background: FK_THEME.border, margin: '12px 0' }} />

        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: FK_THEME.muted }}>
          Select Size
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {product.sizes.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setSize(option)}
              style={{
                width: 44,
                height: 34,
                borderRadius: 4,
                border: `1px solid ${option === size ? FK_THEME.blue : '#e0e0e0'}`,
                background: option === size ? '#f0f5ff' : '#fff',
                fontSize: 12,
                fontWeight: option === size ? 700 : 500,
                cursor: 'pointer',
                color: option === size ? FK_THEME.blue : FK_THEME.text,
              }}
            >
              {option}
            </button>
          ))}
        </div>

        <div style={{ border: `1px solid ${FK_THEME.border}`, padding: 10, marginBottom: 14 }}>
          <FramedFlipkartOffers product={product} compact />
        </div>

        <div style={{ fontSize: 12, color: FK_THEME.text, lineHeight: 1.5, marginBottom: 14 }}>
          <strong>Delivery</strong> {product.delivery}
          <br />
          Seller: <span style={{ color: FK_THEME.blue, fontWeight: 700 }}>{product.seller}</span>
          <br />
          COD available · 7 days replacement · Flipkart assured
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button
            type="button"
            style={{
              flex: 1,
              height: 44,
              borderRadius: 2,
              border: '1px solid #e0e0e0',
              background: '#fff',
              color: FK_THEME.text,
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            ADD TO CART
          </button>
          <button
            type="button"
            style={{
              flex: 1,
              height: 44,
              borderRadius: 2,
              border: 'none',
              background: FK_THEME.orange,
              color: '#fff',
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            BUY NOW
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Myntra templates ────────────────────────────────────────────────────────

const MyntraLogo = () => (
  <span
    role="img"
    aria-label="Myntra"
    style={{
      width: 48,
      height: 42,
      display: 'grid',
      placeItems: 'center',
      overflow: 'hidden',
      flexShrink: 0,
      cursor: 'pointer',
    }}
  >
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {/* biome-ignore lint/performance/noImgElement: local brand asset in scaled marketplace preview */}
    <img
      src="/assets/myntra-mark-official.png"
      alt=""
      aria-hidden="true"
      width={48}
      height={34}
      style={{
        width: 48,
        height: 34,
        objectFit: 'contain',
        display: 'block',
      }}
    />
  </span>
);

const SearchIcon = ({ size = 20, color = '#282c3f' }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke={color}
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const UserIcon = ({ size = 20, color = '#282c3f' }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke={color}
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const HeartIcon = ({ size = 20, color = '#282c3f' }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke={color}
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
  </svg>
);

const ShareIcon = ({ size = 20, color = '#282c3f' }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke={color}
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="M8.6 10.6 15.4 6.4" />
    <path d="M8.6 13.4 15.4 17.6" />
  </svg>
);

const ArrowBackIcon = ({ size = 20, color = '#282c3f' }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke={color}
    strokeWidth="2.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M19 12H5" />
    <path d="m12 19-7-7 7-7" />
  </svg>
);

const BagIcon = ({ size = 20, color = '#282c3f' }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke={color}
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
    <line x1="3" y1="6" x2="21" y2="6" />
    <path d="M16 10a4 4 0 0 1-8 0" />
  </svg>
);

const TruckIcon = ({ size = 20, color = '#282c3f' }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke={color}
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="1" y="3" width="15" height="13" />
    <polygon points="16 8 20 8 23 11 23 16 16 16 16 8" />
    <circle cx="5.5" cy="18.5" r="2.5" />
    <circle cx="18.5" cy="18.5" r="2.5" />
  </svg>
);

function getMyntraProductDetails(gender?: string | null, garmentName?: string | null) {
  const isMen = gender === 'men';
  const name = garmentName || (isMen ? 'Full Sleeve Shirt' : 'Peplum Top');

  if (isMen) {
    return {
      store: 'FURBO',
      title: `Men Solid Cotton Casual ${name}`,
      description:
        'A premium regular fit solid cotton shirt for men. Styled with a spread collar, button placket, and patch pocket.',
      rating: 4.1,
      ratingCount: 156,
      price: '999',
      mrp: '1,999',
      discount: '50% OFF',
      sizes: ['S', 'M', 'L', 'XL', 'XXL'],
      gender: 'men',
      category: 'Shirts',
      breadcrumb: 'Home / Clothing / Men Clothing / Shirts / FURBO Shirts',
      specs: [
        { label: 'Collar', value: 'Spread Collar' },
        { label: 'Fit', value: 'Regular Fit' },
        { label: 'Sleeve Length', value: 'Long Sleeves' },
        { label: 'Fabric', value: '100% Cotton' },
        { label: 'Pattern', value: 'Solid' },
        { label: 'Hemline', value: 'Curved' },
      ],
    };
  }
  return {
    store: 'FURBO',
    title: `Women Solid Puff Sleeve Peplum ${name}`,
    description:
      'A stylish ruched square neck casual top for women. Features short puff sleeves, peplum waist, and lightweight cotton blend fabric.',
    rating: 3.9,
    ratingCount: 44,
    price: '899',
    mrp: '1,799',
    discount: '50% OFF',
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    gender: 'women',
    category: 'Tops',
    breadcrumb: 'Home / Clothing / Women Clothing / Tops / FURBO Tops',
    specs: [
      { label: 'Neck', value: 'Square Neck' },
      { label: 'Fit', value: 'Peplum' },
      { label: 'Sleeve Length', value: 'Short Sleeves' },
      { label: 'Fabric', value: 'Cotton Blend' },
      { label: 'Pattern', value: 'Solid' },
      { label: 'Length', value: 'Regular' },
    ],
  };
}

export function MyntraMobileTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
  gender,
  garmentName,
}: TemplateProps) {
  const details = getMyntraProductDetails(gender, garmentName);
  const [size, setSize] = useState<string>('');
  const [sizeError, setSizeError] = useState(false);
  const active = images[activeIndex];

  const handleAddBag = () => {
    if (!size) {
      setSizeError(true);
    } else {
      setSizeError(false);
    }
  };

  return (
    <div
      style={{
        fontFamily: 'Assistant, -apple-system, BlinkMacSystemFont, Roboto, sans-serif',
        fontSize: 13,
        color: '#282c3f',
        background: '#fff',
      }}
    >
      {/* Header */}
      <div
        style={{
          background: '#fff',
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          height: 52,
          boxSizing: 'border-box',
          borderBottom: '1px solid #f5f5f6',
        }}
      >
        <span style={{ fontSize: 18, color: '#282c3f', cursor: 'pointer' }}>←</span>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: '#282c3f' }}>{details.store}</span>
          <span style={{ color: '#9496a2', fontSize: 10 }}>
            {details.gender === 'men' ? "Men's Wear" : "Women's Western Wear"}
          </span>
        </div>
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            color: '#282c3f',
          }}
        >
          <span style={{ display: 'flex' }}>
            <SearchIcon color="#282c3f" size={18} />
          </span>
          <BagIcon size={18} color="#282c3f" />
        </div>
      </div>

      <ProductImage src={active} ratio={ratio} />

      {/* Carousel Dots */}
      {(() => {
        const resolved = images.map((url, i) => ({ url, i })).filter(({ url }) => Boolean(url));
        if (resolved.length <= 1) return null;
        return (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 5, padding: '8px 0 4px' }}>
            {resolved.map(({ i }) => (
              <button
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                aria-label={`Show image ${i + 1}`}
                style={{
                  width: i === activeIndex ? 7 : 5,
                  height: i === activeIndex ? 7 : 5,
                  borderRadius: '50%',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  background: i === activeIndex ? '#ff3f6c' : '#c2c2c2',
                }}
              />
            ))}
          </div>
        );
      })()}

      {/* Details */}
      <div style={{ padding: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#282c3f', marginBottom: 2 }}>
          {details.store}
        </div>
        <div style={{ fontSize: 13.5, color: '#535665', lineHeight: 1.3, marginBottom: 8 }}>
          {details.title}
        </div>

        {/* Rating */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            border: '1px solid #eaeaec',
            padding: '2px 6px',
            borderRadius: 20,
            marginBottom: 12,
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 600 }}>{details.rating} ★</span>
          <span style={{ color: '#bfc0c6', fontSize: 10 }}>|</span>
          <span style={{ color: '#535665', fontSize: 11 }}>{details.ratingCount} Ratings</span>
        </div>

        {/* Price */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: '#282c3f' }}>₹{details.price}</span>
          <span style={{ color: '#9496a2', textDecoration: 'line-through', fontSize: 12 }}>
            ₹{details.mrp}
          </span>
          <span style={{ color: '#ff905a', fontWeight: 700, fontSize: 13 }}>
            ({details.discount})
          </span>
        </div>

        <div style={{ fontSize: 11, color: '#03a685', fontWeight: 600, marginBottom: 12 }}>
          inclusive of all taxes
        </div>

        {/* Size Selection */}
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: '#282c3f' }}>
          SELECT SIZE
        </div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          {details.sizes.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSize(s);
                setSizeError(false);
              }}
              style={{
                width: 38,
                height: 38,
                borderRadius: '50%',
                border: `1px solid ${s === size ? '#ff3f6c' : '#bfc0c6'}`,
                background: '#fff',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                color: s === size ? '#ff3f6c' : '#282c3f',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {sizeError && (
          <div style={{ color: '#ff3f6c', fontSize: 12, marginBottom: 12, fontWeight: 600 }}>
            Please select a size first
          </div>
        )}

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            style={{
              flex: 1,
              height: 46,
              borderRadius: 4,
              border: '1px solid #d4d5d9',
              background: '#fff',
              color: '#282c3f',
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            ♡ WISHLIST
          </button>
          <button
            type="button"
            onClick={handleAddBag}
            style={{
              flex: 1.5,
              height: 46,
              borderRadius: 4,
              border: 'none',
              background: '#ff3f6c',
              color: '#fff',
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            ADD TO BAG
          </button>
        </div>
      </div>
    </div>
  );
}

export function MyntraDesktopTemplate({
  images,
  activeIndex: _activeIndex,
  onActiveChange: _onActiveChange,
  ratio: _ratio,
  gender,
  garmentName,
}: TemplateProps) {
  const details = getMyntraProductDetails(gender, garmentName);
  const [size, setSize] = useState<string>('');
  const [sizeError, setSizeError] = useState(false);
  const [pincode, setPincode] = useState('');
  const [pincodeChecked, setPincodeChecked] = useState(false);

  // Map non-empty images, if less than 4, fill with empty slots for placeholders
  const validImages = images.filter(Boolean) as string[];
  const gridImages = [...validImages];
  while (gridImages.length < 4) {
    gridImages.push('');
  }

  const handleAddBag = () => {
    if (!size) {
      setSizeError(true);
    } else {
      setSizeError(false);
    }
  };

  return (
    <div
      style={{
        fontFamily: MARKETPLACE_FONTS.myntra,
        fontSize: 14,
        color: '#282c3f',
        background: '#fff',
        width: '100%',
      }}
    >
      {/* CSS Styles for hover active category bottom border and scale hover */}
      <style
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline CSS
        dangerouslySetInnerHTML={{
          __html: `
        .myntra-nav-item {
          position: relative;
          cursor: pointer;
          padding: 28px 0;
          color: #282c3f;
          font-weight: 700;
          font-size: 12.5px;
          letter-spacing: 0.3px;
          text-transform: uppercase;
        }
        .myntra-nav-item:hover::after {
          content: "";
          position: absolute;
          bottom: 0;
          left: 0;
          width: 100%;
          height: 4px;
          background: #ff3f6c;
        }
        .myntra-icon-ctrl {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 3px;
          cursor: pointer;
          font-size: 11px;
          font-weight: 700;
          color: #282c3f;
          position: relative;
        }
        .myntra-icon-ctrl:hover {
          color: #ff3f6c;
        }
      `,
        }}
      />

      {/* Header */}
      <div
        style={{
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 40px',
          height: 80,
          boxShadow: '0 4px 12px 0 rgba(0,0,0,0.05)',
          zIndex: 100,
          position: 'sticky',
          top: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 48 }}>
          <MyntraLogo />
          <nav style={{ display: 'flex', gap: 28 }}>
            {['Men', 'Women', 'Kids', 'Home', 'Beauty', 'Genz'].map((x) => (
              <span key={x} className="myntra-nav-item">
                {x}
              </span>
            ))}
          </nav>
        </div>

        <div style={{ width: 420, display: 'flex', position: 'relative', margin: '0 24px' }}>
          <input
            type="text"
            placeholder="Search for products, brands and more"
            style={{
              width: '100%',
              height: 40,
              padding: '0 12px 0 44px',
              border: 'none',
              borderRadius: 4,
              fontSize: 13,
              background: '#f5f5f6',
              outline: 'none',
              color: '#282c3f',
            }}
          />
          <span
            style={{
              position: 'absolute',
              left: 14,
              top: 10,
              display: 'flex',
              pointerEvents: 'none',
            }}
          >
            <SearchIcon color="#696e79" size={18} />
          </span>
        </div>

        <div style={{ display: 'flex', gap: 28, alignItems: 'center' }}>
          <div className="myntra-icon-ctrl">
            <UserIcon size={20} />
            <span>Profile</span>
          </div>
          <div className="myntra-icon-ctrl">
            <HeartIcon size={20} />
            <span>Wishlist</span>
          </div>
          <div className="myntra-icon-ctrl">
            <BagIcon size={20} />
            <span>Bag</span>
          </div>
        </div>
      </div>

      {/* Main product zone */}
      <div
        style={{
          display: 'flex',
          gap: 40,
          padding: '30px 40px 60px',
          maxWidth: 1440,
          margin: '0 auto',
          alignItems: 'flex-start',
        }}
      >
        {/* Left column: 2-Column Product Gallery (58%) */}
        <div style={{ flex: '0 0 58%', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {gridImages.map((src, i) => {
            if (!src) {
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: placeholder slot
                  key={`placeholder-${i}`}
                  style={{
                    width: '100%',
                    aspectRatio: '3 / 4',
                    background: '#f9f9f9',
                    border: '1px dashed #eaeaec',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#7e818c',
                    fontSize: 12,
                    gap: 8,
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="24"
                    height="24"
                    fill="none"
                    stroke="#d4d5d9"
                    strokeWidth="1.5"
                    aria-hidden="true"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                  <span>Placeholder Image</span>
                </div>
              );
            }

            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: grid index
                key={`img-${i}`}
                style={{
                  width: '100%',
                  aspectRatio: '3 / 4',
                  overflow: 'hidden',
                  background: '#f7f7f7',
                  cursor: 'zoom-in',
                  position: 'relative',
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {/* biome-ignore lint/performance/noImgElement: gallery image */}
                <img
                  src={src}
                  alt={`${details.title} view ${i + 1}`}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    transition: 'transform 0.4s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'scale(1.05)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'scale(1)';
                  }}
                />
              </div>
            );
          })}
        </div>

        {/* Right column: Info details sticky (42%) */}
        <div
          style={{
            flex: 1,
            position: 'sticky',
            top: 100,
            alignSelf: 'flex-start',
            paddingLeft: 10,
          }}
        >
          <div style={{ fontSize: 13, color: '#7e818c', marginBottom: 12 }}>
            {details.breadcrumb}
          </div>

          <h1
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: '#282c3f',
              margin: '0 0 4px',
              letterSpacing: '0.5px',
            }}
          >
            {details.store}
          </h1>
          <p
            style={{
              fontSize: 20,
              color: '#535766',
              margin: '0 0 14px',
              fontWeight: 400,
              lineHeight: '1.4',
            }}
          >
            {details.title}
          </p>

          {/* Rating Badge */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: '1px solid #eaeaec',
              padding: '4px 10px',
              borderRadius: 4,
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            <span>{details.rating} ★</span>
            <span style={{ color: '#d4d5d9' }}>|</span>
            <span style={{ color: '#7e818c', fontWeight: 400 }}>{details.ratingCount} Ratings</span>
          </div>

          <div style={{ height: 1, background: '#eaeaec', marginBottom: 16 }} />

          {/* Pricing Block */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 2 }}>
            <span style={{ fontSize: 24, fontWeight: 700, color: '#282c3f' }}>
              ₹{details.price}
            </span>
            <span style={{ color: '#7e818c', fontSize: 16 }}>
              MRP <span style={{ textDecoration: 'line-through' }}>₹{details.mrp}</span>
            </span>
            <span style={{ color: '#ff905a', fontWeight: 700, fontSize: 20 }}>
              ({details.discount})
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#03a685', fontWeight: 700, marginBottom: 24 }}>
            inclusive of all taxes
          </div>

          {/* Sizes */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
              maxWidth: 320,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700, color: '#282c3f' }}>SELECT SIZE</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#ff3f6c', cursor: 'pointer' }}>
              SIZE CHART →
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            {details.sizes.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setSize(s);
                  setSizeError(false);
                }}
                style={{
                  width: 50,
                  height: 50,
                  borderRadius: '50%',
                  border: `1px solid ${s === size ? '#ff3f6c' : '#d4d5d9'}`,
                  background: '#fff',
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: 'pointer',
                  color: s === size ? '#ff3f6c' : '#282c3f',
                }}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Size error message */}
          {sizeError && (
            <div style={{ color: '#ff3f6c', fontSize: 13, marginBottom: 16, fontWeight: 600 }}>
              Please select a size before adding to bag
            </div>
          )}

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 28 }}>
            <button
              type="button"
              onClick={handleAddBag}
              style={{
                width: '60%',
                height: 52,
                background: '#ff3f6c',
                color: '#fff',
                fontWeight: 700,
                fontSize: 15,
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <BagIcon size={18} color="#fff" />
              <span>ADD TO BAG</span>
            </button>
            <button
              type="button"
              style={{
                width: '35%',
                height: 52,
                background: '#fff',
                color: '#282c3f',
                fontWeight: 700,
                fontSize: 14,
                border: '1px solid #d4d5d9',
                borderRadius: 4,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <HeartIcon size={18} color="#282c3f" />
              <span>WISHLIST</span>
            </button>
          </div>

          <div style={{ height: 1, background: '#eaeaec', marginBottom: 24 }} />

          {/* Delivery Options */}
          <div style={{ marginBottom: 24 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontWeight: 700,
                fontSize: 14,
                marginBottom: 12,
              }}
            >
              <TruckIcon size={18} />
              <span>DELIVERY OPTIONS</span>
            </div>
            <div style={{ display: 'flex', position: 'relative', width: 260, marginBottom: 12 }}>
              <input
                type="text"
                placeholder="Enter Pincode"
                value={pincode}
                onChange={(e) => setPincode(e.target.value)}
                style={{
                  width: '100%',
                  height: 38,
                  border: '1px solid #d4d5d9',
                  borderRadius: 4,
                  padding: '0 64px 0 12px',
                  fontSize: 13,
                  outline: 'none',
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (pincode.length >= 6) {
                    setPincodeChecked(true);
                  }
                }}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: 8,
                  background: 'none',
                  border: 'none',
                  color: '#ff3f6c',
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Check
              </button>
            </div>
            {pincodeChecked ? (
              <div style={{ fontSize: 13, lineHeight: '1.6', color: '#282c3f' }}>
                <div>
                  Get it by <span style={{ fontWeight: 700 }}>Thursday, Jul 17</span>
                </div>
                <div style={{ color: '#7e818c' }}>Pay on delivery available</div>
                <div style={{ color: '#7e818c' }}>Easy 14 days returns &amp; exchanges</div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: '#7e818c' }}>
                Please enter PIN code to check delivery time &amp; COD availability
              </div>
            )}
          </div>

          <div style={{ height: 1, background: '#eaeaec', marginBottom: 24 }} />

          {/* Product Details Section */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>PRODUCT DETAILS</div>
            <div style={{ fontSize: 13.5, color: '#282c3f', lineHeight: '1.6', marginBottom: 16 }}>
              {details.description}
            </div>

            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Specifications</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px' }}>
              {details.specs.map((spec) => (
                <div
                  key={spec.label}
                  style={{ borderBottom: '1px solid #f5f5f6', paddingBottom: 6 }}
                >
                  <div style={{ fontSize: 11, color: '#7e818c', textTransform: 'uppercase' }}>
                    {spec.label}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: '#282c3f' }}>
                    {spec.value}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type FramedMyntraProduct = {
  brand: string;
  title: string;
  description: string;
  breadcrumb: string[];
  rating: string;
  ratingCount: string;
  price: string;
  mrp: string;
  discount: string;
  sizes: string[];
  category: string;
  genderLabel: string;
  details: string[];
};

const MN_THEME = {
  pink: '#ff3f6c',
  textPrimary: '#282c3f',
  textSecondary: '#535766',
  textMuted: '#7e818c',
  border: '#d4d5d9',
  divider: '#eaeaec',
  taxGreen: '#03a685',
  discountOrange: '#ff905a',
  searchBackground: '#f5f5f6',
  pageBackground: '#ffffff',
};

function framedMyntraGarmentName(garmentName?: string | null): string {
  if (!garmentName) return 'Full Sleeve Shirt';
  return garmentName
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function framedMyntraProduct(
  gender?: string | null,
  garmentName?: string | null,
): FramedMyntraProduct {
  const normalizedGender = (gender ?? '').toLowerCase();
  const isWomen = normalizedGender.includes('women') || normalizedGender.includes('girl');
  const audience = isWomen ? 'Women' : 'Men';
  const garment = framedMyntraGarmentName(garmentName);
  const category = garment.toLowerCase().includes('tshirt')
    ? 'Tshirts'
    : garment.toLowerCase().includes('top')
      ? 'Tops'
      : 'Shirts';

  return {
    brand: 'FURBO',
    title: `${audience} Solid Regular Fit ${garment}`,
    description: `${audience} solid ${garment.toLowerCase()} with a clean catalogue-ready fit and premium everyday styling.`,
    breadcrumb: ['Home', 'Clothing', `${audience} Clothing`, category, 'FURBO'],
    rating: '4.2',
    ratingCount: '1.4k Ratings',
    price: '999',
    mrp: '1,999',
    discount: '50% OFF',
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
    category,
    genderLabel: audience,
    details: [
      `Ideal For: ${audience}`,
      'Fabric: Cotton blend',
      'Pattern: Solid',
      'Fit: Regular',
      'Care: Machine wash',
    ],
  };
}

function FramedMyntraHeader() {
  const navItems = ['MEN', 'WOMEN', 'KIDS', 'HOME', 'BEAUTY', 'GENZ'];

  return (
    <header
      style={{
        height: 74,
        background: MN_THEME.pageBackground,
        boxShadow: '0 2px 10px rgba(40,44,63,0.08)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 28px',
        gap: 26,
        fontFamily:
          'Assistant, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        position: 'sticky',
        top: 0,
        zIndex: 5,
      }}
    >
      <MyntraLogo />
      <nav
        aria-label="Myntra categories"
        style={{
          display: 'flex',
          gap: 24,
          alignItems: 'center',
          height: '100%',
          flexShrink: 0,
        }}
      >
        {navItems.map((item) => (
          <span
            key={item}
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              borderBottom: item === 'MEN' ? `4px solid ${MN_THEME.pink}` : '4px solid transparent',
              color: MN_THEME.textPrimary,
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: 0,
            }}
          >
            {item}
          </span>
        ))}
      </nav>
      <div style={{ flex: 1, minWidth: 260, maxWidth: 430, position: 'relative' }}>
        <input
          aria-label="Search Myntra"
          placeholder="Search for products, brands and more"
          style={{
            width: '100%',
            height: 40,
            border: 0,
            borderRadius: 4,
            background: MN_THEME.searchBackground,
            color: MN_THEME.textPrimary,
            outline: 'none',
            padding: '0 12px 0 42px',
            fontSize: 13,
          }}
        />
        <span
          style={{
            position: 'absolute',
            left: 14,
            top: 10,
            color: '#696e79',
            display: 'flex',
          }}
        >
          <SearchIcon size={18} color="#696e79" />
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexShrink: 0 }}>
        {[
          { label: 'Profile', icon: <UserIcon size={19} color={MN_THEME.textPrimary} /> },
          { label: 'Wishlist', icon: <HeartIcon size={19} color={MN_THEME.textPrimary} /> },
          { label: 'Bag', icon: <BagIcon size={19} color={MN_THEME.textPrimary} /> },
        ].map((item) => (
          <button
            key={item.label}
            type="button"
            style={{
              border: 0,
              background: 'transparent',
              color: MN_THEME.textPrimary,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 3,
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>
    </header>
  );
}

function FramedMyntraRating({ product }: { product: FramedMyntraProduct }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        border: `1px solid ${MN_THEME.border}`,
        padding: '6px 10px',
        borderRadius: 2,
        color: MN_THEME.textPrimary,
        fontSize: 13,
        fontWeight: 700,
      }}
    >
      <span>{product.rating} *</span>
      <span style={{ width: 1, height: 15, background: MN_THEME.divider }} />
      <span style={{ color: MN_THEME.textSecondary, fontWeight: 600 }}>{product.ratingCount}</span>
    </div>
  );
}

function FramedMyntraPrice({ product }: { product: FramedMyntraProduct }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ color: MN_THEME.textPrimary, fontSize: 24, fontWeight: 700 }}>
          Rs. {product.price}
        </span>
        <span style={{ color: MN_THEME.textMuted, fontSize: 16 }}>
          MRP <span style={{ textDecoration: 'line-through' }}>Rs. {product.mrp}</span>
        </span>
        <span style={{ color: MN_THEME.discountOrange, fontSize: 16, fontWeight: 700 }}>
          ({product.discount})
        </span>
      </div>
      <div
        style={{
          color: MN_THEME.taxGreen,
          fontSize: 13,
          fontWeight: 700,
          marginTop: 5,
        }}
      >
        inclusive of all taxes
      </div>
    </div>
  );
}

function FramedMyntraSizeSelector({
  product,
  selectedSize,
  onSelect,
  showError,
}: {
  product: FramedMyntraProduct;
  selectedSize: string;
  onSelect: (size: string) => void;
  showError: boolean;
}) {
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
        <span
          style={{
            color: MN_THEME.textPrimary,
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: 0.2,
          }}
        >
          SELECT SIZE
        </span>
        <button
          type="button"
          style={{
            border: 0,
            background: 'transparent',
            color: MN_THEME.pink,
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          SIZE CHART
        </button>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {product.sizes.map((size) => (
          <button
            key={size}
            type="button"
            onClick={() => onSelect(size)}
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              border: `1px solid ${selectedSize === size ? MN_THEME.pink : MN_THEME.border}`,
              background: '#fff',
              color: selectedSize === size ? MN_THEME.pink : MN_THEME.textPrimary,
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {size}
          </button>
        ))}
      </div>
      {showError && (
        <div style={{ color: MN_THEME.pink, fontSize: 12, fontWeight: 700, marginTop: 10 }}>
          Please select a size first.
        </div>
      )}
    </section>
  );
}

function FramedMyntraActions({ onAddBag }: { onAddBag: () => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.45fr 1fr', gap: 12 }}>
      <button
        type="button"
        onClick={onAddBag}
        style={{
          height: 52,
          border: 0,
          borderRadius: 3,
          background: MN_THEME.pink,
          color: '#fff',
          fontWeight: 700,
          fontSize: 14,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        <BagIcon size={18} color="#fff" />
        ADD TO BAG
      </button>
      <button
        type="button"
        style={{
          height: 52,
          borderRadius: 3,
          border: `1px solid ${MN_THEME.border}`,
          background: '#fff',
          color: MN_THEME.textPrimary,
          fontWeight: 700,
          fontSize: 14,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        <HeartIcon size={18} color={MN_THEME.textPrimary} />
        WISHLIST
      </button>
    </div>
  );
}

function FramedMyntraGallery({
  images,
  activeIndex,
  onActiveChange,
  product,
}: {
  images: Array<string | undefined>;
  activeIndex: number;
  onActiveChange: (i: number) => void;
  product: FramedMyntraProduct;
}) {
  const slots = Array.from({ length: 4 }, (_, i) => images[i]);

  return (
    <section
      style={{
        flex: '0 0 53%',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 8,
        alignSelf: 'flex-start',
      }}
    >
      {slots.map((src, i) => (
        <button
          key={`${src ?? 'empty'}-${i}`}
          type="button"
          onClick={() => onActiveChange(i)}
          aria-label={`Show ${product.title} image ${i + 1}`}
          style={{
            border: `1px solid ${i === activeIndex ? MN_THEME.pink : MN_THEME.divider}`,
            background: '#f7f7f7',
            padding: 0,
            aspectRatio: '3 / 4',
            overflow: 'hidden',
            cursor: 'zoom-in',
            borderRadius: 0,
            position: 'relative',
          }}
        >
          {src ? (
            <img
              src={src}
              alt={`${product.title} view ${i + 1}`}
              loading={i > 1 ? 'lazy' : undefined}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                objectPosition: 'center',
                display: 'block',
                background: '#f7f7f7',
              }}
            />
          ) : (
            <div
              className="av-shimmer"
              style={{
                width: '100%',
                height: '100%',
                display: 'grid',
                placeItems: 'center',
                color: MN_THEME.textMuted,
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              Image
            </div>
          )}
        </button>
      ))}
    </section>
  );
}

function FramedMyntraInfo({
  product,
  selectedSize,
  onSelectSize,
  showSizeError,
  onAddBag,
}: {
  product: FramedMyntraProduct;
  selectedSize: string;
  onSelectSize: (size: string) => void;
  showSizeError: boolean;
  onAddBag: () => void;
}) {
  return (
    <section style={{ flex: 1, minWidth: 0, padding: '2px 8px 24px 0' }}>
      <div style={{ color: MN_THEME.textMuted, fontSize: 12, marginBottom: 14 }}>
        {product.breadcrumb.join(' / ')}
      </div>
      <h1 style={{ margin: 0, color: MN_THEME.textPrimary, fontSize: 24, fontWeight: 700 }}>
        {product.brand}
      </h1>
      <div
        style={{
          color: MN_THEME.textSecondary,
          fontSize: 19,
          lineHeight: 1.35,
          marginTop: 3,
          marginBottom: 14,
        }}
      >
        {product.title}
      </div>
      <FramedMyntraRating product={product} />
      <div style={{ height: 1, background: MN_THEME.divider, margin: '18px 0' }} />
      <FramedMyntraPrice product={product} />
      <div style={{ marginTop: 20 }}>
        <FramedMyntraSizeSelector
          product={product}
          selectedSize={selectedSize}
          onSelect={onSelectSize}
          showError={showSizeError}
        />
      </div>
      <div style={{ marginTop: 22 }}>
        <FramedMyntraActions onAddBag={onAddBag} />
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
        {[
          { label: 'Share', icon: <ShareIcon size={15} color={MN_THEME.textSecondary} /> },
          { label: 'Save for later', icon: <HeartIcon size={15} color={MN_THEME.textSecondary} /> },
        ].map((action) => (
          <button
            key={action.label}
            type="button"
            style={{
              border: 0,
              background: 'transparent',
              color: MN_THEME.textSecondary,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: 0,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {action.icon}
            {action.label}
          </button>
        ))}
      </div>
      <section
        style={{ borderTop: `1px solid ${MN_THEME.divider}`, marginTop: 22, paddingTop: 17 }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: MN_THEME.textPrimary,
            fontSize: 14,
            fontWeight: 700,
            marginBottom: 10,
          }}
        >
          DELIVERY OPTIONS <TruckIcon size={18} color={MN_THEME.textPrimary} />
        </div>
        <div style={{ display: 'flex', maxWidth: 250, border: `1px solid ${MN_THEME.border}` }}>
          <input
            aria-label="Enter pincode"
            placeholder="Enter pincode"
            style={{
              flex: 1,
              border: 0,
              outline: 'none',
              height: 36,
              padding: '0 10px',
              fontSize: 13,
              color: MN_THEME.textPrimary,
            }}
          />
          <button
            type="button"
            style={{
              border: 0,
              background: '#fff',
              color: MN_THEME.pink,
              fontWeight: 700,
              padding: '0 12px',
              cursor: 'pointer',
            }}
          >
            CHECK
          </button>
        </div>
        <div
          style={{ color: MN_THEME.textSecondary, fontSize: 13, lineHeight: 1.55, marginTop: 10 }}
        >
          100% original products. Pay on delivery available. Easy 14 days returns and exchange.
        </div>
      </section>
      <section
        style={{ borderTop: `1px solid ${MN_THEME.divider}`, marginTop: 17, paddingTop: 15 }}
      >
        <div
          style={{ color: MN_THEME.textPrimary, fontSize: 14, fontWeight: 700, marginBottom: 8 }}
        >
          PRODUCT DETAILS
        </div>
        <p
          style={{ color: MN_THEME.textSecondary, fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}
        >
          {product.description}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, fontSize: 12 }}>
          {product.details.slice(0, 4).map((item) => (
            <div key={item} style={{ color: MN_THEME.textSecondary }}>
              {item}
            </div>
          ))}
        </div>
        <div style={{ borderTop: `1px solid ${MN_THEME.divider}`, marginTop: 12, paddingTop: 10 }}>
          <div
            style={{ color: MN_THEME.textPrimary, fontSize: 13, fontWeight: 700, marginBottom: 5 }}
          >
            SIZE &amp; FIT
          </div>
          <div style={{ color: MN_THEME.textSecondary, fontSize: 12.5, lineHeight: 1.45 }}>
            Regular fit. The model is wearing size M.
          </div>
          <div
            style={{
              color: MN_THEME.textPrimary,
              fontSize: 13,
              fontWeight: 700,
              margin: '9px 0 5px',
            }}
          >
            MATERIAL &amp; CARE
          </div>
          <div style={{ color: MN_THEME.textSecondary, fontSize: 12.5, lineHeight: 1.45 }}>
            Cotton blend. Machine wash.
          </div>
        </div>
      </section>
    </section>
  );
}

export function FramedMyntraDesktopTemplate({
  images,
  activeIndex,
  onActiveChange,
  gender,
  garmentName,
}: TemplateProps) {
  const product = framedMyntraProduct(gender, garmentName);
  const [selectedSize, setSelectedSize] = useState('');
  const [showSizeError, setShowSizeError] = useState(false);

  const handleAddBag = () => {
    setShowSizeError(!selectedSize);
  };

  return (
    <div
      style={
        {
          '--myntra-pink': MN_THEME.pink,
          '--text-primary': MN_THEME.textPrimary,
          '--text-secondary': MN_THEME.textSecondary,
          '--text-muted': MN_THEME.textMuted,
          '--border-color': MN_THEME.border,
          '--divider-color': MN_THEME.divider,
          '--tax-green': MN_THEME.taxGreen,
          '--discount-orange': MN_THEME.discountOrange,
          '--search-background': MN_THEME.searchBackground,
          '--page-background': MN_THEME.pageBackground,
          fontFamily: MARKETPLACE_FONTS.myntra,
          fontSize: 14,
          color: MN_THEME.textPrimary,
          background: MN_THEME.pageBackground,
          minHeight: 700,
        } as React.CSSProperties
      }
    >
      <FramedMyntraHeader />
      <main
        style={{
          maxWidth: 1160,
          margin: '0 auto',
          display: 'flex',
          gap: 30,
          padding: '22px 26px 36px',
          alignItems: 'flex-start',
        }}
      >
        <FramedMyntraGallery
          images={images}
          activeIndex={activeIndex}
          onActiveChange={onActiveChange}
          product={product}
        />
        <FramedMyntraInfo
          product={product}
          selectedSize={selectedSize}
          onSelectSize={(size) => {
            setSelectedSize(size);
            setShowSizeError(false);
          }}
          showSizeError={showSizeError}
          onAddBag={handleAddBag}
        />
      </main>
    </div>
  );
}

export function FramedMyntraMobileTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
  gender,
  garmentName,
}: TemplateProps) {
  const product = framedMyntraProduct(gender, garmentName);
  const [selectedSize, setSelectedSize] = useState('');
  const [showSizeError, setShowSizeError] = useState(false);
  const active = images[activeIndex];

  const handleAddBag = () => {
    setShowSizeError(!selectedSize);
  };

  return (
    <div
      style={{
        fontFamily:
          'Assistant, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        color: MN_THEME.textPrimary,
        background: '#fff',
        fontSize: 13,
        minHeight: '100%',
      }}
    >
      <header
        style={{
          height: 56,
          display: 'grid',
          gridTemplateColumns: '28px 48px minmax(0, 1fr) 54px',
          alignItems: 'center',
          columnGap: 8,
          padding: '0 12px',
          borderBottom: `1px solid ${MN_THEME.divider}`,
          background: '#fff',
          position: 'sticky',
          top: 0,
          zIndex: 5,
        }}
      >
        <button
          type="button"
          aria-label="Back"
          style={{
            border: 0,
            background: 'transparent',
            color: MN_THEME.textPrimary,
            fontSize: 20,
            fontWeight: 700,
            cursor: 'pointer',
            padding: 0,
            width: 28,
            height: 28,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <ArrowBackIcon size={19} color={MN_THEME.textPrimary} />
        </button>
        <div style={{ display: 'flex', alignItems: 'center', height: 42, overflow: 'hidden' }}>
          <MyntraLogo />
        </div>
        <div
          style={{
            height: 34,
            borderRadius: 3,
            background: MN_THEME.searchBackground,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 9px',
            color: MN_THEME.textMuted,
            fontSize: 11.5,
            minWidth: 0,
          }}
        >
          <SearchIcon size={15} color={MN_THEME.textMuted} />
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            Search
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
          <HeartIcon size={18} color={MN_THEME.textPrimary} />
          <BagIcon size={18} color={MN_THEME.textPrimary} />
        </div>
      </header>

      <section style={{ background: '#f7f7f7' }}>
        <ProductImage src={active} ratio={ratio} />
      </section>
      {(() => {
        const resolved = images.map((url, i) => ({ url, i })).filter(({ url }) => Boolean(url));
        if (resolved.length <= 1) return null;
        return (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 5, padding: '8px 0 6px' }}>
            {resolved.map(({ i }) => (
              <button
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                aria-label={`Show image ${i + 1}`}
                style={{
                  width: i === activeIndex ? 7 : 5,
                  height: i === activeIndex ? 7 : 5,
                  borderRadius: '50%',
                  border: 0,
                  padding: 0,
                  background: i === activeIndex ? MN_THEME.pink : '#c2c2c2',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
        );
      })()}

      <main style={{ padding: 12, paddingBottom: 84 }}>
        <div style={{ color: MN_THEME.textPrimary, fontSize: 17, fontWeight: 700 }}>
          {product.brand}
        </div>
        <div
          style={{ color: MN_THEME.textSecondary, fontSize: 13.5, lineHeight: 1.35, marginTop: 2 }}
        >
          {product.title}
        </div>
        <div style={{ marginTop: 10 }}>
          <FramedMyntraRating product={product} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            type="button"
            style={{
              flex: 1,
              height: 32,
              border: `1px solid ${MN_THEME.border}`,
              background: '#fff',
              color: MN_THEME.textPrimary,
              fontWeight: 700,
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
              cursor: 'pointer',
            }}
          >
            <HeartIcon size={14} color={MN_THEME.textPrimary} />
            Wishlist
          </button>
          <button
            type="button"
            style={{
              flex: 1,
              height: 32,
              border: `1px solid ${MN_THEME.border}`,
              background: '#fff',
              color: MN_THEME.textPrimary,
              fontWeight: 700,
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
              cursor: 'pointer',
            }}
          >
            <ShareIcon size={14} color={MN_THEME.textPrimary} />
            Share
          </button>
        </div>
        <div style={{ height: 1, background: MN_THEME.divider, margin: '13px 0' }} />
        <FramedMyntraPrice product={product} />
        <div style={{ marginTop: 16 }}>
          <FramedMyntraSizeSelector
            product={product}
            selectedSize={selectedSize}
            onSelect={(size) => {
              setSelectedSize(size);
              setShowSizeError(false);
            }}
            showError={showSizeError}
          />
        </div>
        <section
          style={{ borderTop: `1px solid ${MN_THEME.divider}`, marginTop: 18, paddingTop: 14 }}
        >
          <div
            style={{ color: MN_THEME.textPrimary, fontWeight: 700, fontSize: 13, marginBottom: 7 }}
          >
            DELIVERY OPTIONS
          </div>
          <div style={{ color: MN_THEME.textSecondary, fontSize: 12.5, lineHeight: 1.45 }}>
            Pay on delivery available. Easy 14 days returns and exchange.
          </div>
        </section>
        <section
          style={{ borderTop: `1px solid ${MN_THEME.divider}`, marginTop: 15, paddingTop: 13 }}
        >
          <div
            style={{ color: MN_THEME.textPrimary, fontWeight: 700, fontSize: 13, marginBottom: 7 }}
          >
            PRODUCT DETAILS
          </div>
          <p style={{ color: MN_THEME.textSecondary, fontSize: 12.5, lineHeight: 1.45 }}>
            {product.description}
          </p>
          <div style={{ color: MN_THEME.textSecondary, fontSize: 12.5, lineHeight: 1.45 }}>
            Size &amp; Fit: Regular fit. Material &amp; Care: Cotton blend, machine wash.
          </div>
        </section>
      </main>

      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: '#fff',
          borderTop: `1px solid ${MN_THEME.divider}`,
          padding: 10,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={handleAddBag}
          style={{
            height: 44,
            borderRadius: 3,
            border: `1px solid ${MN_THEME.border}`,
            background: '#fff',
            color: MN_THEME.textPrimary,
            fontWeight: 700,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          ADD TO CART
        </button>
        <button
          type="button"
          onClick={handleAddBag}
          style={{
            height: 44,
            borderRadius: 3,
            border: 0,
            background: MN_THEME.pink,
            color: '#fff',
            fontWeight: 700,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          BUY NOW
        </button>
      </div>
    </div>
  );
}

type FramedAjioProduct = {
  brand: string;
  title: string;
  description: string;
  breadcrumb: string[];
  rating: string;
  reviewCount: string;
  price: string;
  mrp: string;
  discount: string;
  sizes: Array<{ label: string; disabled?: boolean }>;
  color: string;
  category: string;
  genderLabel: string;
  offers: string[];
  specs: string[];
};

const AJIO_THEME = {
  dark: '#2c2c2c',
  black: '#111111',
  gold: '#b89b5e',
  accent: '#d4af67',
  lightGold: '#efe7d5',
  textPrimary: '#333333',
  textSecondary: '#666666',
  textMuted: '#8a8a8a',
  border: '#dddddd',
  divider: '#eeeeee',
  page: '#ffffff',
  searchBackground: '#fafafa',
  offerGreen: '#176c45',
  discount: '#b14a32',
};

function framedAjioGarmentName(garmentName?: string | null): string {
  if (!garmentName) return 'Full Sleeve Shirt';
  return garmentName
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function framedAjioProduct(gender?: string | null, garmentName?: string | null): FramedAjioProduct {
  const normalizedGender = (gender ?? '').toLowerCase();
  const isWomen = normalizedGender.includes('women') || normalizedGender.includes('girl');
  const audience = isWomen ? 'Women' : 'Men';
  const garment = framedAjioGarmentName(garmentName);
  const category = garment.toLowerCase().includes('tshirt')
    ? 'T-Shirts'
    : garment.toLowerCase().includes('top')
      ? 'Tops'
      : 'Shirts';

  return {
    brand: 'FURBO',
    title: `${audience} ${garment} with Regular Fit`,
    description: `${audience} ${garment.toLowerCase()} designed with a refined catalogue-ready silhouette, clean finish and versatile everyday styling.`,
    breadcrumb: ['Home', audience, 'Western Wear', category, garment],
    rating: '4.1',
    reviewCount: '213 Ratings',
    price: '999',
    mrp: '1,999',
    discount: '50% OFF',
    sizes: [
      { label: 'S' },
      { label: 'M' },
      { label: 'L' },
      { label: 'XL' },
      { label: 'XXL', disabled: true },
    ],
    color: 'Mauve',
    category,
    genderLabel: audience,
    offers: ['Use code AJIOSTYLE to get extra 10% off', 'Bank offer available on prepaid orders'],
    specs: [
      `Ideal For: ${audience}`,
      'Fabric: Cotton blend',
      'Pattern: Solid',
      'Fit: Regular',
      'Country of Origin: India',
    ],
  };
}

function AjioLogo() {
  return (
    <MarketplaceLogo
      platform="ajio"
      width={118}
      height={38}
      style={{ objectPosition: 'left center' }}
    />
  );
}

function FramedAjioHeader() {
  return (
    <header
      style={{
        fontFamily: MARKETPLACE_FONTS.ajio,
        background: AJIO_THEME.page,
        borderBottom: `1px solid ${AJIO_THEME.border}`,
        color: AJIO_THEME.textPrimary,
      }}
    >
      <div
        style={{
          height: 28,
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 20,
          padding: '0 38px',
          fontSize: 11,
          color: AJIO_THEME.textSecondary,
          letterSpacing: 0.2,
        }}
      >
        <span>Sign In / Join AJIO</span>
        <span>Customer Care</span>
        <span style={{ color: AJIO_THEME.gold, fontWeight: 700 }}>Visit AJIOLUXE</span>
      </div>
      <div
        style={{
          height: 60,
          display: 'flex',
          alignItems: 'center',
          padding: '0 38px',
          gap: 28,
          boxShadow: '0 2px 8px rgba(17,17,17,0.06)',
        }}
      >
        <AjioLogo />
        <nav
          aria-label="AJIO categories"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 24,
            flexShrink: 0,
            fontSize: 13,
            color: AJIO_THEME.dark,
            letterSpacing: 1.1,
          }}
        >
          {['MEN', 'WOMEN', 'KIDS', 'BEAUTY', 'HOME AND KITCHEN'].map((item) => (
            <span key={item} style={{ fontWeight: 500 }}>
              {item}
            </span>
          ))}
        </nav>
        <div
          style={{
            flex: 1,
            minWidth: 210,
            maxWidth: 320,
            marginLeft: 'auto',
            position: 'relative',
          }}
        >
          <input
            aria-label="Search AJIO"
            placeholder="Search AJIO"
            style={{
              width: '100%',
              height: 36,
              borderRadius: 0,
              border: `1px solid ${AJIO_THEME.border}`,
              background: AJIO_THEME.searchBackground,
              color: AJIO_THEME.textPrimary,
              outline: 'none',
              padding: '0 40px 0 13px',
              fontSize: 13,
            }}
          />
          <span style={{ position: 'absolute', right: 12, top: 8, display: 'flex' }}>
            <SearchIcon size={18} color={AJIO_THEME.textSecondary} />
          </span>
        </div>
        <button
          type="button"
          aria-label="Wishlist"
          style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }}
        >
          <HeartIcon size={21} color={AJIO_THEME.dark} />
        </button>
        <button
          type="button"
          aria-label="Bag"
          style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }}
        >
          <BagIcon size={21} color={AJIO_THEME.dark} />
        </button>
      </div>
    </header>
  );
}

function FramedAjioPrice({ product }: { product: FramedAjioProduct }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ color: AJIO_THEME.black, fontSize: 23, fontWeight: 700 }}>
          Rs. {product.price}
        </span>
        <span style={{ color: AJIO_THEME.textMuted, fontSize: 14 }}>
          MRP <span style={{ textDecoration: 'line-through' }}>Rs. {product.mrp}</span>
        </span>
        <span style={{ color: AJIO_THEME.discount, fontSize: 14, fontWeight: 700 }}>
          {product.discount}
        </span>
      </div>
      <div style={{ color: AJIO_THEME.textMuted, fontSize: 12, marginTop: 5 }}>
        Price inclusive of all taxes
      </div>
    </div>
  );
}

function FramedAjioRating({ product }: { product: FramedAjioProduct }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        borderBottom: `1px solid ${AJIO_THEME.divider}`,
        paddingBottom: 7,
        color: AJIO_THEME.textPrimary,
        fontSize: 13,
      }}
    >
      <span style={{ fontWeight: 700 }}>{product.rating} *</span>
      <span style={{ color: AJIO_THEME.textMuted }}>{product.reviewCount}</span>
    </div>
  );
}

function FramedAjioGallery({
  images,
  activeIndex,
  onActiveChange,
  product,
}: {
  images: Array<string | undefined>;
  activeIndex: number;
  onActiveChange: (i: number) => void;
  product: FramedAjioProduct;
}) {
  const validImages = images.map((src, i) => ({ src, i })).filter(({ src }) => Boolean(src));
  const active = images[activeIndex] ?? validImages[0]?.src;
  const thumbnails = validImages.length > 0 ? validImages.slice(0, 5) : [{ src: undefined, i: 0 }];

  return (
    <section style={{ flex: '0 0 56%', display: 'flex', gap: 14, alignSelf: 'flex-start' }}>
      <div style={{ width: 58, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {thumbnails.map(({ src, i }) => (
          <button
            key={`${src ?? 'empty'}-${i}`}
            type="button"
            onClick={() => onActiveChange(i)}
            aria-label={`Show ${product.title} image ${i + 1}`}
            style={{
              width: 58,
              height: 76,
              border: `1px solid ${i === activeIndex ? AJIO_THEME.gold : AJIO_THEME.border}`,
              background: '#f7f7f7',
              padding: 3,
              cursor: 'pointer',
            }}
          >
            {src ? (
              <img
                src={src}
                alt=""
                loading={i > 1 ? 'lazy' : undefined}
                style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
              />
            ) : (
              <div className="av-shimmer" style={{ width: '100%', height: '100%' }} />
            )}
          </button>
        ))}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 500,
          background: '#f6f6f6',
          border: `1px solid ${AJIO_THEME.divider}`,
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          overflow: 'hidden',
        }}
      >
        <button
          type="button"
          aria-label="Save product"
          style={{
            position: 'absolute',
            top: 16,
            right: 16,
            width: 36,
            height: 36,
            borderRadius: '50%',
            border: `1px solid ${AJIO_THEME.border}`,
            background: '#fff',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
          }}
        >
          <HeartIcon size={18} color={AJIO_THEME.dark} />
        </button>
        {active ? (
          <img
            src={active}
            alt={product.title}
            style={{
              width: '100%',
              height: '100%',
              maxHeight: 470,
              objectFit: 'contain',
              display: 'block',
            }}
          />
        ) : (
          <div className="av-shimmer" style={{ width: '100%', height: 460 }} />
        )}
      </div>
    </section>
  );
}

function FramedAjioSizeSelector({
  product,
  selectedSize,
  onSelect,
}: {
  product: FramedAjioProduct;
  selectedSize: string;
  onSelect: (size: string) => void;
}) {
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10 }}>
        <span
          style={{
            color: AJIO_THEME.textPrimary,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 0.7,
          }}
        >
          SELECT SIZE
        </span>
        <button
          type="button"
          style={{
            border: 0,
            background: 'transparent',
            color: AJIO_THEME.gold,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: 0.5,
            padding: 0,
            cursor: 'pointer',
          }}
        >
          SIZE GUIDE
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {product.sizes.map((size) => (
          <button
            key={size.label}
            type="button"
            disabled={size.disabled}
            onClick={() => onSelect(size.label)}
            style={{
              minWidth: 42,
              height: 38,
              borderRadius: 2,
              border: `1px solid ${
                selectedSize === size.label ? AJIO_THEME.black : AJIO_THEME.border
              }`,
              background: '#fff',
              color: size.disabled ? AJIO_THEME.textMuted : AJIO_THEME.textPrimary,
              fontWeight: 700,
              cursor: size.disabled ? 'not-allowed' : 'pointer',
              textDecoration: size.disabled ? 'line-through' : 'none',
              opacity: size.disabled ? 0.55 : 1,
            }}
          >
            {size.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function FramedAjioInfo({
  product,
  selectedSize,
  onSelectSize,
}: {
  product: FramedAjioProduct;
  selectedSize: string;
  onSelectSize: (size: string) => void;
}) {
  return (
    <section style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
      <div style={{ color: AJIO_THEME.textMuted, fontSize: 12, marginBottom: 12 }}>
        {product.breadcrumb.join(' / ')}
      </div>
      <h1
        style={{
          color: AJIO_THEME.black,
          fontSize: 20,
          fontWeight: 700,
          letterSpacing: 0.7,
          margin: 0,
          textTransform: 'uppercase',
        }}
      >
        {product.brand}
      </h1>
      <div
        style={{
          color: AJIO_THEME.textSecondary,
          fontSize: 17,
          lineHeight: 1.35,
          marginTop: 5,
          marginBottom: 10,
        }}
      >
        {product.title}
      </div>
      <FramedAjioRating product={product} />
      <div style={{ marginTop: 16 }}>
        <FramedAjioPrice product={product} />
      </div>
      <div
        style={{
          color: AJIO_THEME.offerGreen,
          background: '#f5fbf8',
          border: `1px solid ${AJIO_THEME.divider}`,
          padding: '9px 11px',
          fontSize: 12.5,
          lineHeight: 1.45,
          marginTop: 14,
        }}
      >
        <strong>Offer price available.</strong> {product.offers[0]}.
        <br />
        <span style={{ color: AJIO_THEME.textMuted }}>{product.offers[1]} · T&amp;C apply</span>
      </div>
      <div style={{ height: 1, background: AJIO_THEME.divider, margin: '16px 0' }} />
      <div style={{ color: AJIO_THEME.textSecondary, fontSize: 13, marginBottom: 14 }}>
        Colour: <strong style={{ color: AJIO_THEME.textPrimary }}>{product.color}</strong>
      </div>
      <FramedAjioSizeSelector
        product={product}
        selectedSize={selectedSize}
        onSelect={onSelectSize}
      />
      <div
        style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr 46px', gap: 10, marginTop: 18 }}
      >
        <button
          type="button"
          style={{
            height: 50,
            border: 0,
            background: AJIO_THEME.black,
            color: '#fff',
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 1.2,
            cursor: 'pointer',
          }}
        >
          ADD TO BAG
        </button>
        <button
          type="button"
          style={{
            height: 50,
            border: `1px solid ${AJIO_THEME.border}`,
            background: '#fff',
            color: AJIO_THEME.dark,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 0.8,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
          }}
        >
          <HeartIcon size={17} color={AJIO_THEME.dark} />
          WISHLIST
        </button>
        <button
          type="button"
          aria-label="Share product"
          style={{
            height: 50,
            border: `1px solid ${AJIO_THEME.border}`,
            background: '#fff',
            color: AJIO_THEME.dark,
            cursor: 'pointer',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <ShareIcon size={18} color={AJIO_THEME.dark} />
        </button>
      </div>
      <section
        style={{ borderTop: `1px solid ${AJIO_THEME.divider}`, marginTop: 18, paddingTop: 14 }}
      >
        <div
          style={{
            color: AJIO_THEME.textPrimary,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 0.8,
            marginBottom: 8,
          }}
        >
          ENTER PINCODE
        </div>
        <div style={{ display: 'flex', maxWidth: 260, border: `1px solid ${AJIO_THEME.border}` }}>
          <input
            aria-label="Enter pincode"
            placeholder="Pincode"
            defaultValue="560001"
            style={{
              flex: 1,
              height: 34,
              border: 0,
              outline: 'none',
              padding: '0 10px',
              fontSize: 13,
              color: AJIO_THEME.textPrimary,
            }}
          />
          <button
            type="button"
            style={{
              border: 0,
              background: '#fff',
              color: AJIO_THEME.gold,
              fontWeight: 700,
              padding: '0 11px',
              cursor: 'pointer',
            }}
          >
            CHECK
          </button>
        </div>
        <div
          style={{
            color: AJIO_THEME.textSecondary,
            fontSize: 12.5,
            lineHeight: 1.55,
            marginTop: 9,
          }}
        >
          Get it in 3-5 days. Cash on delivery available. Easy 7 days return and exchange.
        </div>
      </section>
      <section
        style={{ borderTop: `1px solid ${AJIO_THEME.divider}`, marginTop: 16, paddingTop: 13 }}
      >
        <div
          style={{
            color: AJIO_THEME.textPrimary,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 0.8,
            marginBottom: 8,
          }}
        >
          RETURNS &amp; AUTHENTICITY
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
            color: AJIO_THEME.textSecondary,
            fontSize: 12.5,
          }}
        >
          <span>Easy 7 days return</span>
          <span>100% genuine products</span>
          <span>Quality checked by AJIO</span>
          <span>Secure payments</span>
        </div>
      </section>
      <section
        style={{ borderTop: `1px solid ${AJIO_THEME.divider}`, marginTop: 16, paddingTop: 13 }}
      >
        <div
          style={{
            color: AJIO_THEME.textPrimary,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 0.8,
            marginBottom: 8,
          }}
        >
          PRODUCT DETAILS
        </div>
        <p
          style={{
            color: AJIO_THEME.textSecondary,
            fontSize: 12.5,
            lineHeight: 1.5,
            marginBottom: 9,
          }}
        >
          {product.description}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, fontSize: 12 }}>
          {product.specs.slice(0, 4).map((spec) => (
            <span key={spec} style={{ color: AJIO_THEME.textSecondary }}>
              {spec}
            </span>
          ))}
        </div>
      </section>
    </section>
  );
}

export function FramedAjioDesktopTemplate({
  images,
  activeIndex,
  onActiveChange,
  gender,
  garmentName,
}: TemplateProps) {
  const product = framedAjioProduct(gender, garmentName);
  const [selectedSize, setSelectedSize] = useState('M');

  return (
    <div
      style={
        {
          '--ajio-dark': AJIO_THEME.dark,
          '--ajio-black': AJIO_THEME.black,
          '--ajio-gold': AJIO_THEME.gold,
          '--ajio-accent': AJIO_THEME.accent,
          '--ajio-light-gold': AJIO_THEME.lightGold,
          '--ajio-text-primary': AJIO_THEME.textPrimary,
          '--ajio-text-secondary': AJIO_THEME.textSecondary,
          '--ajio-text-muted': AJIO_THEME.textMuted,
          '--ajio-border': AJIO_THEME.border,
          '--ajio-divider': AJIO_THEME.divider,
          '--ajio-page': AJIO_THEME.page,
          '--ajio-search-background': AJIO_THEME.searchBackground,
          '--ajio-offer-green': AJIO_THEME.offerGreen,
          '--ajio-discount': AJIO_THEME.discount,
          fontFamily: MARKETPLACE_FONTS.ajio,
          color: AJIO_THEME.textPrimary,
          background: AJIO_THEME.page,
          minHeight: 700,
        } as React.CSSProperties
      }
    >
      <FramedAjioHeader />
      <main
        style={{
          maxWidth: 1160,
          margin: '0 auto',
          display: 'flex',
          gap: 30,
          padding: '22px 28px 38px',
          alignItems: 'flex-start',
        }}
      >
        <FramedAjioGallery
          images={images}
          activeIndex={activeIndex}
          onActiveChange={onActiveChange}
          product={product}
        />
        <FramedAjioInfo
          product={product}
          selectedSize={selectedSize}
          onSelectSize={setSelectedSize}
        />
      </main>
    </div>
  );
}

export function FramedAjioMobileTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
  gender,
  garmentName,
}: TemplateProps) {
  const product = framedAjioProduct(gender, garmentName);
  const [selectedSize, setSelectedSize] = useState('M');
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily: MARKETPLACE_FONTS.ajio,
        color: AJIO_THEME.textPrimary,
        background: '#fff',
        minHeight: '100%',
        fontSize: 13,
      }}
    >
      <header
        style={{
          height: 52,
          display: 'grid',
          gridTemplateColumns: '28px minmax(0, 1fr) auto',
          alignItems: 'center',
          columnGap: 10,
          padding: '0 12px',
          borderBottom: `1px solid ${AJIO_THEME.divider}`,
          background: '#fff',
          position: 'sticky',
          top: 0,
          zIndex: 5,
        }}
      >
        <button
          type="button"
          aria-label="Back"
          style={{
            border: 0,
            background: 'transparent',
            color: AJIO_THEME.dark,
            fontSize: 20,
            fontWeight: 700,
            cursor: 'pointer',
            padding: 0,
            width: 28,
            height: 28,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <ArrowBackIcon size={19} color={AJIO_THEME.dark} />
        </button>
        <div style={{ height: 28, minWidth: 0, display: 'flex', alignItems: 'center' }}>
          <MarketplaceLogo
            platform="ajio"
            width={78}
            height={25}
            style={{ objectPosition: 'left center' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 13 }}>
          <SearchIcon size={18} color={AJIO_THEME.dark} />
          <ShareIcon size={18} color={AJIO_THEME.dark} />
          <HeartIcon size={18} color={AJIO_THEME.dark} />
          <BagIcon size={18} color={AJIO_THEME.dark} />
        </div>
      </header>

      <section style={{ position: 'relative', background: '#f6f6f6' }}>
        <ProductImage src={active} ratio={ratio} />
        <button
          type="button"
          aria-label="Wishlist"
          style={{
            position: 'absolute',
            right: 12,
            bottom: 12,
            width: 34,
            height: 34,
            borderRadius: '50%',
            border: `1px solid ${AJIO_THEME.border}`,
            background: '#fff',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
          }}
        >
          <HeartIcon size={17} color={AJIO_THEME.dark} />
        </button>
        <button
          type="button"
          aria-label="Share"
          style={{
            position: 'absolute',
            right: 54,
            bottom: 12,
            width: 34,
            height: 34,
            borderRadius: '50%',
            border: `1px solid ${AJIO_THEME.border}`,
            background: '#fff',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
          }}
        >
          <ShareIcon size={17} color={AJIO_THEME.dark} />
        </button>
      </section>
      {(() => {
        const resolved = images.map((url, i) => ({ url, i })).filter(({ url }) => Boolean(url));
        if (resolved.length <= 1) return null;
        return (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 5, padding: '8px 0 6px' }}>
            {resolved.map(({ i }) => (
              <button
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                aria-label={`Show image ${i + 1}`}
                style={{
                  width: i === activeIndex ? 7 : 5,
                  height: i === activeIndex ? 7 : 5,
                  borderRadius: '50%',
                  border: 0,
                  padding: 0,
                  background: i === activeIndex ? AJIO_THEME.black : '#c9c9c9',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
        );
      })()}

      <main style={{ padding: 12, paddingBottom: 84 }}>
        <div
          style={{
            color: AJIO_THEME.black,
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: 0.7,
            textTransform: 'uppercase',
          }}
        >
          {product.brand}
        </div>
        <div
          style={{
            color: AJIO_THEME.textSecondary,
            fontSize: 13.5,
            lineHeight: 1.35,
            marginTop: 2,
          }}
        >
          {product.title}
        </div>
        <div style={{ marginTop: 10 }}>
          <FramedAjioRating product={product} />
        </div>
        <div style={{ marginTop: 12 }}>
          <FramedAjioPrice product={product} />
        </div>
        <div
          style={{
            color: AJIO_THEME.offerGreen,
            background: '#f5fbf8',
            border: `1px solid ${AJIO_THEME.divider}`,
            padding: 9,
            fontSize: 12,
            lineHeight: 1.4,
            marginTop: 13,
          }}
        >
          {product.offers[0]}
        </div>
        <div style={{ marginTop: 15 }}>
          <FramedAjioSizeSelector
            product={product}
            selectedSize={selectedSize}
            onSelect={setSelectedSize}
          />
        </div>
        <section
          style={{ borderTop: `1px solid ${AJIO_THEME.divider}`, marginTop: 16, paddingTop: 13 }}
        >
          <div
            style={{
              color: AJIO_THEME.textPrimary,
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: 0.7,
            }}
          >
            DELIVERY DETAILS
          </div>
          <div
            style={{
              color: AJIO_THEME.textSecondary,
              fontSize: 12.5,
              lineHeight: 1.45,
              marginTop: 7,
            }}
          >
            Get it in 3-5 days. COD and easy return available for eligible pincodes.
          </div>
          <div
            style={{
              color: AJIO_THEME.textSecondary,
              fontSize: 12.5,
              lineHeight: 1.45,
              marginTop: 6,
            }}
          >
            100% genuine products. Quality checked by AJIO.
          </div>
        </section>
        <section
          style={{ borderTop: `1px solid ${AJIO_THEME.divider}`, marginTop: 15, paddingTop: 13 }}
        >
          <div
            style={{
              color: AJIO_THEME.textPrimary,
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: 0.7,
            }}
          >
            PRODUCT DETAILS
          </div>
          <p
            style={{
              color: AJIO_THEME.textSecondary,
              fontSize: 12.5,
              lineHeight: 1.45,
              marginTop: 7,
            }}
          >
            {product.description}
          </p>
        </section>
      </main>

      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: '#fff',
          borderTop: `1px solid ${AJIO_THEME.divider}`,
          padding: 10,
          display: 'grid',
          gridTemplateColumns: '1fr 1.45fr',
          gap: 8,
        }}
      >
        <button
          type="button"
          style={{
            height: 44,
            border: `1px solid ${AJIO_THEME.border}`,
            background: '#fff',
            color: AJIO_THEME.dark,
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: 0.8,
            cursor: 'pointer',
          }}
        >
          WISHLIST
        </button>
        <button
          type="button"
          style={{
            height: 44,
            border: 0,
            background: AJIO_THEME.black,
            color: '#fff',
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: 1,
            cursor: 'pointer',
          }}
        >
          ADD TO BAG
        </button>
      </div>
    </div>
  );
}

// ─── AJIO templates ──────────────────────────────────────────────────────────

export function AjioMobileTemplate({ images, activeIndex, onActiveChange, ratio }: TemplateProps) {
  const [size, setSize] = useState(TC.defaultSize);
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily: 'Source Sans Pro, Helvetica, Arial, sans-serif',
        fontSize: 13,
        color: '#333',
        background: '#fff',
      }}
    >
      {/* Header */}
      <div
        style={{
          background: '#fff',
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          height: 52,
          boxSizing: 'border-box',
          borderBottom: '1px solid #f2f2f2',
        }}
      >
        <span style={{ fontSize: 18, color: '#333', cursor: 'pointer' }}>←</span>
        <MarketplaceLogo
          platform="ajio"
          width={76}
          height={24}
          style={{ margin: '0 auto 0 0', objectPosition: 'left center' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, color: '#333' }}>
          <span style={{ display: 'flex' }}>
            <SearchG color="#333" />
          </span>
          <CartG size={20} color="#333" />
        </div>
      </div>

      <ProductImage src={active} ratio={ratio} />

      {/* Carousel Dots */}
      {(() => {
        const resolved = images.map((url, i) => ({ url, i })).filter(({ url }) => Boolean(url));
        if (resolved.length <= 1) return null;
        return (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 5, padding: '8px 0 4px' }}>
            {resolved.map(({ i }) => (
              <button
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                aria-label={`Show image ${i + 1}`}
                style={{
                  width: i === activeIndex ? 7 : 5,
                  height: i === activeIndex ? 7 : 5,
                  borderRadius: '50%',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  background: i === activeIndex ? '#b19975' : '#c2c2c2',
                }}
              />
            ))}
          </div>
        );
      })()}

      {/* Details */}
      <div style={{ padding: 12 }}>
        <div
          style={{
            color: '#b19975',
            fontSize: 14,
            fontWeight: 700,
            textTransform: 'uppercase',
            marginBottom: 2,
          }}
        >
          {TC.store}
        </div>
        <div style={{ fontSize: 13.5, color: '#333', lineHeight: 1.3, marginBottom: 8 }}>
          {TC.title}
        </div>

        {/* Price */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: '#2f4254' }}>₹{TC.price}</span>
          <span style={{ color: '#878787', textDecoration: 'line-through', fontSize: 12 }}>
            ₹{TC.mrp}
          </span>
          <span style={{ color: '#b19975', fontWeight: 700, fontSize: 13 }}>
            ({TC.discount} off)
          </span>
        </div>
        <div style={{ fontSize: 10.5, color: '#999', marginBottom: 12 }}>
          Price inclusive of all taxes
        </div>

        <div style={{ height: 1, background: '#f2f2f2', marginBottom: 10 }} />

        {/* Size Selection */}
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: '#333' }}>
          Select Size
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {TC.sizes.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSize(s)}
              style={{
                width: 38,
                height: 38,
                borderRadius: 2,
                border: `1px solid ${s === size ? '#2f4254' : '#d4d4d4'}`,
                background: '#fff',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                color: s === size ? '#2f4254' : '#333',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* AJIO Offer Block */}
        <div
          style={{
            border: '1px dashed #b19975',
            borderRadius: 4,
            padding: 10,
            marginBottom: 14,
            background: '#fdfcf7',
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: '#b19975',
              textTransform: 'uppercase',
              marginBottom: 4,
            }}
          >
            Use Code: EPICSELLER
          </div>
          <div style={{ fontSize: 11, color: '#333', lineHeight: 1.4 }}>
            Get extra discounts on orders above ₹1,490.{' '}
            <span style={{ color: '#2f4254', fontWeight: 600 }}>T&amp;C</span>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            style={{
              flex: 1,
              height: 44,
              borderRadius: 2,
              border: '1px solid #2f4254',
              background: '#fff',
              color: '#2f4254',
              fontWeight: 600,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            ♡ WISHLIST
          </button>
          <button
            type="button"
            style={{
              flex: 1.5,
              height: 44,
              borderRadius: 2,
              border: 'none',
              background: '#2f4254',
              color: '#fff',
              fontWeight: 600,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            ADD TO BAG
          </button>
        </div>
      </div>
    </div>
  );
}

export function AjioDesktopTemplate({ images, activeIndex, onActiveChange, ratio }: TemplateProps) {
  const [size, setSize] = useState(TC.defaultSize);
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily: 'Source Sans Pro, Helvetica, Arial, sans-serif',
        fontSize: 14,
        color: '#333',
        background: '#fff',
      }}
    >
      {/* Top Nav */}
      <div
        style={{
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 6%',
          height: 80,
          borderBottom: '1px solid #f2f2f2',
        }}
      >
        <div
          style={{
            fontWeight: 700,
            fontSize: 28,
            color: '#2f4254',
            letterSpacing: 2,
            fontStyle: 'italic',
            cursor: 'pointer',
          }}
        >
          AJIO
        </div>

        <div
          style={{
            display: 'flex',
            gap: 28,
            fontWeight: 700,
            fontSize: 13,
            color: '#2f4254',
            textTransform: 'uppercase',
          }}
        >
          {['Men', 'Women', 'Kids', 'Indie', 'Home'].map((x) => (
            <span key={x} style={{ cursor: 'pointer' }}>
              {x}
            </span>
          ))}
        </div>

        <div style={{ width: 260, display: 'flex', position: 'relative' }}>
          <input
            type="text"
            placeholder="Search AJIO"
            style={{
              width: '100%',
              height: 34,
              padding: '0 12px 0 34px',
              border: '1px solid #dbdbdb',
              borderRadius: 17,
              fontSize: 12,
              outline: 'none',
            }}
          />
          <span
            style={{ position: 'absolute', left: 12, top: 9, color: '#878787', display: 'flex' }}
          >
            <SearchG color="#878787" />
          </span>
        </div>

        <div style={{ display: 'flex', gap: 20, fontSize: 13, fontWeight: 700 }}>
          <span style={{ cursor: 'pointer' }}>Sign In</span>
          <span style={{ cursor: 'pointer' }}>Wishlist</span>
          <span style={{ cursor: 'pointer' }}>Cart</span>
        </div>
      </div>

      {/* Main product zone */}
      <div style={{ display: 'flex', gap: 32, padding: '32px 8% 40px', alignItems: 'flex-start' }}>
        {/* Left column: Image & Thumbnails */}
        <div style={{ flex: '0 0 460px', display: 'flex', gap: 16 }}>
          {/* Thumbnails */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
            {images.slice(0, 5).map((url, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: gallery index is stable
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                onMouseEnter={() => onActiveChange(i)}
                style={{
                  width: 50,
                  height: 64,
                  border: `1px solid ${i === activeIndex ? '#2f4254' : '#e0e0e0'}`,
                  boxShadow: i === activeIndex ? '0 0 0 1px #2f4254' : 'none',
                  padding: 2,
                  cursor: 'pointer',
                  background: '#fff',
                  overflow: 'hidden',
                }}
              >
                {url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  // biome-ignore lint/performance/noImgElement: generated catalogue preview image
                  <img
                    src={url}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  />
                ) : (
                  <div className="av-shimmer" style={{ width: '100%', height: '100%' }} />
                )}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, border: '1px solid #f2f2f2', overflow: 'hidden' }}>
            <ProductImage src={active} ratio={ratio} />
          </div>
        </div>

        {/* Right column: Info details */}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: '#878787', marginBottom: 12 }}>
            Home / Women / Western Wear / Tops / {TC.store}
          </div>

          <h2
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: '#b19975',
              margin: '0 0 4px',
              textTransform: 'uppercase',
            }}
          >
            {TC.store}
          </h2>
          <h1 style={{ fontSize: 20, color: '#333', margin: '0 0 14px', fontWeight: 400 }}>
            {TC.title}
          </h1>

          {/* Pricing */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
            <span style={{ fontSize: 26, fontWeight: 700, color: '#2f4254' }}>₹{TC.price}</span>
            <span style={{ color: '#878787', textDecoration: 'line-through', fontSize: 16 }}>
              ₹{TC.mrp}
            </span>
            <span style={{ color: '#b19975', fontWeight: 700, fontSize: 16 }}>
              ({TC.discount} off)
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#999', marginBottom: 20 }}>
            Price inclusive of all taxes
          </div>

          <div style={{ height: 1, background: '#f2f2f2', marginBottom: 20 }} />

          {/* Sizes */}
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, color: '#333' }}>
            Select Size
          </div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 28 }}>
            {TC.sizes.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSize(s)}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 2,
                  border: `1px solid ${s === size ? '#2f4254' : '#dbdbdb'}`,
                  background: '#fff',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  color: s === size ? '#2f4254' : '#333',
                }}
              >
                {s}
              </button>
            ))}
          </div>

          {/* AJIO Offers */}
          <div
            style={{
              border: '1px dashed #b19975',
              borderRadius: 4,
              padding: 14,
              marginBottom: 28,
              background: '#fdfcf7',
              maxWidth: 460,
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: '#b19975',
                textTransform: 'uppercase',
                marginBottom: 6,
              }}
            >
              EPIC DEAL OFFER
            </div>
            <div style={{ fontSize: 12, color: '#333', lineHeight: 1.5 }}>
              Use coupon code <b style={{ color: '#2f4254' }}>EPICSELLER</b> to get extra discounts.
              Free delivery on orders above ₹1,199.
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: 16 }}>
            <button
              type="button"
              style={{
                width: 220,
                height: 48,
                background: '#2f4254',
                color: '#fff',
                fontWeight: 700,
                fontSize: 14,
                border: 'none',
                borderRadius: 2,
                cursor: 'pointer',
              }}
            >
              ADD TO BAG
            </button>
            <button
              type="button"
              style={{
                width: 180,
                height: 48,
                background: '#fff',
                color: '#2f4254',
                fontWeight: 700,
                fontSize: 14,
                border: '1px solid #2f4254',
                borderRadius: 2,
                cursor: 'pointer',
              }}
            >
              SAVE TO WISHLIST
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type FramedMeeshoProduct = {
  title: string;
  breadcrumb: string[];
  rating: string;
  ratingCount: string;
  price: string;
  mrp: string;
  discount: string;
  firstOrderPrice: string;
  sizes: Array<{ label: string; disabled?: boolean }>;
  category: string;
  genderLabel: string;
  supplier: string;
  details: Array<{ label: string; value: string }>;
};

const MEESHO_THEME = {
  magenta: '#9f2089',
  darkMagenta: '#7b176c',
  lightMagenta: '#f7eaf5',
  pinkAccent: '#d85bbf',
  textPrimary: '#353543',
  textSecondary: '#616173',
  textMuted: '#8b8ba3',
  border: '#d9d9e3',
  divider: '#eeeef2',
  page: '#ffffff',
  searchBackground: '#ffffff',
  green: '#038d63',
  discount: '#038d63',
  lightBackground: '#f8f8fb',
};

function framedMeeshoGarmentName(garmentName?: string | null): string {
  if (!garmentName) return 'Full Sleeve Shirt';
  return garmentName
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function framedMeeshoProduct(
  gender?: string | null,
  garmentName?: string | null,
): FramedMeeshoProduct {
  const normalizedGender = (gender ?? '').toLowerCase();
  const isWomen = normalizedGender.includes('women') || normalizedGender.includes('girl');
  const audience = isWomen ? 'Women' : 'Men';
  const garment = framedMeeshoGarmentName(garmentName);
  const category = garment.toLowerCase().includes('tshirt')
    ? 'T-Shirts'
    : garment.toLowerCase().includes('top')
      ? 'Tops'
      : 'Shirts';

  return {
    title: `${audience} Solid Casual ${garment}`,
    breadcrumb: ['Home', audience, 'Fashion', category],
    rating: '4.1',
    ratingCount: '1,238 Ratings',
    price: '699',
    mrp: '1,399',
    discount: '50% off',
    firstOrderPrice: '649',
    sizes: [
      { label: 'S' },
      { label: 'M' },
      { label: 'L' },
      { label: 'XL' },
      { label: 'XXL', disabled: true },
    ],
    category,
    genderLabel: audience,
    supplier: 'TRYME Fashion Hub',
    details: [
      { label: 'Name', value: `${audience} Solid Casual ${garment}` },
      { label: 'Fabric', value: 'Cotton Blend' },
      {
        label: 'Sleeve Length',
        value: garment.toLowerCase().includes('shirt') ? 'Long Sleeves' : 'Regular',
      },
      { label: 'Pattern', value: 'Solid' },
      { label: 'Net Quantity', value: '1' },
      { label: 'Country of Origin', value: 'India' },
    ],
  };
}

function MeeshoLogo({ small = false }: { small?: boolean }) {
  return (
    <MarketplaceLogo
      platform="meesho"
      width={small ? 86 : 112}
      height={small ? 32 : 42}
      style={{ objectPosition: 'left center' }}
    />
  );
}

function FramedMeeshoHeader() {
  return (
    <header
      style={{
        fontFamily: MARKETPLACE_FONTS.meesho,
        background: MEESHO_THEME.page,
        borderBottom: `1px solid ${MEESHO_THEME.divider}`,
        color: MEESHO_THEME.textPrimary,
      }}
    >
      <div
        style={{
          height: 64,
          display: 'flex',
          alignItems: 'center',
          gap: 22,
          padding: '0 30px',
        }}
      >
        <MeeshoLogo />
        <div style={{ flex: 1, maxWidth: 470, position: 'relative' }}>
          <input
            aria-label="Search Meesho"
            placeholder="Try Saree, Kurti or Search by Product Code"
            style={{
              width: '100%',
              height: 42,
              border: `1px solid ${MEESHO_THEME.border}`,
              borderRadius: 4,
              background: MEESHO_THEME.searchBackground,
              color: MEESHO_THEME.textPrimary,
              outline: 'none',
              padding: '0 14px 0 42px',
              fontSize: 13,
            }}
          />
          <span style={{ position: 'absolute', left: 13, top: 11, display: 'flex' }}>
            <SearchIcon size={18} color={MEESHO_THEME.textMuted} />
          </span>
        </div>
        {['Download App', 'Become a Supplier', 'Newsroom'].map((item) => (
          <button
            key={item}
            type="button"
            style={{
              border: 0,
              background: 'transparent',
              color: MEESHO_THEME.textPrimary,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {item}
          </button>
        ))}
        <button
          type="button"
          style={{
            border: 0,
            background: 'transparent',
            color: MEESHO_THEME.textPrimary,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          <UserIcon size={18} color={MEESHO_THEME.textPrimary} />
          Profile
        </button>
        <button
          type="button"
          style={{
            border: 0,
            background: 'transparent',
            color: MEESHO_THEME.textPrimary,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          <CartG size={18} color={MEESHO_THEME.textPrimary} />
          Cart
        </button>
      </div>
      <nav
        aria-label="Meesho categories"
        style={{
          height: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 23,
          borderTop: `1px solid ${MEESHO_THEME.divider}`,
          fontSize: 12.5,
          color: MEESHO_THEME.textPrimary,
          whiteSpace: 'nowrap',
        }}
      >
        {[
          'Women Ethnic',
          'Women Western',
          'Men',
          'Kids',
          'Home & Kitchen',
          'Beauty & Health',
          'Jewellery & Accessories',
          'Bags & Footwear',
          'Electronics',
        ].map((item) => (
          <span key={item}>{item}</span>
        ))}
      </nav>
    </header>
  );
}

function FramedMeeshoRating({ product }: { product: FramedMeeshoProduct }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span
        style={{
          background: MEESHO_THEME.green,
          color: '#fff',
          borderRadius: 14,
          padding: '4px 9px',
          fontSize: 12,
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        {product.rating} *
      </span>
      <span style={{ color: MEESHO_THEME.textMuted, fontSize: 12.5, fontWeight: 600 }}>
        {product.ratingCount}
      </span>
    </div>
  );
}

function FramedMeeshoPrice({ product }: { product: FramedMeeshoProduct }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
        <span style={{ color: MEESHO_THEME.textPrimary, fontSize: 25, fontWeight: 700 }}>
          Rs. {product.price}
        </span>
        <span
          style={{
            color: MEESHO_THEME.textMuted,
            fontSize: 14,
            textDecoration: 'line-through',
          }}
        >
          Rs. {product.mrp}
        </span>
        <span style={{ color: MEESHO_THEME.discount, fontSize: 14, fontWeight: 700 }}>
          {product.discount}
        </span>
      </div>
      <div style={{ color: MEESHO_THEME.green, fontSize: 13, fontWeight: 700, marginTop: 5 }}>
        Free Delivery
      </div>
      <div style={{ color: MEESHO_THEME.magenta, fontSize: 12.5, fontWeight: 700, marginTop: 5 }}>
        Rs. {product.firstOrderPrice} with first order discount
      </div>
    </div>
  );
}

function FramedMeeshoGallery({
  images,
  activeIndex,
  onActiveChange,
  product,
}: {
  images: Array<string | undefined>;
  activeIndex: number;
  onActiveChange: (i: number) => void;
  product: FramedMeeshoProduct;
}) {
  const validImages = images.map((src, i) => ({ src, i })).filter(({ src }) => Boolean(src));
  const active = images[activeIndex] ?? validImages[0]?.src;
  const thumbnails = validImages.length > 0 ? validImages.slice(0, 4) : [{ src: undefined, i: 0 }];

  return (
    <section style={{ flex: '0 0 47%', display: 'flex', gap: 12, alignSelf: 'flex-start' }}>
      <div style={{ width: 56, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {thumbnails.map(({ src, i }) => (
          <button
            key={`${src ?? 'empty'}-${i}`}
            type="button"
            onClick={() => onActiveChange(i)}
            aria-label={`Show ${product.title} image ${i + 1}`}
            style={{
              width: 56,
              height: 72,
              border: `1px solid ${i === activeIndex ? MEESHO_THEME.magenta : MEESHO_THEME.border}`,
              borderRadius: 4,
              background: '#fff',
              padding: 3,
              cursor: 'pointer',
            }}
          >
            {src ? (
              <img
                src={src}
                alt=""
                loading={i > 1 ? 'lazy' : undefined}
                style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
              />
            ) : (
              <div className="av-shimmer" style={{ width: '100%', height: '100%' }} />
            )}
          </button>
        ))}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 482,
          border: `1px solid ${MEESHO_THEME.border}`,
          borderRadius: 6,
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 22,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <button
          type="button"
          aria-label="Wishlist"
          style={{
            position: 'absolute',
            top: 14,
            right: 14,
            width: 34,
            height: 34,
            borderRadius: '50%',
            border: `1px solid ${MEESHO_THEME.border}`,
            background: '#fff',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
          }}
        >
          <HeartIcon size={17} color={MEESHO_THEME.textPrimary} />
        </button>
        {active ? (
          <img
            src={active}
            alt={product.title}
            style={{
              width: '100%',
              height: '100%',
              maxHeight: 450,
              objectFit: 'contain',
              display: 'block',
            }}
          />
        ) : (
          <div className="av-shimmer" style={{ width: '100%', height: 430 }} />
        )}
        <div
          style={{
            position: 'absolute',
            left: 16,
            bottom: 14,
            color: MEESHO_THEME.textSecondary,
            background: 'rgba(255,255,255,0.92)',
            border: `1px solid ${MEESHO_THEME.divider}`,
            borderRadius: 14,
            padding: '4px 9px',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          1/{Math.max(validImages.length, 1)}
        </div>
      </div>
    </section>
  );
}

function FramedMeeshoSizeSelector({
  product,
  selectedSize,
  onSelect,
}: {
  product: FramedMeeshoProduct;
  selectedSize: string;
  onSelect: (size: string) => void;
}) {
  return (
    <section>
      <div
        style={{
          color: MEESHO_THEME.textPrimary,
          fontSize: 13,
          fontWeight: 700,
          marginBottom: 10,
        }}
      >
        SELECT SIZE
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {product.sizes.map((size) => (
          <button
            key={size.label}
            type="button"
            disabled={size.disabled}
            onClick={() => onSelect(size.label)}
            style={{
              minWidth: 42,
              height: 36,
              borderRadius: 6,
              border: `1px solid ${
                selectedSize === size.label ? MEESHO_THEME.magenta : MEESHO_THEME.border
              }`,
              background: selectedSize === size.label ? MEESHO_THEME.lightMagenta : '#fff',
              color: size.disabled ? MEESHO_THEME.textMuted : MEESHO_THEME.textPrimary,
              fontWeight: 700,
              cursor: size.disabled ? 'not-allowed' : 'pointer',
              opacity: size.disabled ? 0.55 : 1,
              textDecoration: size.disabled ? 'line-through' : 'none',
            }}
          >
            {size.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function FramedMeeshoInfo({
  product,
  selectedSize,
  onSelectSize,
}: {
  product: FramedMeeshoProduct;
  selectedSize: string;
  onSelectSize: (size: string) => void;
}) {
  return (
    <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          background: '#fff',
          border: `1px solid ${MEESHO_THEME.border}`,
          borderRadius: 6,
          padding: 16,
        }}
      >
        <div style={{ color: MEESHO_THEME.textMuted, fontSize: 12, marginBottom: 9 }}>
          {product.breadcrumb.join(' / ')}
        </div>
        <h1
          style={{
            color: MEESHO_THEME.textPrimary,
            fontSize: 19,
            fontWeight: 700,
            lineHeight: 1.35,
            margin: '0 0 10px',
          }}
        >
          {product.title}
        </h1>
        <FramedMeeshoRating product={product} />
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {[
            { label: 'Wishlist', icon: <HeartIcon size={14} color={MEESHO_THEME.magenta} /> },
            { label: 'Share', icon: <ShareIcon size={14} color={MEESHO_THEME.magenta} /> },
          ].map((action) => (
            <button
              key={action.label}
              type="button"
              style={{
                height: 32,
                border: `1px solid ${MEESHO_THEME.border}`,
                borderRadius: 4,
                background: '#fff',
                color: MEESHO_THEME.magenta,
                padding: '0 11px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
        <div style={{ height: 1, background: MEESHO_THEME.divider, margin: '14px 0' }} />
        <FramedMeeshoPrice product={product} />
      </div>

      <div
        style={{
          background: '#fff',
          border: `1px solid ${MEESHO_THEME.border}`,
          borderRadius: 6,
          padding: 16,
        }}
      >
        <FramedMeeshoSizeSelector
          product={product}
          selectedSize={selectedSize}
          onSelect={onSelectSize}
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 16 }}>
          <button
            type="button"
            style={{
              height: 46,
              borderRadius: 6,
              border: `1px solid ${MEESHO_THEME.magenta}`,
              background: '#fff',
              color: MEESHO_THEME.magenta,
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Buy Now
          </button>
          <button
            type="button"
            style={{
              height: 46,
              borderRadius: 6,
              border: 0,
              background: MEESHO_THEME.magenta,
              color: '#fff',
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
            }}
          >
            <CartG size={17} color="#fff" />
            Add to Cart
          </button>
        </div>
      </div>

      <div
        style={{
          background: '#fff',
          border: `1px solid ${MEESHO_THEME.border}`,
          borderRadius: 6,
          padding: 16,
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: MEESHO_THEME.textPrimary,
            marginBottom: 9,
          }}
        >
          Delivery
        </div>
        <div
          style={{
            display: 'flex',
            maxWidth: 280,
            border: `1px solid ${MEESHO_THEME.border}`,
            borderRadius: 4,
          }}
        >
          <input
            aria-label="Enter delivery pincode"
            placeholder="Enter Delivery Pincode"
            defaultValue="560001"
            style={{
              flex: 1,
              height: 34,
              border: 0,
              outline: 'none',
              padding: '0 10px',
              color: MEESHO_THEME.textPrimary,
              fontSize: 13,
            }}
          />
          <button
            type="button"
            style={{
              border: 0,
              background: '#fff',
              color: MEESHO_THEME.magenta,
              fontWeight: 700,
              padding: '0 11px',
              cursor: 'pointer',
            }}
          >
            Check
          </button>
        </div>
        <div
          style={{
            color: MEESHO_THEME.textSecondary,
            fontSize: 12.5,
            lineHeight: 1.55,
            marginTop: 9,
          }}
        >
          Free Delivery. Cash on Delivery available. Easy 7 days return.
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 8,
            marginTop: 12,
            fontSize: 12,
            color: MEESHO_THEME.textSecondary,
          }}
        >
          {['Secure payments', 'Lowest price', 'Easy returns'].map((item) => (
            <div
              key={item}
              style={{
                background: MEESHO_THEME.lightBackground,
                borderRadius: 4,
                padding: '7px 8px',
              }}
            >
              {item}
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          background: '#fff',
          border: `1px solid ${MEESHO_THEME.border}`,
          borderRadius: 6,
          padding: 16,
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: MEESHO_THEME.textPrimary,
            marginBottom: 10,
          }}
        >
          Product Details
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12.5 }}>
          {product.details.slice(0, 6).map((detail) => (
            <div key={detail.label}>
              <span style={{ color: MEESHO_THEME.textMuted }}>{detail.label}: </span>
              <span style={{ color: MEESHO_THEME.textPrimary, fontWeight: 700 }}>
                {detail.value}
              </span>
            </div>
          ))}
        </div>
        <div style={{ height: 1, background: MEESHO_THEME.divider, margin: '14px 0' }} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <div>
            <div style={{ color: MEESHO_THEME.textMuted, fontSize: 12 }}>Sold By</div>
            <div style={{ color: MEESHO_THEME.textPrimary, fontWeight: 700, fontSize: 13 }}>
              {product.supplier}
            </div>
            <div style={{ color: MEESHO_THEME.green, fontSize: 12, fontWeight: 700, marginTop: 3 }}>
              4.2 supplier rating · 620 products
            </div>
          </div>
          <button
            type="button"
            style={{
              border: `1px solid ${MEESHO_THEME.magenta}`,
              color: MEESHO_THEME.magenta,
              background: '#fff',
              borderRadius: 4,
              height: 34,
              padding: '0 12px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            View Shop
          </button>
        </div>
      </div>
    </section>
  );
}

export function FramedMeeshoDesktopTemplate({
  images,
  activeIndex,
  onActiveChange,
  gender,
  garmentName,
}: TemplateProps) {
  const product = framedMeeshoProduct(gender, garmentName);
  const [selectedSize, setSelectedSize] = useState('M');

  return (
    <div
      style={
        {
          '--meesho-magenta': MEESHO_THEME.magenta,
          '--meesho-dark-magenta': MEESHO_THEME.darkMagenta,
          '--meesho-light-magenta': MEESHO_THEME.lightMagenta,
          '--meesho-pink-accent': MEESHO_THEME.pinkAccent,
          '--meesho-text-primary': MEESHO_THEME.textPrimary,
          '--meesho-text-secondary': MEESHO_THEME.textSecondary,
          '--meesho-text-muted': MEESHO_THEME.textMuted,
          '--meesho-border': MEESHO_THEME.border,
          '--meesho-divider': MEESHO_THEME.divider,
          '--meesho-page': MEESHO_THEME.page,
          '--meesho-search-background': MEESHO_THEME.searchBackground,
          '--meesho-green': MEESHO_THEME.green,
          '--meesho-discount': MEESHO_THEME.discount,
          '--meesho-light-background': MEESHO_THEME.lightBackground,
          fontFamily: MARKETPLACE_FONTS.meesho,
          color: MEESHO_THEME.textPrimary,
          background: MEESHO_THEME.lightBackground,
          minHeight: 700,
        } as React.CSSProperties
      }
    >
      <FramedMeeshoHeader />
      <main
        style={{
          maxWidth: 1160,
          margin: '0 auto',
          display: 'flex',
          gap: 18,
          padding: '20px 28px 34px',
          alignItems: 'flex-start',
        }}
      >
        <FramedMeeshoGallery
          images={images}
          activeIndex={activeIndex}
          onActiveChange={onActiveChange}
          product={product}
        />
        <FramedMeeshoInfo
          product={product}
          selectedSize={selectedSize}
          onSelectSize={setSelectedSize}
        />
      </main>
    </div>
  );
}

export function FramedMeeshoMobileTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
  gender,
  garmentName,
}: TemplateProps) {
  const product = framedMeeshoProduct(gender, garmentName);
  const [selectedSize, setSelectedSize] = useState('M');
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily: MARKETPLACE_FONTS.meesho,
        color: MEESHO_THEME.textPrimary,
        background: MEESHO_THEME.lightBackground,
        minHeight: '100%',
        fontSize: 13,
      }}
    >
      <header
        style={{
          height: 52,
          display: 'grid',
          gridTemplateColumns: '28px minmax(0, 1fr) auto',
          alignItems: 'center',
          columnGap: 10,
          padding: '0 12px',
          borderBottom: `1px solid ${MEESHO_THEME.divider}`,
          background: '#fff',
          position: 'sticky',
          top: 0,
          zIndex: 5,
        }}
      >
        <button
          type="button"
          aria-label="Back"
          style={{
            border: 0,
            background: 'transparent',
            color: MEESHO_THEME.textPrimary,
            fontSize: 20,
            fontWeight: 700,
            cursor: 'pointer',
            padding: 0,
            width: 28,
            height: 28,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <ArrowBackIcon size={19} color={MEESHO_THEME.textPrimary} />
        </button>
        <div style={{ height: 28, minWidth: 0, display: 'flex', alignItems: 'center' }}>
          <MeeshoLogo small />
        </div>
        <div style={{ display: 'flex', gap: 13, alignItems: 'center', justifyContent: 'flex-end' }}>
          <SearchIcon size={18} color={MEESHO_THEME.textPrimary} />
          <ShareIcon size={18} color={MEESHO_THEME.textPrimary} />
          <HeartIcon size={18} color={MEESHO_THEME.textPrimary} />
          <CartG size={18} color={MEESHO_THEME.textPrimary} />
        </div>
      </header>
      <section style={{ background: '#fff', position: 'relative' }}>
        <ProductImage src={active} ratio={ratio} />
        <button
          type="button"
          aria-label="Wishlist"
          style={{
            position: 'absolute',
            right: 12,
            bottom: 12,
            width: 34,
            height: 34,
            borderRadius: '50%',
            border: `1px solid ${MEESHO_THEME.border}`,
            background: '#fff',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
          }}
        >
          <HeartIcon size={17} color={MEESHO_THEME.textPrimary} />
        </button>
      </section>
      {(() => {
        const resolved = images.map((url, i) => ({ url, i })).filter(({ url }) => Boolean(url));
        if (resolved.length <= 1) return null;
        return (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: 5,
              padding: '8px 0 6px',
              background: '#fff',
            }}
          >
            {resolved.map(({ i }) => (
              <button
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                aria-label={`Show image ${i + 1}`}
                style={{
                  width: i === activeIndex ? 7 : 5,
                  height: i === activeIndex ? 7 : 5,
                  borderRadius: '50%',
                  border: 0,
                  padding: 0,
                  background: i === activeIndex ? MEESHO_THEME.magenta : '#c9c9d4',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
        );
      })()}

      <main
        style={{
          padding: 10,
          paddingBottom: 86,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <section
          style={{
            background: '#fff',
            border: `1px solid ${MEESHO_THEME.divider}`,
            borderRadius: 6,
            padding: 12,
          }}
        >
          <h1
            style={{
              margin: '0 0 8px',
              color: MEESHO_THEME.textPrimary,
              fontSize: 15,
              fontWeight: 600,
              lineHeight: 1.35,
            }}
          >
            {product.title}
          </h1>
          <FramedMeeshoRating product={product} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              type="button"
              style={{
                flex: 1,
                height: 30,
                border: `1px solid ${MEESHO_THEME.border}`,
                borderRadius: 4,
                background: '#fff',
                color: MEESHO_THEME.magenta,
                fontWeight: 700,
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                cursor: 'pointer',
              }}
            >
              <HeartIcon size={14} color={MEESHO_THEME.magenta} />
              Wishlist
            </button>
            <button
              type="button"
              style={{
                flex: 1,
                height: 30,
                border: `1px solid ${MEESHO_THEME.border}`,
                borderRadius: 4,
                background: '#fff',
                color: MEESHO_THEME.magenta,
                fontWeight: 700,
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                cursor: 'pointer',
              }}
            >
              <ShareIcon size={14} color={MEESHO_THEME.magenta} />
              Share
            </button>
          </div>
          <div style={{ marginTop: 12 }}>
            <FramedMeeshoPrice product={product} />
          </div>
        </section>
        <section
          style={{
            background: '#fff',
            border: `1px solid ${MEESHO_THEME.divider}`,
            borderRadius: 6,
            padding: 12,
          }}
        >
          <FramedMeeshoSizeSelector
            product={product}
            selectedSize={selectedSize}
            onSelect={setSelectedSize}
          />
        </section>
        <section
          style={{
            background: '#fff',
            border: `1px solid ${MEESHO_THEME.divider}`,
            borderRadius: 6,
            padding: 12,
          }}
        >
          <div
            style={{
              color: MEESHO_THEME.textPrimary,
              fontWeight: 700,
              fontSize: 13,
              marginBottom: 7,
            }}
          >
            Delivery
          </div>
          <div style={{ color: MEESHO_THEME.textSecondary, fontSize: 12.5, lineHeight: 1.45 }}>
            Free Delivery. Cash on Delivery available. Easy 7 days return.
          </div>
          <div
            style={{
              color: MEESHO_THEME.textSecondary,
              fontSize: 12.5,
              lineHeight: 1.45,
              marginTop: 6,
            }}
          >
            Secure payment and supplier-verified product details.
          </div>
        </section>
        <section
          style={{
            background: '#fff',
            border: `1px solid ${MEESHO_THEME.divider}`,
            borderRadius: 6,
            padding: 12,
          }}
        >
          <div
            style={{
              color: MEESHO_THEME.textPrimary,
              fontWeight: 700,
              fontSize: 13,
              marginBottom: 8,
            }}
          >
            Product Details
          </div>
          {product.details.slice(0, 5).map((detail) => (
            <div key={detail.label} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              <span style={{ color: MEESHO_THEME.textMuted }}>{detail.label}: </span>
              <span style={{ color: MEESHO_THEME.textPrimary, fontWeight: 700 }}>
                {detail.value}
              </span>
            </div>
          ))}
          <div style={{ height: 1, background: MEESHO_THEME.divider, margin: '10px 0' }} />
          <div style={{ color: MEESHO_THEME.textMuted, fontSize: 12 }}>Sold By</div>
          <div style={{ color: MEESHO_THEME.textPrimary, fontSize: 13, fontWeight: 700 }}>
            {product.supplier}
          </div>
        </section>
      </main>

      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: '#fff',
          borderTop: `1px solid ${MEESHO_THEME.divider}`,
          padding: 10,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
        }}
      >
        <button
          type="button"
          style={{
            height: 44,
            borderRadius: 6,
            border: `1px solid ${MEESHO_THEME.magenta}`,
            background: '#fff',
            color: MEESHO_THEME.magenta,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Buy Now
        </button>
        <button
          type="button"
          style={{
            height: 44,
            borderRadius: 6,
            border: 0,
            background: MEESHO_THEME.magenta,
            color: '#fff',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Add to Cart
        </button>
      </div>
    </div>
  );
}

// ─── Meesho templates ────────────────────────────────────────────────────────

const NYKAA_THEME = {
  pink: '#fc2779',
  darkPink: '#d81b68',
  lightPink: '#fff0f6',
  textPrimary: '#333333',
  textSecondary: '#666666',
  textMuted: '#8c8c8c',
  border: '#e2e2e2',
  divider: '#eeeeee',
  page: '#ffffff',
  searchBackground: '#f5f5f5',
  discount: '#e80071',
  success: '#008945',
  warning: '#d97706',
};

type FramedNykaaVariant = {
  label: string;
  value?: string;
  color?: string;
  disabled?: boolean;
};

type FramedNykaaProduct = {
  kind: 'beauty' | 'fashion';
  breadcrumb: string;
  brand: string;
  title: string;
  description: string;
  rating: string;
  ratingCount: string;
  price: string;
  mrp: string;
  discount: string;
  taxMessage: string;
  variantLabel: string;
  variantName: string;
  variants: FramedNykaaVariant[];
  offer: string;
  delivery: string;
  details: Array<{ label: string; value: string }>;
  benefits: string[];
};

function framedNykaaProduct(
  gender?: string | null,
  garmentName?: string | null,
): FramedNykaaProduct {
  const normalizedGender =
    gender === 'men' ? 'men' : gender === 'boy' ? 'boy' : gender === 'girl' ? 'girl' : 'women';
  const trimmedName = garmentName?.trim();

  if (trimmedName) {
    const audience =
      normalizedGender === 'men'
        ? 'Men'
        : normalizedGender === 'boy'
          ? 'Boys'
          : normalizedGender === 'girl'
            ? 'Girls'
            : 'Women';
    const lowerName = trimmedName.toLowerCase();
    const category = lowerName.includes('shoe')
      ? 'Footwear'
      : lowerName.includes('shirt')
        ? 'Shirts'
        : 'Westernwear';

    return {
      kind: 'fashion',
      breadcrumb: `Home > Nykaa Fashion > ${audience} > ${category}`,
      brand: 'TRYME EDIT',
      title: `${audience} ${trimmedName}`,
      description: `Premium ${lowerName} styled for a clean catalogue-ready look.`,
      rating: '4.2',
      ratingCount: '1,186 ratings',
      price: '1,099',
      mrp: '2,199',
      discount: '50% Off',
      taxMessage: 'Inclusive of all taxes',
      variantLabel: 'SELECT SIZE',
      variantName: 'Size: M',
      variants: [
        { label: 'S' },
        { label: 'M' },
        { label: 'L' },
        { label: 'XL' },
        { label: 'XXL', disabled: normalizedGender === 'girl' || normalizedGender === 'boy' },
      ],
      offer: 'Extra 10% off on prepaid orders',
      delivery: 'Delivery by tomorrow. Cash on Delivery available.',
      details: [
        { label: 'Product Type', value: trimmedName },
        { label: 'Pattern', value: 'Solid' },
        { label: 'Material', value: 'Cotton Blend' },
        { label: 'Fit', value: 'Regular Fit' },
        { label: 'Country of Origin', value: 'India' },
      ],
      benefits: ['Soft hand-feel', 'Easy styling', 'Machine washable'],
    };
  }

  return {
    kind: 'beauty',
    breadcrumb: 'Home > Makeup > Face > Foundation',
    brand: 'MAYBELLINE NEW YORK',
    title: 'Fit Me Matte + Poreless Liquid Foundation',
    description: 'Lightweight liquid foundation with natural coverage and a matte finish.',
    rating: '4.4',
    ratingCount: '38,426 ratings',
    price: '499',
    mrp: '699',
    discount: '29% Off',
    taxMessage: 'Inclusive of all taxes',
    variantLabel: 'SELECT SHADE',
    variantName: 'Shade: 128 Warm Nude',
    variants: [
      { label: '115', value: 'Ivory', color: '#f1d2b7' },
      { label: '128', value: 'Warm Nude', color: '#d7a679' },
      { label: '220', value: 'Natural Beige', color: '#bd8153' },
      { label: '310', value: 'Sun Beige', color: '#9b633f' },
      { label: '330', value: 'Toffee', color: '#704327', disabled: true },
    ],
    offer: 'Get a mini mascara on orders above Rs. 999',
    delivery: 'Delivery in 2-4 days. Cash on Delivery available.',
    details: [
      { label: 'Product Type', value: 'Liquid Foundation' },
      { label: 'Finish', value: 'Matte' },
      { label: 'Coverage', value: 'Natural' },
      { label: 'Skin Type', value: 'Normal to oily skin' },
      { label: 'Country of Origin', value: 'India' },
    ],
    benefits: ['Blurs pores', 'Controls shine', 'Dermatologist tested'],
  };
}

function NykaaLogo({ small = false }: { small?: boolean }) {
  return (
    <MarketplaceLogo
      platform="nykaa"
      width={small ? 70 : 92}
      height={small ? 22 : 30}
      style={{ objectPosition: 'left center' }}
    />
  );
}

function FramedNykaaHeader() {
  const categories = [
    'Categories',
    'Brands',
    'Luxe',
    'Nykaa Fashion',
    'Beauty Advice',
    'Skin',
    'Makeup',
    'Hair',
    'Fragrance',
    'Bath & Body',
    'Appliances',
  ];

  return (
    <header style={{ background: '#fff', borderBottom: `1px solid ${NYKAA_THEME.divider}` }}>
      <div
        style={{
          height: 30,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 22,
          padding: '0 32px',
          maxWidth: 1220,
          margin: '0 auto',
          color: NYKAA_THEME.textSecondary,
          fontSize: 11.5,
          borderBottom: `1px solid ${NYKAA_THEME.divider}`,
        }}
      >
        {['Get App', 'Store & Events', 'Gift Card', 'Help'].map((item) => (
          <span key={item} style={{ whiteSpace: 'nowrap' }}>
            {item}
          </span>
        ))}
      </div>
      <div
        style={{
          height: 58,
          display: 'grid',
          gridTemplateColumns: '124px minmax(260px, 1fr) auto',
          alignItems: 'center',
          gap: 24,
          maxWidth: 1220,
          margin: '0 auto',
          padding: '0 32px',
        }}
      >
        <NykaaLogo />
        <label
          style={{
            height: 38,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: NYKAA_THEME.searchBackground,
            border: `1px solid ${NYKAA_THEME.border}`,
            borderRadius: 3,
            padding: '0 14px',
            color: NYKAA_THEME.textMuted,
            fontSize: 13,
          }}
        >
          <SearchIcon size={17} color={NYKAA_THEME.textMuted} />
          <input
            aria-label="Search on Nykaa"
            placeholder="Search on Nykaa"
            style={{
              border: 0,
              outline: 0,
              background: 'transparent',
              width: '100%',
              color: NYKAA_THEME.textPrimary,
              fontSize: 13,
              fontFamily: 'inherit',
            }}
          />
        </label>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 20, color: NYKAA_THEME.textPrimary }}
        >
          {[
            { label: 'Account', icon: <UserIcon size={18} color={NYKAA_THEME.textPrimary} /> },
            { label: 'Wishlist', icon: <HeartIcon size={18} color={NYKAA_THEME.textPrimary} /> },
            { label: 'Bag', icon: <BagIcon size={18} color={NYKAA_THEME.textPrimary} /> },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              style={{
                border: 0,
                background: 'transparent',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: NYKAA_THEME.textPrimary,
                fontWeight: 700,
                fontSize: 12,
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <nav
        aria-label="Nykaa categories"
        style={{
          maxWidth: 1220,
          margin: '0 auto',
          padding: '0 32px',
          height: 38,
          display: 'flex',
          alignItems: 'center',
          gap: 23,
          color: NYKAA_THEME.textSecondary,
          fontSize: 12,
          fontWeight: 700,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}
      >
        {categories.map((item, index) => (
          <span
            key={item}
            style={{
              color: index === 0 ? NYKAA_THEME.pink : NYKAA_THEME.textSecondary,
              borderBottom: index === 0 ? `2px solid ${NYKAA_THEME.pink}` : '2px solid transparent',
              height: 38,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {item}
          </span>
        ))}
      </nav>
    </header>
  );
}

function FramedNykaaRating({ product }: { product: FramedNykaaProduct }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          border: `1px solid ${NYKAA_THEME.border}`,
          borderRadius: 3,
          padding: '5px 8px',
          color: NYKAA_THEME.textPrimary,
          fontSize: 12.5,
          fontWeight: 700,
          background: '#fff',
        }}
      >
        {product.rating}
        <span style={{ color: NYKAA_THEME.success, fontSize: 12 }}>*</span>
      </span>
      <span style={{ color: NYKAA_THEME.textMuted, fontSize: 12.5 }}>{product.ratingCount}</span>
    </div>
  );
}

function FramedNykaaPrice({ product }: { product: FramedNykaaProduct }) {
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ color: NYKAA_THEME.textPrimary, fontSize: 24, fontWeight: 700 }}>
          Rs. {product.price}
        </span>
        <span style={{ color: NYKAA_THEME.textMuted, fontSize: 13 }}>
          MRP <span style={{ textDecoration: 'line-through' }}>Rs. {product.mrp}</span>
        </span>
        <span style={{ color: NYKAA_THEME.discount, fontSize: 14, fontWeight: 700 }}>
          {product.discount}
        </span>
      </div>
      <div style={{ color: NYKAA_THEME.success, fontSize: 12.5, fontWeight: 700, marginTop: 5 }}>
        {product.taxMessage}
      </div>
    </div>
  );
}

function FramedNykaaVariantSelector({
  product,
  selected,
  onSelect,
}: {
  product: FramedNykaaProduct;
  selected: string;
  onSelect: (label: string) => void;
}) {
  const isBeauty = product.kind === 'beauty';

  return (
    <section style={{ marginTop: 18 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 10,
        }}
      >
        <div
          style={{
            color: NYKAA_THEME.textPrimary,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 0.5,
          }}
        >
          {product.variantLabel}
        </div>
        <button
          type="button"
          style={{
            border: 0,
            background: 'transparent',
            color: NYKAA_THEME.pink,
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {isBeauty ? 'Shade Finder' : 'Size Guide'}
        </button>
      </div>
      <div style={{ color: NYKAA_THEME.textSecondary, fontSize: 12.5, marginBottom: 10 }}>
        {product.variantName}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9 }}>
        {product.variants.map((variant) => {
          const active = variant.label === selected;
          return (
            <button
              key={variant.label}
              type="button"
              disabled={variant.disabled}
              onClick={() => onSelect(variant.label)}
              title={variant.value || variant.label}
              style={{
                width: isBeauty ? 38 : 42,
                height: isBeauty ? 38 : 40,
                borderRadius: isBeauty ? '50%' : 4,
                border: `2px solid ${active ? NYKAA_THEME.pink : NYKAA_THEME.border}`,
                background: isBeauty ? variant.color || '#fff' : '#fff',
                color: variant.disabled
                  ? NYKAA_THEME.textMuted
                  : active
                    ? NYKAA_THEME.pink
                    : NYKAA_THEME.textPrimary,
                fontSize: 12,
                fontWeight: 700,
                cursor: variant.disabled ? 'not-allowed' : 'pointer',
                opacity: variant.disabled ? 0.45 : 1,
                textDecoration: variant.disabled ? 'line-through' : 'none',
                boxShadow: active && isBeauty ? '0 0 0 2px #fff inset' : 'none',
              }}
              aria-pressed={active}
            >
              {isBeauty ? '' : variant.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function FramedNykaaGallery({
  images,
  activeIndex,
  onActiveChange,
  ratio,
  product,
}: TemplateProps & { product: FramedNykaaProduct }) {
  const active = images[activeIndex];
  const resolvedImages = images
    .map((url, index) => ({ url, index }))
    .filter(({ url }) => Boolean(url));

  return (
    <section
      aria-label="Product images"
      style={{
        flex: '0 0 50%',
        display: 'grid',
        gridTemplateColumns: '70px minmax(0, 1fr)',
        gap: 14,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(resolvedImages.length ? resolvedImages.slice(0, 5) : [{ url: undefined, index: 0 }]).map(
          ({ url, index }) => (
            <button
              key={index}
              type="button"
              onClick={() => onActiveChange(index)}
              aria-label={`Show ${product.title} image ${index + 1}`}
              style={{
                width: 66,
                height: 82,
                border: `2px solid ${index === activeIndex ? NYKAA_THEME.pink : NYKAA_THEME.border}`,
                background: '#fff',
                padding: 3,
                cursor: 'pointer',
                borderRadius: 2,
                overflow: 'hidden',
              }}
            >
              <ProductImage src={url} ratio="3 / 4" />
            </button>
          ),
        )}
      </div>
      <div
        style={{
          background: '#fff',
          border: `1px solid ${NYKAA_THEME.divider}`,
          minHeight: 500,
          position: 'relative',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <ProductImage src={active} ratio={ratio} />
        <button
          type="button"
          aria-label="Add to wishlist"
          style={{
            position: 'absolute',
            top: 14,
            right: 14,
            width: 38,
            height: 38,
            borderRadius: '50%',
            border: `1px solid ${NYKAA_THEME.border}`,
            background: '#fff',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
          }}
        >
          <HeartIcon size={18} color={NYKAA_THEME.pink} />
        </button>
        <div
          style={{
            position: 'absolute',
            left: 14,
            bottom: 14,
            color: NYKAA_THEME.textMuted,
            background: 'rgba(255,255,255,0.92)',
            border: `1px solid ${NYKAA_THEME.border}`,
            borderRadius: 3,
            padding: '6px 9px',
            fontSize: 11.5,
            fontWeight: 700,
          }}
        >
          Zoom image
        </div>
      </div>
    </section>
  );
}

function FramedNykaaInfo({
  product,
  selectedVariant,
  onSelectVariant,
}: {
  product: FramedNykaaProduct;
  selectedVariant: string;
  onSelectVariant: (label: string) => void;
}) {
  return (
    <section style={{ flex: '1 1 0', minWidth: 0, background: '#fff' }}>
      <div style={{ color: NYKAA_THEME.textMuted, fontSize: 12, marginBottom: 11 }}>
        {product.breadcrumb}
      </div>
      <h1
        style={{
          margin: 0,
          color: NYKAA_THEME.textPrimary,
          fontSize: 21,
          fontWeight: 700,
          lineHeight: 1.15,
        }}
      >
        {product.brand}
      </h1>
      <div
        style={{ color: NYKAA_THEME.textSecondary, fontSize: 18, lineHeight: 1.35, marginTop: 5 }}
      >
        {product.title}
      </div>
      <p
        style={{
          color: NYKAA_THEME.textSecondary,
          fontSize: 13.5,
          lineHeight: 1.45,
          margin: '9px 0 0',
        }}
      >
        {product.description}
      </p>
      <FramedNykaaRating product={product} />
      <div style={{ height: 1, background: NYKAA_THEME.divider, margin: '18px 0 0' }} />
      <FramedNykaaPrice product={product} />
      <div
        style={{
          marginTop: 12,
          color: NYKAA_THEME.darkPink,
          background: NYKAA_THEME.lightPink,
          border: `1px solid ${NYKAA_THEME.lightPink}`,
          padding: '9px 11px',
          borderRadius: 3,
          fontSize: 12.5,
          fontWeight: 750,
        }}
      >
        {product.offer}
      </div>
      <FramedNykaaVariantSelector
        product={product}
        selected={selectedVariant}
        onSelect={onSelectVariant}
      />
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <button
          type="button"
          style={{
            height: 48,
            flex: '1 1 66%',
            border: 0,
            borderRadius: 3,
            background: NYKAA_THEME.pink,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: 0.4,
            cursor: 'pointer',
          }}
        >
          <BagIcon size={17} color="#fff" />
          ADD TO BAG
        </button>
        <button
          type="button"
          style={{
            height: 48,
            flex: '0 0 150px',
            borderRadius: 3,
            border: `1px solid ${NYKAA_THEME.border}`,
            background: '#fff',
            color: NYKAA_THEME.textPrimary,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          <HeartIcon size={17} color={NYKAA_THEME.textPrimary} />
          WISHLIST
        </button>
        <button
          type="button"
          aria-label="Share product"
          style={{
            height: 48,
            flex: '0 0 48px',
            borderRadius: 3,
            border: `1px solid ${NYKAA_THEME.border}`,
            background: '#fff',
            color: NYKAA_THEME.textPrimary,
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
          }}
        >
          <ShareIcon size={18} color={NYKAA_THEME.textPrimary} />
        </button>
      </div>
      <section
        style={{ borderTop: `1px solid ${NYKAA_THEME.divider}`, marginTop: 22, paddingTop: 16 }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: NYKAA_THEME.textPrimary,
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          <TruckIcon size={18} color={NYKAA_THEME.textPrimary} />
          DELIVERY OPTIONS
        </div>
        <div
          style={{
            display: 'flex',
            width: 280,
            height: 38,
            marginTop: 10,
            border: `1px solid ${NYKAA_THEME.border}`,
            borderRadius: 3,
          }}
        >
          <input
            aria-label="Delivery pincode"
            placeholder="Enter pincode"
            style={{
              border: 0,
              outline: 0,
              flex: 1,
              padding: '0 12px',
              fontSize: 12.5,
              fontFamily: 'inherit',
            }}
          />
          <button
            type="button"
            style={{
              border: 0,
              background: '#fff',
              color: NYKAA_THEME.pink,
              padding: '0 12px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Check
          </button>
        </div>
        <div
          style={{
            color: NYKAA_THEME.textSecondary,
            fontSize: 12.5,
            lineHeight: 1.55,
            marginTop: 9,
          }}
        >
          {product.delivery}
        </div>
        <div
          style={{
            color: NYKAA_THEME.textSecondary,
            fontSize: 12.5,
            lineHeight: 1.55,
            marginTop: 6,
          }}
        >
          100% genuine products. Easy returns and secure checkout.
        </div>
      </section>
      <section
        style={{ borderTop: `1px solid ${NYKAA_THEME.divider}`, marginTop: 16, paddingTop: 14 }}
      >
        <div
          style={{ color: NYKAA_THEME.textPrimary, fontSize: 13, fontWeight: 700, marginBottom: 8 }}
        >
          PRODUCT DETAILS
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px 16px' }}>
          {product.details.map((detail) => (
            <div key={detail.label} style={{ fontSize: 12.5, lineHeight: 1.35 }}>
              <span style={{ color: NYKAA_THEME.textMuted }}>{detail.label}: </span>
              <span style={{ color: NYKAA_THEME.textPrimary, fontWeight: 750 }}>
                {detail.value}
              </span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 10, color: NYKAA_THEME.textSecondary, fontSize: 12.5 }}>
          {product.benefits.join(' | ')}
        </div>
      </section>
    </section>
  );
}

export function FramedNykaaDesktopTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
  gender,
  garmentName,
}: TemplateProps) {
  const product = framedNykaaProduct(gender, garmentName);
  const [selectedVariant, setSelectedVariant] = useState(
    product.variants.find((variant) => !variant.disabled)?.label ||
      product.variants[0]?.label ||
      '',
  );

  return (
    <div
      style={
        {
          '--nykaa-pink': NYKAA_THEME.pink,
          '--nykaa-dark-pink': NYKAA_THEME.darkPink,
          '--nykaa-light-pink': NYKAA_THEME.lightPink,
          '--nykaa-text-primary': NYKAA_THEME.textPrimary,
          '--nykaa-text-secondary': NYKAA_THEME.textSecondary,
          '--nykaa-text-muted': NYKAA_THEME.textMuted,
          '--nykaa-border': NYKAA_THEME.border,
          '--nykaa-divider': NYKAA_THEME.divider,
          '--nykaa-page': NYKAA_THEME.page,
          '--nykaa-search-background': NYKAA_THEME.searchBackground,
          '--nykaa-discount': NYKAA_THEME.discount,
          '--nykaa-success': NYKAA_THEME.success,
          '--nykaa-warning': NYKAA_THEME.warning,
          fontFamily: MARKETPLACE_FONTS.nykaa,
          color: NYKAA_THEME.textPrimary,
          background: '#fff',
          minHeight: 700,
        } as React.CSSProperties
      }
    >
      <FramedNykaaHeader />
      <main
        style={{
          maxWidth: 1220,
          margin: '0 auto',
          padding: '22px 32px 38px',
          display: 'flex',
          gap: 30,
          alignItems: 'flex-start',
        }}
      >
        <FramedNykaaGallery
          images={images}
          activeIndex={activeIndex}
          onActiveChange={onActiveChange}
          ratio={ratio}
          product={product}
        />
        <FramedNykaaInfo
          product={product}
          selectedVariant={selectedVariant}
          onSelectVariant={setSelectedVariant}
        />
      </main>
    </div>
  );
}

export function FramedNykaaMobileTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
  gender,
  garmentName,
}: TemplateProps) {
  const product = framedNykaaProduct(gender, garmentName);
  const [selectedVariant, setSelectedVariant] = useState(
    product.variants.find((variant) => !variant.disabled)?.label ||
      product.variants[0]?.label ||
      '',
  );
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily: MARKETPLACE_FONTS.nykaa,
        color: NYKAA_THEME.textPrimary,
        background: '#f7f7f8',
        minHeight: '100%',
        fontSize: 13,
      }}
    >
      <header
        style={{
          height: 52,
          display: 'grid',
          gridTemplateColumns: '28px minmax(0, 1fr) auto',
          alignItems: 'center',
          columnGap: 10,
          padding: '0 12px',
          borderBottom: `1px solid ${NYKAA_THEME.divider}`,
          background: '#fff',
          position: 'sticky',
          top: 0,
          zIndex: 5,
        }}
      >
        <button
          type="button"
          aria-label="Back"
          style={{
            border: 0,
            background: 'transparent',
            color: NYKAA_THEME.textPrimary,
            fontSize: 20,
            fontWeight: 700,
            cursor: 'pointer',
            padding: 0,
            width: 28,
            height: 28,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <ArrowBackIcon size={19} color={NYKAA_THEME.textPrimary} />
        </button>
        <div
          style={{ height: 28, minWidth: 0, display: 'flex', alignItems: 'center', paddingTop: 1 }}
        >
          <NykaaLogo small />
        </div>
        <div style={{ display: 'flex', gap: 13, alignItems: 'center', justifyContent: 'flex-end' }}>
          <SearchIcon size={18} color={NYKAA_THEME.textPrimary} />
          <ShareIcon size={18} color={NYKAA_THEME.textPrimary} />
          <HeartIcon size={18} color={NYKAA_THEME.textPrimary} />
          <BagIcon size={18} color={NYKAA_THEME.textPrimary} />
        </div>
      </header>
      <section style={{ background: '#fff', position: 'relative' }}>
        <ProductImage src={active} ratio={ratio} />
        <button
          type="button"
          aria-label="Wishlist"
          style={{
            position: 'absolute',
            right: 12,
            bottom: 12,
            width: 34,
            height: 34,
            borderRadius: '50%',
            border: `1px solid ${NYKAA_THEME.border}`,
            background: '#fff',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
          }}
        >
          <HeartIcon size={17} color={NYKAA_THEME.pink} />
        </button>
      </section>
      {(() => {
        const resolved = images.map((url, i) => ({ url, i })).filter(({ url }) => Boolean(url));
        if (resolved.length <= 1) return null;
        return (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: 5,
              padding: '8px 0 6px',
              background: '#fff',
            }}
          >
            {resolved.map(({ i }) => (
              <button
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                aria-label={`Show image ${i + 1}`}
                style={{
                  width: i === activeIndex ? 7 : 5,
                  height: i === activeIndex ? 7 : 5,
                  borderRadius: '50%',
                  border: 0,
                  padding: 0,
                  background: i === activeIndex ? NYKAA_THEME.pink : '#c9c9c9',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
        );
      })()}

      <main
        style={{
          padding: 10,
          paddingBottom: 86,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <section
          style={{
            background: '#fff',
            border: `1px solid ${NYKAA_THEME.divider}`,
            borderRadius: 6,
            padding: 12,
          }}
        >
          <div style={{ color: NYKAA_THEME.textPrimary, fontSize: 14, fontWeight: 700 }}>
            {product.brand}
          </div>
          <h1
            style={{
              margin: '4px 0 8px',
              color: NYKAA_THEME.textSecondary,
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.35,
            }}
          >
            {product.title}
          </h1>
          <FramedNykaaRating product={product} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              type="button"
              style={{
                flex: 1,
                height: 30,
                border: `1px solid ${NYKAA_THEME.border}`,
                background: '#fff',
                color: NYKAA_THEME.textPrimary,
                fontWeight: 700,
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                cursor: 'pointer',
              }}
            >
              <HeartIcon size={14} color={NYKAA_THEME.pink} />
              Wishlist
            </button>
            <button
              type="button"
              style={{
                flex: 1,
                height: 30,
                border: `1px solid ${NYKAA_THEME.border}`,
                background: '#fff',
                color: NYKAA_THEME.textPrimary,
                fontWeight: 700,
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                cursor: 'pointer',
              }}
            >
              <ShareIcon size={14} color={NYKAA_THEME.pink} />
              Share
            </button>
          </div>
          <FramedNykaaPrice product={product} />
          <div style={{ color: NYKAA_THEME.darkPink, fontSize: 12, fontWeight: 750, marginTop: 8 }}>
            {product.offer}
          </div>
        </section>
        <section
          style={{
            background: '#fff',
            border: `1px solid ${NYKAA_THEME.divider}`,
            borderRadius: 6,
            padding: 12,
          }}
        >
          <FramedNykaaVariantSelector
            product={product}
            selected={selectedVariant}
            onSelect={setSelectedVariant}
          />
        </section>
        <section
          style={{
            background: '#fff',
            border: `1px solid ${NYKAA_THEME.divider}`,
            borderRadius: 6,
            padding: 12,
          }}
        >
          <div
            style={{
              color: NYKAA_THEME.textPrimary,
              fontWeight: 700,
              fontSize: 13,
              marginBottom: 7,
            }}
          >
            Delivery Options
          </div>
          <div style={{ color: NYKAA_THEME.textSecondary, fontSize: 12.5, lineHeight: 1.45 }}>
            {product.delivery} Easy returns and secure checkout.
          </div>
          <div
            style={{
              color: NYKAA_THEME.textSecondary,
              fontSize: 12.5,
              lineHeight: 1.45,
              marginTop: 6,
            }}
          >
            Genuine beauty products with return eligibility.
          </div>
        </section>
        <section
          style={{
            background: '#fff',
            border: `1px solid ${NYKAA_THEME.divider}`,
            borderRadius: 6,
            padding: 12,
          }}
        >
          <div
            style={{
              color: NYKAA_THEME.textPrimary,
              fontWeight: 700,
              fontSize: 13,
              marginBottom: 8,
            }}
          >
            Product Details
          </div>
          {product.details.slice(0, 5).map((detail) => (
            <div key={detail.label} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              <span style={{ color: NYKAA_THEME.textMuted }}>{detail.label}: </span>
              <span style={{ color: NYKAA_THEME.textPrimary, fontWeight: 700 }}>
                {detail.value}
              </span>
            </div>
          ))}
        </section>
      </main>

      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: '#fff',
          borderTop: `1px solid ${NYKAA_THEME.divider}`,
          padding: 10,
          display: 'grid',
          gridTemplateColumns: '0.8fr 1.2fr',
          gap: 8,
        }}
      >
        <button
          type="button"
          style={{
            height: 44,
            borderRadius: 4,
            border: `1px solid ${NYKAA_THEME.border}`,
            background: '#fff',
            color: NYKAA_THEME.textPrimary,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Wishlist
        </button>
        <button
          type="button"
          style={{
            height: 44,
            borderRadius: 4,
            border: 0,
            background: NYKAA_THEME.pink,
            color: '#fff',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Add to Bag
        </button>
      </div>
    </div>
  );
}

export function MeeshoMobileTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
}: TemplateProps) {
  const [size, setSize] = useState(TC.defaultSize);
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 13,
        color: '#353535',
        background: '#f8f8fd',
      }}
    >
      {/* Header */}
      <div
        style={{
          background: '#fff',
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          height: 52,
          boxSizing: 'border-box',
          borderBottom: '1px solid #f0f0f0',
        }}
      >
        <span style={{ fontSize: 18, color: '#353535', cursor: 'pointer' }}>←</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 auto 0 0' }}>
          <MarketplaceLogo
            platform="meesho"
            width={72}
            height={28}
            style={{ objectPosition: 'left center' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, color: '#353535' }}>
          <span style={{ display: 'flex' }}>
            <SearchG color="#353535" />
          </span>
          <CartG size={20} color="#353535" />
        </div>
      </div>

      <div style={{ background: '#fff' }}>
        <ProductImage src={active} ratio={ratio} />
      </div>

      {/* Carousel Dots */}
      {(() => {
        const resolved = images.map((url, i) => ({ url, i })).filter(({ url }) => Boolean(url));
        if (resolved.length <= 1) return null;
        return (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: 5,
              padding: '8px 0 4px',
              background: '#fff',
            }}
          >
            {resolved.map(({ i }) => (
              <button
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                aria-label={`Show image ${i + 1}`}
                style={{
                  width: i === activeIndex ? 7 : 5,
                  height: i === activeIndex ? 7 : 5,
                  borderRadius: '50%',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  background: i === activeIndex ? '#9f206c' : '#c2c2c2',
                }}
              />
            ))}
          </div>
        );
      })()}

      {/* Details Box */}
      <div
        style={{
          padding: 12,
          background: '#fff',
          marginBottom: 8,
          boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
        }}
      >
        <div
          style={{
            fontSize: 14,
            color: '#353535',
            lineHeight: 1.3,
            marginBottom: 6,
            fontWeight: 500,
          }}
        >
          {TC.title}
        </div>

        {/* Price */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: '#353535' }}>₹{TC.price}</span>
          <span style={{ color: '#7f7f7f', textDecoration: 'line-through', fontSize: 12 }}>
            ₹{TC.mrp}
          </span>
          <span style={{ color: '#388e3c', fontWeight: 600, fontSize: 13 }}>{TC.discount} off</span>
        </div>
        <div style={{ fontSize: 11, color: '#7f7f7f', marginBottom: 8 }}>Free Delivery</div>

        {/* Rating */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              background: '#388e3c',
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              padding: '1px 5px',
              borderRadius: 12,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
            }}
          >
            {TC.rating} ★
          </span>
          <span style={{ color: '#7f7f7f', fontSize: 11 }}>{TC.ratingCount} Reviews</span>
        </div>
      </div>

      {/* Size Selection Box */}
      <div
        style={{
          padding: 12,
          background: '#fff',
          marginBottom: 8,
          boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: '#353535' }}>
          Select Size
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {TC.sizes.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSize(s)}
              style={{
                minWidth: 40,
                padding: '0 8px',
                height: 32,
                borderRadius: 16,
                border: `1px solid ${s === size ? '#9f206c' : '#e0e0e0'}`,
                background: s === size ? '#fdf0f7' : '#fff',
                fontSize: 12,
                fontWeight: s === size ? 600 : 400,
                cursor: 'pointer',
                color: s === size ? '#9f206c' : '#353535',
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Buy Buttons */}
      <div style={{ display: 'flex', gap: 8, padding: '12px 12px 20px', background: '#fff' }}>
        <button
          type="button"
          style={{
            flex: 1,
            height: 44,
            borderRadius: 4,
            border: '1px solid #e0e0e0',
            background: '#fff',
            color: '#353535',
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Add to Cart
        </button>
        <button
          type="button"
          style={{
            flex: 1,
            height: 44,
            borderRadius: 4,
            border: 'none',
            background: '#9f206c',
            color: '#fff',
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Buy Now
        </button>
      </div>
    </div>
  );
}

export function MeeshoDesktopTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
}: TemplateProps) {
  const [size, setSize] = useState(TC.defaultSize);
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 14,
        color: '#353535',
        background: '#f8f8fd',
      }}
    >
      {/* Top Nav */}
      <div
        style={{
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8%',
          height: 72,
          borderBottom: '1px solid #e0e0e0',
        }}
      >
        <MarketplaceLogo platform="meesho" width={116} height={36} />

        <div style={{ width: 400, display: 'flex', position: 'relative' }}>
          <input
            type="text"
            placeholder="Try Saree, Kurti or Search by Product Code"
            style={{
              width: '100%',
              height: 36,
              padding: '0 12px 0 34px',
              border: '1px solid #adadad',
              borderRadius: 4,
              fontSize: 13,
              outline: 'none',
            }}
          />
          <span
            style={{ position: 'absolute', left: 10, top: 10, color: '#7f7f7f', display: 'flex' }}
          >
            <SearchG color="#7f7f7f" />
          </span>
        </div>

        <div style={{ display: 'flex', gap: 24, fontSize: 13, fontWeight: 500 }}>
          <span style={{ cursor: 'pointer' }}>Download App</span>
          <span style={{ cursor: 'pointer' }}>Become a Supplier</span>
          <span style={{ cursor: 'pointer' }}>Profile</span>
          <span style={{ cursor: 'pointer' }}>Cart</span>
        </div>
      </div>

      {/* Main product zone */}
      <div style={{ display: 'flex', gap: 24, padding: '24px 8% 40px', alignItems: 'flex-start' }}>
        {/* Left column: Image & Thumbnails */}
        <div style={{ flex: '0 0 380px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              border: '1px solid #e0e0e0',
              borderRadius: 4,
              overflow: 'hidden',
              background: '#fff',
            }}
          >
            <ProductImage src={active} ratio={ratio} />
          </div>

          {/* Thumbnail list */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {images.slice(0, 5).map((url, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: gallery index is stable
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                onMouseEnter={() => onActiveChange(i)}
                style={{
                  width: 50,
                  height: 50,
                  border: `2px solid ${i === activeIndex ? '#9f206c' : '#e0e0e0'}`,
                  borderRadius: 2,
                  padding: 2,
                  cursor: 'pointer',
                  background: '#fff',
                  overflow: 'hidden',
                }}
              >
                {url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  // biome-ignore lint/performance/noImgElement: generated catalogue preview image
                  <img
                    src={url}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  />
                ) : (
                  <div className="av-shimmer" style={{ width: '100%', height: '100%' }} />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Right column: Info details */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Card 1: Details */}
          <div
            style={{
              background: '#fff',
              border: '1px solid #e0e0e0',
              borderRadius: 8,
              padding: 20,
            }}
          >
            <h1 style={{ fontSize: 18, color: '#353535', margin: '0 0 10px', fontWeight: 500 }}>
              {TC.title}
            </h1>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
              <span style={{ fontSize: 24, fontWeight: 700, color: '#353535' }}>₹{TC.price}</span>
              <span style={{ color: '#7f7f7f', textDecoration: 'line-through', fontSize: 15 }}>
                ₹{TC.mrp}
              </span>
              <span style={{ color: '#388e3c', fontWeight: 600, fontSize: 15 }}>
                {TC.discount} off
              </span>
            </div>
            <div style={{ fontSize: 12, color: '#7f7f7f', marginBottom: 12 }}>Free Delivery</div>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: '#f1fcf5',
                border: '1px solid #e0f8e9',
                padding: '4px 10px',
                borderRadius: 20,
              }}
            >
              <span
                style={{
                  background: '#388e3c',
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '1px 6px',
                  borderRadius: 12,
                }}
              >
                {TC.rating} ★
              </span>
              <span style={{ color: '#353535', fontSize: 13 }}>{TC.ratingCount} Ratings</span>
            </div>
          </div>

          {/* Card 2: Size Selection */}
          <div
            style={{
              background: '#fff',
              border: '1px solid #e0e0e0',
              borderRadius: 8,
              padding: 20,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: '#353535' }}>
              Select Size
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              {TC.sizes.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSize(s)}
                  style={{
                    minWidth: 44,
                    height: 36,
                    borderRadius: 18,
                    border: `1px solid ${s === size ? '#9f206c' : '#adadad'}`,
                    background: s === size ? '#fdf0f7' : '#fff',
                    fontSize: 13,
                    fontWeight: s === size ? 600 : 400,
                    cursor: 'pointer',
                    color: s === size ? '#9f206c' : '#353535',
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: 16 }}>
            <button
              type="button"
              style={{
                width: 200,
                height: 48,
                background: '#fff',
                color: '#353535',
                fontWeight: 600,
                fontSize: 14,
                border: '1px solid #e0e0e0',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Add to Cart
            </button>
            <button
              type="button"
              style={{
                width: 200,
                height: 48,
                background: '#9f206c',
                color: '#fff',
                fontWeight: 600,
                fontSize: 14,
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Buy Now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Nykaa Fashion templates ─────────────────────────────────────────────────

export function NykaaMobileTemplate({ images, activeIndex, onActiveChange, ratio }: TemplateProps) {
  const [size, setSize] = useState(TC.defaultSize);
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily: 'Inter, Arial, sans-serif',
        fontSize: 13,
        color: '#3f3f3f',
        background: '#fff',
      }}
    >
      {/* Header */}
      <div
        style={{
          background: '#fff',
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          height: 52,
          boxSizing: 'border-box',
          borderBottom: '1px solid #e2e2e2',
        }}
      >
        <span style={{ fontSize: 18, color: '#3f3f3f', cursor: 'pointer' }}>←</span>
        <span
          style={{
            fontWeight: 700,
            fontSize: 16,
            color: '#fc2779',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            margin: '0 auto 0 0',
          }}
        >
          Nykaa Fashion
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, color: '#3f3f3f' }}>
          <span style={{ display: 'flex' }}>
            <SearchG color="#3f3f3f" />
          </span>
          <CartG size={20} color="#3f3f3f" />
        </div>
      </div>

      <ProductImage src={active} ratio={ratio} />

      {/* Carousel Dots */}
      {(() => {
        const resolved = images.map((url, i) => ({ url, i })).filter(({ url }) => Boolean(url));
        if (resolved.length <= 1) return null;
        return (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 5, padding: '8px 0 4px' }}>
            {resolved.map(({ i }) => (
              <button
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                aria-label={`Show image ${i + 1}`}
                style={{
                  width: i === activeIndex ? 7 : 5,
                  height: i === activeIndex ? 7 : 5,
                  borderRadius: '50%',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  background: i === activeIndex ? '#fc2779' : '#c2c2c2',
                }}
              />
            ))}
          </div>
        );
      })()}

      {/* Details */}
      <div style={{ padding: 12 }}>
        <div
          style={{
            color: '#000',
            fontSize: 15,
            fontWeight: 700,
            textTransform: 'uppercase',
            marginBottom: 2,
          }}
        >
          {TC.store}
        </div>
        <div style={{ fontSize: 13.5, color: '#757575', lineHeight: 1.3, marginBottom: 8 }}>
          {TC.title}
        </div>

        {/* Star rating */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 8 }}>
          <span style={{ fontSize: 12 }}>{TC.rating} ★</span>
          <span style={{ color: '#e2e2e2' }}>|</span>
          <span style={{ color: '#757575', fontSize: 11 }}>{TC.ratingCount} Ratings</span>
        </div>

        {/* Price */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: '#000' }}>₹{TC.price}</span>
          <span style={{ color: '#757575', textDecoration: 'line-through', fontSize: 12 }}>
            ₹{TC.mrp}
          </span>
          <span style={{ color: '#fc2779', fontWeight: 700, fontSize: 13 }}>{TC.discount} off</span>
        </div>

        <div style={{ height: 1, background: '#e2e2e2', marginBottom: 12 }} />

        {/* Size Selection */}
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: '#3f3f3f' }}>
          Select Size
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          {TC.sizes.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSize(s)}
              style={{
                width: 38,
                height: 38,
                borderRadius: 4,
                border: `1px solid ${s === size ? '#fc2779' : '#e2e2e2'}`,
                background: '#fff',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                color: s === size ? '#fc2779' : '#3f3f3f',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Buy Action Buttons */}
        <button
          type="button"
          style={{
            width: '100%',
            height: 44,
            borderRadius: 4,
            border: 'none',
            background: '#fc2779',
            color: '#fff',
            fontWeight: 700,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Add to Bag
        </button>
      </div>
    </div>
  );
}

export function NykaaDesktopTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
}: TemplateProps) {
  const [size, setSize] = useState(TC.defaultSize);
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily: 'Inter, Arial, sans-serif',
        fontSize: 14,
        color: '#3f3f3f',
        background: '#fff',
      }}
    >
      {/* Top Navigation */}
      <div
        style={{
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8%',
          height: 80,
          borderBottom: '1px solid #e2e2e2',
        }}
      >
        <div
          style={{
            fontWeight: 700,
            fontSize: 22,
            color: '#fc2779',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            cursor: 'pointer',
          }}
        >
          Nykaa Fashion
        </div>

        <div
          style={{
            display: 'flex',
            gap: 24,
            fontWeight: 600,
            fontSize: 13,
            color: '#3f3f3f',
            textTransform: 'uppercase',
          }}
        >
          {['Women', 'Men', 'Kids', 'Home', 'Gadgets', 'Sale'].map((x) => (
            <span key={x} style={{ cursor: 'pointer' }}>
              {x}
            </span>
          ))}
        </div>

        <div style={{ width: 240, display: 'flex', position: 'relative' }}>
          <input
            type="text"
            placeholder="Search on Nykaa Fashion"
            style={{
              width: '100%',
              height: 36,
              padding: '0 12px 0 34px',
              border: '1px solid #dcdcdc',
              borderRadius: 4,
              fontSize: 12,
              outline: 'none',
            }}
          />
          <span
            style={{ position: 'absolute', left: 10, top: 10, color: '#757575', display: 'flex' }}
          >
            <SearchG color="#757575" />
          </span>
        </div>

        <div style={{ display: 'flex', gap: 20, fontSize: 13, fontWeight: 600 }}>
          <span style={{ cursor: 'pointer' }}>Account</span>
          <span style={{ cursor: 'pointer' }}>Wishlist</span>
          <span style={{ cursor: 'pointer' }}>Cart</span>
        </div>
      </div>

      {/* Main product zone */}
      <div style={{ display: 'flex', gap: 32, padding: '32px 8% 40px', alignItems: 'flex-start' }}>
        {/* Left Column: Image & Thumbnails */}
        <div style={{ flex: '0 0 420px', display: 'flex', gap: 16 }}>
          {/* Thumbnails */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
            {images.slice(0, 5).map((url, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: gallery index is stable
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                onMouseEnter={() => onActiveChange(i)}
                style={{
                  width: 50,
                  height: 64,
                  border: `1px solid ${i === activeIndex ? '#fc2779' : '#e2e2e2'}`,
                  boxShadow: i === activeIndex ? '0 0 0 1px #fc2779' : 'none',
                  padding: 2,
                  cursor: 'pointer',
                  background: '#fff',
                  overflow: 'hidden',
                }}
              >
                {url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  // biome-ignore lint/performance/noImgElement: generated catalogue preview image
                  <img
                    src={url}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  />
                ) : (
                  <div className="av-shimmer" style={{ width: '100%', height: '100%' }} />
                )}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, border: '1px solid #e2e2e2', overflow: 'hidden' }}>
            <ProductImage src={active} ratio={ratio} />
          </div>
        </div>

        {/* Right column: Info details */}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: '#757575', marginBottom: 12 }}>
            Home / Women / Westernwear / Tops / {TC.store}
          </div>

          <h2
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: '#000',
              margin: '0 0 4px',
              textTransform: 'uppercase',
            }}
          >
            {TC.store}
          </h2>
          <h1 style={{ fontSize: 18, color: '#757575', margin: '0 0 14px', fontWeight: 400 }}>
            {TC.title}
          </h1>

          {/* Rating */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <span>{TC.rating} ★</span>
            <span style={{ color: '#e2e2e2' }}>|</span>
            <span style={{ color: '#757575', fontSize: 13 }}>{TC.ratingCount} Ratings</span>
          </div>

          <div style={{ height: 1, background: '#e2e2e2', marginBottom: 16 }} />

          {/* Pricing */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 20 }}>
            <span style={{ fontSize: 26, fontWeight: 700, color: '#000' }}>₹{TC.price}</span>
            <span style={{ color: '#757575', textDecoration: 'line-through', fontSize: 16 }}>
              ₹{TC.mrp}
            </span>
            <span style={{ color: '#fc2779', fontWeight: 700, fontSize: 16 }}>
              ({TC.discount} off)
            </span>
          </div>

          {/* Sizes */}
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, color: '#3f3f3f' }}>
            Select Size
          </div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 28 }}>
            {TC.sizes.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSize(s)}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 4,
                  border: `1px solid ${s === size ? '#fc2779' : '#e2e2e2'}`,
                  background: '#fff',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  color: s === size ? '#fc2779' : '#3f3f3f',
                }}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Action Buttons */}
          <button
            type="button"
            style={{
              width: 240,
              height: 48,
              background: '#fc2779',
              color: '#fff',
              fontWeight: 700,
              fontSize: 14,
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            ADD TO BAG
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Shopify templates ───────────────────────────────────────────────────────

const SHOPIFY_THEME = {
  brand: '#111111',
  accent: '#3f6f5b',
  accentHover: '#315747',
  background: '#ffffff',
  softBackground: '#f7f7f4',
  textPrimary: '#171717',
  textSecondary: '#5f5f5f',
  textMuted: '#8a8a8a',
  border: '#deded8',
  divider: '#ecece8',
  success: '#287a4b',
  sale: '#b54732',
};

const shopifyStore = {
  name: 'TRYME',
  announcement: 'Free shipping on orders over Rs. 999',
  accentColor: SHOPIFY_THEME.accent,
  navigation: ['New Arrivals', 'Women', 'Men', 'Accessories', 'Collections', 'About'],
};

type FramedShopifyVariant = {
  label: string;
  value?: string;
  color?: string;
  disabled?: boolean;
};

type FramedShopifyProduct = {
  vendor: string;
  collection: string;
  title: string;
  description: string;
  rating: string;
  reviewCount: string;
  price: string;
  compareAtPrice: string;
  saleLabel: string;
  selectedColor: string;
  colors: FramedShopifyVariant[];
  variantLabel: string;
  variants: FramedShopifyVariant[];
  material: string;
  inventory: string;
  details: Array<{ label: string; value: string }>;
  accordion: Array<{ title: string; content: string; open?: boolean }>;
};

function framedShopifyProduct(
  gender?: string | null,
  garmentName?: string | null,
): FramedShopifyProduct {
  const normalizedGender =
    gender === 'men' ? 'men' : gender === 'boy' ? 'boy' : gender === 'girl' ? 'girl' : 'women';
  const audience =
    normalizedGender === 'men'
      ? 'Men'
      : normalizedGender === 'boy'
        ? 'Kids'
        : normalizedGender === 'girl'
          ? 'Kids'
          : 'Women';
  const name =
    garmentName?.trim() ||
    (normalizedGender === 'men' ? 'Relaxed Cotton Full Sleeve Shirt' : 'Tailored Cotton Shirt');
  const lowerName = name.toLowerCase();
  const isFootwear = lowerName.includes('shoe') || lowerName.includes('footwear');
  const collection = isFootwear
    ? 'Footwear'
    : audience === 'Kids'
      ? 'Kids Essentials'
      : `${audience} Essentials`;
  const variantLabel = isFootwear ? 'Size' : 'Size';
  const variants = isFootwear
    ? [
        { label: '6' },
        { label: '7' },
        { label: '8' },
        { label: '9' },
        { label: '10', disabled: true },
      ]
    : [
        { label: 'XS' },
        { label: 'S' },
        { label: 'M' },
        { label: 'L' },
        { label: 'XL' },
        { label: 'XXL', disabled: audience === 'Kids' },
      ];

  return {
    vendor: shopifyStore.name,
    collection,
    title: name,
    description: `A polished ${lowerName} designed for modern catalogue-led storefronts with a premium everyday finish.`,
    rating: '4.8',
    reviewCount: '124 reviews',
    price: '999',
    compareAtPrice: '1,999',
    saleLabel: 'Sale',
    selectedColor: lowerName.includes('mauve')
      ? 'Dusty Mauve'
      : lowerName.includes('blue')
        ? 'Oxford Blue'
        : 'Cloud White',
    colors: [
      { label: 'Cloud White', color: '#f4f1ea' },
      { label: 'Oxford Blue', color: '#6f8fb5' },
      { label: 'Dusty Mauve', color: '#9d727d' },
      { label: 'Charcoal', color: '#2f3336', disabled: true },
    ],
    variantLabel,
    variants,
    material: isFootwear ? 'Textile upper and rubber sole' : 'Cotton blend',
    inventory: 'Only 4 left',
    details: [
      { label: 'Collection', value: collection },
      { label: 'Fit', value: isFootwear ? 'Regular' : 'Relaxed fit' },
      { label: 'Material', value: isFootwear ? 'Textile and rubber' : 'Cotton blend' },
      { label: 'Care', value: isFootwear ? 'Wipe with dry cloth' : 'Machine wash cold' },
    ],
    accordion: [
      {
        title: 'Description',
        content: `Cut for a refined DTC storefront look, this ${lowerName} pairs clean product photography with a modern premium silhouette.`,
        open: true,
      },
      {
        title: 'Materials & Care',
        content: isFootwear
          ? 'Textile upper, cushioned footbed, rubber sole.'
          : 'Cotton blend. Wash inside out with similar colors.',
      },
      {
        title: 'Shipping & Returns',
        content: 'Ships in 1-2 business days. Easy 7-day returns on unused products.',
      },
      {
        title: 'Product Details',
        content: 'Designed by TRYME and photographed for catalogue-ready ecommerce presentation.',
      },
    ],
  };
}

function ShopifyStoreLogo({ small = false }: { small?: boolean }) {
  return (
    <div
      style={{
        color: SHOPIFY_THEME.brand,
        fontFamily: 'Georgia, "Times New Roman", serif',
        fontSize: small ? 18 : 30,
        fontWeight: 700,
        letterSpacing: small ? 1.8 : 2.8,
        lineHeight: 1,
      }}
    >
      {shopifyStore.name}
    </div>
  );
}

function FramedShopifyHeader() {
  return (
    <header
      style={{
        background: SHOPIFY_THEME.background,
        borderBottom: `1px solid ${SHOPIFY_THEME.divider}`,
      }}
    >
      <div
        style={{
          height: 32,
          display: 'grid',
          placeItems: 'center',
          background: SHOPIFY_THEME.brand,
          color: '#fff',
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 0.2,
        }}
      >
        {shopifyStore.announcement}
      </div>
      <div
        style={{
          maxWidth: 1220,
          margin: '0 auto',
          height: 72,
          display: 'grid',
          gridTemplateColumns: '180px minmax(0, 1fr) 132px',
          alignItems: 'center',
          gap: 28,
          padding: '0 32px',
        }}
      >
        <ShopifyStoreLogo />
        <nav
          aria-label="Store navigation"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 28,
            color: SHOPIFY_THEME.textPrimary,
            fontSize: 13,
            fontWeight: 700,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          {shopifyStore.navigation.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </nav>
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 16 }}>
          <button
            type="button"
            aria-label="Search"
            style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }}
          >
            <SearchIcon size={19} color={SHOPIFY_THEME.textPrimary} />
          </button>
          <button
            type="button"
            aria-label="Account"
            style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }}
          >
            <UserIcon size={19} color={SHOPIFY_THEME.textPrimary} />
          </button>
          <button
            type="button"
            aria-label="Cart, 1 item"
            style={{
              border: 0,
              background: 'transparent',
              padding: 0,
              cursor: 'pointer',
              position: 'relative',
            }}
          >
            <BagIcon size={20} color={SHOPIFY_THEME.textPrimary} />
            <span
              style={{
                position: 'absolute',
                top: -8,
                right: -9,
                width: 17,
                height: 17,
                borderRadius: '50%',
                background: SHOPIFY_THEME.accent,
                color: '#fff',
                fontSize: 10,
                fontWeight: 700,
                display: 'grid',
                placeItems: 'center',
              }}
            >
              1
            </span>
          </button>
        </div>
      </div>
    </header>
  );
}

function FramedShopifyRating({ product }: { product: FramedShopifyProduct }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 12 }}>
      <span
        role="img"
        aria-label={`${product.rating} out of 5 stars`}
        style={{ color: SHOPIFY_THEME.brand, fontSize: 13, letterSpacing: 1.5 }}
      >
        *****
      </span>
      <span style={{ color: SHOPIFY_THEME.textSecondary, fontSize: 12.5 }}>
        {product.rating} | {product.reviewCount}
      </span>
    </div>
  );
}

function FramedShopifyPrice({ product }: { product: FramedShopifyProduct }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 }}>
      <span style={{ color: SHOPIFY_THEME.textPrimary, fontSize: 24, fontWeight: 700 }}>
        Rs. {product.price}
      </span>
      <span
        style={{ color: SHOPIFY_THEME.textMuted, fontSize: 15, textDecoration: 'line-through' }}
      >
        Rs. {product.compareAtPrice}
      </span>
      <span
        style={{
          color: SHOPIFY_THEME.sale,
          border: `1px solid ${SHOPIFY_THEME.sale}`,
          padding: '4px 8px',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        }}
      >
        {product.saleLabel}
      </span>
    </div>
  );
}

function FramedShopifyColorSelector({
  product,
  selected,
  onSelect,
}: {
  product: FramedShopifyProduct;
  selected: string;
  onSelect: (label: string) => void;
}) {
  return (
    <section style={{ marginTop: 18 }}>
      <div
        style={{ color: SHOPIFY_THEME.textPrimary, fontSize: 13, fontWeight: 700, marginBottom: 9 }}
      >
        Color:{' '}
        <span style={{ color: SHOPIFY_THEME.textSecondary, fontWeight: 600 }}>{selected}</span>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        {product.colors.map((color) => {
          const active = color.label === selected;
          return (
            <button
              key={color.label}
              type="button"
              disabled={color.disabled}
              onClick={() => onSelect(color.label)}
              aria-label={color.label}
              aria-pressed={active}
              style={{
                width: 34,
                height: 34,
                borderRadius: '50%',
                border: `1px solid ${active ? SHOPIFY_THEME.brand : SHOPIFY_THEME.border}`,
                background: color.color,
                cursor: color.disabled ? 'not-allowed' : 'pointer',
                opacity: color.disabled ? 0.38 : 1,
                boxShadow: active ? '0 0 0 3px #fff inset, 0 0 0 2px #111' : '0 0 0 3px #fff inset',
              }}
            />
          );
        })}
      </div>
    </section>
  );
}

function FramedShopifySizeSelector({
  product,
  selected,
  onSelect,
}: {
  product: FramedShopifyProduct;
  selected: string;
  onSelect: (label: string) => void;
}) {
  return (
    <section style={{ marginTop: 18 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 10,
        }}
      >
        <div style={{ color: SHOPIFY_THEME.textPrimary, fontSize: 13, fontWeight: 700 }}>
          {product.variantLabel}
        </div>
        <button
          type="button"
          style={{
            border: 0,
            background: 'transparent',
            color: SHOPIFY_THEME.accent,
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          Size Guide
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {product.variants.map((variant) => {
          const active = variant.label === selected;
          return (
            <button
              key={variant.label}
              type="button"
              disabled={variant.disabled}
              onClick={() => onSelect(variant.label)}
              aria-pressed={active}
              style={{
                minWidth: 44,
                height: 40,
                border: `1px solid ${active ? SHOPIFY_THEME.accent : SHOPIFY_THEME.border}`,
                background: active ? SHOPIFY_THEME.accent : '#fff',
                color: variant.disabled
                  ? SHOPIFY_THEME.textMuted
                  : active
                    ? '#fff'
                    : SHOPIFY_THEME.textPrimary,
                fontSize: 12,
                fontWeight: 700,
                cursor: variant.disabled ? 'not-allowed' : 'pointer',
                opacity: variant.disabled ? 0.45 : 1,
                textDecoration: variant.disabled ? 'line-through' : 'none',
              }}
            >
              {variant.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function FramedShopifyQuantity({
  quantity,
  onChange,
}: {
  quantity: number;
  onChange: (quantity: number) => void;
}) {
  return (
    <div style={{ marginTop: 18 }}>
      <div
        style={{ color: SHOPIFY_THEME.textPrimary, fontSize: 13, fontWeight: 700, marginBottom: 9 }}
      >
        Quantity
      </div>
      <div
        style={{
          display: 'inline-grid',
          gridTemplateColumns: '38px 42px 38px',
          height: 38,
          border: `1px solid ${SHOPIFY_THEME.border}`,
        }}
      >
        <button
          type="button"
          aria-label="Decrease quantity"
          onClick={() => onChange(Math.max(1, quantity - 1))}
          style={{
            border: 0,
            background: '#fff',
            color: SHOPIFY_THEME.textPrimary,
            fontSize: 18,
            cursor: 'pointer',
          }}
        >
          -
        </button>
        <div
          style={{
            display: 'grid',
            placeItems: 'center',
            borderLeft: `1px solid ${SHOPIFY_THEME.border}`,
            borderRight: `1px solid ${SHOPIFY_THEME.border}`,
            fontWeight: 700,
          }}
        >
          {quantity}
        </div>
        <button
          type="button"
          aria-label="Increase quantity"
          onClick={() => onChange(quantity + 1)}
          style={{
            border: 0,
            background: '#fff',
            color: SHOPIFY_THEME.textPrimary,
            fontSize: 18,
            cursor: 'pointer',
          }}
        >
          +
        </button>
      </div>
    </div>
  );
}

function FramedShopifyGallery({
  images,
  activeIndex,
  onActiveChange,
  ratio,
  product,
}: TemplateProps & { product: FramedShopifyProduct }) {
  const active = images[activeIndex];
  const resolvedImages = images
    .map((url, index) => ({ url, index }))
    .filter(({ url }) => Boolean(url));

  return (
    <section
      aria-label="Product media"
      style={{
        flex: '0 0 60%',
        display: 'grid',
        gridTemplateColumns: '82px minmax(0, 1fr)',
        gap: 14,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(resolvedImages.length ? resolvedImages.slice(0, 5) : [{ url: undefined, index: 0 }]).map(
          ({ url, index }) => (
            <button
              key={index}
              type="button"
              onClick={() => onActiveChange(index)}
              aria-label={`Show ${product.title} image ${index + 1}`}
              style={{
                width: 78,
                height: 98,
                border: `1px solid ${index === activeIndex ? SHOPIFY_THEME.brand : SHOPIFY_THEME.border}`,
                background: SHOPIFY_THEME.softBackground,
                padding: 3,
                cursor: 'pointer',
                overflow: 'hidden',
              }}
            >
              <ProductImage src={url} ratio="3 / 4" />
            </button>
          ),
        )}
      </div>
      <div
        style={{
          background: SHOPIFY_THEME.softBackground,
          minHeight: 552,
          position: 'relative',
          display: 'grid',
          placeItems: 'center',
          cursor: 'zoom-in',
        }}
      >
        <ProductImage src={active} ratio={ratio} />
        <div
          style={{
            position: 'absolute',
            left: 16,
            top: 16,
            background: '#fff',
            color: SHOPIFY_THEME.sale,
            border: `1px solid ${SHOPIFY_THEME.divider}`,
            padding: '6px 10px',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.7,
            textTransform: 'uppercase',
          }}
        >
          Best Seller
        </div>
        <div
          style={{
            position: 'absolute',
            right: 16,
            bottom: 16,
            background: 'rgba(255,255,255,0.92)',
            border: `1px solid ${SHOPIFY_THEME.border}`,
            color: SHOPIFY_THEME.textSecondary,
            padding: '6px 10px',
            fontSize: 11.5,
            fontWeight: 750,
          }}
        >
          {activeIndex + 1} / {Math.max(resolvedImages.length, 1)}
        </div>
      </div>
    </section>
  );
}

function FramedShopifyAccordions({ product }: { product: FramedShopifyProduct }) {
  return (
    <section style={{ marginTop: 20, borderTop: `1px solid ${SHOPIFY_THEME.divider}` }}>
      {product.accordion.map((item) => (
        <details
          key={item.title}
          open={item.open}
          style={{
            borderBottom: `1px solid ${SHOPIFY_THEME.divider}`,
            padding: '12px 0',
            color: SHOPIFY_THEME.textPrimary,
          }}
        >
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 700, listStyle: 'none' }}>
            {item.title}
          </summary>
          <p
            style={{
              margin: '8px 0 0',
              color: SHOPIFY_THEME.textSecondary,
              fontSize: 12.5,
              lineHeight: 1.55,
            }}
          >
            {item.content}
          </p>
        </details>
      ))}
    </section>
  );
}

function FramedShopifyInfo({
  product,
  selectedColor,
  onSelectColor,
  selectedSize,
  onSelectSize,
  quantity,
  onQuantityChange,
}: {
  product: FramedShopifyProduct;
  selectedColor: string;
  onSelectColor: (color: string) => void;
  selectedSize: string;
  onSelectSize: (size: string) => void;
  quantity: number;
  onQuantityChange: (quantity: number) => void;
}) {
  return (
    <section style={{ flex: '1 1 0', minWidth: 0, paddingLeft: 4 }}>
      <div
        style={{
          color: SHOPIFY_THEME.textMuted,
          fontSize: 12,
          letterSpacing: 0.9,
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
      >
        {product.collection}
      </div>
      <div
        style={{
          color: SHOPIFY_THEME.textSecondary,
          fontSize: 12,
          letterSpacing: 1.5,
          textTransform: 'uppercase',
          fontWeight: 600,
          marginTop: 12,
        }}
      >
        {product.vendor}
      </div>
      <h1
        style={{
          color: SHOPIFY_THEME.textPrimary,
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontSize: 32,
          lineHeight: 1.12,
          fontWeight: 500,
          margin: '8px 0 0',
          letterSpacing: 0,
        }}
      >
        {product.title}
      </h1>
      <FramedShopifyRating product={product} />
      <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
        {[
          {
            label: 'Add to Wishlist',
            icon: <HeartIcon size={15} color={SHOPIFY_THEME.textSecondary} />,
          },
          { label: 'Share', icon: <ShareIcon size={15} color={SHOPIFY_THEME.textSecondary} /> },
        ].map((action) => (
          <button
            key={action.label}
            type="button"
            style={{
              border: 0,
              background: 'transparent',
              color: SHOPIFY_THEME.textSecondary,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: 0,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {action.icon}
            {action.label}
          </button>
        ))}
      </div>
      <FramedShopifyPrice product={product} />
      <p
        style={{
          color: SHOPIFY_THEME.textSecondary,
          fontSize: 13.5,
          lineHeight: 1.55,
          margin: '14px 0 0',
        }}
      >
        {product.description}
      </p>
      <FramedShopifyColorSelector
        product={product}
        selected={selectedColor}
        onSelect={onSelectColor}
      />
      <FramedShopifySizeSelector
        product={product}
        selected={selectedSize}
        onSelect={onSelectSize}
      />
      <FramedShopifyQuantity quantity={quantity} onChange={onQuantityChange} />
      <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button
          type="button"
          style={{
            height: 50,
            border: 0,
            background: SHOPIFY_THEME.brand,
            color: '#fff',
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 1.2,
            cursor: 'pointer',
          }}
        >
          ADD TO CART
        </button>
        <button
          type="button"
          style={{
            height: 50,
            border: `1px solid ${SHOPIFY_THEME.brand}`,
            background: '#fff',
            color: SHOPIFY_THEME.brand,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 1.2,
            cursor: 'pointer',
          }}
        >
          BUY IT NOW
        </button>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 10,
          marginTop: 16,
          color: SHOPIFY_THEME.textSecondary,
          fontSize: 12.5,
          lineHeight: 1.45,
        }}
      >
        {[
          'Ships in 1-2 business days',
          'Easy 7-day returns',
          'Secure checkout',
          product.inventory,
        ].map((item) => (
          <div key={item} style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: SHOPIFY_THEME.success,
                flexShrink: 0,
              }}
            />
            {item}
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 12,
          borderTop: `1px solid ${SHOPIFY_THEME.divider}`,
          paddingTop: 12,
          color: SHOPIFY_THEME.textSecondary,
          fontSize: 12.5,
          lineHeight: 1.5,
        }}
      >
        Powered storefront experience with secure checkout, saved products, shareable product links
        and direct brand support.
      </div>
      <FramedShopifyAccordions product={product} />
    </section>
  );
}

export function FramedShopifyDesktopTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
  gender,
  garmentName,
}: TemplateProps) {
  const product = framedShopifyProduct(gender, garmentName);
  const [selectedColor, setSelectedColor] = useState(product.selectedColor);
  const [selectedSize, setSelectedSize] = useState(
    product.variants.find((variant) => !variant.disabled)?.label ||
      product.variants[0]?.label ||
      '',
  );
  const [quantity, setQuantity] = useState(1);

  return (
    <div
      style={
        {
          '--shopify-brand': SHOPIFY_THEME.brand,
          '--shopify-accent': SHOPIFY_THEME.accent,
          '--shopify-accent-hover': SHOPIFY_THEME.accentHover,
          '--shopify-background': SHOPIFY_THEME.background,
          '--shopify-soft-background': SHOPIFY_THEME.softBackground,
          '--shopify-text-primary': SHOPIFY_THEME.textPrimary,
          '--shopify-text-secondary': SHOPIFY_THEME.textSecondary,
          '--shopify-text-muted': SHOPIFY_THEME.textMuted,
          '--shopify-border': SHOPIFY_THEME.border,
          '--shopify-divider': SHOPIFY_THEME.divider,
          '--shopify-success': SHOPIFY_THEME.success,
          '--shopify-sale': SHOPIFY_THEME.sale,
          fontFamily: MARKETPLACE_FONTS.shopifyBody,
          color: SHOPIFY_THEME.textPrimary,
          background: SHOPIFY_THEME.background,
          minHeight: 720,
        } as React.CSSProperties
      }
    >
      <FramedShopifyHeader />
      <main
        style={{
          maxWidth: 1240,
          margin: '0 auto',
          padding: '24px 32px 42px',
          display: 'flex',
          gap: 34,
          alignItems: 'flex-start',
        }}
      >
        <FramedShopifyGallery
          images={images}
          activeIndex={activeIndex}
          onActiveChange={onActiveChange}
          ratio={ratio}
          product={product}
        />
        <FramedShopifyInfo
          product={product}
          selectedColor={selectedColor}
          onSelectColor={setSelectedColor}
          selectedSize={selectedSize}
          onSelectSize={setSelectedSize}
          quantity={quantity}
          onQuantityChange={setQuantity}
        />
      </main>
    </div>
  );
}

export function FramedShopifyMobileTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
  gender,
  garmentName,
}: TemplateProps) {
  const product = framedShopifyProduct(gender, garmentName);
  const [selectedColor, setSelectedColor] = useState(product.selectedColor);
  const [selectedSize, setSelectedSize] = useState(
    product.variants.find((variant) => !variant.disabled)?.label ||
      product.variants[0]?.label ||
      '',
  );
  const [quantity, setQuantity] = useState(1);
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily: MARKETPLACE_FONTS.shopifyBody,
        color: SHOPIFY_THEME.textPrimary,
        background: SHOPIFY_THEME.softBackground,
        minHeight: '100%',
        fontSize: 13,
      }}
    >
      <div
        style={{
          height: 28,
          display: 'grid',
          placeItems: 'center',
          background: SHOPIFY_THEME.brand,
          color: '#fff',
          fontSize: 11.5,
          fontWeight: 700,
        }}
      >
        {shopifyStore.announcement}
      </div>
      <header
        style={{
          height: 52,
          display: 'grid',
          gridTemplateColumns: '36px 1fr 104px',
          alignItems: 'center',
          padding: '0 12px',
          borderBottom: `1px solid ${SHOPIFY_THEME.divider}`,
          background: '#fff',
          position: 'sticky',
          top: 0,
          zIndex: 5,
        }}
      >
        <button
          type="button"
          aria-label="Menu"
          style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }}
        >
          <MenuG color={SHOPIFY_THEME.textPrimary} />
        </button>
        <div style={{ display: 'grid', placeItems: 'center' }}>
          <ShopifyStoreLogo small />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 14 }}>
          <SearchIcon size={18} color={SHOPIFY_THEME.textPrimary} />
          <ShareIcon size={18} color={SHOPIFY_THEME.textPrimary} />
          <HeartIcon size={18} color={SHOPIFY_THEME.textPrimary} />
          <BagIcon size={18} color={SHOPIFY_THEME.textPrimary} />
        </div>
      </header>
      <section style={{ background: '#fff', position: 'relative' }}>
        <ProductImage src={active} ratio={ratio} />
        <div
          style={{
            position: 'absolute',
            left: 12,
            top: 12,
            background: '#fff',
            color: SHOPIFY_THEME.sale,
            border: `1px solid ${SHOPIFY_THEME.divider}`,
            padding: '5px 8px',
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: 0.7,
          }}
        >
          SALE
        </div>
      </section>
      {(() => {
        const resolved = images.map((url, i) => ({ url, i })).filter(({ url }) => Boolean(url));
        if (resolved.length <= 1) return null;
        return (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: 5,
              padding: '8px 0 6px',
              background: '#fff',
            }}
          >
            {resolved.map(({ i }) => (
              <button
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                aria-label={`Show image ${i + 1}`}
                style={{
                  width: i === activeIndex ? 7 : 5,
                  height: i === activeIndex ? 7 : 5,
                  borderRadius: '50%',
                  border: 0,
                  padding: 0,
                  background: i === activeIndex ? SHOPIFY_THEME.brand : '#c8c8c1',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
        );
      })()}
      <main
        style={{
          padding: 10,
          paddingBottom: 104,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <section
          style={{ background: '#fff', border: `1px solid ${SHOPIFY_THEME.divider}`, padding: 12 }}
        >
          <div
            style={{
              color: SHOPIFY_THEME.textMuted,
              fontSize: 11,
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            {product.vendor}
          </div>
          <h1
            style={{
              margin: '5px 0 8px',
              color: SHOPIFY_THEME.textPrimary,
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontSize: 22,
              lineHeight: 1.15,
              fontWeight: 500,
            }}
          >
            {product.title}
          </h1>
          <FramedShopifyRating product={product} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              type="button"
              style={{
                flex: 1,
                height: 30,
                border: `1px solid ${SHOPIFY_THEME.border}`,
                background: '#fff',
                color: SHOPIFY_THEME.textSecondary,
                fontWeight: 700,
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                cursor: 'pointer',
              }}
            >
              <HeartIcon size={14} color={SHOPIFY_THEME.textSecondary} />
              Wishlist
            </button>
            <button
              type="button"
              style={{
                flex: 1,
                height: 30,
                border: `1px solid ${SHOPIFY_THEME.border}`,
                background: '#fff',
                color: SHOPIFY_THEME.textSecondary,
                fontWeight: 700,
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                cursor: 'pointer',
              }}
            >
              <ShareIcon size={14} color={SHOPIFY_THEME.textSecondary} />
              Share
            </button>
          </div>
          <FramedShopifyPrice product={product} />
          <p
            style={{
              color: SHOPIFY_THEME.textSecondary,
              fontSize: 12.5,
              lineHeight: 1.5,
              margin: '10px 0 0',
            }}
          >
            {product.description}
          </p>
        </section>
        <section
          style={{ background: '#fff', border: `1px solid ${SHOPIFY_THEME.divider}`, padding: 12 }}
        >
          <FramedShopifyColorSelector
            product={product}
            selected={selectedColor}
            onSelect={setSelectedColor}
          />
          <FramedShopifySizeSelector
            product={product}
            selected={selectedSize}
            onSelect={setSelectedSize}
          />
          <FramedShopifyQuantity quantity={quantity} onChange={setQuantity} />
        </section>
        <section
          style={{ background: '#fff', border: `1px solid ${SHOPIFY_THEME.divider}`, padding: 12 }}
        >
          <div
            style={{
              color: SHOPIFY_THEME.success,
              fontWeight: 700,
              fontSize: 12.5,
              marginBottom: 6,
            }}
          >
            {product.inventory}
          </div>
          <div style={{ color: SHOPIFY_THEME.textSecondary, fontSize: 12.5, lineHeight: 1.45 }}>
            Free shipping over Rs. 999. Ships in 1-2 business days. Easy 7-day returns.
          </div>
        </section>
        <section
          style={{
            background: '#fff',
            border: `1px solid ${SHOPIFY_THEME.divider}`,
            padding: '0 12px',
          }}
        >
          <FramedShopifyAccordions product={product} />
        </section>
      </main>
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: '#fff',
          borderTop: `1px solid ${SHOPIFY_THEME.divider}`,
          padding: 10,
          display: 'grid',
          gridTemplateColumns: '1fr',
          gap: 8,
        }}
      >
        <button
          type="button"
          style={{
            height: 44,
            border: 0,
            background: SHOPIFY_THEME.brand,
            color: '#fff',
            fontWeight: 700,
            letterSpacing: 1,
            cursor: 'pointer',
          }}
        >
          ADD TO CART
        </button>
        <button
          type="button"
          style={{
            height: 40,
            border: `1px solid ${SHOPIFY_THEME.brand}`,
            background: '#fff',
            color: SHOPIFY_THEME.brand,
            fontWeight: 700,
            letterSpacing: 1,
            cursor: 'pointer',
          }}
        >
          BUY IT NOW
        </button>
      </div>
    </div>
  );
}

export function ShopifyMobileTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
}: TemplateProps) {
  const [size, setSize] = useState(TC.defaultSize);
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        fontSize: 14,
        color: '#202223',
        background: '#fff',
      }}
    >
      {/* Header */}
      <div
        style={{
          background: '#fff',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 56,
          boxSizing: 'border-box',
          borderBottom: '1px solid #f1f1f1',
        }}
      >
        <span style={{ fontSize: 18, color: '#202223', cursor: 'pointer' }}>☰</span>
        <span
          style={{ fontWeight: 700, fontSize: 15, textTransform: 'uppercase', letterSpacing: 1.5 }}
        >
          {TC.store} FASHION
        </span>
        <CartG size={20} color="#202223" />
      </div>

      <ProductImage src={active} ratio={ratio} />

      {/* Carousel Navigation */}
      {(() => {
        const resolved = images.map((url, i) => ({ url, i })).filter(({ url }) => Boolean(url));
        if (resolved.length <= 1) return null;
        return (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 5, padding: '10px 0 6px' }}>
            {resolved.map(({ i }) => (
              <button
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                aria-label={`Show image ${i + 1}`}
                style={{
                  width: i === activeIndex ? 6 : 4,
                  height: i === activeIndex ? 6 : 4,
                  borderRadius: '50%',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  background: i === activeIndex ? '#202223' : '#c2c2c2',
                }}
              />
            ))}
          </div>
        );
      })()}

      {/* Details */}
      <div style={{ padding: '12px 16px 24px' }}>
        <h1
          style={{
            fontSize: 18,
            fontWeight: 500,
            color: '#202223',
            margin: '0 0 8px',
            lineHeight: 1.3,
          }}
        >
          {TC.title}
        </h1>

        {/* Price */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 16 }}>
          <span style={{ fontSize: 16, fontWeight: 500, color: '#202223' }}>₹{TC.price}.00</span>
          <span style={{ color: '#6d7175', textDecoration: 'line-through', fontSize: 13 }}>
            ₹{TC.mrp}.00
          </span>
          <span
            style={{
              background: '#e2f1eb',
              color: '#008060',
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 6px',
              borderRadius: 12,
            }}
          >
            Save 50%
          </span>
        </div>

        <div style={{ height: 1, background: '#f1f1f1', marginBottom: 16 }} />

        {/* Size Selector */}
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            marginBottom: 8,
            color: '#6d7175',
            textTransform: 'uppercase',
          }}
        >
          Size
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          {TC.sizes.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSize(s)}
              style={{
                padding: '6px 16px',
                borderRadius: 20,
                border: `1px solid ${s === size ? '#202223' : '#dbdbdb'}`,
                background: s === size ? '#202223' : '#fff',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                color: s === size ? '#fff' : '#202223',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            type="button"
            style={{
              width: '100%',
              height: 46,
              borderRadius: 4,
              border: '1px solid #202223',
              background: '#fff',
              color: '#202223',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Add to cart
          </button>
          <button
            type="button"
            style={{
              width: '100%',
              height: 46,
              borderRadius: 4,
              border: 'none',
              background: '#5a31f4',
              color: '#fff',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Buy with Shop Pay
          </button>
        </div>
      </div>
    </div>
  );
}

export function ShopifyDesktopTemplate({
  images,
  activeIndex,
  onActiveChange,
  ratio,
}: TemplateProps) {
  const [size, setSize] = useState(TC.defaultSize);
  const active = images[activeIndex];

  return (
    <div
      style={{
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        fontSize: 14,
        color: '#202223',
        background: '#fff',
      }}
    >
      {/* Top Nav */}
      <div
        style={{
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8%',
          height: 80,
          borderBottom: '1px solid #f1f1f1',
        }}
      >
        <div
          style={{
            fontWeight: 700,
            fontSize: 20,
            textTransform: 'uppercase',
            letterSpacing: 2,
            cursor: 'pointer',
          }}
        >
          {TC.store} FASHION
        </div>

        <div style={{ display: 'flex', gap: 32, fontWeight: 500, fontSize: 14, color: '#202223' }}>
          {['Home', 'Catalog', 'About', 'Contact'].map((x) => (
            <span key={x} style={{ cursor: 'pointer' }}>
              {x}
            </span>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 20 }}>
          <span style={{ cursor: 'pointer', display: 'flex' }}>
            <SearchG color="#202223" />
          </span>
          <span style={{ cursor: 'pointer', display: 'flex' }}>
            <CartG size={20} color="#202223" />
          </span>
        </div>
      </div>

      {/* Main product zone */}
      <div style={{ display: 'flex', gap: 48, padding: '40px 8% 60px', alignItems: 'flex-start' }}>
        {/* Left Column: Image Gallery */}
        <div style={{ flex: '0 0 460px', display: 'flex', gap: 16 }}>
          {/* Thumbnails */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
            {images.slice(0, 5).map((url, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: gallery index is stable
                key={i}
                type="button"
                onClick={() => onActiveChange(i)}
                onMouseEnter={() => onActiveChange(i)}
                style={{
                  width: 54,
                  height: 68,
                  border: `1px solid ${i === activeIndex ? '#202223' : '#dbdbdb'}`,
                  borderRadius: 2,
                  padding: 2,
                  cursor: 'pointer',
                  background: '#fff',
                  overflow: 'hidden',
                }}
              >
                {url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  // biome-ignore lint/performance/noImgElement: generated catalogue preview image
                  <img
                    src={url}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  />
                ) : (
                  <div className="av-shimmer" style={{ width: '100%', height: '100%' }} />
                )}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, border: '1px solid #f1f1f1', overflow: 'hidden' }}>
            <ProductImage src={active} ratio={ratio} />
          </div>
        </div>

        {/* Right column: Info details */}
        <div style={{ flex: 1, maxWidth: 500 }}>
          <div
            style={{
              fontSize: 12,
              color: '#6d7175',
              marginBottom: 12,
              textTransform: 'uppercase',
              letterSpacing: 1,
            }}
          >
            {TC.store}
          </div>
          <h1
            style={{
              fontSize: 26,
              color: '#202223',
              margin: '0 0 16px',
              fontWeight: 500,
              lineHeight: 1.25,
            }}
          >
            {TC.title}
          </h1>

          {/* Pricing */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 20 }}>
            <span style={{ fontSize: 20, color: '#202223' }}>₹{TC.price}.00</span>
            <span style={{ color: '#6d7175', textDecoration: 'line-through', fontSize: 15 }}>
              ₹{TC.mrp}.00
            </span>
            <span
              style={{
                background: '#e2f1eb',
                color: '#008060',
                fontSize: 12,
                fontWeight: 600,
                padding: '3px 8px',
                borderRadius: 12,
              }}
            >
              Sale
            </span>
          </div>

          <div style={{ height: 1, background: '#f1f1f1', marginBottom: 20 }} />

          {/* Sizes */}
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 8,
              color: '#6d7175',
              textTransform: 'uppercase',
            }}
          >
            Size
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 28 }}>
            {TC.sizes.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSize(s)}
                style={{
                  padding: '8px 20px',
                  borderRadius: 20,
                  border: `1px solid ${s === size ? '#202223' : '#dbdbdb'}`,
                  background: s === size ? '#202223' : '#fff',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  color: s === size ? '#fff' : '#202223',
                }}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              type="button"
              style={{
                width: '100%',
                height: 48,
                background: '#fff',
                color: '#202223',
                fontWeight: 600,
                fontSize: 14,
                border: '1px solid #202223',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Add to cart
            </button>
            <button
              type="button"
              style={{
                width: '100%',
                height: 48,
                background: '#5a31f4',
                color: '#fff',
                fontWeight: 600,
                fontSize: 14,
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Buy with Shop Pay
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
