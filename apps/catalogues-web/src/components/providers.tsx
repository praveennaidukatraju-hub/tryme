'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000, // 5 min — most catalog/model/profile data is stable
            gcTime: 30 * 60 * 1000, // keep cached pages warm for instant revisits
            refetchOnWindowFocus: false, // no surprise refetch jank on tab refocus
            refetchOnReconnect: false,
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
