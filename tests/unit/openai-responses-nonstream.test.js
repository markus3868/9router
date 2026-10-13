import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { convertResponsesStreamToJson } = await import("../../open-sse/transformer/streamToJsonConverter.js");

it.each(["failed", "in_progress"])("returns 502 for a %s Codex stream without marking success", async (status) => {
  const raw = status === "failed"
    ? 'event: response.failed\ndata: {"response":{"error":{"message":"upstream overloaded"}}}\n\n'
    : 'event: response.created\ndata: {"response":{"id":"resp_incomplete"}}\n\n';
  const onRequestSuccess = vi.fn();
  const appendLog = vi.fn();
  const result = await handleForcedSSEToJson({
    providerResponse: new Response(raw, { headers: { "content-type": "text/event-stream" } }),
    sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI_RESPONSES,
    provider: "codex", model: "fixture", body: {}, stream: false,
    requestStartTime: Date.now(), trackDone: vi.fn(), onRequestSuccess, appendLog,
  });
  expect(result.success).toBe(false);
  expect(result.response.status).toBe(502);
  expect((await result.response.json()).error.message).toBe(
    status === "failed" ? "upstream overloaded" : "Upstream response in_progress");
  expect(onRequestSuccess).not.toHaveBeenCalled();
  expect(appendLog).not.toHaveBeenCalled();
});

// A chat.completion body as returned by a chat-native upstream (e.g. op-ericding)
const CHAT_TOOL_BODY = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1700000000,
  model: "cl/claude-haiku-4-5",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }]
    },
    finish_reason: "tool_calls"
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
};

describe("non-stream Chat upstream for a Responses-API client (op-ericding bug)", () => {
  it("translates chat.completion tool_calls into Responses function_call output", () => {
    // translateNonStreamingResponse(body, targetFormat=PROVIDER format, sourceFormat=CLIENT format)
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    expect(out.object).toBe("response");
    expect(out).not.toHaveProperty("choices");
    const fc = (out.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.call_id).toBe("call_1");
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"ls\"}");
  });

  it("translates marked Chat tools into Responses custom_tool_call output", () => {
    const customBody = structuredClone(CHAT_TOOL_BODY);
    customBody.choices[0].message.tool_calls[0] = {
      id: "call_exec",
      type: "function",
      function: {
        name: "exec",
        arguments: "{\"input\":\"return await tools.shell({command: 'pwd'});\"}"
      }
    };
    const out = translateNonStreamingResponse(
      customBody,
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      new Set(["exec"])
    );
    const call = (out.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_exec",
      name: "exec",
      input: "return await tools.shell({command: 'pwd'});"
    });
    expect(out.output.some((item) => item.type === "function_call")).toBe(false);
  });

  it("keeps chat.completion text content as a Responses message item", () => {
    const body = {
      ...CHAT_TOOL_BODY,
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }]
    };
    const out = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    const msg = (out.output || []).find((o) => o.type === "message");
    expect(msg).toBeTruthy();
    expect(msg.content[0].type).toBe("output_text");
    expect(msg.content[0].text).toBe("hello");
  });

  it("leaves chat->chat untouched", () => {
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI);
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });
});

describe("forced-SSE JSON path for a Responses-API client behind a chat upstream", () => {
  const sseCtx = (sourceFormat, targetFormat) => {
    const encoder = new TextEncoder();
    const raw = [
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"shell","arguments":""}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"pwd\\"}"}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    return {
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat,
      targetFormat,
      provider: "op-test-chat",
      model: "gpt-x",
      body: { model: "gpt-x", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/responses" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    };
  };

  it("parses chat SSE chunks and returns a Responses function_call body", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("response");
    const fc = (json.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"pwd\"}");
  });

  it("returns a custom_tool_call for a marked tool", async () => {
    const ctx = sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
    ctx.customToolNames = new Set(["shell"]);
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    const call = (json.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_9",
      name: "shell",
      input: "{\"cmd\":\"pwd\"}"
    });
  });

  it("still returns chat.completion for a plain chat client", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });
});

describe("forced Responses JSON identity receipts", () => {
  const upstreamModel = "actual-model-20261014[1m]";
  const requestedModel = "selected-alias";
  const usage = { input_tokens: 13, output_tokens: 7, total_tokens: 20 };
  const output = [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    { type: "function_call", id: "fc_original", call_id: "call_original", name: "reason_and_summarize", arguments: '{"answer":"unchanged"}' }
  ];
  const frame = (event, response = {}) => ({ event, data: { response } });
  const created = (model = upstreamModel) => frame("response.created", { id: "resp_identity", created_at: 1700000000, status: "in_progress", model });
  const completed = (model = upstreamModel) => frame("response.completed", { status: "completed", model, usage });
  const items = output.map((item, output_index) => ({ event: "response.output_item.done", data: { output_index, item } }));
  const rawStream = (events) => events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}`).join("\n\n");
  const context = (events, overrides = {}) => ({
    providerResponse: new Response(rawStream(events), { headers: { "content-type": "text/event-stream" } }),
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    provider: "codex",
    model: requestedModel,
    body: { model: requestedModel, provider: "unexecuted-provider", messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    ...overrides
  });
  const expectUnknown = (response) => {
    expect(response.headers.has("x-resolved-model")).toBe(false);
    expect(response.headers.has("x-resolved-provider")).toBe(false);
  };

  it.each([
    ["created-only model", [created(), ...items, frame("response.completed", { status: "completed", usage })]],
    ["terminal-only model", [frame("response.created", { id: "resp_identity", created_at: 1700000000 }), ...items, completed()]],
    ["done terminal", [created(), ...items, frame("response.done", { status: "completed", model: upstreamModel, usage })]],
    ["all observations agree", [created(), ...items, completed(), frame("response.done", { status: "completed", model: upstreamModel })]]
  ])("uses the observed model for %s, preserving tool payload and usage", async (_, events) => {
    const result = await handleForcedSSEToJson(context(events));
    expect(result.success).toBe(true);
    expect(result.response.headers.get("x-resolved-model")).toBe(upstreamModel);
    expect(result.response.headers.get("x-resolved-provider")).toBe("codex");
    expect(await result.response.json()).toEqual({
      id: "resp_identity", object: "chat.completion", created: 1700000000,
      model: upstreamModel,
      choices: [{ index: 0, message: { role: "assistant", content: "answer", tool_calls: [{
        id: "call_original", type: "function", function: { name: "reason_and_summarize", arguments: '{"answer":"unchanged"}' }
      }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 }
    });
  });

  it("returns the same Responses payload plus observed model, restoring tool names", async () => {
    const result = await handleForcedSSEToJson(context([created(), ...items, completed()], {
      sourceFormat: FORMATS.OPENAI_RESPONSES, toolNameMap: new Map([["reason_and_summarize", "OriginalTool"]])
    }));
    expect(result.response.headers.get("x-resolved-model")).toBe(upstreamModel);
    expect(result.response.headers.get("x-resolved-provider")).toBe("codex");
    expect(await result.response.json()).toEqual({
      id: "resp_identity", object: "response", created_at: 1700000000, status: "completed", model: upstreamModel,
      output: [output[0], { ...output[1], name: "OriginalTool" }], usage
    });
  });

  it("keeps absent-model fallback without inferring from selected alias or upstream headers", async () => {
    const events = [frame("response.created", { id: "resp_identity", created_at: 1700000000 }), ...items, frame("response.completed", { status: "completed", usage })];
    const result = await handleForcedSSEToJson(context(events, {
      providerResponse: new Response(rawStream(events), { headers: {
        "content-type": "text/event-stream", "x-resolved-model": "untrusted-header", "x-resolved-provider": "untrusted-provider"
      } })
    }));
    expect(result.success).toBe(true);
    expectUnknown(result.response);
    expect((await result.response.json()).model).toBe(requestedModel);
    const responses = await handleForcedSSEToJson(context(events, { sourceFormat: FORMATS.OPENAI_RESPONSES }));
    expectUnknown(responses.response);
    expect(await responses.response.json()).not.toHaveProperty("model");
  });

  it.each([
    ["conflicting terminal model", [created(), completed("other-model")]],
    ["conflicting done model", [created(), completed(), frame("response.done", { status: "completed", model: "other-model" })]],
    ["missing terminal status", [created(), frame("response.completed", { model: upstreamModel })]],
    ["non-completed terminal status", [created(), frame("response.completed", { status: "incomplete", model: upstreamModel })]],
    ["failed payload status", [created(), frame("response.completed", { status: "failed", model: upstreamModel })]],
    ["terminal error", [created(), frame("response.completed", { status: "completed", model: upstreamModel, error: { message: "failed" } })]],
    ["top-level error", [created(), { event: "error", data: { error: { message: "failed" } } }, completed()]],
    ["prior failure", [created(), frame("response.failed", { error: { message: "failed" } }), completed()]],
    ["prior incomplete", [created(), frame("response.incomplete", { status: "incomplete" }), completed()]],
    ["prior failed status", [frame("response.created", { model: upstreamModel, status: "failed" }), completed()]]
  ])("does not emit a receipt after %s", async (_, events) => {
    const result = await handleForcedSSEToJson(context(events));
    expectUnknown(result.response);
    const converted = await convertResponsesStreamToJson(new Response(rawStream(events)).body);
    expect(converted).not.toHaveProperty("model");
  });

  it.each([
    null, "", " ", "unknown", "UNKNOWN", "null", "none", "unverified", "unresolved", "n/a",
    1, {}, [], "bad,model", "model\nheader:value", "model\n", "model\r", " leading", "trailing ", "https://host/model", "é-model", "x".repeat(257),
    "sk-fixture-secret", "SK-fixture-secret", "prefix-sk-fixture-secret", "Bearer fixture-secret"
  ].map(value => [value]))("rejects invalid upstream model %j even when another event is valid", async (invalid) => {
    const result = await handleForcedSSEToJson(context([created(invalid), completed()]));
    expectUnknown(result.response);
    expect((await result.response.json()).model).toBe(requestedModel);
  });

  it("does not expose the client credential echoed as upstream model", async () => {
    const apiKey = "plain-fixture-client-credential";
    const result = await handleForcedSSEToJson(context([created(apiKey), completed(apiKey)], { apiKey }));
    expectUnknown(result.response);
    const body = await result.response.text();
    expect(body).not.toContain(apiKey);
    expect(JSON.parse(body).model).toBe(requestedModel);
  });

  it.each(["failed", "in_progress"])("keeps the deployed error behavior for %s streams", async (status) => {
    const events = status === "failed" ? [created(), frame("response.failed", { error: { message: "upstream overloaded" } })] : [created()];
    const onRequestSuccess = vi.fn();
    const result = await handleForcedSSEToJson(context(events, { onRequestSuccess }));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expectUnknown(result.response);
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect((await result.response.json()).error.message).toBe(status === "failed" ? "upstream overloaded" : "Upstream response in_progress");
  });

  it("takes provider from the executed route, never the body provider or model prefix", async () => {
    const result = await handleForcedSSEToJson(context([created(), completed()], { provider: "op-other-route" }));
    expect(result.response.headers.get("x-resolved-provider")).toBe("op-other-route");
    expect(result.response.headers.get("x-resolved-model")).toBe(upstreamModel);
  });

  it.each([undefined, "", "unknown", "bad,provider", "provider\r\nheader:value", "provider\n", "https://host", "x".repeat(257), "sk-fixture-secret", "Bearer fixture-secret"])("requires a valid executed provider %j before emitting either receipt field", async (provider) => {
    const result = await handleForcedSSEToJson(context([created(), completed()], { provider }));
    expectUnknown(result.response);
  });

  it("requires HTTP success without changing existing error handling", async () => {
    const events = [created(), completed()];
    const result = await handleForcedSSEToJson(context(events, {
      providerResponse: new Response(rawStream(events), { status: 502, headers: { "content-type": "text/event-stream" } })
    }));
    expectUnknown(result.response);
  });

  it("retains model across byte chunk seams and an unterminated last SSE event", async () => {
    const bytes = new TextEncoder().encode(rawStream([created(), ...items, completed()]));
    const stream = new ReadableStream({ start(controller) {
      for (let start = 0; start < bytes.length; start += 3) controller.enqueue(bytes.slice(start, start + 3));
      controller.close();
    } });
    const converted = await convertResponsesStreamToJson(stream);
    expect(converted.model).toBe(upstreamModel);
    expect(converted.output).toEqual(output);
    expect(converted.usage).toEqual(usage);
  });
});
