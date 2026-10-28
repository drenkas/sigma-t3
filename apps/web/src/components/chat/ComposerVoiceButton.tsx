import type { EnvironmentId } from "@t3tools/contracts";
import { EllipsisIcon, MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { startVoiceRecording, type VoiceRecording } from "./voiceRecording";

type Phase = "idle" | "recording" | "transcribing";

// Matches the mobile composer's cap and keeps one request well under the server's limit.
const RECORDING_LIMIT_MS = 5 * 60 * 1000;
const METER_BARS = 12;
const METER_INTERVAL_MS = 80;

function VoiceLevelMeter({ level }: { readonly level: () => number }) {
  const bars = useRef<Array<HTMLSpanElement | null>>([]);

  // oxlint-disable-next-line t3code/react-effect-budget -- samples the live microphone level while recording
  useEffect(() => {
    const history: number[] = Array.from({ length: METER_BARS }, () => 0);
    // Mutating the bars directly keeps a 12 Hz meter from re-rendering the composer.
    const timer = window.setInterval(() => {
      history.shift();
      history.push(level());
      history.forEach((value, index) => {
        const bar = bars.current[index];
        if (bar) bar.style.transform = `scaleY(${Math.max(0.12, value).toFixed(3)})`;
      });
    }, METER_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [level]);

  return (
    <span aria-hidden className="flex h-4 items-center gap-0.5 px-1">
      {Array.from({ length: METER_BARS }, (_, index) => (
        <span
          key={index}
          ref={(element) => {
            bars.current[index] = element;
          }}
          className="h-full w-0.5 scale-y-[0.12] rounded-full bg-destructive"
        />
      ))}
    </span>
  );
}

export function ComposerVoiceButton({
  environmentId,
  onTranscript,
}: {
  readonly environmentId: EnvironmentId;
  readonly onTranscript: (text: string) => void;
}) {
  const status = useEnvironmentQuery(
    serverEnvironment.speechStatus({ environmentId, input: {} }),
  ).data;
  const transcribe = useAtomCommand(serverEnvironment.transcribeSpeech);
  const warmUp = useAtomCommand(serverEnvironment.transcribeSpeech, { reportFailure: false });
  const [phase, setPhase] = useState<Phase>("idle");
  const [level, setLevel] = useState<(() => number) | null>(null);
  const recording = useRef<VoiceRecording | null>(null);
  const limitTimer = useRef<number | null>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- releases the microphone if the composer unmounts mid-recording
  useEffect(
    () => () => {
      recording.current?.cancel();
      if (limitTimer.current !== null) window.clearTimeout(limitTimer.current);
    },
    [],
  );

  const finish = async () => {
    const active = recording.current;
    if (active === null) return;
    recording.current = null;
    if (limitTimer.current !== null) window.clearTimeout(limitTimer.current);
    setPhase("transcribing");
    setLevel(null);
    try {
      const audio = await active.stop();
      const result = await transcribe({ environmentId, input: audio });
      if (result._tag !== "Success") return;
      const text = result.value.text.trim();
      if (text.length > 0) {
        onTranscript(text);
      } else {
        toastManager.add({
          type: "warning",
          title: "No speech recognized",
          description: "Check that Sigma T3 can use the microphone and speak a little louder.",
        });
      }
    } catch {
      toastManager.add({ type: "error", title: "Could not read the recording." });
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
