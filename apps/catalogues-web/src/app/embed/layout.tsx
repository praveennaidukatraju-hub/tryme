import { JobStreamProvider } from '@/components/job-stream-provider';
import { C } from '@/components/tokens';

// No Sidebar/TopBar/ChatWidget/ProfileGate here — this route group renders
// full-bleed inside a same-origin <iframe> hosted by /sellio. It still
// needs JobStreamProvider because the embedded wizard's GenerationPanel
// subscribes to job-status SSE events via useJobStream.
export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <JobStreamProvider>
      <div style={{ minHeight: '100vh', background: C.white, boxSizing: 'border-box' }}>
        {children}
      </div>
    </JobStreamProvider>
  );
}
