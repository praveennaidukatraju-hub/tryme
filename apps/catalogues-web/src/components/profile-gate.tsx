'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { ProfileCompletionModal } from './profile-completion-modal';

interface MeResponse {
  email: string | null;
  phone: string | null;
  companyName: string | null;
}

export function ProfileGate({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: () => api.get('/v1/me'),
    retry: false,
  });

  const complete = Boolean(data?.phone && /^\d{10}$/.test(data.phone) && data?.email);

  if (isLoading && !data) {
    return <div style={{ flex: 1, background: '#fff' }} />;
  }

  return (
    <>
      {children}
      <ProfileCompletionModal
        open={Boolean(data && !complete)}
        email={data?.email ?? null}
        phone={data?.phone ?? null}
        companyName={data?.companyName ?? null}
      />
    </>
  );
}
