#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const FORK = "drenkas/sigma-t3";
const UPSTREAM = "pingdotgg/t3code";
const GH_REPO = `github.com/${FORK}`;
const MAIN = "main";
const TERMINAL_PHASES = new Set(["no-updates", "pr-closed", "superseded"]);
const SESSION_MS = 60 * 60 * 1000;
const MERGE_IDENTITY = {
  GIT_AUTHOR_NAME: "Dmytro Renkas",
  GIT_AUTHOR_EMAIL: "25162167+drenkas@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Dmytro Renkas",
  GIT_COMMITTER_EMAIL: "25162167+drenkas@users.noreply.github.com",
};

function command(binary, args, cwd, { allowFailure = false, env = process.env, input } = {}) {
  const result = spawnSync(binary, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw new Error(`${binary} could not start: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-8).join("\n");
    throw new Error(
      `${binary} ${args[0] ?? ""} failed${result.status === null ? "" : ` (${result.status})`}${detail ? `: ${detail}` : ""}`,
    );
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(args, cwd, options) {
  return command("git", args, cwd, options).stdout.trim();
}

function mergeCommit(args, cwd) {
  return command("git", args, cwd, {
    allowFailure: true,
    env: { ...process.env, ...MERGE_IDENTITY },
  });
}

function gitConfig(cwd, key) {
  const result = command("git", ["config", "--null", "--get-all", key], cwd, {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.split("\0").filter(Boolean) : [];
}

function identityFromUrl(value) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/.exec(
      value,
    );
  return match?.[1].toLowerCase() ?? null;
}

function validateRemote(cwd, name, expected) {
  const fetchUrls = gitConfig(cwd, `remote.${name}.url`);
  const pushUrls = gitConfig(cwd, `remote.${name}.pushurl`);
  if (!fetchUrls.length) throw new Error(`Missing ${name} remote.`);
  const resolvedFetch = git(["remote", "get-url", "--all", name], cwd).split("\n");
  const resolvedPush = git(["remote", "get-url", "--push", "--all", name], cwd).split("\n");
  for (const url of [...fetchUrls, ...pushUrls, ...resolvedFetch, ...resolvedPush]) {
    const actual = identityFromUrl(url);
    if (actual !== expected)
      throw new Error(
        `${name} remote must point exactly to github.com/${expected}; found an unexpected URL.`,
      );
  }
}

function locate() {
  const root = git(["rev-parse", "--show-toplevel"], process.cwd());
  let commonDir = git(["rev-parse", "--git-common-dir"], root);
  if (!path.isAbsolute(commonDir)) commonDir = path.resolve(root, commonDir);
  return { root, commonDir, stateDir: path.join(commonDir, "sigma-upstream-sync") };
}

// Sync worktrees live beside the main checkout (`<checkout>-sync/<sha>`), not under
// the Git dir: vitest and lint exclude `**/.git/**`, so checks could not run there.
// Runs journaled earlier keep their recorded path.
function worktreesDir(stateDir) {
  const gitDir = commonDir(stateDir);
  const checkout =
    path.basename(gitDir) === ".git" ? path.dirname(gitDir) : gitDir.replace(/\.git$/, "");
  return `${checkout}-sync`;
}

function loadJournal(stateDir) {
  const file = path.join(stateDir, "journal.json");
  if (!existsSync(file)) return { version: 1, activeRunId: null, runs: {} };
  const journal = JSON.parse(readFileSync(file, "utf8"));
  if (journal.version !== 1 || !journal.runs || typeof journal.runs !== "object") {
    throw new Error(`Unsupported or corrupt journal: ${file}`);
  }
  return journal;
}

function saveJournal(stateDir, journal) {
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "journal.json");
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, file);
}

const SESSION_REF = "refs/sigma-upstream-sync/session";
const MUTEX_REF = "refs/sigma-upstream-sync/mutex";

function commonDir(stateDir) {
  return path.dirname(stateDir);
}

function readLock(stateDir, ref) {
  try {
    const objectId = git(
      ["--git-dir", commonDir(stateDir), "rev-parse", "--verify", ref],
      process.cwd(),
    );
    const value = git(
      ["--git-dir", commonDir(stateDir), "cat-file", "blob", objectId],
      process.cwd(),
    );
    return { objectId, owner: JSON.parse(value) };
  } catch {
    return null;
  }
}

function sessionOwner(stateDir) {
  return readLock(stateDir, SESSION_REF)?.owner ?? null;
}

function writeLock(stateDir, ref, owner, expectedObjectId = null) {
  const blob = command(
    "git",
    ["--git-dir", commonDir(stateDir), "hash-object", "-w", "--stdin"],
    process.cwd(),
    { input: `${JSON.stringify(owner)}\n` },
  ).stdout.trim();
  const format = git(
    ["--git-dir", commonDir(stateDir), "rev-parse", "--show-object-format"],
    process.cwd(),
  );
  const zero = "0".repeat(format === "sha256" ? 64 : 40);
  command(
    "git",
    ["--git-dir", commonDir(stateDir), "update-ref", ref, blob, expectedObjectId ?? zero],
    process.cwd(),
  );
  return blob;
}

function releaseLock(stateDir, ref, expectedObjectId) {
  if (!expectedObjectId) return false;
  const current = readLock(stateDir, ref);
  if (!current || current.objectId !== expectedObjectId) return false;
  const result = command(
    "git",
    ["--git-dir", commonDir(stateDir), "update-ref", "-d", ref, expectedObjectId],
    process.cwd(),
    { allowFailure: true },
  );
  return result.status === 0;
}

// The owner must outlive a single command and stay distinct per agent task, so
// recovery can tell a live owner from an ended one. Agent harnesses set these.
const OWNER_ENV = ["SIGMA_SYNC_OWNER", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"];

function syncOwner() {
  const name = OWNER_ENV.find((key) => process.env[key]);
  if (!name)
    throw new Error(
      `Set SIGMA_SYNC_OWNER to a stable id for this task to claim a sync session (${OWNER_ENV.slice(1).join(" and ")} are used when present).`,
    );
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(process.env[name]))
    throw new Error(`${name} must be 8-128 characters of letters, digits, "_" or "-".`);
  return process.env[name];
}

function claimSession(stateDir, ownerThread, runId) {
  const startedAt = Date.now();
  const sessionId = randomUUID();
  const ownerObjectId = writeLock(stateDir, SESSION_REF, {
    ownerThread,
    sessionId,
    runId,
    startedAt,
    deadline: startedAt + SESSION_MS,
  });
  return { ownerThread, sessionId, ownerObjectId };
}

function releaseSession(stateDir, ownerThread, sessionId) {
  const current = readLock(stateDir, SESSION_REF);
  if (current?.owner.ownerThread === ownerThread && current.owner.sessionId === sessionId) {
    releaseLock(stateDir, SESSION_REF, current.objectId);
  }
}

function withMutationMutex(stateDir, action) {
  const lock = readLock(stateDir, MUTEX_REF);
  const owner = { pid: process.pid, host: os.hostname(), nonce: randomUUID() };
  let objectId;
  if (lock) {
    let dead = false;
    if (lock.owner.host === os.hostname() && Number.isInteger(lock.owner.pid)) {
      try {
        process.kill(lock.owner.pid, 0);
      } catch (probeError) {
        dead = probeError.code === "ESRCH";
      }
    }
    if (!dead)
      throw new Error("Another sync command is mutating the journal; retry after it finishes.");
    try {
      objectId = writeLock(stateDir, MUTEX_REF, owner, lock.objectId);
    } catch {
      throw new Error("Another sync command acquired the mutation lock; retry after it finishes.");
    }
  } else {
    try {
      objectId = writeLock(stateDir, MUTEX_REF, owner);
    } catch {
      throw new Error("Another sync command acquired the mutation lock; retry after it finishes.");
    }
  }
  try {
    return action();
  } finally {
    releaseLock(stateDir, MUTEX_REF, objectId);
  }
}

function assertSession(stateDir, ownerThread, sessionId) {
  const owner = sessionOwner(stateDir);
  if (!owner) throw new Error("No active sync session; run prepare first.");
  if (owner.ownerThread !== ownerThread || owner.sessionId !== sessionId)
    throw new Error(
      "This run does not own the sync session. Resume with the nonce returned by prepare, or recover after confirming the prior task ended.",
    );
  if (!Number.isFinite(owner.deadline) || Date.now() > owner.deadline)
    throw new Error(
      "The 60-minute sync session expired; reconcile with recover --owner-dead before continuing.",
    );
  return owner;
}

function fetchHeads(root) {
  git(["fetch", "--no-tags", "origin", `refs/heads/${MAIN}:refs/remotes/origin/${MAIN}`], root);
  git(["fetch", "--no-tags", "upstream", `refs/heads/${MAIN}:refs/remotes/upstream/${MAIN}`], root);
  return {
    baseSha: git(["rev-parse", `refs/remotes/origin/${MAIN}^{commit}`], root),
    upstreamSha: git(["rev-parse", `refs/remotes/upstream/${MAIN}^{commit}`], root),
  };
}

function isAncestor(root, older, newer) {
  return (
    command("git", ["merge-base", "--is-ancestor", older, newer], root, { allowFailure: true })
      .status === 0
  );
}

function worktreeStatus(worktree) {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"], worktree);
  const unresolved = git(["diff", "--name-only", "--diff-filter=U"], worktree);
  return { dirty: status.length > 0, unresolved: unresolved.length > 0 };
}

function assertWorktree(run) {
  if (!run.worktree || !existsSync(run.worktree))
    throw new Error(
      `Worktree for run ${run.runId} is missing; preserve it and inspect the journal before recovery.`,
    );
  const branch = git(["branch", "--show-current"], run.worktree);
  if (branch !== run.branch)
    throw new Error(
      `Expected branch ${run.branch} in ${run.worktree}, found ${branch || "detached HEAD"}.`,
    );
}

function prepare(root, stateDir, journal, assertCurrent) {
  const { baseSha, upstreamSha: latestUpstreamSha } = fetchHeads(root);
  for (const previous of Object.values(journal.runs)) {
    if (TERMINAL_PHASES.has(previous.phase) || !previous.branch) continue;
    const unresolvedPublication =
      previous.pr ||
      ["pushed", "creating-pr", "updating-pr", "pr-open", "stale"].includes(previous.phase);
    if (!unresolvedPublication) continue;
    const pr = readPullRequests(previous.branch);
    if (pr) {
      const remoteSha = remoteBranchSha(root, previous.branch);
      const expectedSha = previous.publishedSha ?? previous.testedSha;
      if (
        !remoteSha ||
        !expectedSha ||
        remoteSha !== expectedSha ||
        (pr.headRefOid && pr.headRefOid !== remoteSha)
      ) {
        throw new Error(
          `PR ${pr.url} does not match the recorded published SHA for ${previous.branch}; inspect it before continuing.`,
        );
      }
      previous.pr = pr.url;
      previous.phase = ["CLOSED", "MERGED"].includes(pr.state) ? "pr-closed" : "pr-open";
      if (previous.phase === "pr-open") {
        journal.activeRunId = previous.runId;
        saveJournal(stateDir, journal);
        return {
          result: "pr-open",
          run: previous,
          message:
            "An existing upstream PR is still open; finish its review before starting another target.",
        };
      }
    } else if (previous.pr) {
      throw new Error(
        `Previously recorded PR ${previous.pr} is not returned for ${previous.branch}; inspect the remote state before continuing.`,
      );
    } else if (
      previous.publishedSha ||
      ["pushed", "creating-pr", "updating-pr", "pr-open"].includes(previous.phase)
    ) {
      const remoteSha = remoteBranchSha(root, previous.branch);
      const expectedSha = previous.publishedSha ?? previous.testedSha;
      if (!remoteSha || !expectedSha || remoteSha !== expectedSha) {
        throw new Error(
          `Publication for ${previous.branch} remains unresolved; reconcile its remote branch before starting another target.`,
        );
      }
      previous.lastPrLookup = { state: "absent", at: new Date().toISOString() };
    }
  }
  // An unfinished run keeps its upstream target; a newer upstream waits for the
  // next run, after this one's PR closes.
  const unfinished = Object.values(journal.runs).find(
    (candidate) => candidate.runId === journal.activeRunId,
  );
  const upstreamSha =
    unfinished?.branch && !TERMINAL_PHASES.has(unfinished.phase)
      ? unfinished.upstreamSha
      : latestUpstreamSha;
  const pinned = (result) =>
    upstreamSha === latestUpstreamSha ? result : { ...result, latestUpstreamSha };
  if (isAncestor(root, upstreamSha, baseSha)) {
    let run = journal.runs[upstreamSha];
    if (!run) {
      run = {
        runId: randomUUID(),
        baseSha,
        upstreamSha,
        branch: null,
        worktree: null,
        phase: "no-updates",
        testedSha: null,
        pr: null,
      };
      journal.runs[upstreamSha] = run;
    } else {
      run.baseSha = baseSha;
      run.phase = "no-updates";
      run.testedSha = null;
    }
    journal.activeRunId = run.runId;
    saveJournal(stateDir, journal);
    return pinned({ result: "no-updates", run });
  }

  let run = journal.runs[upstreamSha];
  if (!run) {
    const pending = Object.values(journal.runs).filter(
      (candidate) => !TERMINAL_PHASES.has(candidate.phase),
    );
    const uncertainPublish = pending.find((candidate) =>
      ["pushed", "creating-pr", "updating-pr"].includes(candidate.phase),
    );
    if (uncertainPublish)
      throw new Error(
        `Run ${uncertainPublish.runId} for upstream ${uncertainPublish.upstreamSha} is still ${uncertainPublish.phase}; run publish-pr to reconcile its remote state before starting another target.`,
      );
    for (const previous of pending) {
      previous.phase = "superseded";
      previous.testedSha = null;
    }
    const branch = `sigma-upstream/${upstreamSha}`;
    const worktree = path.join(worktreesDir(stateDir), upstreamSha);
    run = {
      runId: randomUUID(),
      baseSha,
      upstreamSha,
      branch,
      worktree,
      phase: "preparing",
      testedSha: null,
      pr: null,
    };
    journal.runs[upstreamSha] = run;
    saveJournal(stateDir, journal);
  }
  journal.activeRunId = run.runId;
  validateRemote(root, "origin", FORK);
  validateRemote(root, "upstream", UPSTREAM);

  const branchExists =
    command("git", ["show-ref", "--verify", "--quiet", `refs/heads/${run.branch}`], root, {
      allowFailure: true,
    }).status === 0;
  const pathExists = existsSync(run.worktree);
  if (!branchExists && !pathExists) {
    run.phase = "preparing";
    run.baseSha = baseSha;
    run.testedSha = null;
    saveJournal(stateDir, journal);
    mkdirSync(path.dirname(run.worktree), { recursive: true });
    assertCurrent();
    git(["worktree", "add", "-b", run.branch, run.worktree, baseSha], root);
  } else {
    if (!branchExists || !pathExists)
      throw new Error(
        `Incomplete worktree state for ${run.branch}; inspect ${run.worktree} and the shared Git journal before recovery.`,
      );
    assertWorktree(run);
  }

  const state = worktreeStatus(run.worktree);
  if (state.unresolved) {
    run.phase = "conflict";
    run.testedSha = null;
    saveJournal(stateDir, journal);
    return {
      result: "conflict",
      run,
      message: "Resolve and commit the merge in the recorded worktree, then run prepare again.",
    };
  }
  if (state.dirty)
    throw new Error(
      `Worktree ${run.worktree} has uncommitted changes; preserve and commit or resolve them before continuing.`,
    );

  const head = git(["rev-parse", "HEAD"], run.worktree);
  const baseMoved = run.baseSha !== baseSha;
  if (baseMoved) run.testedSha = null;
  if (!isAncestor(run.worktree, baseSha, head)) {
    run.phase = "integrating-base";
    run.baseSha = baseSha;
    run.testedSha = null;
    saveJournal(stateDir, journal);
    if (!isAncestor(run.worktree, baseSha, head)) {
      assertCurrent();
      const merge = mergeCommit(["merge", "--no-edit", baseSha], run.worktree);
      if (merge.status !== 0) {
        run.phase = "conflict";
        saveJournal(stateDir, journal);
        return {
          result: "conflict",
          run,
          message:
            "origin/main moved; resolve and commit the ordinary merge in the recorded worktree, then run prepare again.",
        };
      }
    }
  } else if (baseMoved) {
    run.baseSha = baseSha;
    saveJournal(stateDir, journal);
  }

  const currentHead = git(["rev-parse", "HEAD"], run.worktree);
  if (!isAncestor(run.worktree, upstreamSha, currentHead)) {
    run.phase = "merging-upstream";
    run.testedSha = null;
    saveJournal(stateDir, journal);
    assertCurrent();
    const merge = mergeCommit(["merge", "--no-edit", upstreamSha], run.worktree);
    if (merge.status !== 0) {
      run.phase = "conflict";
      saveJournal(stateDir, journal);
      return {
        result: "conflict",
        run,
        message:
          "Resolve and commit the upstream merge in the recorded worktree, then run prepare again.",
      };
    }
  }
  run.phase = "ready-for-validation";
  run.testedSha = null;
  saveJournal(stateDir, journal);
  return pinned({ result: "ready-for-validation", run });
}

function activeRun(journal) {
  const run = Object.values(journal.runs).find((item) => item.runId === journal.activeRunId);
  if (!run) throw new Error("No active sync run. Run prepare first.");
  return run;
}

function recordValidation(root, stateDir, journal) {
  const run = activeRun(journal);
  if (
    run.phase !== "ready-for-validation" &&
    run.phase !== "validated" &&
    run.phase !== "pushed" &&
    run.phase !== "pr-open"
  ) {
    throw new Error(
      `Run ${run.runId} is ${run.phase}; prepare and resolve all merges before recording validation.`,
    );
  }
  // Upstream moves faster than validation, so the run keeps its pinned upstream
  // and only a moved origin/main invalidates the proof.
  const heads = fetchHeads(root);
  if (heads.baseSha !== run.baseSha) {
    run.testedSha = null;
    run.phase = "stale";
    saveJournal(stateDir, journal);
    throw new Error(
      "origin/main moved; validation proof was invalidated. Run prepare and repeat the required checks.",
    );
  }
  assertWorktree(run);
  const state = worktreeStatus(run.worktree);
  if (state.unresolved || state.dirty)
    throw new Error(
      `Cannot record validation: worktree is ${state.unresolved ? "unmerged" : "dirty"}.`,
    );
  const testedSha = git(["rev-parse", "HEAD"], run.worktree);
  if (
    !isAncestor(run.worktree, run.baseSha, testedSha) ||
    !isAncestor(run.worktree, run.upstreamSha, testedSha)
  ) {
    throw new Error(
      "The worktree no longer contains both pinned origin/main and upstream/main commits.",
    );
  }
  run.testedSha = testedSha;
  run.phase = "validated";
  saveJournal(stateDir, journal);
  return run;
}

function readPullRequests(branch) {
  const result = command(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      GH_REPO,
      "--state",
      "all",
      "--head",
      branch,
      "--json",
      "number,url,state,headRefName,headRefOid,baseRefName,headRepositoryOwner,headRepository",
    ],
    process.cwd(),
  );
  const prs = JSON.parse(result.stdout);
  if (!Array.isArray(prs)) throw new Error("gh returned an invalid pull request list.");
  const matching = prs.filter((pr) => pr.headRefName === branch);
  if (matching.length > 1)
    throw new Error(
      `More than one pull request exists for ${branch}; inspect them before publishing.`,
    );
  if (matching.length) {
    const pr = matching[0];
    if (pr.baseRefName !== MAIN)
      throw new Error(
        `Existing pull request for ${branch} targets ${pr.baseRefName}, not ${MAIN}.`,
      );
    if (pr.headRepositoryOwner?.login !== "drenkas" || pr.headRepository?.name !== "sigma-t3") {
      throw new Error(
        `Existing pull request for ${branch} comes from an unexpected head repository.`,
      );
    }
  }
  return matching[0] ?? null;
}

function remoteBranchSha(root, branch) {
  const result = git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], root);
  return result ? result.split(/\s+/)[0] : null;
}

function reconcileExistingPullRequest(root, stateDir, journal, run) {
  const pr = readPullRequests(run.branch);
  if (!pr) {
    if (["creating-pr", "updating-pr", "pushed"].includes(run.phase)) {
      run.lastPrLookup = { state: "absent", at: new Date().toISOString() };
      saveJournal(stateDir, journal);
    }
    return null;
  }
  const remoteSha = remoteBranchSha(root, run.branch);
  const expectedSha = run.publishedSha ?? run.testedSha;
  if (
    !remoteSha ||
    !expectedSha ||
    remoteSha !== expectedSha ||
    (pr.headRefOid && pr.headRefOid !== remoteSha)
  ) {
    throw new Error(
      `Existing PR ${pr.url} does not match the recorded published SHA for ${run.branch} (remote=${remoteSha ?? "missing"}, recorded=${expectedSha ?? "missing"}, PR=${pr.headRefOid ?? "missing"}); inspect it before continuing.`,
    );
  }
  run.pr = pr.url;
  run.phase = ["CLOSED", "MERGED"].includes(pr.state) ? "pr-closed" : "pr-open";
  saveJournal(stateDir, journal);
  return run;
}

function ensurePushed(root, run, testedSha, assertCurrent) {
  const remoteSha = remoteBranchSha(root, run.branch);
  if (remoteSha === testedSha) return;
  if (remoteSha) {
    git(["fetch", "--no-tags", "origin", `refs/heads/${run.branch}`], root);
    const fetchedSha = git(["rev-parse", "FETCH_HEAD^{commit}"], root);
    if (!isAncestor(run.worktree, fetchedSha, testedSha)) {
      throw new Error(
        `Remote branch ${run.branch} is not an ancestor of the validated commit; refusing to overwrite it.`,
      );
    }
  }
  assertCurrent();
  const pushed = command("git", ["push", "origin", `${testedSha}:refs/heads/${run.branch}`], root, {
    allowFailure: true,
  });
  const after = remoteBranchSha(root, run.branch);
  if (after === testedSha) return;
  const detail = pushed.stderr.trim().split("\n").slice(-8).join("\n");
  if (pushed.status !== 0 && /without [`'"]?workflow[`'"]? scope/i.test(detail)) {
    throw new Error(
      `GitHub rejected the push of ${run.branch}: the merge changes .github/workflows and the GitHub token lacks the workflow scope. Run \`gh auth refresh -h github.com -s workflow\`, then re-run publish-pr.\n${detail}`,
    );
  }
  if (pushed.status !== 0) {
    throw new Error(
      `git push of ${run.branch} failed (${pushed.status}); remote points to ${after ?? "no branch"}.${detail ? `\n${detail}` : ""}`,
    );
  }
  throw new Error(
    `Push outcome is not confirmed for ${run.branch}; remote now points to ${after ?? "no branch"}. Re-run publish-pr to reconcile before retrying.`,
  );
}

function publishPullRequest(root, stateDir, journal, bodyFile, assertCurrent) {
  const body = readFileSync(bodyFile, "utf8").trim();
  if (!body) throw new Error("PR body file is empty.");
  const run = activeRun(journal);
  if (!["validated", "pushed", "pr-open", "creating-pr", "updating-pr"].includes(run.phase))
    throw new Error(
      `Run ${run.runId} is ${run.phase}; record validation after the required checks first.`,
    );

  const existingPr = reconcileExistingPullRequest(root, stateDir, journal, run);
  if (existingPr) return existingPr;
  const heads = fetchHeads(root);
  if (heads.baseSha !== run.baseSha) {
    run.testedSha = null;
    run.phase = "stale";
    saveJournal(stateDir, journal);
    throw new Error(
      "origin/main moved; validation proof was invalidated. Run prepare and repeat the required checks.",
    );
  }
  assertWorktree(run);
  const state = worktreeStatus(run.worktree);
  const head = git(["rev-parse", "HEAD"], run.worktree);
  if (state.dirty || state.unresolved || head !== run.testedSha) {
    run.testedSha = null;
    run.phase = "ready-for-validation";
    saveJournal(stateDir, journal);
    throw new Error(
      "Validated worktree changed; validation proof was invalidated. Repeat the required checks and record validation again.",
    );
  }
  if (
    !isAncestor(run.worktree, run.baseSha, head) ||
    !isAncestor(run.worktree, run.upstreamSha, head)
  ) {
    run.testedSha = null;
    run.phase = "ready-for-validation";
    saveJournal(stateDir, journal);
    throw new Error(
      "Validated worktree no longer contains both pinned commits; repeat the required checks.",
    );
  }

  let pr = readPullRequests(run.branch);
  ensurePushed(root, run, run.testedSha, assertCurrent);
  run.publishedSha = run.testedSha;
  run.phase = "pushed";
  saveJournal(stateDir, journal);

  pr = readPullRequests(run.branch) ?? pr;
  if (pr?.state === "CLOSED" || pr?.state === "MERGED") {
    run.pr = pr.url;
    run.phase = "pr-closed";
    saveJournal(stateDir, journal);
    return run;
  }

  const title = `Sync upstream ${run.upstreamSha.slice(0, 12)}`;
  if (pr) {
    run.pr = pr.url;
    run.phase = "updating-pr";
    saveJournal(stateDir, journal);
    assertCurrent();
    command(
      "gh",
      [
        "pr",
        "edit",
        String(pr.number),
        "--repo",
        GH_REPO,
        "--title",
        title,
        "--body-file",
        bodyFile,
      ],
      process.cwd(),
    );
  } else {
    run.phase = "creating-pr";
    saveJournal(stateDir, journal);
    assertCurrent();
    const created = command(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        GH_REPO,
        "--head",
        `drenkas:${run.branch}`,
        "--base",
        MAIN,
        "--title",
        title,
        "--body-file",
        bodyFile,
      ],
      process.cwd(),
      { allowFailure: true },
    );
    pr = readPullRequests(run.branch);
    if (!pr) {
      const detail = (created.stderr || created.stdout || "")
        .trim()
        .split("\n")
        .slice(-4)
        .join("\n");
      throw new Error(
        `PR creation is not confirmed; re-run publish-pr to reconcile before retrying.${detail ? ` ${detail}` : ""}`,
      );
    }
    run.pr = pr.url;
    if (pr.state === "CLOSED" || pr.state === "MERGED") {
      run.phase = "pr-closed";
      saveJournal(stateDir, journal);
      return run;
    }
    assertCurrent();
    command(
      "gh",
      [
        "pr",
        "edit",
        String(pr.number),
        "--repo",
        GH_REPO,
        "--title",
        title,
        "--body-file",
        bodyFile,
      ],
      process.cwd(),
    );
  }
  run.pr = pr.url;
  run.phase = "pr-open";
  saveJournal(stateDir, journal);
  return run;
}

function parseArgs(args) {
  const commandName = args.shift();
  const options = {};
  while (args.length) {
    const name = args.shift();
    if (name === "--owner-dead") options.ownerDead = true;
    else if (name === "--body-file" || name === "--session-id") {
      if (!args.length) throw new Error(`Missing value for ${name}`);
      const value = args.shift();
      if (name === "--body-file") options.bodyFile = path.resolve(value);
      else options.sessionId = value;
    } else throw new Error(`Unexpected argument: ${name}`);
  }
  if (!["prepare", "status", "record-validation", "publish-pr", "recover"].includes(commandName)) {
    throw new Error(
      "Usage: node scripts/sigma-upstream-sync.mjs <prepare|status|record-validation|publish-pr|recover> [--session-id NONCE] [--owner-dead] [--body-file PATH]",
    );
  }
  if (commandName === "recover" && !options.ownerDead)
    throw new Error(
      "recover requires --owner-dead after confirming the prior owner task has ended.",
    );
  if (commandName !== "recover" && options.ownerDead)
    throw new Error("--owner-dead is only valid with recover.");
  if (commandName === "publish-pr" && !options.bodyFile)
    throw new Error("publish-pr requires --body-file with the concrete PR description.");
  if (commandName !== "publish-pr" && options.bodyFile)
    throw new Error("--body-file is only valid for publish-pr.");
  if (["record-validation", "publish-pr"].includes(commandName) && !options.sessionId)
    throw new Error(
      `${commandName} requires --session-id from the successful prepare output; status does not expose it.`,
    );
  if (["prepare", "recover"].includes(commandName) && options.sessionId === "")
    throw new Error("--session-id cannot be empty.");
  return { commandName, options };
}

function beginSession(root, stateDir, journal, commandName, ownerThread, requestedSessionId) {
  let owner = sessionOwner(stateDir);
  if (owner) {
    assertSession(stateDir, ownerThread, requestedSessionId);
    return owner;
  }
  if (commandName !== "prepare")
    throw new Error(
      "No sync session is active; run prepare first or recover an abandoned session.",
    );
  const active = Object.values(journal.runs).find((run) => run.runId === journal.activeRunId);
  if (active && !TERMINAL_PHASES.has(active.phase) && active.phase !== "pr-open") {
    throw new Error(
      `Run ${active.runId} is still ${active.phase}; reconcile and recover it before starting another sync.`,
    );
  }
  if (active?.phase === "pr-open") {
    const pr = readPullRequests(active.branch);
    if (!pr)
      throw new Error(
        `Cannot confirm state of previously opened PR ${active.pr}; reconcile before continuing.`,
      );
    if (!["CLOSED", "MERGED"].includes(pr.state))
      throw new Error(`PR ${pr.url} remains open; finish review before starting another target.`);
    active.phase = "pr-closed";
    saveJournal(stateDir, journal);
  }
  if (requestedSessionId)
    throw new Error(
      "No session is active for that nonce; run prepare without --session-id to start a new session.",
    );
  return claimSession(stateDir, ownerThread, active?.runId ?? null);
}

function recover(root, stateDir, journal, ownerThread) {
  const oldOwner = sessionOwner(stateDir);
  if (oldOwner?.ownerThread === ownerThread && Date.now() <= oldOwner.deadline)
    throw new Error(
      "This owner still holds the session; continue with prepare or record-validation.",
    );
  if (oldOwner && (!oldOwner.sessionId || !oldOwner.ownerThread))
    throw new Error("The session owner record is corrupt; inspect the lock before recovery.");
  const heads = fetchHeads(root);
  let run;
  try {
    run = activeRun(journal);
  } catch {}
  if (!run) {
    if (!oldOwner) throw new Error("No abandoned session exists to recover.");
    releaseSession(stateDir, oldOwner.ownerThread, oldOwner.sessionId);
    const { sessionId } = claimSession(stateDir, ownerThread, null);
    return { result: "recovered-initial", sessionId, heads };
  }
  const pr = run.branch ? readPullRequests(run.branch) : null;
  if (run.branch) {
    const remoteSha = remoteBranchSha(root, run.branch);
    if (remoteSha) {
      if (!run.testedSha)
        throw new Error(
          "A remote sync branch exists without a recorded validation SHA; inspect it before recovery.",
        );
      git(["fetch", "--no-tags", "origin", `refs/heads/${run.branch}`], root);
      const fetchedSha = git(["rev-parse", "FETCH_HEAD^{commit}"], root);
      if (fetchedSha !== run.testedSha && !isAncestor(root, fetchedSha, run.testedSha)) {
        throw new Error(
          "Remote sync branch diverges from journal proof; inspect it before recovery.",
        );
      }
    }
  }
  if (pr) {
    run.pr = pr.url;
    run.phase = ["CLOSED", "MERGED"].includes(pr.state) ? "pr-closed" : "pr-open";
    saveJournal(stateDir, journal);
    if (oldOwner) releaseSession(stateDir, oldOwner.ownerThread, oldOwner.sessionId);
    return { result: run.phase, run };
  }
  if (heads.baseSha !== run.baseSha) {
    run.testedSha = null;
    run.phase = "stale";
    saveJournal(stateDir, journal);
    if (oldOwner) releaseSession(stateDir, oldOwner.ownerThread, oldOwner.sessionId);
    const { sessionId } = claimSession(stateDir, ownerThread, run.runId);
    return {
      result: "stale",
      run,
      sessionId,
      message: "origin/main moved; run prepare to reconcile and repeat validation.",
    };
  }
  if (oldOwner) releaseSession(stateDir, oldOwner.ownerThread, oldOwner.sessionId);
  const { sessionId } = claimSession(stateDir, ownerThread, run.runId);
  run.testedSha = null;
  if (["validated", "pushed", "creating-pr", "updating-pr"].includes(run.phase))
    run.phase = "ready-for-validation";
  saveJournal(stateDir, journal);
  return { result: "recovered", run, sessionId };
}

function main() {
  const { commandName, options } = parseArgs(process.argv.slice(2));
  const { root, stateDir } = locate();
  validateRemote(root, "origin", FORK);
  validateRemote(root, "upstream", UPSTREAM);

  if (commandName === "status") {
    const journal = loadJournal(stateDir);
    process.stdout.write(`${JSON.stringify(journal, null, 2)}\n`);
    return;
  }

  const ownerThread = syncOwner();
  withMutationMutex(stateDir, () => {
    const journal = loadJournal(stateDir);
    if (commandName === "recover") {
      const result = recover(root, stateDir, journal, ownerThread);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const session = beginSession(
      root,
      stateDir,
      journal,
      commandName,
      ownerThread,
      options.sessionId,
    );
    const assertCurrent = () => assertSession(stateDir, ownerThread, session.sessionId);
    assertCurrent();
    let result;
    if (commandName === "prepare") result = prepare(root, stateDir, journal, assertCurrent);
    else if (commandName === "record-validation")
      result = { result: "validated", run: recordValidation(root, stateDir, journal) };
    else
      result = {
        result: "published",
        run: publishPullRequest(root, stateDir, journal, options.bodyFile, assertCurrent),
      };
    if (["no-updates", "pr-closed", "pr-open"].includes(result.run?.phase))
      releaseSession(stateDir, ownerThread, session.sessionId);
    if (commandName === "prepare") result.sessionId = session.sessionId;
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`sigma-upstream-sync: ${error.message}\n`);
  process.exitCode = 1;
}
