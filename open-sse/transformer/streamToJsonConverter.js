/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

// Same bounded token shape as the miner receipt consumer; never accept a URL or placeholder.
export function isReceiptIdentity(value, secret = null) {
  return typeof value === "string"
    && value === value.trim()
    && /^[A-Za-z0-9][A-Za-z0-9._:/@()+\[\]-]{0,255}$/.test(value)
    && !value.includes("://")
    && !/sk-[A-Za-z0-9_-]+|Bearer\s+\S+/i.test(value)
    && !(typeof secret === "string" && secret && value.includes(secret))
    && !["unknown", "null", "none", "unverified", "unresolved", "n/a"].includes(value.toLowerCase());
}

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!eventMatch || !dataMatch) return;

  const eventType = eventMatch[1].trim();
  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  // Keep identity separate from the requested alias and legacy completion/error handling.
  if (parsed?.error != null || parsed?.response?.error != null
      || eventType === "error" || eventType === "response.failed" || eventType === "response.incomplete"
      || ["failed", "incomplete", "cancelled"].includes(parsed?.response?.status)) {
    state.identityInvalid = true;
  }
  if (eventType === "response.created" || eventType === "response.completed" || eventType === "response.done") {
    const upstreamModel = parsed?.response?.model;
    if (upstreamModel !== undefined) {
      if (!isReceiptIdentity(upstreamModel, state.receiptSecret) || (state.model && state.model !== upstreamModel)) {
        state.identityInvalid = true;
      } else {
        state.model = upstreamModel;
      }
    }
    if (eventType !== "response.created") {
      if (parsed?.response?.status === "completed") state.identityCompleted = true;
      else state.identityInvalid = true;
    }
  }

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (eventType === "response.completed" || eventType === "response.done") {
    state.status = "completed";
    if (parsed.response?.usage) {
      state.usage.input_tokens = parsed.response.usage.input_tokens || 0;
      state.usage.output_tokens = parsed.response.usage.output_tokens || 0;
      state.usage.total_tokens = parsed.response.usage.total_tokens || 0;
    }
  } else if (eventType === "response.failed") {
    state.status = "failed";
    state.error = parsed.response?.error || parsed.error || null;
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @param {string|null} receiptSecret - Client credential that must never become model metadata
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream, receiptSecret = null) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    model: null,
    identityCompleted: false,
    identityInvalid: false,
    receiptSecret,
    usage: { ...EMPTY_RESPONSE },
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  // Build output array from accumulated items (ordered by index)
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    ...(state.error ? { error: state.error } : {}),
    ...(state.model && state.identityCompleted && !state.identityInvalid ? { model: state.model } : {}),
    output,
    usage: state.usage
  };
}
