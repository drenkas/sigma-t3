import { type ThreadId, RepositoryTaskError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface WorkspacePreparationObserverService {
  readonly beforeRelease: <A, E, R>(
    threadId: ThreadId,
    cwd: string,
    release: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | RepositoryTaskError, R>;
}

export class WorkspacePreparationObserver extends Context.Reference<
  WorkspacePreparationObserverService | undefined
>("t3/orchestration-v2/WorkspacePreparationObserver", { defaultValue: () => undefined }) {}
