// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - verifies generated remote scripts using real shell and Node processes.
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { quoteRemoteArg, remoteDeviceEnvironment, remoteDeviceScript } from "./sshDeviceScript.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

it.effect("finds Android Studio Java for a non-interactive SSH session", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    yield* Effect.promise(async () => {
      const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ssh-java-"));
      try {
        const javaHome = NodePath.join(home, ".local/opt/android-studio/jbr");
        await NodeFSP.mkdir(NodePath.join(javaHome, "bin"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(javaHome, "bin/java"),
          "#!/bin/sh\necho test-java\n",
          { mode: 0o755 },
        );
        const result = await exec("/bin/sh", ["-c", `${remoteDeviceEnvironment}\njava`], {
          env: { HOME: home, PATH: "/nonexistent", JAVA_HOME: "" },
        });
        expect(result.stdout.trim()).toBe("test-java");
      } finally {
        await NodeFSP.rm(home, { recursive: true, force: true });
      }
    });
  }),
);

it.effect("preserves shell metacharacters and newlines in remote arguments", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    yield* Effect.promise(async () => {
      const value = "quotes ' \" ; $(echo expanded) $HOME\nnext line";
      const result = await exec("sh", ["-c", `printf %s ${quoteRemoteArg(value)}`]);
      expect(result.stdout).toBe(value);
    });
  }),
);

it.effect(
  "keeps remote helper state in the fork namespace and leaves official device state alone",
  () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      yield* Effect.promise(async () => {
        const home = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "sigma-t3-remote-script-"),
        );
        try {
          const official = NodePath.join(home, ".t3/device/keep.txt");
          await NodeFSP.mkdir(NodePath.dirname(official), { recursive: true });
          await NodeFSP.writeFile(official, "official device state");
          const script = NodePath.join(home, "probe.cjs");
          await NodeFSP.writeFile(script, remoteDeviceScript("one", "probe"));
          const result = await exec(process.execPath, [script], {
            env: { ...process.env, HOME: home },
          });
          expect(JSON.parse(result.stdout).tools.hub.runningVersion).toBeNull();
          expect(await NodeFSP.readFile(official, "utf8")).toBe("official device state");
          expect(await NodeFSP.readdir(NodePath.join(home, ".t3/device"))).toEqual(["keep.txt"]);
          expect(remoteDeviceScript("one", "probe")).toContain(
            "path.join(os.homedir(), '.sigma-t3', 'device')",
          );
        } finally {
          await NodeFSP.rm(home, { recursive: true, force: true });
        }
      });
    }),
);
