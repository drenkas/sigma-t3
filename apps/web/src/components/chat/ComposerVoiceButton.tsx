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
  const recording = useRef<VoiceRecording | null>(null);
  const limitTimer = useRef<number | null>(null);

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
    try {
      const audio = await active.stop();
      const result = await transcribe({ environmentId, input: audio });
      if (result._tag === "Success" && result.value.text.length > 0) {
        onTranscript(result.value.text);
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
    try {
      recording.current = await startVoiceRecording();
    } catch {
      toastManager.add({
        type: "error",
        title: "Microphone unavailable",
        description: "Allow microphone access for Sigma T3 and try again.",
      });
      return;
    }
    setPhase("recording");
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
  );
}
