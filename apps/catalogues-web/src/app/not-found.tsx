import { ErrorState } from '@/components/ui/error-state';

export default function NotFound(): React.ReactElement {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', background: '#fff' }}>
      <ErrorState
        title="Page not found"
        message="The page you're looking for doesn't exist or may have moved."
        homeHref="/studio"
        homeLabel="Go to Studio"
      />
    </div>
  );
}
