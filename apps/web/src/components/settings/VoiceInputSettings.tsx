import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_UNIFIED_SETTINGS, type SpeechStatus } from "@t3tools/contracts";

import { formatBytes } from "../../lib/formatBytes";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function describeModel(status: SpeechStatus | null): string {
  if (status === null) return "Checking the speech model…";
  const size = formatBytes(status.totalBytes);
  switch (status.phase) {
    case "unsupported":
      return "This environment has no local speech recognizer for its platform.";
    case "missing":
      return `${status.modelLabel} (${size}) runs on the environment and is not downloaded yet.`;
    case "downloading":
      return `Downloading ${status.modelLabel}: ${formatBytes(status.downloadedBytes)} of ${size}.`;
    case "ready":
      return `${status.modelLabel} (${size}) is ready. Speech never leaves the environment.`;
    case "failed":
      return status.message ?? "The download failed.";
  }
}

export function VoiceInputSettingsRow() {
  const enabled = useScopedSettings((settings) => settings.voiceInputEnabled);
  const updateSettings = useUpdateScopedSettings();
  const { environment } = useSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = environment?.environmentId ?? primaryEnvironmentId;
  const status = useEnvironmentQuery(
    enabled && environmentId !== null
      ? serverEnvironment.speechStatus({ environmentId, input: {} })
      : null,
  ).data;
  const canManage = useAtomValue(
    serverEnvironment.installSpeechModel.permissionAtom(environmentId ?? null),
  );
  const installModel = useAtomCommand(serverEnvironment.installSpeechModel);
  const removeModel = useAtomCommand(serverEnvironment.removeSpeechModel);

  const modelAction =
    environmentId === null || status === null || !canManage ? null : status.phase === "ready" ? (
      <Button
        variant="outline"
        size="sm"
        onClick={() => void removeModel({ environmentId, input: {} })}
      >
        Remove model
      </Button>
    ) : status.phase === "missing" || status.phase === "failed" ? (
      <Button
        variant="outline"
        size="sm"
        onClick={() => void installModel({ environmentId, input: {} })}
      >
        {status.phase === "failed" ? "Retry download" : "Download model"}
      </Button>
    ) : null;

  return (
    <SettingsRow
      {...searchableSetting("voice-input")}
      description="Dictate into the composer. Speech is transcribed by a local model on the environment."
      status={enabled ? describeModel(status) : undefined}
      resetAction={
        enabled !== DEFAULT_UNIFIED_SETTINGS.voiceInputEnabled ? (
          <SettingResetButton
            label="voice input"
            onClick={() =>
              updateSettings({ voiceInputEnabled: DEFAULT_UNIFIED_SETTINGS.voiceInputEnabled })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => updateSettings({ voiceInputEnabled: Boolean(checked) })}
          aria-label="Voice input"
        />
      }
    >
      {enabled ? modelAction : null}
    </SettingsRow>
  );
}
