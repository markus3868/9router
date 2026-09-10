import { NextResponse } from "next/server";
import { getCustomModels, getModelAliases, setModelAlias } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias } from "@/shared/constants/providers";
import { capabilitiesFromServiceKind, getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// GET /api/models - Get models with aliases
export async function GET() {
  try {
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();
    const customModels = await getCustomModels();
    const aliasByFullModel = {};
    for (const [alias, fullModel] of Object.entries(modelAliases)) {
      if (typeof fullModel !== "string") continue;
      const separatorIndex = fullModel.indexOf("/");
      if (separatorIndex <= 0 || separatorIndex === fullModel.length - 1) continue;
      const provider = fullModel.slice(0, separatorIndex);
      const model = fullModel.slice(separatorIndex + 1);
      aliasByFullModel[`${getProviderAlias(provider) || provider}/${model}`] = alias;
    }

    const isModelDisabled = (providerAlias, providerId, modelId) => {
      const aliasList = disabled[providerAlias] || [];
      const providerList = disabled[providerId] || [];
      return aliasList.includes(modelId) || providerList.includes(modelId);
    };

    const modelsByFullModel = new Map();
    const addModel = ({ provider, model, name, type = "llm", caps = null }) => {
      const rawProvider = String(provider || "").trim();
      const modelId = String(model || "").trim();
      if (!rawProvider || !modelId) return;

      const providerAlias = getProviderAlias(rawProvider) || rawProvider;
      if (type !== "llm") return;
      if (isModelDisabled(providerAlias, rawProvider, modelId)) return;

      const fullModel = `${providerAlias}/${modelId}`;
      if (modelsByFullModel.has(fullModel)) return;
      const capabilities = {
        ...getCapabilitiesForModel(providerAlias, modelId),
        ...(capabilitiesFromServiceKind(type) || {}),
        ...(caps || {}),
      };

      modelsByFullModel.set(fullModel, {
        provider: providerAlias,
        model: modelId,
        name: name || modelId,
        type,
        fullModel,
        routedModel: fullModel,
        alias: aliasByFullModel[fullModel] || modelId,
        caps: {
          vision: capabilities.vision,
          search: capabilities.search,
          reasoning: capabilities.reasoning,
          contextWindow: capabilities.contextWindow,
          maxOutput: capabilities.maxOutput,
        },
      });
    };

    for (const model of AI_MODELS) {
      addModel(model);
    }

    for (const customModel of customModels) {
      addModel({
        provider: customModel?.providerAlias,
        model: customModel?.id,
        name: customModel?.name,
        type: customModel?.kind || customModel?.type || "llm",
        caps: customModel?.caps,
      });
    }

    for (const [alias, fullModel] of Object.entries(modelAliases)) {
      if (typeof fullModel !== "string") continue;
      const separatorIndex = fullModel.indexOf("/");
      if (separatorIndex <= 0 || separatorIndex === fullModel.length - 1) continue;

      addModel({
        provider: fullModel.slice(0, separatorIndex),
        model: fullModel.slice(separatorIndex + 1),
        name: alias,
      });
    }

    const models = Array.from(modelsByFullModel.values());

    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();

    // Check if alias already exists for different model
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    await setModelAlias(model, alias);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
