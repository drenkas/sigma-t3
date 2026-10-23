import * as NodeModule from "node:module";

export interface SpeechRecognizer {
  readonly transcribe: (samples: Float32Array, sampleRate: number) => Promise<string>;
}

export type LoadSpeechRecognizer = (modelDir: string) => Promise<SpeechRecognizer>;

// The flat N-API addon, not the `sherpa-onnx` package: that one is WASM and
// cannot read model files from disk. It has no type definitions.
interface SherpaAddon {
  readonly createOfflineRecognizerAsync: (config: unknown) => Promise<unknown>;
  readonly createOfflineStream: (recognizer: unknown) => unknown;
  readonly acceptWaveformOffline: (
    stream: unknown,
    wave: { readonly sampleRate: number; readonly samples: Float32Array },
  ) => void;
  readonly decodeOfflineStreamAsync: (recognizer: unknown, stream: unknown) => Promise<void>;
  readonly getOfflineStreamResultAsJson: (stream: unknown) => string;
}

const SUPPORTED_TARGETS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
]);

const sherpaPackageName = (platform: string, arch: string) =>
  `sherpa-onnx-${platform === "win32" ? "win" : platform}-${arch}`;

// Like node-pty, the addon stays outside the bundle and must load through
// `require` so it resolves from the real filesystem.
const requireForSherpa = NodeModule.createRequire(import.meta.url);

/** Returns null where no recognizer build exists for this host. */
export function sherpaRecognizerLoader(
  platform: string,
  arch: string,
): LoadSpeechRecognizer | null {
  if (!SUPPORTED_TARGETS.has(`${platform}-${arch}`)) return null;
  return async (modelDir) => {
    const sherpa = requireForSherpa(sherpaPackageName(platform, arch)) as SherpaAddon;
    const recognizer = await sherpa.createOfflineRecognizerAsync({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: `${modelDir}/encoder.int8.onnx`,
          decoder: `${modelDir}/decoder.int8.onnx`,
          joiner: `${modelDir}/joiner.int8.onnx`,
        },
        tokens: `${modelDir}/tokens.txt`,
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
      decodingMethod: "greedy_search",
    });
    return {
      transcribe: async (samples, sampleRate) => {
        // An offline stream is single-use, so every utterance gets a fresh one.
        const stream = sherpa.createOfflineStream(recognizer);
        sherpa.acceptWaveformOffline(stream, { sampleRate, samples });
        await sherpa.decodeOfflineStreamAsync(recognizer, stream);
        const result = JSON.parse(sherpa.getOfflineStreamResultAsJson(stream)) as {
          readonly text?: unknown;
        };
        return typeof result.text === "string" ? result.text.trim() : "";
      },
    };
  };
}

/** Decodes mono 16-bit little-endian PCM, or returns null for a torn sample. */
export function pcm16ToFloat32(pcm: Uint8Array): Float32Array | null {
  if (pcm.byteLength % 2 !== 0) return null;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Float32Array(pcm.byteLength / 2);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = view.getInt16(index * 2, true) / 32_768;
  }
  return samples;
}
