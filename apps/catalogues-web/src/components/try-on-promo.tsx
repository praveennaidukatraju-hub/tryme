'use client';

import { Play } from 'lucide-react';
import { useState } from 'react';
import { FaAndroid } from 'react-icons/fa';
import { extractYoutubeId } from '@/lib/youtube';
import { C, grad } from './tokens';

const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=tryme.nice.interactive';

const DEMO_VIDEO_URL = 'https://youtu.be/bEfqH2V2FDs?si=4UlcPKa87JpdIudW';

/** Android app promo — shown in the Try-On page's top bar, next to the
 * phone/support/user-menu cluster. Lead-in copy plus a link styled like
 * GradBtn (components/ui/grad-btn.tsx), the app's standard primary button,
 * but as an <a> (external link, not an in-page action). */
export function GetAppButton() {
  return (
    <div
      className="get-app-btn"
      style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 16 }}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @media (max-width: 1023px) {
              .get-app-btn {
                margin-right: 8px !important;
              }
              .get-app-btn a {
                padding: 0 10px !important;
              }
            }
            /* Below 640px the top bar is already tight (hamburger, title,
               support, credits, avatar) — keep the promo as an icon-only
               button instead of dropping it, so it stays reachable. */
            @media (max-width: 639px) {
              .get-app-btn {
                margin-right: 4px !important;
                gap: 0 !important;
              }
              .get-app-btn a {
                width: 34px !important;
                height: 34px !important;
                padding: 0 !important;
              }
            }
          `,
        }}
      />
      <span
        className="hide-mobile-tablet"
        style={{ fontSize: 14, fontWeight: 600, color: C.text, whiteSpace: 'nowrap' }}
      >
        Get Android App
      </span>
      <a
        href={PLAY_STORE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-hover-opacity"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          height: 38,
          padding: '0 16px',
          boxSizing: 'border-box',
          borderRadius: 8,
          fontFamily: 'inherit',
          fontWeight: 600,
          fontSize: 14,
          whiteSpace: 'nowrap',
          background: grad,
          color: C.white,
          border: 'none',
          textDecoration: 'none',
          boxShadow: '0 4px 12px rgba(245,92,122,0.28)',
          flexShrink: 0,
        }}
      >
        <FaAndroid size={16} />
        <span className="hide-mobile-tablet">Download App</span>
      </a>
    </div>
  );
}

/** Bottom-of-page "how it works" video — click-to-play YouTube embed, same
 * thumbnail/play-button pattern as the Tutorials page. Sized to roughly a
 * quarter of the container width rather than stretching full-width. */
export function DemoVideoSection({ youtubeUrl = DEMO_VIDEO_URL }: { youtubeUrl?: string }) {
  const [playing, setPlaying] = useState(false);
  const videoId = extractYoutubeId(youtubeUrl);
  const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

  return (
    <div
      className="demo-video-section"
      style={{
        background: C.white,
        borderRadius: 16,
        border: 'none',
        padding: '20px',
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 12,
        boxShadow: '0 8px 30px rgba(0,0,0,0.05)',
        margin: '0 28px 40px',
        maxWidth: '100%',
        boxSizing: 'border-box',
      }}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @media (max-width: 639px) {
              .demo-video-section {
                margin-left: 16px !important;
                margin-right: 16px !important;
                padding: 14px !important;
              }
            }
            @media (min-width: 640px) and (max-width: 1023px) {
              .demo-video-section {
                margin-left: 20px !important;
                margin-right: 20px !important;
              }
            }
          `,
        }}
      />
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>Demo video</div>
        <div style={{ fontSize: 12, color: C.mid, marginTop: 2 }}>See Try-On in action</div>
      </div>

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: same pattern as the Tutorials page card */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same pattern as the Tutorials page card */}
      <div
        style={{
          position: 'relative',
          width: 560,
          maxWidth: '100%',
          aspectRatio: '16 / 9',
          borderRadius: 12,
          overflow: 'hidden',
          background: C.bg,
          cursor: playing ? 'default' : 'pointer',
        }}
        onClick={() => {
          if (!playing) setPlaying(true);
        }}
      >
        {playing ? (
          <iframe
            width="100%"
            height="100%"
            // origin is required by some videos' embed player to validate the
            // requesting site — omitting it is a common cause of YouTube's
            // "Error 153: video player configuration error" even when
            // embedding is allowed for the video. Only reachable after a
            // client-side click, so window is always defined here.
            src={`https://www.youtube.com/embed/${videoId}?autoplay=1&origin=${encodeURIComponent(window.location.origin)}`}
            title="Try-On demo video"
            frameBorder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            style={{ position: 'absolute', inset: 0 }}
          />
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {/* biome-ignore lint/performance/noImgElement: youtube thumbnail */}
            <img
              src={thumbnailUrl}
              alt="Try-On demo video"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(0,0,0,0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: '50%',
                  background: grad,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
                }}
              >
                <Play size={26} color="#fff" fill="#fff" />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
