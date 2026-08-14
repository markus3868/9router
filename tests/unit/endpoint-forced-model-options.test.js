import { describe, expect, it } from "vitest";
import {
  normalizeAvailableCombos,
  normalizeAvailableModels,
  normalizeForcedModelValue,
} from "../../src/app/(dashboard)/dashboard/endpoint/forcedModelOptions.js";

describe("Endpoint forced model options", () => {
  it("keeps Codex models and the approved DeepSeek model only", () => {
    const models = normalizeAvailableModels([
      { provider: "cx", model: "gpt-5.6-sol", fullModel: "cx/gpt-5.6-sol", type: "llm" },
      { provider: "ds", model: "deepseek-v4-flash", fullModel: "ds/deepseek-v4-flash", type: "llm" },
      { provider: "ds", model: "deepseek-chat", fullModel: "ds/deepseek-chat", type: "llm" },
      { provider: "openai", model: "gpt-5.4", fullModel: "openai/gpt-5.4", type: "llm" },
      { provider: "cx", model: "gpt-5.5-image", fullModel: "cx/gpt-5.5-image", type: "image" },
    ]);

    expect(models.map((model) => model.fullModel)).toEqual([
      "cx/gpt-5.6-sol",
      "ds/deepseek-v4-flash",
    ]);
  });

  it("normalizes legacy codex model values", () => {
    expect(normalizeForcedModelValue("codex/gpt-5.6-sol")).toBe("cx/gpt-5.6-sol");
  });

  it("includes only LLM combos and removes duplicates", () => {
    const combos = normalizeAvailableCombos([
      { name: "9combo", kind: null },
      { name: "reasoning-combo", kind: "llm" },
      { name: "image-combo", kind: "image" },
      { name: "9combo", kind: "llm" },
    ]);

    expect(combos.map((combo) => combo.fullModel)).toEqual(["9combo", "reasoning-combo"]);
  });
});
