import { scopedProjectKey, scopeProjectRef } from "../environment/scoped.ts";
import {
  repositoryGroupingDisplayNameOf,
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type ScopedProjectRef,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";

import type { EnvironmentProject } from "./models.ts";
import { normalizeProjectPathForComparison } from "./projects.ts";

const SCRATCH_PROJECT_SCOPE_KEY = "\0no-project";

export interface ProjectGroupingSettings {
  readonly sidebarProjectGroupingMode: SidebarProjectGroupingMode;
  readonly sidebarProjectGroupingOverrides: Record<string, SidebarProjectGroupingMode>;
}

export type ProjectGroupingMode = SidebarProjectGroupingMode;

export function selectProjectGroupingSettings(settings: ClientSettings): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  };
}

function uniqueNonEmptyValues(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function deriveRepositoryRelativeProjectPath(
  project: Pick<EnvironmentProject, "workspaceRoot" | "repositoryIdentity">,
): string | null {
  const rootPath = project.repositoryIdentity?.rootPath?.trim();
  if (!rootPath) {
    return null;
  }

  const normalizedProjectPath = normalizeProjectPathForComparison(project.workspaceRoot);
  const normalizedRootPath = normalizeProjectPathForComparison(rootPath);
  if (normalizedProjectPath.length === 0 || normalizedRootPath.length === 0) {
    return null;
  }

  if (normalizedProjectPath === normalizedRootPath) {
    return "";
  }

  const separator = normalizedRootPath.includes("\\") ? "\\" : "/";
  const rootPrefix = `${normalizedRootPath}${separator}`;
  if (!normalizedProjectPath.startsWith(rootPrefix)) {
    return null;
  }

  return normalizedProjectPath.slice(rootPrefix.length).replaceAll("\\", "/");
}

export function derivePhysicalProjectKeyFromPath(environmentId: string, cwd: string): string {
  return `${environmentId}:${normalizeProjectPathForComparison(cwd)}`;
}

type ProjectKeySource = Pick<EnvironmentProject, "environmentId" | "workspaceRoot">;

type GroupableProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity" | "isScratch" | "createdAt"
>;

export function derivePhysicalProjectKey(project: ProjectKeySource): string {
  return derivePhysicalProjectKeyFromPath(project.environmentId, project.workspaceRoot);
}

function deriveProjectGroupingOverrideKey(project: ProjectKeySource): string {
  return derivePhysicalProjectKey(project);
}

export function getProjectOrderKey(project: ProjectKeySource): string {
  return derivePhysicalProjectKey(project);
}

function resolveProjectGroupingMode(
  project: ProjectKeySource,
  settings: ProjectGroupingSettings,
): SidebarProjectGroupingMode {
  return (
    settings.sidebarProjectGroupingOverrides?.[deriveProjectGroupingOverrideKey(project)] ??
    settings.sidebarProjectGroupingMode
  );
}

function deriveRepositoryScopedKey(
  project: Pick<EnvironmentProject, "workspaceRoot" | "repositoryIdentity">,
  groupingMode: SidebarProjectGroupingMode,
): string | null {
  const canonicalKey = project.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity)
    : null;
  // A NUL reserves the scratch key namespace outside valid repository identities.
  if (!canonicalKey || canonicalKey.includes("\0")) {
    return null;
  }

  if (groupingMode === "repository") {
    return canonicalKey;
  }

  const relativeProjectPath = deriveRepositoryRelativeProjectPath(project);
  if (relativeProjectPath === null) {
    return canonicalKey;
  }

  return relativeProjectPath.length === 0
    ? canonicalKey
    : `${canonicalKey}::${relativeProjectPath}`;
}

function projectAgeOrder(
  left: Pick<EnvironmentProject, "id" | "createdAt">,
  right: Pick<EnvironmentProject, "id" | "createdAt">,
): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  const delta =
    (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
  if (delta !== 0) return delta;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

// The oldest project on a set of folders keeps the plain key; later ones carry `@id` so adding a duplicate never renames the original.
function indexOldestProjectByBaseKey(
  projects: ReadonlyArray<GroupableProject>,
): Map<string, GroupableProject> {
  const oldest = new Map<string, GroupableProject>();
  for (const project of projects) {
    const baseKey = derivePhysicalProjectKey(project);
    const current = oldest.get(baseKey);
    if (!current || projectAgeOrder(project, current) < 0) oldest.set(baseKey, project);
  }
  return oldest;
}

function isLaterDuplicate(
  project: GroupableProject,
  oldestByBaseKey: ReadonlyMap<string, GroupableProject>,
): boolean {
  const oldest = oldestByBaseKey.get(derivePhysicalProjectKey(project));
  return oldest !== undefined && oldest.id !== project.id;
}

function deriveMemberPhysicalKey(project: GroupableProject, duplicate: boolean): string {
  const baseKey = derivePhysicalProjectKey(project);
  return duplicate ? `${baseKey}@${project.id}` : baseKey;
}

function deriveLogicalProjectKey(
  project: GroupableProject,
  options: {
    readonly groupingMode: SidebarProjectGroupingMode;
    readonly groupScratchProjects: boolean;
    readonly duplicate: boolean;
  },
): string {
  if (options.groupScratchProjects && project.isScratch) return SCRATCH_PROJECT_SCOPE_KEY;
  const baseKey =
    (options.groupingMode === "separate"
      ? null
      : deriveRepositoryScopedKey(project, options.groupingMode)) ??
    derivePhysicalProjectKey(project);
  // A same-folder duplicate is its own row in every grouping mode.
  return options.duplicate ? `${baseKey}@${project.id}` : baseKey;
}

export function deriveLogicalProjectKeyFromSettings(
  project: GroupableProject,
  settings: ProjectGroupingSettings,
  options?: {
    readonly groupScratchProjects?: boolean;
    // Pass every known project so a later same-folder duplicate resolves to its own key.
    readonly projects?: ReadonlyArray<GroupableProject>;
  },
): string {
  return deriveLogicalProjectKey(project, {
    groupingMode: resolveProjectGroupingMode(project, settings),
    groupScratchProjects: options?.groupScratchProjects ?? false,
    duplicate: options?.projects
      ? isLaterDuplicate(project, indexOldestProjectByBaseKey(options.projects))
      : false,
  });
}

export function resolveScratchProjectScopeKey(
  key: string | null,
  projects: ReadonlyArray<GroupableProject>,
  settings: ProjectGroupingSettings = {
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  },
): string | null {
  if (key === null || key === SCRATCH_PROJECT_SCOPE_KEY) return key;
  const oldestByBaseKey = indexOldestProjectByBaseKey(projects);
  const duplicateOf = (project: GroupableProject) => isLaterDuplicate(project, oldestByBaseKey);
  if (
    projects.some(
      (project) =>
        deriveLogicalProjectKey(project, {
          groupingMode: resolveProjectGroupingMode(project, settings),
          groupScratchProjects: true,
          duplicate: duplicateOf(project),
        }) === key,
    )
  ) {
    return key;
  }
  return projects.some((project) => {
    if (!project.isScratch) return false;
    const mode = resolveProjectGroupingMode(project, settings);
    return (
      deriveMemberPhysicalKey(project, duplicateOf(project)) === key ||
      (mode !== "separate" && deriveRepositoryScopedKey(project, mode) === key)
    );
  })
    ? SCRATCH_PROJECT_SCOPE_KEY
    : key;
}

export function deriveProjectGroupLabel(input: {
  readonly representative: Pick<EnvironmentProject, "title" | "repositoryIdentity">;
  readonly members: ReadonlyArray<Pick<EnvironmentProject, "title" | "repositoryIdentity">>;
}): string {
  const sharedTitles = uniqueNonEmptyValues(input.members.map((member) => member.title));
  const sharedDisplayNames = uniqueNonEmptyValues(
    input.members.map((member) =>
      member.repositoryIdentity ? repositoryGroupingDisplayNameOf(member.repositoryIdentity) : null,
    ),
  );
  const sharedRepositoryNames = uniqueNonEmptyValues(
    input.members.map((member) => member.repositoryIdentity?.name),
  );
  const sharedTitle = sharedTitles[0];
  if (
    sharedTitles.length === 1 &&
    sharedTitle !== undefined &&
    !sharedDisplayNames.includes(sharedTitle) &&
    !sharedRepositoryNames.includes(sharedTitle)
  ) {
    return sharedTitle;
  }
  if (sharedDisplayNames.length === 1) {
    return sharedDisplayNames[0]!;
  }

  if (sharedRepositoryNames.length === 1) {
    return sharedRepositoryNames[0]!;
  }

  return input.representative.title;
}

export interface ProjectGroupMember<TProject extends EnvironmentProject = EnvironmentProject> {
  readonly physicalProjectKey: string;
  readonly project: TProject;
}

export interface ProjectGroup<TProject extends EnvironmentProject = EnvironmentProject> {
  readonly key: string;
  readonly label: string;
  readonly representative: TProject;
  readonly members: ReadonlyArray<ProjectGroupMember<TProject>>;
  readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
}

export function buildProjectGroups<TProject extends EnvironmentProject>(input: {
  readonly projects: ReadonlyArray<TProject>;
  readonly settings: ProjectGroupingSettings;
  readonly preferredEnvironmentId?: EnvironmentId | null;
  readonly groupScratchProjects?: boolean;
}): ReadonlyArray<ProjectGroup<TProject>> {
  const oldestByBaseKey = indexOldestProjectByBaseKey(input.projects);
  const groupedMembers = new Map<string, ProjectGroupMember<TProject>[]>();
  const projectRefsByLogicalKey = new Map<string, ScopedProjectRef[]>();
  const seenProjectRefs = new Set<string>();
  for (const project of input.projects) {
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    const projectRefKey = scopedProjectKey(projectRef);
    if (seenProjectRefs.has(projectRefKey)) continue;
    seenProjectRefs.add(projectRefKey);

    // Several projects may share folders; each is its own member.
    const duplicate = isLaterDuplicate(project, oldestByBaseKey);
    const physicalProjectKey = deriveMemberPhysicalKey(project, duplicate);
    const logicalKey = deriveLogicalProjectKey(project, {
      groupingMode: resolveProjectGroupingMode(project, input.settings),
      groupScratchProjects: input.groupScratchProjects ?? false,
      duplicate,
    });
    const member = { physicalProjectKey, project };
    const existingMembers = groupedMembers.get(logicalKey);
    if (existingMembers) {
      existingMembers.push(member);
    } else {
      groupedMembers.set(logicalKey, [member]);
    }
    const existingRefs = projectRefsByLogicalKey.get(logicalKey);
    if (existingRefs) {
      existingRefs.push(projectRef);
    } else {
      projectRefsByLogicalKey.set(logicalKey, [projectRef]);
    }
  }

  const preferredEnvironmentId = input.preferredEnvironmentId ?? null;
  return Array.from(groupedMembers, ([key, members]) => {
    const representative =
      (preferredEnvironmentId
        ? members.find((member) => member.project.environmentId === preferredEnvironmentId)?.project
        : null) ?? members[0]!.project;
    return {
      key,
      label:
        input.groupScratchProjects && representative.isScratch
          ? "No project"
          : members.length > 1
            ? deriveProjectGroupLabel({
                representative,
                members: members.map((member) => member.project),
              })
            : representative.title,
      representative,
      members,
      memberProjectRefs: projectRefsByLogicalKey.get(key) ?? [],
    };
  });
}

export function sortProjectsByGroupOrder<
  TProject extends { readonly id: string; readonly environmentId: string },
>(
  projects: ReadonlyArray<TProject>,
  groups: ReadonlyArray<{ readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef> }>,
): TProject[] {
  const rankByProject = new Map<string, number>();
  groups.forEach((group, rank) => {
    for (const ref of group.memberProjectRefs) {
      const key = `${ref.environmentId}\0${ref.projectId}`;
      if (!rankByProject.has(key)) rankByProject.set(key, rank);
    }
  });
  const rankOf = (project: TProject) =>
    rankByProject.get(`${project.environmentId}\0${project.id}`) ?? groups.length;
  return [...projects].sort((left, right) => rankOf(left) - rankOf(right));
}
