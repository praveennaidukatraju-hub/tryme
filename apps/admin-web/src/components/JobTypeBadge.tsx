import { jobTypeBadge } from '../lib/data';

export function JobTypeBadge({ jobType }: { jobType?: string | null }) {
  if (!jobType) return <span className="mono sub">—</span>;
  const [variant, label] = jobTypeBadge(jobType);
  return <span className={`badge dot ${variant}`}>{label}</span>;
}
