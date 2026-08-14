export const FORCED_MODEL_PROVIDER = "cx";
export const EXTRA_FORCED_MODELS = new Set(["ds/deepseek-v4-flash"]);

export function normalizeForcedModelValue(model) {
  if (typeof model !== "string" || !model) return "";
  if (!model.startsWith("codex/")) return model;
  return `${FORCED_MODEL_PROVIDER}/${model.slice("codex/".length)}`;
}

export function normalizeAvailableModels(models = []) {
  const seen = new Set();
  return models
    .filter((model) => {
      if ((model?.type || "llm") !== "llm") return false;
      const fullModel = normalizeForcedModelValue(model?.fullModel);
      const isAllowed = fullModel.startsWith(`${FORCED_MODEL_PROVIDER}/`) || EXTRA_FORCED_MODELS.has(fullModel);
      if (!isAllowed || seen.has(fullModel)) return false;
      seen.add(fullModel);
      return true;
    })
    .map((model) => ({ ...model, fullModel: normalizeForcedModelValue(model.fullModel) }))
    .sort((a, b) => String(a.alias || a.fullModel).localeCompare(String(b.alias || b.fullModel)));
}

export function normalizeAvailableCombos(combos = []) {
  const seen = new Set();
  return combos
    .filter((combo) => {
      const name = typeof combo?.name === "string" ? combo.name.trim() : "";
      const isLlmCombo = !combo?.kind || combo.kind === "llm";
      if (!name || !isLlmCombo || seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .map((combo) => ({
      provider: "combo",
      model: combo.name.trim(),
      name: combo.name.trim(),
      type: "combo",
      fullModel: combo.name.trim(),
      alias: combo.name.trim(),
    }))
    .sort((a, b) => a.fullModel.localeCompare(b.fullModel));
}

export function formatModelOptionLabel(model) {
  const fullModel = normalizeForcedModelValue(model?.fullModel);
  if (!fullModel) return "";
  if (model.alias && model.alias !== model.model) {
    return `${model.alias} (${fullModel})`;
  }
  return fullModel;
}
