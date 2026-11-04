import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { newProjectId } from "~/lib/utils";
import { projectEnvironment } from "~/state/projects";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

export interface CreateAndOpenProjectInput {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly additionalWorkspaceRoots: ReadonlyArray<string>;
  readonly createWorkspaceRootIfMissing: boolean;
  readonly title?: string;
  readonly description?: string;
}

/** `created-not-opened` means the project exists, so a caller must not create it again. */
export type CreateAndOpenProjectOutcome =
  | { readonly status: "opened"; readonly projectId: ProjectId }
  | { readonly status: "created-not-opened"; readonly projectId: ProjectId }
  | { readonly status: "not-created" };

function toastFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/** Creates a project, then lands on a new thread in it. Failures are toasted here. */
export function useCreateAndOpenProject() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  return async (input: CreateAndOpenProjectInput): Promise<CreateAndOpenProjectOutcome> => {
    if (!readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Cannot add project",
          description: "This connection cannot add projects.",
        }),
      );
      return { status: "not-created" };
    }
    const projectId = newProjectId();
    const createResult = await createProject({
      environmentId: input.environmentId,
      input: {
        projectId,
        title: input.title ?? inferProjectTitleFromPath(input.workspaceRoot),
        workspaceRoot: input.workspaceRoot,
        createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing,
        ...(input.additionalWorkspaceRoots.length > 0
          ? { additionalWorkspaceRoots: input.additionalWorkspaceRoots }
          : {}),
        ...(input.description === undefined ? {} : { description: input.description }),
        defaultModelSelection: null,
      },
    });
    if (createResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(createResult)) {
        toastFailure("Failed to add project", squashAtomCommandFailure(createResult));
      }
      return { status: "not-created" };
    }

    const navigationResult = await settlePromise(() =>
      handleNewThread(scopeProjectRef(input.environmentId, projectId)),
    );
    if (navigationResult._tag === "Failure") {
      toastFailure(
        "Project added, but it did not open",
        squashAtomCommandFailure(navigationResult),
      );
      return { status: "created-not-opened", projectId };
    }
    return { status: "opened", projectId };
  };
}
