import { AppShell } from '@/components/app-shell';
import { JobStreamProvider } from '@/components/job-stream-provider';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <JobStreamProvider>
      <AppShell>{children}</AppShell>
    </JobStreamProvider>
  );
}
