import type { EnvironmentId } from "@t3tools/contracts";
import { EllipsisIcon, MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { startVoiceRecording, type VoiceRecording } from "./voiceRecording";

export type ComposerVoicePhase = "idle" | "recording" | "transcribing";
type Phase = ComposerVoicePhase;

export type VoiceTranscriptOutcome = "inserted" | "empty" | "failed";

export interface ComposerVoiceHandle {
  /** Stops an active recording and inserts its transcript, like the mic button does. */
  readonly stopAndTranscribe: () => Promise<VoiceTranscriptOutcome>;
}

// Matches the mobile composer's cap and keeps one request well under the server's limit.
const RECORDING_LIMIT_MS = 5 * 60 * 1000;
const METER_INTERVAL_MS = 55;
const METER_WIDTH = 120;
const METER_HEIGHT = 28;
const METER_HISTORY = 12;
const METER_COLORS = ["#f472b6", "#a78bfa", "#60a5fa"];
// Translucent layers at different heights and ripple phases give the wave depth.
const METER_LAYERS = [
  { alpha: 0.35, scale: 1, phase: 0 },
  { alpha: 0.55, scale: 0.75, phase: 2.1 },
  { alpha: 1, scale: 0.5, phase: 4.2 },
];

function waveHalfHeight(
  history: readonly number[],
  x: number,
  tick: number,
  layer: (typeof METER_LAYERS)[number],
) {
  const progress = x / METER_WIDTH;
  // Cosine interpolation between level samples gives the smooth, swelling outline.
  const position = progress * (history.length - 1);
  const index = Math.floor(position);
  const blend = (1 - Math.cos((position - index) * Math.PI)) / 2;
  const from = history[index] ?? 0;
  const to = history[Math.min(index + 1, history.length - 1)] ?? from;
  const level = from + (to - from) * blend;
  const taper = Math.sqrt(Math.sin(progress * Math.PI));
  const ripple = 0.85 + 0.15 * Math.sin(x * 0.25 + tick * 0.6 + layer.phase);
  return Math.max(0.6, level * taper * ripple * layer.scale * (METER_HEIGHT / 2 - 1));
}

function drawWaveform(context: CanvasRenderingContext2D, history: readonly number[], tick: number) {
  const middle = METER_HEIGHT / 2;
  context.clearRect(0, 0, METER_WIDTH, METER_HEIGHT);
  for (const layer of METER_LAYERS) {
    context.globalAlpha = layer.alpha;
    context.beginPath();
    context.moveTo(0, middle);
    for (let x = 0; x <= METER_WIDTH; x++) {
      context.lineTo(x, middle - waveHalfHeight(history, x, tick, layer));
    }
    for (let x = METER_WIDTH; x >= 0; x--) {
      context.lineTo(x, middle + waveHalfHeight(history, x, tick, layer));
    }
    context.closePath();
    context.fill();
  }
  context.globalAlpha = 1;
}

function VoiceLevelMeter({ level }: { readonly level: () => number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- samples the live microphone level while recording
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = METER_WIDTH * scale;
    canvas.height = METER_HEIGHT * scale;
    context.scale(scale, scale);
    const gradient = context.createLinearGradient(0, 0, METER_WIDTH, 0);
    METER_COLORS.forEach((color, index) =>
      gradient.addColorStop(index / (METER_COLORS.length - 1), color),
    );
    context.fillStyle = gradient;
    const history: number[] = Array.from({ length: METER_HISTORY }, () => 0);
    let tick = 0;
    drawWaveform(context, history, tick);
    // Drawing on a canvas at 18 Hz keeps the meter from re-rendering the composer.
    const timer = window.setInterval(() => {
      history.shift();
      history.push(level());
      drawWaveform(context, history, ++tick);
    }, METER_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [level]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="mx-1 shrink-0"
      style={{ width: METER_WIDTH, height: METER_HEIGHT }}
    />
  );
}

export function ComposerVoiceButton({
  environmentId,
  onTranscript,
  onPhaseChange,
  ref,
}: {
  readonly environmentId: EnvironmentId;
  readonly onTranscript: (text: string) => boolean;
  readonly onPhaseChange: (phase: ComposerVoicePhase) => void;
  readonly ref: Ref<ComposerVoiceHandle>;
}) {
  const status = useEnvironmentQuery(
    serverEnvironment.speechStatus({ environmentId, input: {} }),
  ).data;
  const transcribe = useAtomCommand(serverEnvironment.transcribeSpeech);
  const warmUp = useAtomCommand(serverEnvironment.transcribeSpeech, { reportFailure: false });
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [level, setLevel] = useState<(() => number) | null>(null);
  const recording = useRef<VoiceRecording | null>(null);
  const limitTimer = useRef<number | null>(null);
  const setPhase = (next: Phase) => {
    setPhaseState(next);
    onPhaseChange(next);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the microphone if the composer unmounts mid-recording
  useEffect(
    () => () => {
      recording.current?.cancel();
      if (limitTimer.current !== null) window.clearTimeout(limitTimer.current);
      onPhaseChange("idle");
    },
    [onPhaseChange],
  );

  const finish = async (): Promise<VoiceTranscriptOutcome> => {
    const active = recording.current;
    if (active === null) return "failed";
    recording.current = null;
    if (limitTimer.current !== null) window.clearTimeout(limitTimer.current);
    setPhase("transcribing");
    setLevel(null);
    try {
      const audio = await active.stop();
      const result = await transcribe({ environmentId, input: audio });
      if (result._tag !== "Success") return "failed";
      const text = result.value.text.trim();
      if (text.length > 0) {
        return onTranscript(text) ? "inserted" : "failed";
      }
      toastManager.add({
        type: "warning",
        title: "No speech recognized",
        description: "Check that Sigma T3 can use the microphone and speak a little louder.",
      });
      return "empty";
    } catch {
      toastManager.add({ type: "error", title: "Could not read the recording." });
      return "failed";
    } finally {
      setPhase("idle");
    }
  };

  const start = async () => {
    if (status?.phase !== "ready") {
      toastManager.add({
        type: "info",
        title: "Voice input needs its speech model",
        description: "Download it in Settings → General → Voice input.",
      });
      return;
    }
    let started: VoiceRecording;
    try {
      started = await startVoiceRecording();
    } catch {
      toastManager.add({
        type: "error",
        title: "Microphone unavailable",
        description: "Allow microphone access for Sigma T3 and try again.",
      });
      return;
    }
    recording.current = started;
    setPhase("recording");
    setLevel(() => started.level);
    limitTimer.current = window.setTimeout(() => void finish(), RECORDING_LIMIT_MS);
    void warmUp({ environmentId, input: { sampleRate: 16_000, pcm: new Uint8Array(0) } });
  };

  useImperativeHandle(ref, () => ({ stopAndTranscribe: finish }));

  const label =
    phase === "recording"
      ? "Stop and transcribe"
      : phase === "transcribing"
        ? "Transcribing"
        : "Dictate";
  return (
    <span className="flex items-center">
      {level ? <VoiceLevelMeter level={level} /> : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant={phase === "recording" ? "destructive-outline" : "ghost"}
              size="icon-sm"
              disabled={phase === "transcribing"}
              aria-pressed={phase === "recording"}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => void (phase === "recording" ? finish() : start())}
              aria-label={label}
            />
          }
        >
          {phase === "recording" ? (
            <SquareIcon />
          ) : phase === "transcribing" ? (
            <EllipsisIcon />
          ) : (
            <MicIcon />
          )}
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
    </span>
  );
}
