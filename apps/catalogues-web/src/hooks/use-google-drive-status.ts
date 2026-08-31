import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface GoogleDriveStatus {
  status: 'NOT_CONNECTED' | 'CONNECTED' | 'REAUTH_REQUIRED';
  googleEmail: string | null;
}

export function useGoogleDriveStatus() {
  return useQuery({
    queryKey: ['google-drive-status'],
    queryFn: () => api.get<GoogleDriveStatus>('/v1/integrations/google-drive/status'),
    staleTime: 60_000,
  });
}
