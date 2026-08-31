import { C } from '../tokens';

export function Divider({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ flex: 1, height: 1, background: C.border2 }} />
      <span style={{ fontSize: 12, color: C.light, whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: C.border2 }} />
    </div>
  );
}
