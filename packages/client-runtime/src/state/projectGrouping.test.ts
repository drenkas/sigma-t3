import { EnvironmentId, ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import { chooseLoadBalancedEnvironment } from "../load-balancing.ts";
import {
  buildProjectGroups,
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  resolveScratchProjectScopeKey,
  sortProjectsByGroupOrder,
  type ProjectGroupingSettings,
} from "./projectGrouping.ts";

const environmentId = EnvironmentId.make("environment");

describe("load balancing shared project machines", () => {
  const now = 100_000;
  const resources = {
    sampledAt: now,
    cpuUtilization: 0.2,
    cpuCount: 8,
    availableMemoryBytes: 8_000,
    totalMemoryBytes: 16_000,
  };

  it("compares three machines using free capacity and preference", () => {
    const candidates = [
      { environmentId: "busy", resources: { ...resources, cpuUtilization: 0.9 }, weight: 1 },
      { environmentId: "idle", resources, weight: 1 },
      { environmentId: "preferred", resources: { ...resources, cpuCount: 4 }, weight: 3 },
    ];
    expect(chooseLoadBalancedEnvironment(candidates, now)).toBe("preferred");
    expect(chooseLoadBalancedEnvironment(candidates.slice(0, 2), now)).toBe("idle");
  });

  it("rejects stale, unknown, excluded and saturated machines", () => {
    expect(
      chooseLoadBalancedEnvironment(
        [
          {
            environmentId: "stale",
            resources: { ...resources, sampledAt: now - 15_001 },
            weight: 1,
          },
          { environmentId: "unknown", resources: null, weight: 1 },
          {
            environmentId: "no-cpu-sample",
            resources: { ...resources, cpuUtilization: null },
            weight: 1,
          },
          { environmentId: "excluded", resources, weight: 0 },
          {
            environmentId: "cpu-full",
            resources: { ...resources, cpuUtilization: 0.95 },
            weight: 1,
          },
          {
            environmentId: "memory-full",
            resources: { ...resources, availableMemoryBytes: 100 },
            weight: 1,
          },
        ],
        now,
      ),
    ).toBeNull();
  });

  it("uses client receipt time when host clocks differ", () => {
    const candidate = {
      environmentId: "different-clock",
      resources: { ...resources, sampledAt: now + 60_000 },
      receivedAt: now,
      weight: 1,
    };
    expect(chooseLoadBalancedEnvironment([candidate], now)).toBe("different-clock");
    expect(chooseLoadBalancedEnvironment([candidate], now + 15_001)).toBeNull();
  });
});
const repositoryIdentity = {
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote" as const,
    remoteName: "upstream",
    remoteUrl: "https://github.com/t3tools/t3code.git",
  },
  provider: SourceControlProviderKind.make("github"),
  owner: "t3tools",
  name: "t3code",
  displayName: "T3 Code",
};

function makeProject(
  id: string,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function settings(
  mode: ProjectGroupingSettings["sidebarProjectGroupingMode"],
  overrides: ProjectGroupingSettings["sidebarProjectGroupingOverrides"] = {},
): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode: mode,
    sidebarProjectGroupingOverrides: overrides,
  };
}

describe("buildProjectGroups", () => {
  it.each(["repository", "repository_path", "separate"] as const)(
    "keeps scratch project ownership separate by default in %s mode",
    (mode) => {
      const projects = [
        makeProject("scratch-local", "/local/scratch", {
          isScratch: true,
          repositoryIdentity: null,
        }),
        makeProject("scratch-remote", "/remote/scratch", {
          environmentId: EnvironmentId.make("remote"),
          isScratch: true,
          repositoryIdentity: null,
        }),
      ];
      const groups = buildProjectGroups({ projects, settings: settings(mode) });
      expect(groups.map((group) => group.key)).toEqual(projects.map(derivePhysicalProjectKey));
      expect(groups.map((group) => group.memberProjectRefs)).toEqual(
        projects.map((project) => [
          { environmentId: project.environmentId, projectId: project.id },
        ]),
      );
      expect(
        buildProjectGroups({ projects, settings: settings(mode), groupScratchProjects: true }),
      ).toHaveLength(1);
    },
  );

  it.each(["repository", "repository_path", "separate"] as const)(
    "migrates a pre-config %s scratch selection and retains it after the original host is removed",
    (mode) => {
      const local = makeProject("scratch-local", "/local/repo/scratch", {
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/local/repo" },
      });
      const remote = makeProject("scratch-remote", "/remote/scratch", {
        environmentId: EnvironmentId.make("remote"),
        repositoryIdentity: null,
        isScratch: true,
      });
      const groupingSettings = settings(mode);
      const selectedBeforeConfig = deriveLogicalProjectKeyFromSettings(local, groupingSettings);
      const loaded = [{ ...local, isScratch: true as const }, remote];
      const migrated = resolveScratchProjectScopeKey(
        selectedBeforeConfig,
        loaded,
        groupingSettings,
      );
      const scratchKey = buildProjectGroups({
        projects: loaded,
        settings: groupingSettings,
        groupScratchProjects: true,
      })[0]!.key;
      expect(migrated).toBe(scratchKey);
      expect(resolveScratchProjectScopeKey(migrated, [remote], groupingSettings)).toBe(scratchKey);
      expect(
        buildProjectGroups({
          projects: [remote],
          settings: groupingSettings,
          groupScratchProjects: true,
        })[0]?.memberProjectRefs,
      ).toEqual([{ environmentId: remote.environmentId, projectId: remote.id }]);
    },
  );

  it("retains a repository filter that still belongs to an ordinary project", () => {
    const scratch = makeProject("scratch", "/scratch", { isScratch: true });
    const ordinary = makeProject("ordinary", "/ordinary");
    const key = deriveLogicalProjectKeyFromSettings(ordinary, settings("repository"));
    expect(resolveScratchProjectScopeKey(key, [scratch, ordinary])).toBe(key);
  });

  it.each(["repository", "repository_path", "separate"] as const)(
    "coalesces scratch homes in %s mode without merging ordinary same-title projects",
    (mode) => {
      const remoteEnvironmentId = EnvironmentId.make("remote");
      const projects = [
        makeProject("scratch-local", "/local/scratch", {
          title: "No project",
          isScratch: true,
          repositoryIdentity: null,
        }),
        makeProject("scratch-remote", "/remote/scratch", {
          title: "No project",
          environmentId: remoteEnvironmentId,
          isScratch: true,
        }),
        makeProject("scratch-duplicate", "/remote/scratch/", {
          title: "No project",
          environmentId: remoteEnvironmentId,
          isScratch: true,
          repositoryIdentity: null,
          updatedAt: "2026-07-02T00:00:00.000Z",
        }),
        makeProject("ordinary", "/ordinary", { title: "No project" }),
        makeProject("reserved-collision", "/other", {
          title: "No project",
          repositoryIdentity: { ...repositoryIdentity, canonicalKey: "\0no-project" },
        }),
      ];
      const groups = buildProjectGroups({
        projects,
        groupScratchProjects: true,
        settings: settings(mode, { [derivePhysicalProjectKey(projects[0]!)]: "separate" }),
        preferredEnvironmentId: remoteEnvironmentId,
      });
      expect(groups).toHaveLength(3);
      const scratch = groups.find((group) => group.representative.isScratch)!;
      expect(scratch.label).toBe("No project");
      expect(scratch.representative.id).toBe(projects[1]?.id);
      expect(scratch.members).toHaveLength(3);
      expect(scratch.memberProjectRefs).toEqual(
        projects.slice(0, 3).map((project) => ({
          environmentId: project.environmentId,
          projectId: project.id,
        })),
      );
      expect(resolveScratchProjectScopeKey(derivePhysicalProjectKey(projects[1]!), projects)).toBe(
        scratch.key,
      );
      expect(resolveScratchProjectScopeKey(derivePhysicalProjectKey(projects[3]!), projects)).toBe(
        derivePhysicalProjectKey(projects[3]!),
      );
      expect(groups.filter((group) => !group.representative.isScratch)).toHaveLength(2);
    },
  );

  it("preserves every physical clone as a selectable member in repository modes", () => {
    const projects = [
      makeProject("t3code", "/work/t3code"),
      makeProject("t3code-2", "/work/t3code-2"),
      makeProject("t3code-3", "/work/t3code-3"),
    ];

    for (const mode of ["repository", "repository_path"] as const) {
      const groups = buildProjectGroups({ projects, settings: settings(mode) });
      expect(groups).toHaveLength(1);
      expect(groups[0]?.members.map((member) => member.project.id)).toEqual([
        "t3code",
        "t3code-2",
        "t3code-3",
      ]);
      expect(groups[0]?.memberProjectRefs).toHaveLength(3);
    }
  });

  it("keeps a fork apart from its upstream checkout and labels it by its own remote", () => {
    const fork = makeProject("fork", "/work/t3code-fork", {
      repositoryIdentity: {
        ...repositoryIdentity,
        origin: {
          canonicalKey: "github.com/julius/t3code-fork",
          displayName: "julius/t3code-fork",
        },
      },
    });
    const forkWorktree = makeProject("fork-2", "/work/t3code-fork-2", {
      repositoryIdentity: fork.repositoryIdentity,
    });
    const projects = [makeProject("t3code", "/work/t3code"), fork, forkWorktree];

    const groups = buildProjectGroups({ projects, settings: settings("repository") });
    expect(groups.map((group) => group.key)).toEqual([
      "github.com/t3tools/t3code",
      "github.com/julius/t3code-fork",
    ]);
    expect(groups[1]?.members.map((member) => member.project.id)).toEqual(["fork", "fork-2"]);
    expect(groups[1]?.label).toBe("julius/t3code-fork");
  });

  it("applies a physical-project override without dropping its siblings", () => {
    const first = makeProject("t3code", "/work/t3code");
    const second = makeProject("t3code-2", "/work/t3code-2");
    const third = makeProject("t3code-3", "/work/t3code-3");
    const groups = buildProjectGroups({
      projects: [first, second, third],
      settings: settings("repository", {
        [derivePhysicalProjectKey(second)]: "separate",
      }),
    });

    expect(groups).toHaveLength(2);
    expect(groups.flatMap((group) => group.members.map((member) => member.project.id))).toEqual([
      "t3code",
      "t3code-3",
      "t3code-2",
    ]);
  });

  it.each(["repository", "repository_path", "separate"] as const)(
    "keeps every project on one folder as its own row in %s mode",
    (mode) => {
      const first = makeProject("first", "/work/t3code");
      const second = makeProject("second", "/work/t3code/");
      const third = makeProject("third", "/work/t3code");
      const sibling = makeProject("sibling", "/work/t3code-2");

      const groups = buildProjectGroups({
        projects: [first, second, third, sibling],
        settings: settings(mode),
      });
      const members = groups.flatMap((group) => group.members);
      expect(new Set(members.map((member) => member.physicalProjectKey)).size).toBe(4);
      expect(new Set(groups.map((group) => group.key)).size).toBe(groups.length);
      for (const id of ["second", "third"]) {
        const group = groups.find((candidate) => candidate.memberProjectRefs[0]?.projectId === id);
        expect(group?.members.map((member) => member.project.id)).toEqual([id]);
      }
      const original = groups.find((group) =>
        group.members.some((member) => member.project.id === "first"),
      );
      expect(original?.members.map((member) => member.project.id)).not.toContain("second");
      expect(original?.members.map((member) => member.project.id)).not.toContain("third");
    },
  );

  it("keeps a same-folder duplicate out of the original's group and apart from a sibling checkout", () => {
    const first = makeProject("first", "/work/t3code");
    const duplicate = makeProject("duplicate", "/work/t3code/", {
      createdAt: "2026-07-02T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [first, duplicate, sibling],
      settings: settings("repository"),
    });
    expect(groups.map((group) => group.members.map((member) => member.project.id))).toEqual([
      ["first", "sibling"],
      ["duplicate"],
    ]);
    expect(groups[1]?.key).toBe("github.com/t3tools/t3code@duplicate");
  });

  it("lets the oldest project on a folder keep its plain key when a duplicate appears", () => {
    const original = makeProject("zzz-original", "/work/app", {
      repositoryIdentity: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const duplicate = makeProject("aaa-duplicate", "/work/app", {
      repositoryIdentity: null,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    const tiedA = makeProject("tie-a", "/work/tied", { repositoryIdentity: null });
    const tiedB = makeProject("tie-b", "/work/tied", { repositoryIdentity: null });

    const groups = buildProjectGroups({
      projects: [duplicate, original, tiedB, tiedA],
      settings: settings("repository"),
    });
    const keyOf = (id: string) =>
      groups.flatMap((group) => group.members).find((member) => member.project.id === id)
        ?.physicalProjectKey;
    expect(keyOf("zzz-original")).toBe("environment:/work/app");
    expect(keyOf("aaa-duplicate")).toBe("environment:/work/app@aaa-duplicate");
    expect(keyOf("tie-a")).toBe("environment:/work/tied");
    expect(keyOf("tie-b")).toBe("environment:/work/tied@tie-b");
    expect(groups.find((group) => group.members[0]?.project.id === "zzz-original")?.key).toBe(
      "environment:/work/app",
    );
  });

  it("resolves a duplicate's own logical key from a single project when its siblings are given", () => {
    const original = makeProject("original", "/work/t3code");
    const duplicate = makeProject("duplicate", "/work/t3code", {
      createdAt: "2026-07-02T00:00:00.000Z",
    });
    const projects = [original, duplicate];
    const groupingSettings = settings("repository");
    const groups = buildProjectGroups({ projects, settings: groupingSettings });

    expect(deriveLogicalProjectKeyFromSettings(original, groupingSettings, { projects })).toBe(
      groups[0]?.key,
    );
    expect(deriveLogicalProjectKeyFromSettings(duplicate, groupingSettings, { projects })).toBe(
      groups[1]?.key,
    );
    expect(resolveScratchProjectScopeKey(groups[1]!.key, projects, groupingSettings)).toBe(
      groups[1]!.key,
    );
  });

  it("groups same-folder projects by their own repository identity", () => {
    const otherIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/t3tools/other-repository",
      name: "other-repository",
      displayName: "Other Repository",
    };
    const first = makeProject("first", "/work/t3code");
    const second = makeProject("second", "/work/t3code/", { repositoryIdentity: otherIdentity });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [first, second, sibling],
      settings: settings("repository"),
    });
    expect(groups.map((group) => group.members.map((member) => member.project.id))).toEqual([
      ["first", "sibling"],
      ["second"],
    ]);
  });
});

describe("sortProjectsByGroupOrder", () => {
  const remote = EnvironmentId.make("remote");
  const ref = (projectId: string, env = environmentId) => ({
    environmentId: env,
    projectId: ProjectId.make(projectId),
  });
  const project = (id: string, env: string = environmentId) => ({ id, environmentId: env });

  it("tells the same project id on two environments apart", () => {
    const sorted = sortProjectsByGroupOrder(
      [project("shared"), project("shared", remote)],
      [{ memberProjectRefs: [ref("shared", remote)] }, { memberProjectRefs: [ref("shared")] }],
    );
    expect(sorted.map((entry) => entry.environmentId)).toEqual([remote, environmentId]);
  });
});
