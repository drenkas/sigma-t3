import type {
  EnvironmentId,
  ModelSelection,
  ProviderDriverKind,
  ProviderOptionSelection,
  RepositoryTaskRole,
  ServerProviderModel,
} from "@t3tools/contracts";

import { useEnvironmentProviders } from "../../state/environments";
import {
  readPromptUltrathink,
  shouldRenderTraitsControls,
  TraitsPicker,
} from "../chat/TraitsPicker";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
} from "../../providerInstances";
import { getProviderModelCapabilities } from "../../providerModels";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export const ROLES = ["implementation", "research", "review", "design", "test", "general"] as const;
export type Role = (typeof ROLES)[number];
const NO_MODEL = "none";

/** The key the pickers use for a model, independent of its options. */
export const modelKey = (selection: ModelSelection) =>
  JSON.stringify({ instanceId: selection.instanceId, model: selection.model });

/** A group's own model for a role wins over the host's default. */
export const resolveRoleModel = (
  role: Role,
  group: ReadonlyArray<RepositoryTaskRole> | undefined,
  host: ReadonlyArray<RepositoryTaskRole>,
) =>
  (group ?? []).find((entry) => entry.role === role) ?? host.find((entry) => entry.role === role);

export type AvailableModel = {
  key: string;
  selection: ModelSelection;
  label: string;
  driver: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: ServerProviderModel;
};

function unavailableModelLabel(key: string): string {
  try {
    const selection = JSON.parse(key) as { instanceId?: unknown; model?: unknown };
    return typeof selection.model === "string"
      ? `${selection.model} (${String(selection.instanceId ?? "provider")})`
      : "previous selection";
  } catch {
    return "previous selection";
  }
}

export function availableModels(
  providers: ReturnType<typeof useEnvironmentProviders>,
  environmentId: EnvironmentId | null,
): AvailableModel[] {
  if (!environmentId) return [];
  const entries = deriveProviderInstanceEntries(providers.get(environmentId) ?? []);
  return entries.flatMap((provider) =>
    isProviderInstancePickerReady(provider) && provider.snapshot.supportsTextGeneration !== false
      ? provider.models.map((model) => {
          const selection: ModelSelection = { instanceId: provider.instanceId, model: model.slug };
          return {
            key: modelKey(selection),
            selection,
            label: `${provider.displayName} · ${model.name}`,
            driver: provider.driverKind,
            models: provider.models,
            model,
          };
        })
      : [],
  );
}

export function selectedOptionsUnavailable(
  model: AvailableModel | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | undefined,
): boolean {
  if (!model || !selections?.length) return false;
  const descriptors =
    getProviderModelCapabilities(model.models, model.model.slug, model.driver).optionDescriptors ??
    [];
  return selections.some((selection) => {
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (!descriptor) return true;
    if (descriptor.type === "boolean") return typeof selection.value !== "boolean";
    return (
      typeof selection.value !== "string" ||
      !descriptor.options.some((option) => option.id === selection.value)
    );
  });
}

export function ModelSelect({
  label,
  models,
  value,
  onChange,
  emptyLabel,
}: {
  label: string;
  models: AvailableModel[];
  value: string;
  onChange: (value: string) => void;
  // Offers clearing the choice, shown when nothing is chosen.
  emptyLabel?: string;
}) {
  const selected = models.find((model) => model.key === value);
  const unavailable = !!value && !selected;
  return (
    <label className="grid min-w-0 gap-1 text-sm font-medium">
      {label}
      <Select
        value={value}
        onValueChange={(next) => onChange(!next || next === NO_MODEL ? "" : next)}
      >
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue>
            {selected?.label ??
              (unavailable
                ? `Unavailable: ${unavailableModelLabel(value)}`
                : emptyLabel !== undefined
                  ? emptyLabel
                  : models.length
                    ? "Choose a model"
                    : "No available models")}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {emptyLabel !== undefined ? <SelectItem value={NO_MODEL}>{emptyLabel}</SelectItem> : null}
          {unavailable ? (
            <SelectItem value={value} disabled>
              Unavailable: {unavailableModelLabel(value)}
            </SelectItem>
          ) : null}
          {models.map((model) => (
            <SelectItem key={model.key} value={model.key}>
              {model.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </label>
  );
}

export function ModelOptionsPicker({
  model,
  options,
  prompt,
  onPromptChange,
  onChange,
  disabled,
  selectionLabel,
}: {
  model: AvailableModel | undefined;
  options: ReadonlyArray<ProviderOptionSelection> | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onChange: (options: ReadonlyArray<ProviderOptionSelection> | undefined) => void;
  disabled: boolean;
  selectionLabel: string;
}) {
  if (!model) return null;
  const promptUltrathink = readPromptUltrathink(prompt);
  const hasOptions = shouldRenderTraitsControls({
    provider: model.driver,
    models: model.models,
    model: model.selection.model,
    promptUltrathink,
    modelOptions: options,
    allowPromptInjectedEffort: false,
    planModeEnabled: true,
  });
  const hasStaleOptions = selectedOptionsUnavailable(model, options);
  if (!hasOptions && !hasStaleOptions) return null;
  return (
    <div className="flex items-center gap-2">
      {hasOptions ? (
        <>
          <span className="text-xs font-medium text-muted-foreground">Options</span>
          <TraitsPicker
            provider={model.driver}
            instanceId={model.selection.instanceId}
            models={model.models}
            model={model.selection.model}
            promptUltrathink={promptUltrathink}
            onPromptEdit={(edit) => onPromptChange(edit(prompt))}
            modelOptions={options}
            onModelOptionsChange={onChange}
            allowPromptInjectedEffort={false}
            planModeEnabled={true}
            disabled={disabled}
          />
        </>
      ) : null}
      {hasStaleOptions ? (
        <>
          <span role="status" className="text-xs text-destructive">
            Saved options are no longer advertised.
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onChange(undefined)}
          >
            Clear unavailable options for {selectionLabel}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** Picks a saved model, with its options, for each role; a role left empty is not saved. */
export function RoleModelsEditor({
  label,
  scope,
  emptyLabel,
  models,
  value,
  onChange,
}: {
  label: string;
  // Names each picker apart from the task form's role pickers.
  scope: string;
  emptyLabel: string;
  models: AvailableModel[];
  value: ReadonlyArray<RepositoryTaskRole>;
  onChange: (roles: RepositoryTaskRole[]) => void;
}) {
  const update = (role: Role, modelSelection: ModelSelection | null) =>
    onChange(
      ROLES.flatMap((entry) => {
        if (entry === role) return modelSelection ? [{ role, modelSelection }] : [];
        const saved = value.find((item) => item.role === entry);
        return saved ? [saved] : [];
      }),
    );
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      {ROLES.map((role) => {
        const saved = value.find((entry) => entry.role === role)?.modelSelection;
        const key = saved ? modelKey(saved) : "";
        const model = models.find((entry) => entry.key === key);
        return (
          <div key={role} className="space-y-2 rounded-lg bg-muted/40 p-3">
            <ModelSelect
              label={`${role.charAt(0).toUpperCase()}${role.slice(1)} (${scope})`}
              models={models}
              value={key}
              emptyLabel={emptyLabel}
              onChange={(next) =>
                update(role, models.find((entry) => entry.key === next)?.selection ?? null)
              }
            />
            <ModelOptionsPicker
              model={model}
              options={saved?.options}
              prompt=""
              onPromptChange={() => {}}
              onChange={(options) =>
                model &&
                update(role, options?.length ? { ...model.selection, options } : model.selection)
              }
              disabled={!model}
              selectionLabel={`${role} model`}
            />
          </div>
        );
      })}
    </fieldset>
  );
}
