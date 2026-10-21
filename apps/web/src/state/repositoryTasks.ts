import { createRepositoryTaskEnvironmentAtoms } from "@t3tools/client-runtime/state/repository-tasks";

import { connectionAtomRuntime } from "../connection/runtime";

export const repositoryTaskEnvironment =
  createRepositoryTaskEnvironmentAtoms(connectionAtomRuntime);
