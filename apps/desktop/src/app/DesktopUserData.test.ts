import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["darwin", "win32"] as const)(
  "keeps production and development profiles separate from official T3 data on %s",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "sigma-t3-profile-" });
      for (const name of ["t3code", "t3code-v2", "T3 Code (Alpha)", "T3 Code (Dev)"]) {
        yield* fs.makeDirectory(path.join(directory, name));
        yield* fs.writeFileString(
          path.join(directory, name, "Local State"),
          "official credentials",
        );
      }
      for (const isDevelopment of [false, true]) {
        const destination = yield* resolveUserDataPath({
          appDataDirectory: directory,
          isDevelopment,
          platform,
        });
        assert.equal(
          destination,
          path.join(directory, isDevelopment ? "sigma-t3-dev" : "sigma-t3"),
        );
        assert.isFalse(yield* fs.exists(path.join(destination, "Local State")));
      }
      assert.equal(
        yield* fs.readFileString(path.join(directory, "t3code", "Local State")),
        "official credentials",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
