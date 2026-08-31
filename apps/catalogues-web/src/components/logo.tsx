const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function Logo({ small }: { small?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {/* biome-ignore lint/performance/noImgElement: logo SVG */}
      <img
        src={`${BASE}/assets/logo.svg`}
        alt=""
        style={{ height: small ? 24 : 28, width: 'auto' }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {/* biome-ignore lint/performance/noImgElement: logo text SVG */}
      <img
        src={`${BASE}/assets/logo-text.svg`}
        alt="Ai Vastra"
        style={{ height: small ? 32 : 38, width: 'auto' }}
      />
    </div>
  );
}

export function LogoAuth() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {/* biome-ignore lint/performance/noImgElement: auth logo SVG */}
      <img src={`${BASE}/assets/logo.svg`} alt="" style={{ height: 32, width: 'auto' }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {/* biome-ignore lint/performance/noImgElement: auth logo text SVG */}
      <img
        src={`${BASE}/assets/logo-text.svg`}
        alt="Ai Vastra"
        style={{ height: 34, width: 'auto' }}
      />
    </div>
  );
}
