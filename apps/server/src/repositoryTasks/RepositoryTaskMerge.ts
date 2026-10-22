import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

// Every snapshot goes through a private index, so the real index, HEAD and refs stay untouched.
const INDEX_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "splitIndex.sharedIndexExpire=never",
] as const;
// commit-tree needs an identity; these commits are never referenced and only carry trees.
const IDENTITY = {
  GIT_AUTHOR_NAME: "Sigma T3",
  GIT_AUTHOR_EMAIL: "sigma-t3@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Sigma T3",
  GIT_COMMITTER_EMAIL: "sigma-t3@users.noreply.github.com",
};

export class RepositoryTaskMergeError extends Schema.TaggedError<RepositoryTaskMergeError>()(
  "RepositoryTaskMergeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export type MergePlan =
  | { readonly status: "empty" }
  | {
      readonly status: "conflict";
      readonly baseCommit: string;
      readonly oursTree: string;
      readonly theirsTree: string;
      // Holds conflict markers for the conflicted paths; it is only ever previewed.
      readonly mergedTree: string;
      readonly files: ReadonlyArray<string>;
    }
  | {
      readonly status: "ready";
      readonly baseCommit: string;
      readonly oursTree: string;
      readonly mergedTree: string;
      readonly files: ReadonlyArray<string>;
    };

export type Observation = "after" | "before" | "diverged";

/** A ready path carries its unified patch; a conflicted one its diff3 text. Too large → null. */
export type PreviewFile = {
  readonly path: string;
  readonly status: "ready" | "conflict";
  readonly text: string | null;
};

// Keeps one preview from flooding the websocket with a huge generated file.
const PREVIEW_FILE_BYTES = 256 * 1024;
const PREVIEW_TOTAL_BYTES = 1024 * 1024;

const lines = (stdout: string) => stdout.split("\n").filter(Boolean);

export const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;

  const run = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    env?: NodeJS.ProcessEnv,
  ) =>
    git
      .execute({
        operation: `RepositoryTaskMerge.${operation}`,
        cwd,
        args,
        ...(env === undefined ? {} : { env }),
      })
      .pipe(Effect.map((result) => result.stdout.trim()));

  /** The tree of a working copy as it is now: tracked edits plus untracked, non-ignored files. */
  const workingTree = Effect.fn("RepositoryTaskMerge.workingTree")(function* (cwd: string) {
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "sigma-task-merge-" });
    const env = { GIT_INDEX_FILE: `${directory}/index` };
    yield* run("readHead", cwd, [...INDEX_CONFIG, "read-tree", "HEAD"], env);
    yield* run("addAll", cwd, [...INDEX_CONFIG, "add", "--all", "--", "."], env);
    return yield* run("writeTree", cwd, [...INDEX_CONFIG, "write-tree"], env);
  }, Effect.scoped);

  const changedPaths = (cwd: string, from: string, to: string) =>
    run("diffTree", cwd, ["diff-tree", "-r", "--no-renames", "--name-only", from, to]).pipe(
      Effect.map(lines),
    );

  /** Plans a three-way merge of `source`'s working copy into `cwd`'s without writing anything. */
  const plan = Effect.fn("RepositoryTaskMerge.plan")(function* (cwd: string, source: string) {
    const baseCommit = yield* run("mergeBase", cwd, [
      "merge-base",
      "HEAD",
      yield* run("sourceHead", source, ["rev-parse", "HEAD"]),
    ]);
    const baseTree = yield* run("baseTree", cwd, ["rev-parse", `${baseCommit}^{tree}`]);
    const theirsTree = yield* workingTree(source);
    if (theirsTree === baseTree) return { status: "empty" } satisfies MergePlan;
    const oursTree = yield* workingTree(cwd);
    const commit = (tree: string) =>
      run("commitTree", cwd, ["commit-tree", tree, "-m", "merge input"], IDENTITY);
    const merged = yield* git.execute({
      operation: "RepositoryTaskMerge.mergeTree",
      cwd,
      args: [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        `--merge-base=${baseCommit}`,
        yield* commit(oursTree),
        yield* commit(theirsTree),
      ],
      allowNonZeroExit: true,
    });
    const [mergedTree = "", ...conflicted] = lines(merged.stdout);
    if (merged.exitCode === 1)
      return {
        status: "conflict",
        baseCommit,
        oursTree,
        theirsTree,
        mergedTree,
        files: conflicted,
      } satisfies MergePlan;
    if (merged.exitCode !== 0)
      return yield* new RepositoryTaskMergeError({ detail: merged.stderr.trim() });
    return {
      status: "ready",
      baseCommit,
      oursTree,
      mergedTree,
      files: yield* changedPaths(cwd, oursTree, mergedTree),
    } satisfies MergePlan;
  });

  /** Where `cwd` stands relative to a planned merge, judged only by the paths the merge changes. */
  const observe = Effect.fn("RepositoryTaskMerge.observe")(function* (
    cwd: string,
    oursTree: string,
    mergedTree: string,
  ) {
    const current = yield* workingTree(cwd);
    if (current === mergedTree) return "after" satisfies Observation;
    if (current === oursTree) return "before" satisfies Observation;
    const files = new Set(yield* changedPaths(cwd, oursTree, mergedTree));
    const fromMerged = yield* changedPaths(cwd, mergedTree, current);
    if (!fromMerged.some((path) => files.has(path))) return "after" satisfies Observation;
    const fromOurs = yield* changedPaths(cwd, oursTree, current);
    return fromOurs.some((path) => files.has(path))
      ? ("diverged" satisfies Observation)
      : ("before" satisfies Observation);
  });

  /** Writes the planned paths into `cwd` only while the working copy still matches the plan. */
  const apply = Effect.fn("RepositoryTaskMerge.apply")(function* (
    cwd: string,
    ready: Extract<MergePlan, { status: "ready" }>,
  ) {
    if ((yield* workingTree(cwd)) !== ready.oursTree)
      return yield* new RepositoryTaskMergeError({
        detail: "The workspace changed after the merge was planned.",
      });
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "sigma-task-merge-" });
    const env = { GIT_INDEX_FILE: `${directory}/index` };
    yield* run("readMerged", cwd, [...INDEX_CONFIG, "read-tree", ready.mergedTree], env);
    const present = new Set(
      lines(yield* run("listMerged", cwd, ["ls-tree", "-r", "--name-only", ready.mergedTree])),
    );
    const written = ready.files.filter((path) => present.has(path));
    for (const path of ready.files)
      if (!present.has(path)) yield* fs.remove(`${cwd}/${path}`, { force: true });
    if (written.length > 0)
      yield* git.execute({
        operation: "RepositoryTaskMerge.checkout",
        cwd,
        args: [...INDEX_CONFIG, "checkout-index", "--force", "-z", "--stdin"],
        env,
        stdin: `${written.join("\0")}\0`,
      });
    return yield* observe(cwd, ready.oursTree, ready.mergedTree);
  }, Effect.scoped);

  const capture = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git.execute({
      operation: `RepositoryTaskMerge.${operation}`,
      cwd,
      args,
      allowNonZeroExit: true,
      maxOutputBytes: PREVIEW_FILE_BYTES,
      appendTruncationMarker: true,
    });

  const conflictText = Effect.fn("RepositoryTaskMerge.conflictText")(function* (
    cwd: string,
    path: string,
    sides: Record<"root" | "base" | "worker", string>,
  ) {
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "sigma-task-merge-" });
    const inputs: Array<string> = [];
    for (const [label, tree] of Object.entries(sides)) {
      const blob = yield* capture("readBlob", cwd, ["cat-file", "blob", `${tree}:${path}`]);
      if (blob.stdoutTruncated || blob.stdout.includes("\0")) return null;
      // A side without the file (added or deleted there) merges as an empty file.
      yield* fs.writeFileString(`${directory}/${label}`, blob.exitCode === 0 ? blob.stdout : "");
      inputs.push(`${directory}/${label}`);
    }
    const merged = yield* capture("mergeFile", cwd, [
      "merge-file",
      "-p",
      "--diff3",
      "-L",
      "root",
      "-L",
      "base",
      "-L",
      "worker",
      ...inputs,
    ]);
    return merged.stdoutTruncated || merged.exitCode < 0 ? null : merged.stdout;
  }, Effect.scoped);

  /** What a merge writes into `cwd`, file by file, seen from the member's side. */
  const preview = Effect.fn("RepositoryTaskMerge.preview")(function* (
    cwd: string,
    plan:
      | { readonly status: "ready"; readonly oursTree: string; readonly mergedTree: string }
      | Extract<MergePlan, { status: "conflict" }>,
  ) {
    const conflicted = new Set(plan.status === "conflict" ? plan.files : []);
    const changed = yield* changedPaths(cwd, plan.oursTree, plan.mergedTree);
    const paths = [...new Set([...changed, ...conflicted])].toSorted();
    let budget = PREVIEW_TOTAL_BYTES;
    const files: Array<PreviewFile> = [];
    for (const path of paths) {
      const status = conflicted.has(path) ? "conflict" : "ready";
      let text: string | null = null;
      if (budget > 0) {
        if (plan.status === "conflict" && status === "conflict") {
          text = yield* conflictText(cwd, path, {
            root: plan.oursTree,
            base: `${plan.baseCommit}^{tree}`,
            worker: plan.theirsTree,
          });
        } else {
          const patch = yield* capture("diffPatch", cwd, [
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-renames",
            plan.oursTree,
            plan.mergedTree,
            "--",
            path,
          ]);
          text = patch.stdoutTruncated ? null : patch.stdout;
        }
        budget -= text?.length ?? 0;
      }
      files.push({ path, status, text });
    }
    return files;
  });

  return { plan, apply, observe, preview };
});
