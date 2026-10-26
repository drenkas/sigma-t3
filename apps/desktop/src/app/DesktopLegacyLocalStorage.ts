import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export class DesktopLegacyLocalStorage extends Context.Service<
  DesktopLegacyLocalStorage,
  {
    readonly load: (userDataPath: string) => Effect.Effect<void>;
    readonly take: Effect.Effect<Option.Option<Readonly<Record<string, string>>>>;
    readonly complete: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopLegacyLocalStorage") {}

// History import is a separate, explicitly authorized operation for this fork.
export const layer = Layer.succeed(
  DesktopLegacyLocalStorage,
  DesktopLegacyLocalStorage.of({
    load: (_userDataPath) => Effect.void,
    take: Effect.succeedNone,
    complete: Effect.void,
  }),
);
