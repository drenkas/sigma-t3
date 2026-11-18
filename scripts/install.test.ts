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

// regression: #38234
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("concurrent installers", () => {
  it("publishes one runtime without nesting the other install's staging directory", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-concurrent-"));
    const version = "1.2.3";
    const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
    const archiveName = `${stem}.tar.gz`;
    const target = NodePath.join(root, "home/runtime/versions", version);
    const waiting = new Map<string, NodeHttp.ServerResponse>();
    const server = NodeHttp.createServer();
    try {
      const tools = NodePath.join(root, "tools");
      await NodeFSP.mkdir(tools);
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      const archivePath = NodePath.join(root, archiveName);
      NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, stem]);
      const archive = await NodeFSP.readFile(archivePath);
      const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      server.on("request", (request, response) => {
        if (request.url?.startsWith("/ready/")) {
          waiting.set(request.url.slice(7), response);
          if (waiting.size === 2) waiting.get("first")!.end("go");
        } else if (request.url === "/published") {
          waiting.get("second")!.end("go");
          response.end("ok");
        } else {
          response.end(
            request.url?.endsWith("/SHA256SUMS") ? `${digest}  ${archiveName}\n` : archive,
          );
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const origin = `http://127.0.0.1:${address.port}`;
      const realMv = NodeChildProcess.execFileSync("sh", ["-c", "command -v mv"], {
        encoding: "utf8",
      }).trim();
      // Hold publication until both installers have removed the destination, then let them rename in order.
      const wrapper = NodePath.join(tools, "mv.mjs");
      await NodeFSP.writeFile(
        wrapper,
        `
import { execFileSync } from 'node:child_process';
await fetch(process.env.T3_TEST_ORIGIN + '/ready/' + process.env.T3_TEST_INSTALLER);
execFileSync(${JSON.stringify(realMv)}, process.argv.slice(2));
if (process.env.T3_TEST_INSTALLER === 'first') await fetch(process.env.T3_TEST_ORIGIN + '/published');
`,
      );
      await NodeFSP.writeFile(
        NodePath.join(tools, "mv"),
        `#!/bin/sh\nexec '${process.execPath}' '${wrapper}' "$@"\n`,
        { mode: 0o755 },
      );
      const install = (id: string) =>
        new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          const child = NodeChildProcess.spawn(
            "sh",
            [NodePath.join(import.meta.dirname, "install.sh")],
            {
              env: {
                ...process.env,
                PATH: `${tools}:${process.env.PATH}`,
                T3CODE_VERSION: version,
                T3CODE_HOME: NodePath.join(root, "home"),
                T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin", id),
                T3CODE_RELEASE_BASE_URL: origin,
                T3_TEST_ORIGIN: origin,
                T3_TEST_INSTALLER: id,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, output }));
        });
      const results = await Promise.all([install("first"), install("second")]);
      for (const result of results) expect(result.code, result.output).toBe(0);
      expect(
        (await NodeFSP.readdir(target)).filter((name) => name.startsWith(".staging-")),
        "concurrent installs must not leave a nested runtime",
      ).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
