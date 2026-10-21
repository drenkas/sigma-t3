import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";

import { RepositoryTasksPage } from "../components/repositoryTasks/RepositoryTasksPage";

function RepositoryTasksRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/repository-tasks" });
  return (
    <RepositoryTasksPage
      {...(search.taskId ? { taskId: search.taskId } : {})}
      {...(search.taskEnvironmentId
        ? { environmentId: search.taskEnvironmentId as EnvironmentId }
        : {})}
      onTaskChange={(taskId, environmentId) =>
        void navigate({
          search: (previous) => {
            const {
              taskId: _currentTaskId,
              taskEnvironmentId: _currentEnvironmentId,
              ...rest
            } = previous;
            return {
              ...rest,
              ...(environmentId ? { taskEnvironmentId: environmentId } : {}),
              ...(taskId ? { taskId } : {}),
            };
          },
        })
      }
    />
  );
}

export const Route = createFileRoute("/_chat/repository-tasks")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.taskId === "string" ? { taskId: search.taskId } : {}),
    ...(typeof search.taskEnvironmentId === "string"
      ? { taskEnvironmentId: search.taskEnvironmentId }
      : {}),
  }),
  component: RepositoryTasksRoute,
});
