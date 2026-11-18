// @effect-diagnostics nodeBuiltinImport:off - Executes the real installer with isolated homes and download sentinels.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

it("refuses standalone installation before downloading or creating runtime state", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sigma-t3-install-"));
  try {
    const marker = NodePath.join(root, "network-attempted");
    for (const tool of ["curl", "wget"]) {
      NodeFS.writeFileSync(
        NodePath.join(root, tool),
        `#!/bin/sh\nprintf attempted > '${marker}'\nexit 1\n`,
        { mode: 0o755 },
      );
    }
    const home = NodePath.join(root, "home");
    const result = NodeChildProcess.spawnSync(
      "/bin/sh",
      [NodePath.join(import.meta.dirname, "install.sh")],
      {
        env: { PATH: root, SIGMA_T3_HOME: home, T3CODE_HOME: home },
        encoding: "utf8",
        timeout: 2000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("standalone CLI installation is not released");
    expect(NodeFS.existsSync(home)).toBe(false);
    expect(NodeFS.existsSync(marker)).toBe(false);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
