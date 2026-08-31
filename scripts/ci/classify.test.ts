import { describe, expect, it } from 'vitest';
import { classify } from './lib/classify.mts';
import { loadTargets } from './lib/targets.mts';
import {
  buildDependentsGraph,
  listWorkspaceManifests,
  readWorkspaceMembers,
} from './lib/workspace.mts';

const config = loadTargets('config/ci-targets.json');
const members = readWorkspaceMembers(listWorkspaceManifests());
const graph = buildDependentsGraph(members);

const run = (changedFiles: string[], fallbackReason?: string) =>
  classify({
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    changedFiles,
    config,
    members,
    graph,
    fallbackReason,
  });

const ALL_SERVICES = ['admin', 'api', 'chatbot', 'dispatcher', 'shopify-admin', 'web'];

describe('documentation changes', () => {
  it('classifies a docs-only change as docsOnly with no services', () => {
    const result = run(['docs/readme.md']);
    expect(result.docsOnly).toBe(true);
    expect(result.services).toEqual([]);
    expect(result.fallbackToAll).toBe(false);
  });

  it('treats root markdown as documentation', () => {
    expect(run(['README.md']).docsOnly).toBe(true);
  });

  it('does not treat markdown inside a service as documentation', () => {
    const result = run(['apps/api/README.md']);
    expect(result.docsOnly).toBe(false);
    expect(result.services).toEqual(['api']);
  });

  it('is not docsOnly when a deleted service file accompanies a docs change', () => {
    const result = run(['docs/readme.md', 'apps/api/src/server.ts']);
    expect(result.docsOnly).toBe(false);
    expect(result.services).toEqual(['api']);
  });
});

describe('per-service directories that differ from the target name', () => {
  it('maps apps/catalogues-web to web', () => {
    expect(run(['apps/catalogues-web/src/app/page.tsx']).services).toEqual(['web']);
  });

  it('maps apps/admin-web to admin', () => {
    expect(run(['apps/admin-web/src/App.tsx']).services).toEqual(['admin']);
  });

  it('maps apps/shopify to shopify-admin', () => {
    expect(run(['apps/shopify/src/main.tsx']).services).toEqual(['shopify-admin']);
  });

  it('maps a service Dockerfile to its own service', () => {
    expect(run(['apps/dispatcher/Dockerfile']).services).toEqual(['dispatcher']);
  });
});

describe('shared packages', () => {
  it('selects all recursive consumers of types', () => {
    const result = run(['packages/types/src/jobs.ts']);
    expect(result.services).toEqual([
      'admin',
      'api',
      'chatbot',
      'dispatcher',
      'shopify-admin',
      'web',
    ]);
    expect(result.changedPackages).toEqual(['@tryme/types']);
  });

  it('selects db consumers and flags migrations', () => {
    const result = run(['packages/db/src/migrations/0117_add_column.sql']);
    expect(result.migrationChanged).toBe(true);
    expect(result.services).toEqual(['api', 'chatbot', 'dispatcher']);
  });

  it('flags the migration journal', () => {
    expect(run(['packages/db/src/migrations/meta/_journal.json']).migrationChanged).toBe(true);
  });

  it('does not flag migrations for an ordinary db source change', () => {
    const result = run(['packages/db/src/schema/jobs.ts']);
    expect(result.migrationChanged).toBe(false);
    expect(result.services).toEqual(['api', 'chatbot', 'dispatcher']);
  });
});

describe('unresolvable diff range (resolveRange fallback)', () => {
  // resolveRange() hits this when it can't compute a base SHA at all (initial
  // push, force-push, or an unresolvable merge-base) — classify() then gets an
  // empty changedFiles list plus a fallbackReason. It already forces
  // fallbackToAll (rebuild every service, since we don't know what changed) —
  // migrationChanged must get the same treatment for the same reason: a
  // production deploy must never skip `db:migrate` just because the detector
  // couldn't compute a diff. This mirrors the two other fallback paths in
  // detect-affected.mts (manual force_all override, and the top-level
  // detector-crash fail-safe), which both already force migrationChanged=true.
  it('forces migrationChanged=true when no diff range could be resolved', () => {
    const result = run([], 'no usable base SHA (initial push or force-push)');
    expect(result.fallbackToAll).toBe(true);
    expect(result.migrationChanged).toBe(true);
  });
});

describe('global and infrastructure paths', () => {
  it('falls back to all services on a lockfile change', () => {
    const result = run(['pnpm-lock.yaml']);
    expect(result.fallbackToAll).toBe(true);
    expect(result.services).toEqual(ALL_SERVICES);
  });

  it('falls back to all services on a .dockerignore change', () => {
    expect(run(['.dockerignore']).services).toEqual(ALL_SERVICES);
  });

  // Infra governs how every running container is wired, so it has to reach
  // production through a full recreate. Flagging it without selecting any
  // service made infra-only merges go green while deploying nothing.
  it('deploys every service on an infrastructure change', () => {
    const result = run(['infra/docker-compose.prod.yml']);
    expect(result.infrastructureChanged).toBe(true);
    expect(result.fallbackToAll).toBe(true);
    expect(result.services).toEqual(ALL_SERVICES);
    expect(result.docsOnly).toBe(false);
  });

  it('flags a CI change without selecting services', () => {
    const result = run(['.github/workflows/ci.yml']);
    expect(result.ciChanged).toBe(true);
    expect(result.services).toEqual([]);
  });

  it('flags a deployment bundle change without selecting services', () => {
    const result = run(['.env.production.example']);
    expect(result.deploymentBundleChanged).toBe(true);
    expect(result.services).toEqual([]);
  });
});

describe('separate release surfaces', () => {
  it('does not deploy for the Shopify theme extension', () => {
    const result = run(['apps/shopify-extension/blocks/widget.liquid']);
    expect(result.services).toEqual([]);
    expect(result.fallbackToAll).toBe(false);
    expect(result.docsOnly).toBe(false);
  });

  it('handles a directory name containing an ampersand', () => {
    const result = run(['apps/virtual-tryon-mobile&kiosk_latest/app/index.tsx']);
    expect(result.services).toEqual([]);
    expect(result.fallbackToAll).toBe(false);
  });

  it('does not deploy for the native Android app, which has no package.json', () => {
    const result = run(['apps/saree_catalogue_android/app/build.gradle.kts']);
    expect(result.services).toEqual([]);
    expect(result.fallbackToAll).toBe(false);
    expect(result.docsOnly).toBe(false);
  });
});

describe('fail-safe behaviour', () => {
  it('falls back to all services for an unmapped path under apps/', () => {
    const result = run(['apps/brand-new-thing/src/index.ts']);
    expect(result.fallbackToAll).toBe(true);
    expect(result.services).toEqual(ALL_SERVICES);
    expect(result.reasons.ALL.join(' ')).toMatch(/unmapped production path/);
  });

  it('falls back to all services for an unmapped top-level path', () => {
    expect(run(['deploy.sh']).fallbackToAll).toBe(true);
  });

  it('falls back to all services when the caller reports an unusable diff range', () => {
    const result = run(['docs/readme.md'], 'force-push: no usable merge base');
    expect(result.fallbackToAll).toBe(true);
    expect(result.docsOnly).toBe(false);
    expect(result.services).toEqual(ALL_SERVICES);
  });

  it('treats an empty diff as docs-only-equivalent and deploys nothing', () => {
    const result = run([]);
    expect(result.services).toEqual([]);
    expect(result.fallbackToAll).toBe(false);
  });
});

describe('test targets', () => {
  it('selects only packages with unit tests wired into CI', () => {
    expect(run(['packages/types/src/jobs.ts']).testTargets).toEqual([
      '@tryme/api',
      '@tryme/dispatcher',
    ]);
  });

  it('selects no test targets for a frontend-only change', () => {
    expect(run(['apps/admin-web/src/App.tsx']).testTargets).toEqual([]);
  });
});

describe('reasons', () => {
  it('records why each service was selected', () => {
    const result = run(['apps/api/src/server.ts', 'packages/types/src/jobs.ts']);
    expect(result.reasons['@tryme/types']).toEqual(['packages/types/src/jobs.ts']);
    expect(result.reasons.api).toEqual(['apps/api/src/server.ts']);
  });

  it('is deterministic for the same input in any order', () => {
    const a = run(['packages/types/src/jobs.ts', 'apps/api/src/server.ts']);
    const b = run(['apps/api/src/server.ts', 'packages/types/src/jobs.ts']);
    expect(a.services).toEqual(b.services);
    expect(a.affectedPackages).toEqual(b.affectedPackages);
  });
});
