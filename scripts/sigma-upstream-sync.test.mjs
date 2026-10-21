import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("./sigma-upstream-sync.mjs", import.meta.url));
const forkUrl = "https://github.com/drenkas/sigma-t3.git";
const upstreamUrl = "https://github.com/pingdotgg/t3code.git";
const sessionRef = "refs/sigma-upstream-sync/session";
const mutexRef = "refs/sigma-upstream-sync/mutex";

function run(binary, args, cwd, env = process.env, expected = 0, input) {
  const result = spawnSync(binary, args, { cwd, env, input, encoding: "utf8" });
  assert.equal(
    result.status,
    expected,
    `${binary} ${args.join(" ")}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result;
}

function git(args, cwd, env, input) {
  return run("git", args, cwd, env, 0, input).stdout.trim();
}

function updateRef(repo, env, ref, value, expectedObjectId) {
  const objectId = git(["hash-object", "-w", "--stdin"], repo, env, `${JSON.stringify(value)}\n`);
  const format = git(["rev-parse", "--show-object-format"], repo, env);
  const expected = expectedObjectId ?? "0".repeat(format === "sha256" ? 64 : 40);
  git(["update-ref", ref, objectId, expected], repo, env);
  return objectId;
}

function readRef(repo, env, ref) {
  const objectId = git(["rev-parse", "--verify", ref], repo, env);
  return { objectId, value: JSON.parse(git(["cat-file", "blob", objectId], repo, env)) };
}

function deleteRef(repo, env, ref) {
  const current = readRef(repo, env, ref);
  git(["update-ref", "-d", ref, current.objectId], repo, env);
}

function commitFile(repo, name, contents, message, env) {
  writeFileSync(path.join(repo, name), contents);
  git(["add", name], repo, env);
  git(["commit", "-m", message], repo, env);
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "sigma-upstream-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const originBare = path.join(root, "origin.git");
  const upstreamBare = path.join(root, "upstream.git");
  const seed = path.join(root, "seed");
  mkdirSync(seed);
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
  };
  git(["init", "-b", "main"], seed, gitEnv);
  git(["config", "user.name", "Sync Fixture"], seed, gitEnv);
  git(["config", "user.email", "sync-fixture@example.invalid"], seed, gitEnv);
  commitFile(seed, "base.txt", "base\n", "base", gitEnv);
  run("git", ["clone", "--bare", seed, originBare], root, gitEnv);
  run("git", ["clone", "--bare", seed, upstreamBare], root, gitEnv);

  const forkWriter = path.join(root, "fork-writer");
  run("git", ["clone", originBare, forkWriter], root, gitEnv);
  git(["config", "user.name", "Sync Fixture"], forkWriter, gitEnv);
  git(["config", "user.email", "sync-fixture@example.invalid"], forkWriter, gitEnv);
  commitFile(forkWriter, "fork.txt", "fork\n", "fork change", gitEnv);
  git(["push", "origin", "main"], forkWriter, gitEnv);

  const upstreamWriter = path.join(root, "upstream-writer");
  run("git", ["clone", upstreamBare, upstreamWriter], root, gitEnv);
  git(["config", "user.name", "Sync Fixture"], upstreamWriter, gitEnv);
  git(["config", "user.email", "sync-fixture@example.invalid"], upstreamWriter, gitEnv);
  commitFile(upstreamWriter, "upstream.txt", "upstream\n", "upstream change", gitEnv);
  git(["push", "origin", "main"], upstreamWriter, gitEnv);

  const repo = path.join(root, "repo");
  run("git", ["clone", originBare, repo], root, gitEnv);
  git(["config", "user.name", "Sync Fixture"], repo, gitEnv);
  git(["config", "user.email", "sync-fixture@example.invalid"], repo, gitEnv);
  git(["remote", "set-url", "origin", forkUrl], repo, gitEnv);
  git(["remote", "add", "upstream", upstreamUrl], repo, gitEnv);

  assert.equal(git(["remote", "get-url", "--all", "origin"], repo, gitEnv), forkUrl);
  assert.equal(git(["remote", "get-url", "--push", "--all", "origin"], repo, gitEnv), forkUrl);

  const ghState = path.join(root, "gh-state.json");
  writeFileSync(ghState, JSON.stringify({ prs: [], creates: 0, edits: 0 }));
  const binDir = path.join(root, "bin");
  mkdirSync(binDir);
  const fakeGh = path.join(binDir, "gh");
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const fs = require('node:fs');
const childProcess = require('node:child_process');
const statePath = process.env.SYNC_TEST_GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'list') {
  const value = (flag) => args[args.indexOf(flag) + 1];
  const branch = value('--head');
  const fields = value('--json')?.split(',');
  if (value('--repo') !== 'github.com/drenkas/sigma-t3' || value('--state') !== 'all' || !branch || branch.includes(':') ||
      !fields?.includes('headRepositoryOwner') || !fields?.includes('headRepository') || !fields?.includes('headRefOid') || !fields?.includes('baseRefName')) process.exit(2);
  if (state.failNextList) {
    state.failNextList = false;
    fs.writeFileSync(statePath, JSON.stringify(state));
    process.stderr.write('simulated failed PR readback');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(state.prs.filter((pr) => pr.headRefName === branch)));
} else if (args[0] === 'pr' && args[1] === 'create') {
  const value = (flag) => args[args.indexOf(flag) + 1];
  const head = value('--head').split(':')[1];
  const remoteLine = childProcess.execFileSync('git', ['ls-remote', 'origin', 'refs/heads/' + head], { cwd: process.cwd(), encoding: 'utf8' });
  const headRefOid = remoteLine.split(/\\s+/)[0];
  state.creates++;
  state.prs.push({ number: 17, url: 'https://github.com/drenkas/sigma-t3/pull/17', state: 'OPEN', headRefName: head, headRefOid, baseRefName: 'main', headRepositoryOwner: { login: 'drenkas' }, headRepository: { name: 'sigma-t3' } });
  if (state.failReadbackAfterCreate) state.failNextList = true;
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stderr.write('simulated lost response after create');
  process.exit(1);
} else if (args[0] === 'pr' && args[1] === 'edit') {
  state.edits++;
  fs.writeFileSync(statePath, JSON.stringify(state));
} else {
  process.exit(2);
}
`,
  );
  chmodSync(fakeGh, 0o755);
  const realGit = run("which", ["git"], root, gitEnv).stdout.trim();
  const gitAdapter = path.join(binDir, "git");
  writeFileSync(
    gitAdapter,
    `#!/usr/bin/env python3
import os, subprocess, sys, time
args = sys.argv[1:]
if args and args[0] == "fetch" and os.environ.get("SYNC_TEST_HOLD_FETCH_READY"):
    open(os.environ["SYNC_TEST_HOLD_FETCH_READY"], "w").close()
    while not os.path.exists(os.environ["SYNC_TEST_HOLD_FETCH_RELEASE"]):
        time.sleep(0.01)
if args and args[0] == "push" and os.environ.get("MOVE_LOCAL_BRANCH"):
    subprocess.run([os.environ["REAL_GIT"], "update-ref", "refs/heads/" + os.environ["MOVE_LOCAL_BRANCH"], os.environ["MOVE_LOCAL_TO"]], cwd=os.getcwd(), check=True)
if args and args[0] == "push" and os.environ.get("SYNC_TEST_PUSH_REJECT"):
    sys.stderr.write(os.environ["SYNC_TEST_PUSH_REJECT"])
    sys.exit(1)
if args and args[0] in {"fetch", "push", "ls-remote"}:
    names = {"origin": "file://" + os.environ["ORIGIN_BARE"], "upstream": "file://" + os.environ["UPSTREAM_BARE"]}
    for index, value in enumerate(args):
        if value in names:
            args[index] = names[value]
            break
os.execv(os.environ["REAL_GIT"], [os.environ["REAL_GIT"], *args])
`,
  );
  chmodSync(gitAdapter, 0o755);
  const inherited = { ...gitEnv };
  for (const key of ["SIGMA_SYNC_OWNER", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"])
    delete inherited[key];
  const env = {
    ...inherited,
    PATH: `${binDir}:${process.env.PATH}`,
    REAL_GIT: realGit,
    ORIGIN_BARE: originBare,
    UPSTREAM_BARE: upstreamBare,
    CODEX_THREAD_ID: "test-thread-00000001",
    SYNC_TEST_GH_STATE: ghState,
  };
  return { root, repo, originBare, upstreamBare, env, ghState, forkWriter, upstreamWriter };
}

function cli(f, command, args = [], expected = 0) {
  const result = run(
    process.execPath,
    [helper, command, ...args],
    f.repo,
    f.helperEnv ?? f.env,
    expected,
  );
  if (expected !== 0) return result;
  const output = result.stdout.trim();
  return output ? JSON.parse(output) : null;
}

function journal(f) {
  return JSON.parse(
    readFileSync(path.join(f.root, "repo", ".git", "sigma-upstream-sync", "journal.json"), "utf8"),
  );
}

test("prepares an isolated merge and recovers an uncertain PR create without duplicating it", (t) => {
  const f = fixture(t);
  f.helperEnv = {
    ...f.env,
    GIT_AUTHOR_NAME: "Injected author",
    GIT_AUTHOR_EMAIL: "bad@example.invalid",
    GIT_COMMITTER_NAME: "Injected committer",
    GIT_COMMITTER_EMAIL: "bad@example.invalid",
  };
  const prepared = cli(f, "prepare");
  assert.ok(prepared.sessionId);
  assert.equal(JSON.stringify(cli(f, "status")).includes(prepared.sessionId), false);
  assert.equal(prepared.result, "ready-for-validation");
  assert.equal(prepared.run.baseSha, git(["rev-parse", "origin/main"], f.repo, f.env));
  assert.equal(
    git(["branch", "--show-current"], prepared.run.worktree, f.env),
    prepared.run.branch,
  );
  assert.equal(
    git(
      ["merge-base", "--is-ancestor", prepared.run.upstreamSha, "HEAD"],
      prepared.run.worktree,
      f.env,
    ),
    "",
  );
  assert.equal(
    git(["show", "-s", "--format=%an <%ae>%n%cn <%ce>", "HEAD"], prepared.run.worktree, f.env),
    "Dmytro Renkas <25162167+drenkas@users.noreply.github.com>\nDmytro Renkas <25162167+drenkas@users.noreply.github.com>",
  );

  const recorded = cli(f, "record-validation", ["--session-id", prepared.sessionId]);
  assert.equal(recorded.run.testedSha, git(["rev-parse", "HEAD"], prepared.run.worktree, f.env));
  const bodyFile = path.join(f.root, "pr-body.md");
  writeFileSync(
    bodyFile,
    "Reviewed upstream sync with the required checks recorded for this commit.\n",
  );

  f.helperEnv.MOVE_LOCAL_BRANCH = prepared.run.branch;
  f.helperEnv.MOVE_LOCAL_TO = prepared.run.upstreamSha;
  const published = cli(f, "publish-pr", [
    "--session-id",
    prepared.sessionId,
    "--body-file",
    bodyFile,
  ]);
  assert.equal(published.run.phase, "pr-open");
  assert.equal(published.run.pr, "https://github.com/drenkas/sigma-t3/pull/17");
  const gh = JSON.parse(readFileSync(f.ghState, "utf8"));
  assert.equal(gh.creates, 1);
  assert.equal(gh.edits, 1);

  const remoteBranch = git(["ls-remote", "--heads", "origin", prepared.run.branch], f.repo, f.env);
  assert.equal(remoteBranch.split(/\s+/)[0], recorded.run.testedSha);
  assert.equal(
    git(["rev-parse", `refs/heads/${prepared.run.branch}`], f.repo, f.env),
    prepared.run.upstreamSha,
  );
  assert.equal(journal(f).runs[prepared.run.upstreamSha].pr, published.run.pr);
});

test("record-validation refuses a worktree missing its pinned base ancestor", (t) => {
  const f = fixture(t);
  const prepared = cli(f, "prepare");
  git(["reset", "--hard", prepared.run.upstreamSha], prepared.run.worktree, f.env);
  const rejected = cli(f, "record-validation", ["--session-id", prepared.sessionId], 1);
  assert.match(rejected.stderr, /both pinned origin\/main and upstream\/main/);
  assert.equal(journal(f).runs[prepared.run.upstreamSha].testedSha, null);
});

test("rejects an existing PR with a foreign head repository before pushing", (t) => {
  const f = fixture(t);
  const prepared = cli(f, "prepare");
  cli(f, "record-validation", ["--session-id", prepared.sessionId]);
  const state = JSON.parse(readFileSync(f.ghState, "utf8"));
  state.prs.push({
    number: 18,
    url: "https://github.com/drenkas/sigma-t3/pull/18",
    state: "OPEN",
    headRefName: prepared.run.branch,
    baseRefName: "main",
    headRepositoryOwner: { login: "other-owner" },
    headRepository: { name: "other-repo" },
  });
  writeFileSync(f.ghState, JSON.stringify(state));
  const bodyFile = path.join(f.root, "foreign-pr.md");
  writeFileSync(bodyFile, "Concrete sync body.\n");
  const rejected = cli(
    f,
    "publish-pr",
    ["--session-id", prepared.sessionId, "--body-file", bodyFile],
    1,
  );
  assert.match(rejected.stderr, /unexpected head repository/);
  assert.equal(git(["ls-remote", "--heads", "origin", prepared.run.branch], f.repo, f.env), "");
});

test("reconciles a created PR before invalidating a run whose upstream has advanced", (t) => {
  const f = fixture(t);
  const prepared = cli(f, "prepare");
  cli(f, "record-validation", ["--session-id", prepared.sessionId]);
  const bodyFile = path.join(f.root, "pr-reconcile.md");
  writeFileSync(bodyFile, "Reviewed sync PR body.\n");
  const state = JSON.parse(readFileSync(f.ghState, "utf8"));
  state.failReadbackAfterCreate = true;
  writeFileSync(f.ghState, JSON.stringify(state));

  const uncertain = cli(
    f,
    "publish-pr",
    ["--session-id", prepared.sessionId, "--body-file", bodyFile],
    1,
  );
  assert.match(uncertain.stderr, /simulated failed PR readback/);
  const pending = journal(f).runs[prepared.run.upstreamSha];
  assert.equal(pending.phase, "creating-pr");
  assert.equal(pending.pr, null);

  commitFile(f.upstreamWriter, "later-upstream.txt", "later\n", "advance upstream main", f.env);
  // Advance the upstream fixture directly. The repo-under-test adapter maps
  // symbolic remotes for its own fetch/push calls and would map this writer's
  // `origin` to the fork fixture instead.
  git(["push", "origin", "main"], f.upstreamWriter, { ...f.env, PATH: process.env.PATH });

  const recovered = cli(f, "publish-pr", [
    "--session-id",
    prepared.sessionId,
    "--body-file",
    bodyFile,
  ]);
  assert.equal(recovered.run.phase, "pr-open");
  assert.equal(recovered.run.pr, "https://github.com/drenkas/sigma-t3/pull/17");
  assert.equal(journal(f).runs[prepared.run.upstreamSha].phase, "pr-open");
  const latest = JSON.parse(readFileSync(f.ghState, "utf8"));
  assert.equal(latest.creates, 1);

  const newTarget = cli(f, "prepare", [], 1);
  assert.match(newTarget.stderr, /remains open/);
  assert.equal(Object.keys(journal(f).runs).length, 1);
  assert.equal(JSON.parse(readFileSync(f.ghState, "utf8")).creates, 1);
});

test("invalidates validation when origin/main moves and refuses to publish that stale proof", (t) => {
  const f = fixture(t);
  const prepared = cli(f, "prepare");
  cli(f, "record-validation", ["--session-id", prepared.sessionId]);

  const writer = f.forkWriter;
  commitFile(writer, "later-fork.txt", "later\n", "advance fork main", f.env);
  git(["push", "origin", "main"], writer, f.env);

  const bodyFile = path.join(f.root, "pr-body.md");
  writeFileSync(bodyFile, "A concrete sync summary.\n");
  const rejected = cli(
    f,
    "publish-pr",
    ["--session-id", prepared.sessionId, "--body-file", bodyFile],
    1,
  );
  assert.match(rejected.stderr, /validation proof was invalidated/);
  const run = journal(f).runs[prepared.run.upstreamSha];
  assert.equal(run.phase, "stale");
  assert.equal(run.testedSha, null);
  assert.equal(JSON.parse(readFileSync(f.ghState, "utf8")).creates, 0);

  const resumed = cli(f, "prepare", ["--session-id", prepared.sessionId]);
  assert.equal(resumed.result, "ready-for-validation");
  assert.notEqual(resumed.run.baseSha, prepared.run.baseSha);
  assert.equal(
    git(["merge-base", "--is-ancestor", resumed.run.baseSha, "HEAD"], resumed.run.worktree, f.env),
    "",
  );
});

test("rejects a competing lock and refuses a fork remote with a different identity", (t) => {
  const f = fixture(t);
  updateRef(f.repo, f.env, sessionRef, {
    runId: "held-by-another-run",
    ownerThread: "another-thread",
    sessionId: "another-nonce",
    deadline: Date.now() + 60_000,
  });
  const locked = cli(f, "prepare", [], 1);
  assert.match(locked.stderr, /does not own the sync session/);
  deleteRef(f.repo, f.env, sessionRef);

  updateRef(f.repo, f.env, mutexRef, {
    pid: process.pid,
    host: os.hostname(),
    nonce: "active-mutation",
  });
  const mutating = cli(f, "prepare", [], 1);
  assert.match(mutating.stderr, /Another sync command is mutating/);
  deleteRef(f.repo, f.env, mutexRef);

  git(["remote", "set-url", "origin", "https://github.com/someone-else/repo.git"], f.repo, f.env);
  const wrongRemote = cli(f, "prepare", [], 1);
  assert.match(wrongRemote.stderr, /origin remote must point exactly/);
});

test("serializes concurrent prepare commands with an atomic shared-ref mutex", async (t) => {
  const f = fixture(t);
  const ready = path.join(f.root, "fetch-ready");
  const release = path.join(f.root, "fetch-release");
  const child = spawn(process.execPath, [helper, "prepare"], {
    cwd: f.repo,
    env: { ...f.env, SYNC_TEST_HOLD_FETCH_READY: ready, SYNC_TEST_HOLD_FETCH_RELEASE: release },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const finished = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  try {
    assert.equal(
      existsSync(ready),
      true,
      "first prepare should reach its held fetch after claiming the mutex",
    );
    const competing = cli(f, "prepare", [], 1);
    assert.match(competing.stderr, /Another sync command is mutating/);
  } finally {
    writeFileSync(release, "go");
  }
  assert.equal(await finished, 0, stderr || stdout);
  assert.equal(JSON.parse(stdout).result, "ready-for-validation");
});

test("requires explicit recovery after owner death and fences the abandoned nonce", (t) => {
  const f = fixture(t);
  const prepared = cli(f, "prepare");
  commitFile(f.forkWriter, "later-fork.txt", "later\n", "advance fork main", f.env);
  git(["push", "origin", "main"], f.forkWriter, f.env);
  const old = readRef(f.repo, f.env, sessionRef);
  const abandoned = { ...old.value, ownerThread: "ended-thread-000000" };
  updateRef(f.repo, f.env, sessionRef, abandoned, old.objectId);

  f.env.CODEX_THREAD_ID = "recovery-thread-000001";
  const rejected = cli(f, "record-validation", ["--session-id", prepared.sessionId], 1);
  assert.match(rejected.stderr, /does not own the sync session/);
  const recovered = cli(f, "recover", ["--owner-dead"]);
  assert.equal(recovered.result, "stale");
  assert.ok(recovered.sessionId);
  assert.notEqual(recovered.sessionId, prepared.sessionId);
  assert.equal(JSON.stringify(cli(f, "status")).includes(recovered.sessionId), false);
  const oldNonce = cli(f, "prepare", ["--session-id", prepared.sessionId], 1);
  assert.match(oldNonce.stderr, /does not own the sync session/);
  const resumed = cli(f, "prepare", ["--session-id", recovered.sessionId]);
  assert.equal(resumed.result, "ready-for-validation");
  assert.notEqual(resumed.run.baseSha, prepared.run.baseSha);
  const continued = cli(f, "record-validation", ["--session-id", recovered.sessionId]);
  assert.equal(continued.run.phase, "validated");
});

test("recovers a claimed session whose first prepare failed before journaling a run", (t) => {
  const f = fixture(t);
  updateRef(f.repo, f.env, sessionRef, {
    ownerThread: "failed-thread-000001",
    sessionId: "old-private-nonce",
    runId: null,
    deadline: Date.now() - 1,
  });
  f.env.CODEX_THREAD_ID = "recovery-thread-000001";
  const recovered = cli(f, "recover", ["--owner-dead"]);
  assert.equal(recovered.result, "recovered-initial");
  const prepared = cli(f, "prepare", ["--session-id", recovered.sessionId]);
  assert.equal(prepared.result, "ready-for-validation");
});

function advanceUpstream(f, name) {
  commitFile(f.upstreamWriter, `${name}.txt`, `${name}\n`, `upstream ${name}`, f.env);
  // The writer pushes to the bare fixture directly; the adapter on PATH would
  // map its `origin` to the fork fixture.
  git(["push", "origin", "main"], f.upstreamWriter, { ...f.env, PATH: process.env.PATH });
  return git(["rev-parse", "HEAD"], f.upstreamWriter, f.env);
}

function setPrState(f, state) {
  const gh = JSON.parse(readFileSync(f.ghState, "utf8"));
  for (const pr of gh.prs) pr.state = state;
  writeFileSync(f.ghState, JSON.stringify(gh));
}

test("keeps the run's upstream target pinned while upstream/main advances", (t) => {
  const f = fixture(t);
  const prepared = cli(f, "prepare");
  const pinnedSha = prepared.run.upstreamSha;

  const newer = advanceUpstream(f, "during-checks");
  const resumed = cli(f, "prepare", ["--session-id", prepared.sessionId]);
  assert.equal(resumed.result, "ready-for-validation");
  assert.equal(resumed.run.upstreamSha, pinnedSha);
  assert.equal(resumed.latestUpstreamSha, newer);
  assert.equal(Object.keys(journal(f).runs).length, 1);

  cli(f, "record-validation", ["--session-id", prepared.sessionId]);
  const newest = advanceUpstream(f, "before-publish");
  const bodyFile = path.join(f.root, "pinned.md");
  writeFileSync(bodyFile, "Pinned sync body.\n");
  const published = cli(f, "publish-pr", [
    "--session-id",
    prepared.sessionId,
    "--body-file",
    bodyFile,
  ]);
  assert.equal(published.run.phase, "pr-open");
  assert.equal(published.run.upstreamSha, pinnedSha);

  setPrState(f, "CLOSED");
  const next = cli(f, "prepare");
  assert.equal(next.result, "ready-for-validation");
  assert.equal(next.run.upstreamSha, newest);
  assert.equal(next.latestUpstreamSha, undefined);
  assert.equal(journal(f).runs[pinnedSha].phase, "pr-closed");
});

test("surfaces push stderr and asks for the workflow scope when GitHub rejects workflow changes", (t) => {
  const f = fixture(t);
  const prepared = cli(f, "prepare");
  cli(f, "record-validation", ["--session-id", prepared.sessionId]);
  const bodyFile = path.join(f.root, "push.md");
  writeFileSync(bodyFile, "Sync body.\n");
  const publish = () =>
    cli(f, "publish-pr", ["--session-id", prepared.sessionId, "--body-file", bodyFile], 1);

  f.helperEnv = {
    ...f.env,
    SYNC_TEST_PUSH_REJECT:
      " ! [remote rejected] HEAD -> sigma-upstream/x (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)\nerror: failed to push some refs\n",
  };
  const scope = publish();
  assert.match(scope.stderr, /gh auth refresh -h github\.com -s workflow/);
  assert.match(scope.stderr, /refusing to allow an OAuth App/);
  assert.equal(journal(f).runs[prepared.run.upstreamSha].phase, "validated");

  f.helperEnv = { ...f.env, SYNC_TEST_PUSH_REJECT: "fatal: unable to access remote: timeout\n" };
  const generic = publish();
  assert.match(generic.stderr, /git push of .* failed \(1\)/);
  assert.match(generic.stderr, /unable to access remote: timeout/);
  assert.doesNotMatch(generic.stderr, /workflow scope/);
  assert.equal(git(["ls-remote", "--heads", "origin", prepared.run.branch], f.repo, f.env), "");

  f.helperEnv = undefined;
  const published = cli(f, "publish-pr", [
    "--session-id",
    prepared.sessionId,
    "--body-file",
    bodyFile,
  ]);
  assert.equal(published.run.phase, "pr-open");
});

test("creates worktrees beside the checkout and keeps journaled runs under the Git dir working", (t) => {
  const f = fixture(t);
  const prepared = cli(f, "prepare");
  const sha = prepared.run.upstreamSha;
  assert.equal(prepared.run.worktree, path.join(realpathSync(f.root), "repo-sync", sha));

  // Earlier helper versions recorded worktrees inside the Git dir.
  const legacy = path.join(f.repo, ".git", "sigma-upstream-sync", "worktrees", sha);
  mkdirSync(path.dirname(legacy), { recursive: true });
  git(["worktree", "move", prepared.run.worktree, legacy], f.repo, f.env);
  const file = path.join(f.repo, ".git", "sigma-upstream-sync", "journal.json");
  const saved = journal(f);
  saved.runs[sha].worktree = legacy;
  writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);

  const resumed = cli(f, "prepare", ["--session-id", prepared.sessionId]);
  assert.equal(resumed.run.worktree, legacy);
  const recorded = cli(f, "record-validation", ["--session-id", prepared.sessionId]);
  assert.equal(recorded.run.testedSha, git(["rev-parse", "HEAD"], legacy, f.env));
});

test("accepts SIGMA_SYNC_OWNER or a Claude Code session id as the session owner", (t) => {
  const f = fixture(t);
  delete f.env.CODEX_THREAD_ID;
  const missing = cli(f, "prepare", [], 1);
  assert.match(missing.stderr, /Set SIGMA_SYNC_OWNER/);

  f.helperEnv = { ...f.env, SIGMA_SYNC_OWNER: "bad owner" };
  assert.match(cli(f, "prepare", [], 1).stderr, /SIGMA_SYNC_OWNER must be/);

  f.helperEnv = { ...f.env, SIGMA_SYNC_OWNER: "nightly-sync-0001" };
  const prepared = cli(f, "prepare");
  assert.equal(readRef(f.repo, f.env, sessionRef).value.ownerThread, "nightly-sync-0001");
  cli(f, "record-validation", ["--session-id", prepared.sessionId]);

  f.helperEnv = { ...f.env, CLAUDE_CODE_SESSION_ID: "0b9e6c1a-claude-session" };
  const other = cli(f, "record-validation", ["--session-id", prepared.sessionId], 1);
  assert.match(other.stderr, /does not own the sync session/);
  const recovered = cli(f, "recover", ["--owner-dead"]);
  assert.equal(readRef(f.repo, f.env, sessionRef).value.ownerThread, "0b9e6c1a-claude-session");
  cli(f, "prepare", ["--session-id", recovered.sessionId]);
});
