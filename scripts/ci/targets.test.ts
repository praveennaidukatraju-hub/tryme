import { describe, expect, it } from 'vitest';
import { loadTargets, matchAny } from './lib/targets.mts';

describe('loadTargets', () => {
  it('loads the six deployable targets', () => {
    const config = loadTargets('config/ci-targets.json');
    expect(config.schemaVersion).toBe(1);
    expect(config.targets.map((t) => t.name).sort()).toEqual([
      'admin',
      'api',
      'chatbot',
      'dispatcher',
      'shopify-admin',
      'web',
    ]);
  });

  it('maps directories that differ from their target name', () => {
    const config = loadTargets('config/ci-targets.json');
    const byName = new Map(config.targets.map((t) => [t.name, t]));
    expect(byName.get('web')?.dir).toBe('apps/catalogues-web');
    expect(byName.get('web')?.packageName).toBe('@tryme/web');
    expect(byName.get('admin')?.dir).toBe('apps/admin-web');
    expect(byName.get('admin')?.packageName).toBe('@tryme/admin');
    expect(byName.get('shopify-admin')?.dir).toBe('apps/shopify');
    expect(byName.get('shopify-admin')?.packageName).toBe('@tryme/shopify-admin');
  });

  it('declares the separate release surfaces', () => {
    const config = loadTargets('config/ci-targets.json');
    expect(config.separateSurfaces.map((s) => s.dir).sort()).toEqual([
      'apps/saree_catalogue_android',
      'apps/shopify-extension',
      'apps/virtual-tryon-mobile&kiosk_latest',
    ]);
  });

  it('rejects an unsupported schemaVersion', () => {
    expect(() => loadTargets('scripts/ci/__fixtures__/bad-schema.json')).toThrow(
      /schemaVersion must be 1/,
    );
  });

  it('rejects duplicate target directories', () => {
    expect(() => loadTargets('scripts/ci/__fixtures__/duplicate-dir.json')).toThrow(
      /duplicate target dir/,
    );
  });

  it('rejects duplicate target names', () => {
    expect(() => loadTargets('scripts/ci/__fixtures__/duplicate-name.json')).toThrow(
      /duplicate target name/,
    );
  });
});

describe('matchAny', () => {
  it('matches a directory glob', () => {
    expect(matchAny('docs/a/b.md', ['docs/**'])).toBe(true);
    expect(matchAny('docsy/a.md', ['docs/**'])).toBe(false);
  });

  it('matches a root-only extension glob', () => {
    expect(matchAny('README.md', ['*.md'])).toBe(true);
    expect(matchAny('apps/api/README.md', ['*.md'])).toBe(false);
  });

  it('matches an exact path', () => {
    expect(matchAny('pnpm-lock.yaml', ['pnpm-lock.yaml'])).toBe(true);
    expect(matchAny('pnpm-lock.yaml.bak', ['pnpm-lock.yaml'])).toBe(false);
  });
});
