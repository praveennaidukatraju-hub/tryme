'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api } from '@/lib/api';

function WidgetLinkCompleteInner(): React.ReactElement {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'linking' | 'done' | 'error'>('linking');

  useEffect(() => {
    const origin = searchParams.get('origin');
    const nonce = searchParams.get('nonce');
    if (!origin || !nonce || !window.opener) {
      setStatus('error');
      return;
    }

    (async () => {
      try {
        const { code } = await api.post<{ code: string }>('/v1/shopify/customer/account/link', {});
        window.opener.postMessage({ type: 'tryme-widget-link', code, nonce }, origin);
        setStatus('done');
        setTimeout(() => window.close(), 800);
      } catch {
        setStatus('error');
      }
    })();
  }, [searchParams]);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <p>
        {status === 'linking' && 'Linking your account\u2026'}
        {status === 'done' && 'Linked! You can close this window.'}
        {status === 'error' &&
          'Something went wrong \u2014 please close this window and try again.'}
      </p>
    </div>
  );
}

export default function WidgetLinkCompletePage(): React.ReactElement {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh' }} />}>
      <WidgetLinkCompleteInner />
    </Suspense>
  );
}
