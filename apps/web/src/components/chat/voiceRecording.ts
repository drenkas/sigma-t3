const TRANSCRIPTION_SAMPLE_RATE = 16_000;

export interface VoiceRecording {
  /** Resolves with mono 16-bit little-endian PCM at 16 kHz. */
  readonly stop: () => Promise<{ readonly pcm: Uint8Array; readonly sampleRate: number }>;
  readonly cancel: () => void;
}

/**
 * Records with MediaRecorder and converts once at the end. The recognizer is
 * offline, so streaming raw samples during capture would only add traffic.
 */
export async function startVoiceRecording(): Promise<VoiceRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  recorder.start();
  return {
    stop: () =>
      new Promise((resolve, reject) => {
        recorder.addEventListener(
          "stop",
          () => {
            release();
            encodePcm16(new Blob(chunks, { type: recorder.mimeType })).then(resolve, reject);
          },
          { once: true },
        );
        recorder.stop();
      }),
    cancel: () => {
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
  };
}

async function encodePcm16(blob: Blob) {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void context.close();
  }
  // A one-channel offline context downmixes and resamples in a single render.
  const frames = Math.max(1, Math.ceil(decoded.duration * TRANSCRIPTION_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, TRANSCRIPTION_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const samples = (await offline.startRendering()).getChannelData(0);
  const pcm = new Uint8Array(samples.length * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return { pcm, sampleRate: TRANSCRIPTION_SAMPLE_RATE };
}
