import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  appendProjectFolder,
  findExistingAddProject,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  MAX_PROJECT_FOLDERS,
  normalizePastedCloneUrl,
  uniqueProjectTitle,
} from "./projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

describe("add project shared logic", () => {
  it("routes owner/repository shorthand to GitHub over HTTPS", () => {
    expect(normalizePastedCloneUrl("imputnet/helium")).toBe(
      "https://github.com/imputnet/helium.git",
    );
    expect(normalizePastedCloneUrl("  pingdotgg/t3code  ")).toBe(
      "https://github.com/pingdotgg/t3code.git",
    );
  });

  it("keeps explicit clone URLs and local paths unchanged", () => {
    expect(normalizePastedCloneUrl("https://gitlab.com/group/project.git")).toBe(
      "https://gitlab.com/group/project.git",
    );
    expect(normalizePastedCloneUrl("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(normalizePastedCloneUrl("group/subgroup/project")).toBe("group/subgroup/project");
    expect(normalizePastedCloneUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });

  it("uses HTTPS for repositories selected through a provider", () => {
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("github"),
        url: "https://github.com/imputnet/helium",
        sshUrl: "git@github.com:imputnet/helium.git",
      }),
    ).toBe("https://github.com/imputnet/helium");
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("forgejo"),
        url: "https://forgejo.example.test:8443/owner/repo.git",
        sshUrl: "ssh://git@forgejo.example.test:2222/owner/repo.git",
      }),
    ).toBe("https://forgejo.example.test:8443/owner/repo.git");
  });

  it("derives the clone folder name from any pasted clone URL", () => {
    expect(getCloneDirectoryName("https://github.com/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("ssh://git@github.com:22/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://user@bitbucket.org/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://dev.azure.com/org/project/_git/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo.git?ref=main#readme")).toBe("repo");
    expect(getCloneDirectoryName("/srv/git/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("C:\\src\\repo.git")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:repo.git")).toBe("repo");
    expect(getCloneDirectoryName("  https://github.com/owner/repo.git  ")).toBe("repo");
  });

  it("keeps a numeric repository name that sits on a path", () => {
    expect(getCloneDirectoryName("https://github.com/acme/123.git")).toBe("123");
    expect(getCloneDirectoryName("https://github.com/acme/123")).toBe("123");
    expect(getCloneDirectoryName("git@github.com:acme/123.git")).toBe("123");
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        environmentId: env,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })?.id).toBe(
      "project",
    );
  });

  it("ignores projects that have additional folders", () => {
    const env = EnvironmentId.make("env");
    const projects: EnvironmentProject[] = [
      {
        environmentId: env,
        id: ProjectId.make("folders"),
        title: "Repo + api",
        workspaceRoot: "/repo",
        additionalWorkspaceRoots: ["/api"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })).toBeNull();
    expect(
      findExistingAddProject({
        projects: [{ ...projects[0]!, additionalWorkspaceRoots: [] }],
        environmentId: env,
        path: "/repo",
      })?.id,
    ).toBe("folders");
  });
});

describe("appendProjectFolder", () => {
  it("appends in pick order and ignores a folder already picked", () => {
    const first = appendProjectFolder([], "/work/app");
    expect(first).toEqual({ folders: ["/work/app"], status: "added" });
    const second = appendProjectFolder(first.folders, "/work/api");
    expect(second.folders).toEqual(["/work/app", "/work/api"]);
    expect(appendProjectFolder(second.folders, "/work/app/")).toEqual({
      folders: ["/work/app", "/work/api"],
      status: "duplicate",
    });
  });

  it("stops at one working folder plus twenty additional folders", () => {
    const full = Array.from({ length: MAX_PROJECT_FOLDERS }, (_, index) => `/work/${index}`);
    expect(appendProjectFolder(full, "/work/extra")).toEqual({ folders: full, status: "full" });
  });
});

describe("uniqueProjectTitle", () => {
  it("keeps an unused title", () => {
    expect(uniqueProjectTitle("app", [])).toBe("app");
    expect(uniqueProjectTitle("app", ["api", "app 2"])).toBe("app");
  });

  it("numbers from 2 and takes the first free number, ignoring case and padding", () => {
    expect(uniqueProjectTitle("app", ["App "])).toBe("app 2");
    expect(uniqueProjectTitle("app", ["app", "APP 2", " app 3 "])).toBe("app 4");
    expect(uniqueProjectTitle("app", ["app", "app 3"])).toBe("app 2");
  });
});
