import { statusBadge } from '../lib/data';

export function StatusBadge({ status, mono }: { status: string; mono?: boolean }) {
  const [variant, label] = statusBadge(status);
  return <span className={`badge dot ${variant} ${mono ? 'mono' : ''}`}>{label}</span>;
}
