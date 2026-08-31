'use client';

import { ExternalLink } from 'lucide-react';
import { C } from '@/components/tokens';
import { TopBar } from '@/components/topbar';
import { KeysPanel } from './KeysPanel';
import { UsagePanel } from './UsagePanel';

// Same API host + same fallback as the shared fetch wrapper (@/lib/api) — see
// apps/catalogues-web/src/lib/api.ts. This link points at the Fastify API's
// own Swagger UI (apps/api/src/server.ts, routePrefix '/v1/dev/docs'), not a
// frontend route, so NEXT_PUBLIC_BASE_PATH does not apply here.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const CURL_EXAMPLE = `curl -X POST ${API_URL}/v1/dev/tryon \\
  -H "Authorization: Bearer sk_live_..." \\
  -F person=@person.jpg \\
  -F garment=@garment.jpg \\
  -F category=upper`;

function QuickstartPanel() {
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: 24,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: C.text, margin: 0 }}>Quickstart</h3>
          <p style={{ fontSize: 13, color: C.mid, margin: '4px 0 0' }}>
            Create an API key below, then call the tryon endpoint directly.
          </p>
        </div>
        <a
          href={`${API_URL}/v1/dev/docs`}
          target="_blank"
          rel="noreferrer"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            fontWeight: 600,
            color: C.pink,
            textDecoration: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Full API docs <ExternalLink size={14} />
        </a>
      </div>
      <pre
        style={{
          margin: 0,
          padding: '14px 16px',
          borderRadius: 8,
          background: C.dark,
          color: C.onDark,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 12.5,
          lineHeight: 1.55,
          overflowX: 'auto',
          boxSizing: 'border-box',
        }}
      >
        {CURL_EXAMPLE}
      </pre>
    </div>
  );
}

export default function DevelopersPage(): React.ReactElement {
  return (
    <>
      <TopBar
        title="Developers"
        subtitle="Manage API keys and monitor your virtual tryon API usage."
      />
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px 28px',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        <QuickstartPanel />
        <KeysPanel />
        <UsagePanel />
      </div>
    </>
  );
}
