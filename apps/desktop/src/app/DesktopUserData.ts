import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: {
    readonly appDataDirectory: string;
    readonly isDevelopment: boolean;
    readonly platform: NodeJS.Platform;
  }) {
    const path = yield* Path.Path;
    // Official profiles and credential keys must never be imported implicitly.
    return path.join(input.appDataDirectory, input.isDevelopment ? "sigma-t3-dev" : "sigma-t3");
  },
);
