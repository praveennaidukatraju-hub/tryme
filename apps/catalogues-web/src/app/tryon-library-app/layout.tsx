import AuthGate from './AuthGate';

export const metadata = {
  title: 'Try On Library',
  manifest: '/tryon-library-app/manifest.webmanifest',
};

export default function TryonLibraryAppLayout({ children }: { children: React.ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
