// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import {
  SpeechError,
  type SpeechErrorReason,
  type SpeechStatus,
  type SpeechTranscribeInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../config.ts";
import { PARAKEET_TDT_V3, speechModelSize, type SpeechModel } from "./SpeechModel.ts";
import {
  type LoadSpeechRecognizer,
  pcm16ToFloat32,
  type SpeechRecognizer,
  sherpaRecognizerLoader,
} from "./SpeechRecognizer.ts";

// The client caps a recording at five minutes; this only bounds what a
// misbehaving client can make the recognizer chew on.
const MAX_AUDIO_SECONDS = 6 * 60;
// The loaded model holds about 1.5 GB, so it is dropped once dictation goes quiet.
const RECOGNIZER_IDLE_RELEASE = "5 minutes";

interface SpeechServiceShape {
  readonly status: Effect.Effect<SpeechStatus>;
  readonly changes: Stream.Stream<SpeechStatus>;
  readonly install: Effect.Effect<SpeechStatus, SpeechError>;
  readonly remove: Effect.Effect<SpeechStatus, SpeechError>;
  readonly transcribe: (
    input: SpeechTranscribeInput,
  ) => Effect.Effect<{ readonly text: string }, SpeechError>;
}

export class SpeechService extends Context.Service<SpeechService, SpeechServiceShape>()(
  "t3/speech/SpeechService",
) {}

export interface SpeechServiceOptions {
  readonly modelsDir: string;
  readonly model?: SpeechModel;
  /** Null means this host has no recognizer build. */
  readonly loadRecognizer?: LoadSpeechRecognizer | null;
}

const isSpeechError = Schema.is(SpeechError);
const speechError = (reason: SpeechErrorReason, detail: string) =>
  new SpeechError({ reason, detail });

export const makeSpeechService = Effect.fn("makeSpeechService")(function* (
  options: SpeechServiceOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;
  const model = options.model ?? PARAKEET_TDT_V3;
  const loadRecognizer =
    options.loadRecognizer === undefined
      ? sherpaRecognizerLoader(yield* HostProcess.Platform, yield* HostProcess.Architecture)
      : options.loadRecognizer;
  const modelDir = path.join(options.modelsDir, model.id);
  const stagingDir = path.join(options.modelsDir, `.${model.id}.partial`);
  const totalBytes = speechModelSize(model);

  // Files are hash-checked before the staging directory is renamed into
  // place, so a complete set of correctly sized files is an installed model.
  const isInstalled = Effect.forEach(model.files, (file) =>
    fs.stat(path.join(modelDir, file.name)).pipe(
      Effect.map((info) => info.type === "File" && Number(info.size) === file.sizeBytes),
      Effect.orElseSucceed(() => false),
    ),
  ).pipe(Effect.map((checks) => checks.every(Boolean)));

  const baseStatus = {
    modelId: model.id,
    modelLabel: model.label,
    totalBytes,
  };
  const state = yield* SubscriptionRef.make<SpeechStatus>({
    ...baseStatus,
    phase: loadRecognizer === null ? "unsupported" : (yield* isInstalled) ? "ready" : "missing",
    downloadedBytes: 0,
    message: null,
  });

  const installGate = yield* Semaphore.make(1);
  const recognizerGate = yield* Semaphore.make(1);
  let recognizer: SpeechRecognizer | null = null;
  let idleRelease: Fiber.Fiber<void> | null = null;

  const download = Effect.fn("SpeechService.download")(function* () {
    yield* fs.remove(stagingDir, { recursive: true, force: true });
    yield* fs.makeDirectory(stagingDir, { recursive: true });
    let downloadedBytes = 0;
    let lastProgressAt = yield* Clock.currentTimeMillis;
    for (const file of model.files) {
      const hash = NodeCrypto.createHash("sha256");
      let fileBytes = 0;
      const response = yield* http
        .execute(HttpClientRequest.get(file.url))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            fileBytes += chunk.byteLength;
            downloadedBytes += chunk.byteLength;
            if (fileBytes > file.sizeBytes) {
              return yield* speechError(
                "write_failed",
                `${file.name} is larger than the published model file.`,
              );
            }
            hash.update(chunk);
            const now = yield* Clock.currentTimeMillis;
            if (now - lastProgressAt >= 250) {
              lastProgressAt = now;
              yield* SubscriptionRef.update(state, (current) => ({ ...current, downloadedBytes }));
            }
          }),
        ),
        Stream.run(fs.sink(path.join(stagingDir, file.name), { flag: "wx", mode: 0o600 })),
      );
      if (fileBytes !== file.sizeBytes || hash.digest("hex") !== file.sha256) {
        return yield* speechError(
          "write_failed",
          `${file.name} failed its size or SHA-256 check. Nothing was installed.`,
        );
      }
    }
    yield* fs.remove(modelDir, { recursive: true, force: true });
    yield* fs.rename(stagingDir, modelDir);
  });

  const install = installGate.withPermit(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);
      if (current.phase === "unsupported") {
        return yield* speechError(
          "unsupported_platform",
          "Voice input has no local recognizer for this machine.",
        );
      }
      if (current.phase === "downloading" || current.phase === "ready") return current;
      const next: SpeechStatus = {
        ...baseStatus,
        phase: "downloading",
        downloadedBytes: 0,
        message: null,
      };
      yield* SubscriptionRef.set(state, next);
      const work = download().pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? SubscriptionRef.set(state, {
                ...baseStatus,
                phase: "ready",
                downloadedBytes: totalBytes,
                message: null,
              })
            : fs.remove(stagingDir, { recursive: true, force: true }).pipe(
                Effect.ignore,
                Effect.andThen(
                  SubscriptionRef.set(state, {
                    ...baseStatus,
                    phase: "failed",
                    downloadedBytes: 0,
                    message: Option.match(Cause.findErrorOption(exit.cause), {
                      onNone: () => "The model download stopped. Check the connection and retry.",
                      onSome: (error) =>
                        isSpeechError(error)
                          ? error.detail
                          : "The model download failed. Check the connection and disk space.",
                    }),
                  }),
                ),
              ),
        ),
        Effect.ignoreCause,
      );
      yield* Effect.forkIn(Effect.interruptible(work), serviceScope);
      return next;
    }).pipe(Effect.uninterruptible),
  );

  const remove = installGate.withPermit(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);
      if (current.phase === "downloading") {
        return yield* speechError("busy", "Wait for the model download to finish.");
      }
      yield* recognizerGate.withPermit(
        Effect.sync(() => {
          recognizer = null;
        }),
      );
      yield* fs
        .remove(modelDir, { recursive: true, force: true })
        .pipe(
          Effect.mapError(() =>
            speechError("write_failed", "Could not delete the speech model files."),
          ),
        );
      const next: SpeechStatus = {
        ...baseStatus,
        phase: current.phase === "unsupported" ? "unsupported" : "missing",
        downloadedBytes: 0,
        message: null,
      };
      yield* SubscriptionRef.set(state, next);
      return next;
    }),
  );

  const scheduleIdleRelease = Effect.gen(function* () {
    if (idleRelease !== null) yield* Fiber.interrupt(idleRelease);
    idleRelease = yield* Effect.sleep(RECOGNIZER_IDLE_RELEASE).pipe(
      Effect.andThen(
        recognizerGate.withPermit(
          Effect.sync(() => {
            recognizer = null;
          }),
        ),
      ),
      Effect.forkIn(serviceScope),
    );
  });

  const transcribe = Effect.fn("SpeechService.transcribe")(function* (
    input: SpeechTranscribeInput,
  ) {
    const current = yield* SubscriptionRef.get(state);
    if (current.phase !== "ready" || loadRecognizer === null) {
      return yield* speechError("model_missing", "Download the voice input model in Settings.");
    }
    const samples = pcm16ToFloat32(input.pcm);
    if (samples === null || samples.length / input.sampleRate > MAX_AUDIO_SECONDS) {
      return yield* speechError("invalid_audio", "The recording could not be read.");
    }
    const text = yield* recognizerGate.withPermit(
      Effect.gen(function* () {
        const ready =
          recognizer ??
          (yield* Effect.tryPromise({
            try: () => loadRecognizer(modelDir),
            catch: () =>
              speechError(
                "transcription_failed",
                "The speech model could not be loaded. Remove it and download it again.",
              ),
          }));
        recognizer = ready;
        // Clients send an empty recording when the microphone opens, so the
        // model loads while the user speaks instead of after they stop.
        if (samples.length === 0) return "";
        return yield* Effect.tryPromise({
          try: () => ready.transcribe(samples, input.sampleRate),
          catch: () =>
            speechError("transcription_failed", "The recording could not be transcribed."),
        });
      }),
    );
    yield* scheduleIdleRelease;
    return { text };
  });

  return SpeechService.of({
    status: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    install,
    remove,
    transcribe,
  });
});

export const layer = Layer.effect(
  SpeechService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* makeSpeechService({ modelsDir: path.join(config.baseDir, "speech-models") });
  }),
);
