import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as RepositoryTasks from "./RepositoryTasks.ts";
import { forkParked } from "../serverActivation.ts";

export class RepositoryTaskReactor extends Context.Service<
  RepositoryTaskReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/repositoryTasks/RepositoryTaskReactor") {}

const make = Effect.gen(function* () {
  const events = yield* EventSink.EventSinkV2;
  const tasks = yield* RepositoryTasks.RepositoryTasks;
  const start = Effect.fn("RepositoryTaskReactor.start")(function* () {
    const afterSequence = yield* events.latestSequence();
    yield* tasks.recover;
    // Only T3 starts providers. This reactor delivers persisted results between ordinary roots.
    yield* forkParked(
      events.stream({ afterSequence }).pipe(
        Stream.filter(({ event }) =>
          [
            "run.created",
            "run.updated",
            "subagent.updated",
            "runtime-request.updated",
            "provider-thread.updated",
            "thread.metadata-updated",
            "context-transfer.created",
            "context-transfer.updated",
          ].includes(event.type),
        ),
        Stream.runForEach(({ event }) =>
          tasks.taskIdsForThread(event.threadId).pipe(
            Effect.flatMap((ids) =>
              Effect.forEach(ids, (id) => tasks.reconcile(id), { discard: true }),
            ),
            Effect.andThen(tasks.notifyChanged),
            Effect.catch(() =>
              Effect.logWarning(
                "Repository task result delivery failed; the task requires recovery",
                { threadId: event.threadId },
              ),
            ),
          ),
        ),
        Effect.orDie,
      ),
    );
  }, Effect.orDie);
  return { start };
});
export const layer = Layer.effect(RepositoryTaskReactor, make);
