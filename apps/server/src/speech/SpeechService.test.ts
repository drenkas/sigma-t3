import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { SpeechModel } from "./SpeechModel.ts";
import type { SpeechRecognizer } from "./SpeechRecognizer.ts";
import * as SpeechService from "./SpeechService.ts";

const encoder = new TextEncoder();
const fileBodies = { "model.onnx": encoder.encode("weights"), "tokens.txt": encoder.encode("a b") };

const makeHarness = Effect.fn("test.makeSpeechService")(function* (
  input: {
    readonly corruptFile?: keyof typeof fileBodies;
    readonly recognizer?: SpeechRecognizer;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const modelsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-speech-test-" });
  const files = yield* Effect.forEach(Object.entries(fileBodies), ([name, body]) =>
    crypto.digest("SHA-256", body).pipe(
      Effect.orDie,
      Effect.map((digest) => ({
        name,
        url: `https://models.test/${name}`,
        sizeBytes: body.byteLength,
        sha256: name === input.corruptFile ? "0".repeat(64) : Hex.encode(digest),
      })),
    ),
  );
  const model: SpeechModel = { id: "test-model", label: "Test model", files };
  const loads: string[] = [];
  const service = yield* SpeechService.makeSpeechService({
    modelsDir,
    model,
    loadRecognizer: (modelDir) => {
      loads.push(modelDir);
      return Promise.resolve(
        input.recognizer ?? { transcribe: (samples) => Promise.resolve(`${samples.length}`) },
      );
    },
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const name = new URL(request.url).pathname.slice(1) as keyof typeof fileBodies;
          return Object.defineProperty(
            HttpClientResponse.fromWeb(request, new Response(null)),
            "stream",
            { value: Stream.succeed(fileBodies[name]) },
          );
        }),
      ),
    ),
  );
  return { service, fs, modelsDir, loads };
});

const settledStatus = (service: SpeechService.SpeechService["Service"]) =>
  service.changes.pipe(
    Stream.filter((status) => status.phase === "ready" || status.phase === "failed"),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect("installs a verified model and transcribes PCM with it", () =>
  Effect.gen(function* () {
    const { service, fs, modelsDir, loads } = yield* makeHarness();
    expect((yield* service.status).phase).toBe("missing");
    expect((yield* service.install).phase).toBe("downloading");
    expect(yield* settledStatus(service)).toMatchObject({ phase: "ready", downloadedBytes: 10 });
    expect(yield* fs.readFileString(`${modelsDir}/test-model/tokens.txt`)).toBe("a b");

    const warmup = yield* service.transcribe({ sampleRate: 16_000, pcm: new Uint8Array(0) });
    expect(warmup.text).toBe("");
    expect(loads).toEqual([`${modelsDir}/test-model`]);
    const result = yield* service.transcribe({ sampleRate: 16_000, pcm: new Uint8Array(8) });
    expect(result.text).toBe("4");
    expect(loads).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a corrupted download without installing anything", () =>
  Effect.gen(function* () {
    const { service, fs, modelsDir } = yield* makeHarness({ corruptFile: "tokens.txt" });
    yield* service.install;
    const status = yield* settledStatus(service);
    expect(status.phase).toBe("failed");
    expect(status.message).toContain("SHA-256");
    expect(yield* fs.readDirectory(modelsDir)).toEqual([]);
    const error = yield* service
      .transcribe({ sampleRate: 16_000, pcm: new Uint8Array(2) })
      .pipe(Effect.flip);
    expect(error.reason).toBe("model_missing");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects torn PCM and removes the model on request", () =>
  Effect.gen(function* () {
    const { service, fs, modelsDir } = yield* makeHarness();
    yield* service.install;
    yield* settledStatus(service);
    const error = yield* service
      .transcribe({ sampleRate: 16_000, pcm: new Uint8Array(3) })
      .pipe(Effect.flip);
    expect(error.reason).toBe("invalid_audio");

    expect((yield* service.remove).phase).toBe("missing");
    expect(yield* fs.exists(`${modelsDir}/test-model`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
