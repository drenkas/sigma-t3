export interface SpeechModelFile {
  readonly name: string;
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface SpeechModel {
  readonly id: string;
  readonly label: string;
  readonly files: ReadonlyArray<SpeechModelFile>;
}

const huggingFaceFile = (
  repository: string,
  revision: string,
  name: string,
  sizeBytes: number,
  sha256: string,
): SpeechModelFile => ({
  name,
  url: `https://huggingface.co/${repository}/resolve/${revision}/${encodeURIComponent(name)}?download=true`,
  sizeBytes,
  sha256,
});

const PARAKEET_REPOSITORY = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const PARAKEET_REVISION = "2bda32ec70b097a55adaa07d9a7173915b43cc78";

/**
 * NVIDIA Parakeet TDT 0.6B v3 (CC-BY-4.0), int8 export for sherpa-onnx. It covers
 * 25 European languages including Ukrainian and English, with punctuation.
 * The revision is pinned and every file is hash-checked, so a moved branch
 * cannot change what gets installed.
 */
export const PARAKEET_TDT_V3: SpeechModel = {
  id: "parakeet-tdt-0.6b-v3-int8",
  label: "Parakeet TDT v3",
  files: [
    huggingFaceFile(
      PARAKEET_REPOSITORY,
      PARAKEET_REVISION,
      "encoder.int8.onnx",
      652_184_281,
      "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
    ),
    huggingFaceFile(
      PARAKEET_REPOSITORY,
      PARAKEET_REVISION,
      "decoder.int8.onnx",
      11_845_275,
      "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
    ),
    huggingFaceFile(
      PARAKEET_REPOSITORY,
      PARAKEET_REVISION,
      "joiner.int8.onnx",
      6_355_277,
      "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
    ),
    huggingFaceFile(
      PARAKEET_REPOSITORY,
      PARAKEET_REVISION,
      "tokens.txt",
      93_939,
      "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
    ),
  ],
};

export const speechModelSize = (model: SpeechModel) =>
  model.files.reduce((total, file) => total + file.sizeBytes, 0);
