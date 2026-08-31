import { matchAny, type TargetsConfig } from './targets.mts';
import { recursiveConsumers, type WorkspaceMember } from './workspace.mts';

export interface DetectResult {
  schemaVersion: 1;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  changedPackages: string[];
  affectedPackages: string[];
  services: string[];
  testTargets: string[];
  migrationChanged: boolean;
  deploymentBundleChanged: boolean;
  infrastructureChanged: boolean;
  ciChanged: boolean;
  docsOnly: boolean;
  fallbackToAll: boolean;
  reasons: Record<string, string[]>;
}

export interface ClassifyInput {
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  config: TargetsConfig;
  members: WorkspaceMember[];
  graph: Map<string, string[]>;
  fallbackReason?: string;
}

const MIGRATION_PREFIX = 'packages/db/src/migrations/';

export function classify(input: ClassifyInput): DetectResult {
  const { config, members, graph } = input;

  const result: DetectResult = {
    schemaVersion: 1,
    baseSha: input.baseSha,
    headSha: input.headSha,
    changedFiles: [...input.changedFiles].sort(),
    changedPackages: [],
    affectedPackages: [],
    services: [],
    testTargets: [],
    migrationChanged: false,
    deploymentBundleChanged: false,
    infrastructureChanged: false,
    ciChanged: false,
    docsOnly: false,
    fallbackToAll: false,
    reasons: {},
  };

  const addReason = (key: string, why: string): void => {
    const list = (result.reasons[key] ??= []);
    if (!list.includes(why)) list.push(why);
  };

  if (input.fallbackReason) {
    result.fallbackToAll = true;
    // No diff range means no visibility into whether a migration was added —
    // mirrors the force_all and detector-crash fallbacks in detect-affected.mts,
    // which both already force this for the same reason: a deploy must never
    // skip `db:migrate` just because the detector couldn't compute a diff.
    result.migrationChanged = true;
    addReason('ALL', input.fallbackReason);
  }

  const changedPackages = new Set<string>();
  let sawNonDocsPath = false;

  for (const file of result.changedFiles) {
    if (matchAny(file, config.docsPaths)) {
      addReason('docs', file);
      continue;
    }

    sawNonDocsPath = true;

    if (matchAny(file, config.globalRebuildPaths)) {
      result.fallbackToAll = true;
      addReason('ALL', file);
      continue;
    }

    const surface = config.separateSurfaces.find((s) => file.startsWith(`${s.dir}/`));
    if (surface) {
      addReason('separate-surface', file);
      continue;
    }

    if (file.startsWith(MIGRATION_PREFIX)) {
      result.migrationChanged = true;
      // No `continue` here: the same file must also match a target/member below
      // so its package (and recursive consumers) still get selected for deploy.
    }

    if (matchAny(file, config.ciPaths)) {
      result.ciChanged = true;
      addReason('ci', file);
      continue;
    }

    // Infra covers the prod compose file, the cloudflared configs and the Alloy
    // config — all of which govern how the running containers are wired, so a
    // change here only reaches production once every service is recreated.
    // Selecting all services (rather than merely flagging) keeps prod from
    // drifting away from the repo: previously this `continue`d without picking
    // any target, so an infra-only merge went green and deployed nothing.
    if (matchAny(file, config.infraPaths)) {
      result.infrastructureChanged = true;
      result.fallbackToAll = true;
      addReason('ALL', file);
      continue;
    }

    if (matchAny(file, config.deploymentBundlePaths)) {
      result.deploymentBundleChanged = true;
      addReason('deployment-bundle', file);
      continue;
    }

    // Targets are checked before generic workspace members: a target directory
    // is also a workspace member, and the target mapping is the specific one.
    const target = config.targets.find((t) => file.startsWith(`${t.dir}/`));
    if (target) {
      changedPackages.add(target.packageName);
      addReason(target.name, file);
      continue;
    }

    const member = members.find((m) => file.startsWith(`${m.dir}/`));
    if (member) {
      changedPackages.add(member.name);
      addReason(member.name, file);
      continue;
    }

    result.fallbackToAll = true;
    addReason('ALL', `unmapped production path: ${file}`);
  }

  result.docsOnly = !sawNonDocsPath && !result.fallbackToAll && result.changedFiles.length > 0;

  const affected = new Set<string>(changedPackages);
  for (const pkg of changedPackages) {
    for (const consumer of recursiveConsumers(graph, pkg)) affected.add(consumer);
  }

  const targetByPackage = new Map(config.targets.map((t) => [t.packageName, t.name]));

  if (result.fallbackToAll) {
    result.affectedPackages = members.map((m) => m.name).sort();
    result.services = config.targets.map((t) => t.name).sort();
  } else {
    result.affectedPackages = [...affected].sort();
    result.services = [...affected]
      .map((pkg) => targetByPackage.get(pkg))
      .filter((name): name is string => Boolean(name))
      .sort();
  }

  result.changedPackages = [...changedPackages].sort();

  const testable = new Set(config.testablePackages);
  result.testTargets = result.affectedPackages.filter((pkg) => testable.has(pkg));

  return result;
}
