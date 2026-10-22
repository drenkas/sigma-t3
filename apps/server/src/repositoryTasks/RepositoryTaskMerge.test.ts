import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as Merge from "./RepositoryTaskMerge.ts";

const fixture = Effect.fn("test.mergeFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "repository-task-merge-" });
  const root = `${directory}/root`;
  yield* fs.makeDirectory(root);
  const run = (cwd: string, ...args: string[]) =>
    git
      .execute({ operation: "test.git", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* run(root, "init");
  yield* fs.writeFileString(`${root}/shared.txt`, "one\ntwo\nthree\n");
  yield* fs.writeFileString(`${root}/removed.txt`, "gone soon\n");
  yield* run(root, "add", ".");
  yield* run(
    root,
    "-c",
    "user.name=Sigma test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  const worktree = Effect.fn("test.worktree")(function* (name: string) {
    const path = `${directory}/${name}`;
    yield* run(root, "worktree", "add", "--detach", path);
    return path;
  });
  const state = Effect.gen(function* () {
    return {
      head: yield* run(root, "rev-parse", "HEAD"),
      staged: yield* run(root, "diff", "--cached", "--name-only"),
    };
  });
  return { fs, root, worktree, state, merger: yield* Merge.make };
});

const layer = (directory: string) =>
  Layer.mergeAll(
    NodeServices.layer,
    GitVcsDriver.layer.pipe(
      Layer.provide(ServerConfig.layerTest(directory, { prefix: "repository-task-merge-git-" })),
      Layer.provide(NodeServices.layer),
    ),
  );

it.layer(layer(process.cwd()))("repository task worktree merge", (it) => {
  it.effect(
    "brings two agents' disjoint work into the workspace without touching HEAD or the index",
    () =>
      Effect.gen(function* () {
        const { fs, root, worktree, state, merger } = yield* fixture();
        const before = yield* state;
        const first = yield* worktree("first");
        const second = yield* worktree("second");
        yield* fs.writeFileString(`${first}/shared.txt`, "ONE\ntwo\nthree\n");
        yield* fs.writeFileString(`${first}/added.txt`, "new file\n");
        yield* fs.writeFileString(`${second}/shared.txt`, "one\ntwo\nTHREE\n");
        yield* fs.remove(`${second}/removed.txt`);
        // The member's own uncommitted edit is kept as the "ours" side.
        yield* fs.writeFileString(`${root}/member.txt`, "member work\n");

        for (const source of [first, second]) {
          const plan = yield* merger.plan(root, source);
          assert.equal(plan.status, "ready");
          if (plan.status !== "ready") return;
          assert.equal(yield* merger.apply(root, plan), "after");
        }

        assert.equal(yield* fs.readFileString(`${root}/shared.txt`), "ONE\ntwo\nTHREE\n");
        assert.equal(yield* fs.readFileString(`${root}/added.txt`), "new file\n");
        assert.equal(yield* fs.readFileString(`${root}/member.txt`), "member work\n");
        assert.isFalse(yield* fs.exists(`${root}/removed.txt`));
        assert.deepEqual(yield* state, before);
        const replay = yield* merger.plan(root, first);
        assert.equal(replay.status, "ready");
        if (replay.status === "ready") assert.deepEqual(replay.files, []);
      }).pipe(Effect.scoped),
  );

  it.effect("reports a conflict and writes nothing", () =>
    Effect.gen(function* () {
      const { fs, root, worktree, merger } = yield* fixture();
      const agent = yield* worktree("agent");
      yield* fs.writeFileString(`${agent}/shared.txt`, "agent\ntwo\nthree\n");
      yield* fs.writeFileString(`${root}/shared.txt`, "member\ntwo\nthree\n");

      const plan = yield* merger.plan(root, agent);

      assert.deepEqual(plan, { status: "conflict", files: ["shared.txt"] });
      assert.equal(yield* fs.readFileString(`${root}/shared.txt`), "member\ntwo\nthree\n");
    }).pipe(Effect.scoped),
  );

  it.effect("skips an agent that changed nothing", () =>
    Effect.gen(function* () {
      const { root, worktree, merger } = yield* fixture();
      assert.deepEqual(yield* merger.plan(root, yield* worktree("idle")), { status: "empty" });
    }).pipe(Effect.scoped),
  );

  it.effect("judges an interrupted merge from the files alone and refuses a stale plan", () =>
    Effect.gen(function* () {
      const { fs, root, worktree, merger } = yield* fixture();
      const agent = yield* worktree("agent");
      yield* fs.writeFileString(`${agent}/shared.txt`, "ONE\ntwo\nthree\n");
      const plan = yield* merger.plan(root, agent);
      assert.equal(plan.status, "ready");
      if (plan.status !== "ready") return;

      assert.equal(yield* merger.observe(root, plan.oursTree, plan.mergedTree), "before");
      yield* fs.writeFileString(`${root}/shared.txt`, "ONE\ntwo\nthree\n");
      assert.equal(yield* merger.observe(root, plan.oursTree, plan.mergedTree), "after");
      yield* fs.writeFileString(`${root}/shared.txt`, "something else\n");
      assert.equal(yield* merger.observe(root, plan.oursTree, plan.mergedTree), "diverged");

      const stale = yield* merger.apply(root, plan).pipe(Effect.flip);
      assert.equal(stale._tag, "RepositoryTaskMergeError");
      assert.equal(yield* fs.readFileString(`${root}/shared.txt`), "something else\n");
    }).pipe(Effect.scoped),
  );
});
