import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

export const SpeechModelPhase = Schema.Literals([
  "unsupported",
  "missing",
  "downloading",
  "ready",
  "failed",
]);
export type SpeechModelPhase = typeof SpeechModelPhase.Type;

export const SpeechStatus = Schema.Struct({
  modelId: Schema.String,
  modelLabel: Schema.String,
  phase: SpeechModelPhase,
  downloadedBytes: NonNegativeInt,
  totalBytes: NonNegativeInt,
  message: Schema.NullOr(Schema.String),
});
export type SpeechStatus = typeof SpeechStatus.Type;

/** Mono 16-bit little-endian PCM; the recognizer resamples to the model's rate. */
export const SpeechTranscribeInput = Schema.Struct({
  sampleRate: PositiveInt,
  pcm: Schema.Uint8ArrayFromBase64,
});
export type SpeechTranscribeInput = typeof SpeechTranscribeInput.Type;

export const SpeechTranscribeResult = Schema.Struct({
  text: Schema.String,
});
export type SpeechTranscribeResult = typeof SpeechTranscribeResult.Type;

export const SpeechErrorReason = Schema.Literals([
  "unsupported_platform",
  "model_missing",
  "busy",
  "invalid_audio",
  "transcription_failed",
  "write_failed",
]);
export type SpeechErrorReason = typeof SpeechErrorReason.Type;

export class SpeechError extends Schema.TaggedError<SpeechError>()("SpeechError", {
  reason: SpeechErrorReason,
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}
