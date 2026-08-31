'use client';
import Link from 'next/link';
import { use } from 'react';
import { ArrowLeft } from '@/components/icons';
import { C } from '@/components/tokens';
import { TopBar } from '@/components/topbar';
import { ComingSoon } from '@/components/ui/coming-soon';

export default function ViewAssetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.ReactElement {
  use(params);
  return (
    <>
      <TopBar
        lead={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Link
              href="/my-products"
              style={{ color: C.mid, display: 'flex', textDecoration: 'none' }}
            >
              <ArrowLeft />
            </Link>
            <div style={{ fontWeight: 700, fontSize: 18, color: C.text }}>Asset Details</div>
          </div>
        }
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
        <ComingSoon
          title="Asset details"
          message="A detailed view of each uploaded garment — including the catalogues it's used in — is on the way."
        />
      </div>
    </>
  );
}
