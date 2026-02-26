import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HISTORY_CONTEXT_MARKER } from "../auto-reply/reply/history.js";
import { CURRENT_MESSAGE_MARKER } from "../auto-reply/reply/mentions.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { buildAssistantDeltaResult } from "./test-helpers.agent-results.js";
import { agentCommand, getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let enabledServer: Awaited<ReturnType<typeof startServer>>;
let enabledPort: number;

beforeAll(async () => {
  enabledPort = await getFreePort();
  enabledServer = await startServer(enabledPort, { openResponsesEnabled: true });
});

afterAll(async () => {
  await enabledServer.close({ reason: "openresponses enabled suite done" });
});

beforeEach(() => {
  return resetReliabilityMetrics();
});

async function resetReliabilityMetrics() {
  const mod = await import("./openresponses-http.js");
  mod.resetOpenResponsesToolCallReliabilityMetrics();
}

async function readReliabilityMetrics() {
  const mod = await import("./openresponses-http.js");
  return mod.getOpenResponsesToolCallReliabilityMetrics();
}

async function startServer(port: number, opts?: { openResponsesEnabled?: boolean }) {
  const { startGatewayServer } = await import("./server.js");
  const serverOpts = {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
  } as const;
  return await startGatewayServer(
    port,
    opts?.openResponsesEnabled === undefined
      ? serverOpts
      : { ...serverOpts, openResponsesEnabled: opts.openResponsesEnabled },
  );
}

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is required for gateway config tests");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function startResponsesServerWithConfig(
  responsesConfig: Record<string, unknown>,
): Promise<{ port: number; close: (params: { reason: string }) => Promise<void> }> {
  await writeGatewayConfig({
    gateway: {
      http: {
        endpoints: {
          responses: {
            enabled: true,
            ...responsesConfig,
          },
        },
      },
    },
  });
  const port = await getFreePort();
  const server = await startServer(port, { openResponsesEnabled: true });
  return {
    port,
    close: (params) => server.close(params),
  };
}

async function postResponses(port: number, body: unknown, headers?: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer secret",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return res;
}

function parseSseEvents(text: string): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = [];
  const lines = text.split("\n");
  let currentEvent: string | undefined;
  let currentData: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice("event: ".length);
    } else if (line.startsWith("data: ")) {
      currentData.push(line.slice("data: ".length));
    } else if (line.trim() === "" && currentData.length > 0) {
      events.push({ event: currentEvent, data: currentData.join("\n") });
      currentEvent = undefined;
      currentData = [];
    }
  }

  return events;
}

async function ensureResponseConsumed(res: Response) {
  if (res.bodyUsed) {
    return;
  }
  try {
    await res.text();
  } catch {
    // Ignore drain failures; best-effort to release keep-alive sockets in tests.
  }
}

describe("OpenResponses HTTP API (e2e)", () => {
  it("rejects when disabled (default + config)", { timeout: 120_000 }, async () => {
    const port = await getFreePort();
    const _server = await startServer(port);
    try {
      const res = await postResponses(port, {
        model: "openclaw",
        input: "hi",
      });
      expect(res.status).toBe(404);
      await ensureResponseConsumed(res);
    } finally {
      // shared server
    }

    const disabledPort = await getFreePort();
    const disabledServer = await startServer(disabledPort, {
      openResponsesEnabled: false,
    });
    try {
      const res = await postResponses(disabledPort, {
        model: "openclaw",
        input: "hi",
      });
      expect(res.status).toBe(404);
      await ensureResponseConsumed(res);
    } finally {
      await disabledServer.close({ reason: "test done" });
    }
  });

  it("handles OpenResponses request parsing and validation", async () => {
    const port = enabledPort;
    const mockAgentOnce = (payloads: Array<{ text: string }>, meta?: unknown) => {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({ payloads, meta } as never);
    };

    try {
      const resNonPost = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "GET",
        headers: { authorization: "Bearer secret" },
      });
      expect(resNonPost.status).toBe(405);
      await ensureResponseConsumed(resNonPost);

      const resMissingAuth = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openclaw", input: "hi" }),
      });
      expect(resMissingAuth.status).toBe(401);
      await ensureResponseConsumed(resMissingAuth);

      const resMissingModel = await postResponses(port, { input: "hi" });
      expect(resMissingModel.status).toBe(400);
      const missingModelJson = (await resMissingModel.json()) as Record<string, unknown>;
      expect((missingModelJson.error as Record<string, unknown> | undefined)?.type).toBe(
        "invalid_request_error",
      );
      await ensureResponseConsumed(resMissingModel);

      mockAgentOnce([{ text: "hello" }]);
      const resHeader = await postResponses(
        port,
        { model: "openclaw", input: "hi" },
        { "x-openclaw-agent-id": "beta" },
      );
      expect(resHeader.status).toBe(200);
      const optsHeader = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect((optsHeader as { sessionKey?: string } | undefined)?.sessionKey ?? "").toMatch(
        /^agent:beta:/,
      );
      await ensureResponseConsumed(resHeader);

      mockAgentOnce([{ text: "hello" }]);
      const resModel = await postResponses(port, { model: "openclaw:beta", input: "hi" });
      expect(resModel.status).toBe(200);
      const optsModel = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect((optsModel as { sessionKey?: string } | undefined)?.sessionKey ?? "").toMatch(
        /^agent:beta:/,
      );
      await ensureResponseConsumed(resModel);

      mockAgentOnce([{ text: "hello" }]);
      const resUser = await postResponses(port, {
        user: "alice",
        model: "openclaw",
        input: "hi",
      });
      expect(resUser.status).toBe(200);
      const optsUser = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect((optsUser as { sessionKey?: string } | undefined)?.sessionKey ?? "").toContain(
        "openresponses-user:alice",
      );
      await ensureResponseConsumed(resUser);

      mockAgentOnce([{ text: "hello" }]);
      const resString = await postResponses(port, {
        model: "openclaw",
        input: "hello world",
      });
      expect(resString.status).toBe(200);
      const optsString = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect((optsString as { message?: string } | undefined)?.message).toBe("hello world");
      await ensureResponseConsumed(resString);

      mockAgentOnce([{ text: "hello" }]);
      const resArray = await postResponses(port, {
        model: "openclaw",
        input: [{ type: "message", role: "user", content: "hello there" }],
      });
      expect(resArray.status).toBe(200);
      const optsArray = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect((optsArray as { message?: string } | undefined)?.message).toBe("hello there");
      await ensureResponseConsumed(resArray);

      mockAgentOnce([{ text: "hello" }]);
      const resSystemDeveloper = await postResponses(port, {
        model: "openclaw",
        input: [
          { type: "message", role: "system", content: "You are a helpful assistant." },
          { type: "message", role: "developer", content: "Be concise." },
          { type: "message", role: "user", content: "Hello" },
        ],
      });
      expect(resSystemDeveloper.status).toBe(200);
      const optsSystemDeveloper = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      const extraSystemPrompt =
        (optsSystemDeveloper as { extraSystemPrompt?: string } | undefined)?.extraSystemPrompt ??
        "";
      expect(extraSystemPrompt).toContain("You are a helpful assistant.");
      expect(extraSystemPrompt).toContain("Be concise.");
      await ensureResponseConsumed(resSystemDeveloper);

      mockAgentOnce([{ text: "hello" }]);
      const resInstructions = await postResponses(port, {
        model: "openclaw",
        input: "hi",
        instructions: "Always respond in French.",
      });
      expect(resInstructions.status).toBe(200);
      const optsInstructions = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      const instructionPrompt =
        (optsInstructions as { extraSystemPrompt?: string } | undefined)?.extraSystemPrompt ?? "";
      expect(instructionPrompt).toContain("Always respond in French.");
      await ensureResponseConsumed(resInstructions);

      mockAgentOnce([{ text: "I am Claude" }]);
      const resHistory = await postResponses(port, {
        model: "openclaw",
        input: [
          { type: "message", role: "system", content: "You are a helpful assistant." },
          { type: "message", role: "user", content: "Hello, who are you?" },
          { type: "message", role: "assistant", content: "I am Claude." },
          { type: "message", role: "user", content: "What did I just ask you?" },
        ],
      });
      expect(resHistory.status).toBe(200);
      const optsHistory = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      const historyMessage = (optsHistory as { message?: string } | undefined)?.message ?? "";
      expect(historyMessage).toContain(HISTORY_CONTEXT_MARKER);
      expect(historyMessage).toContain("User: Hello, who are you?");
      expect(historyMessage).toContain("Assistant: I am Claude.");
      expect(historyMessage).toContain(CURRENT_MESSAGE_MARKER);
      expect(historyMessage).toContain("User: What did I just ask you?");
      await ensureResponseConsumed(resHistory);

      mockAgentOnce([{ text: "ok" }]);
      const resFunctionOutput = await postResponses(port, {
        model: "openclaw",
        input: [
          { type: "message", role: "user", content: "What's the weather?" },
          { type: "function_call_output", call_id: "call_1", output: "Sunny, 70F." },
        ],
      });
      expect(resFunctionOutput.status).toBe(200);
      const optsFunctionOutput = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      const functionOutputMessage =
        (optsFunctionOutput as { message?: string } | undefined)?.message ?? "";
      expect(functionOutputMessage).toContain("Sunny, 70F.");
      await ensureResponseConsumed(resFunctionOutput);

      mockAgentOnce([{ text: "ok" }]);
      const resInputFile = await postResponses(port, {
        model: "openclaw",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "read this" },
              {
                type: "input_file",
                source: {
                  type: "base64",
                  media_type: "text/plain",
                  data: Buffer.from("hello").toString("base64"),
                  filename: "hello.txt",
                },
              },
            ],
          },
        ],
      });
      expect(resInputFile.status).toBe(200);
      const optsInputFile = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      const inputFileMessage = (optsInputFile as { message?: string } | undefined)?.message ?? "";
      const inputFilePrompt =
        (optsInputFile as { extraSystemPrompt?: string } | undefined)?.extraSystemPrompt ?? "";
      expect(inputFileMessage).toBe("read this");
      expect(inputFilePrompt).toContain('<file name="hello.txt">');
      await ensureResponseConsumed(resInputFile);

      mockAgentOnce([{ text: "ok" }]);
      const resToolNone = await postResponses(port, {
        model: "openclaw",
        input: "hi",
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "Get weather" },
          },
        ],
        tool_choice: "none",
      });
      expect(resToolNone.status).toBe(200);
      const optsToolNone = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect(
        (optsToolNone as { clientTools?: unknown[] } | undefined)?.clientTools,
      ).toBeUndefined();
      await ensureResponseConsumed(resToolNone);

      mockAgentOnce([{ text: "ok" }], {
        stopReason: "tool_calls",
        pendingToolCalls: [{ id: "call_get_time", name: "get_time", arguments: "{}" }],
      });
      const resToolChoice = await postResponses(port, {
        model: "openclaw",
        input: "hi",
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "Get weather" },
          },
          {
            type: "function",
            function: { name: "get_time", description: "Get time" },
          },
        ],
        tool_choice: { type: "function", function: { name: "get_time" } },
      });
      expect(resToolChoice.status).toBe(200);
      const optsToolChoice = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      const clientTools =
        (optsToolChoice as { clientTools?: Array<{ function?: { name?: string } }> } | undefined)
          ?.clientTools ?? [];
      expect(clientTools).toHaveLength(1);
      expect(clientTools[0]?.function?.name).toBe("get_time");
      const toolChoiceJson = (await resToolChoice.json()) as {
        status?: string;
        output?: Array<{ type?: string; name?: string }>;
      };
      expect(toolChoiceJson.status).toBe("incomplete");
      expect(
        (toolChoiceJson.output ?? []).some(
          (item) => item.type === "function_call" && item.name === "get_time",
        ),
      ).toBe(true);
      await ensureResponseConsumed(resToolChoice);

      const resUnknownTool = await postResponses(port, {
        model: "openclaw",
        input: "hi",
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "Get weather" },
          },
        ],
        tool_choice: { type: "function", function: { name: "unknown_tool" } },
      });
      expect(resUnknownTool.status).toBe(400);
      await ensureResponseConsumed(resUnknownTool);

      mockAgentOnce([{ text: "I will do it now." }], {
        stopReason: "stop",
      });
      const resRequiredNoToolCall = await postResponses(port, {
        model: "openclaw",
        input: "run this",
        tools: [
          {
            type: "function",
            function: { name: "exec", description: "run command" },
          },
        ],
        tool_choice: "required",
      });
      expect(resRequiredNoToolCall.status).toBe(422);
      const requiredNoToolCallJson = (await resRequiredNoToolCall.json()) as {
        status?: string;
        error?: { code?: string; message?: string };
      };
      expect(requiredNoToolCallJson.status).toBe("failed");
      expect(requiredNoToolCallJson.error?.code).toBe("tool_choice_not_satisfied");
      expect(requiredNoToolCallJson.error?.message ?? "").toMatch(/tool_choice=required/i);
      await ensureResponseConsumed(resRequiredNoToolCall);

      mockAgentOnce([{ text: "wrong tool" }], {
        stopReason: "tool_calls",
        pendingToolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }],
      });
      const resSpecificToolMismatch = await postResponses(port, {
        model: "openclaw",
        input: "check now",
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "Get weather" },
          },
          {
            type: "function",
            function: { name: "exec", description: "Run command" },
          },
        ],
        tool_choice: { type: "function", function: { name: "exec" } },
      });
      expect(resSpecificToolMismatch.status).toBe(422);
      const specificToolMismatchJson = (await resSpecificToolMismatch.json()) as {
        status?: string;
        error?: { code?: string; message?: string };
      };
      expect(specificToolMismatchJson.status).toBe("failed");
      expect(specificToolMismatchJson.error?.code).toBe("tool_choice_not_satisfied");
      expect(specificToolMismatchJson.error?.message ?? "").toMatch(
        /tool_choice\.function\.name="exec"/i,
      );
      await ensureResponseConsumed(resSpecificToolMismatch);

      mockAgentOnce([{ text: "ok" }]);
      const resMaxTokens = await postResponses(port, {
        model: "openclaw",
        input: "hi",
        max_output_tokens: 123,
      });
      expect(resMaxTokens.status).toBe(200);
      const optsMaxTokens = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect(
        (optsMaxTokens as { streamParams?: { maxTokens?: number } } | undefined)?.streamParams
          ?.maxTokens,
      ).toBe(123);
      await ensureResponseConsumed(resMaxTokens);

      mockAgentOnce([{ text: "ok" }], {
        agentMeta: {
          usage: { input: 3, output: 5, cacheRead: 1, cacheWrite: 1 },
        },
      });
      const resUsage = await postResponses(port, {
        stream: false,
        model: "openclaw",
        input: "hi",
      });
      expect(resUsage.status).toBe(200);
      const usageJson = (await resUsage.json()) as Record<string, unknown>;
      expect(usageJson.usage).toEqual({ input_tokens: 3, output_tokens: 5, total_tokens: 10 });
      await ensureResponseConsumed(resUsage);

      mockAgentOnce([{ text: "hello" }]);
      const resShape = await postResponses(port, {
        stream: false,
        model: "openclaw",
        input: "hi",
      });
      expect(resShape.status).toBe(200);
      const shapeJson = (await resShape.json()) as Record<string, unknown>;
      expect(shapeJson.object).toBe("response");
      expect(shapeJson.status).toBe("completed");
      expect(Array.isArray(shapeJson.output)).toBe(true);

      const output = shapeJson.output as Array<Record<string, unknown>>;
      expect(output.length).toBe(1);
      const item = output[0] ?? {};
      expect(item.type).toBe("message");
      expect(item.role).toBe("assistant");

      const content = item.content as Array<Record<string, unknown>>;
      expect(content.length).toBe(1);
      expect(content[0]?.type).toBe("output_text");
      expect(content[0]?.text).toBe("hello");
      await ensureResponseConsumed(resShape);

      const resNoUser = await postResponses(port, {
        model: "openclaw",
        input: [{ type: "message", role: "system", content: "yo" }],
      });
      expect(resNoUser.status).toBe(400);
      const noUserJson = (await resNoUser.json()) as Record<string, unknown>;
      expect((noUserJson.error as Record<string, unknown> | undefined)?.type).toBe(
        "invalid_request_error",
      );
      await ensureResponseConsumed(resNoUser);
    } finally {
      // shared server
    }
  });

  it("streams OpenResponses SSE events", async () => {
    const port = enabledPort;
    try {
      agentCommand.mockReset();
      agentCommand.mockImplementationOnce((async (opts: unknown) =>
        buildAssistantDeltaResult({
          opts,
          emit: emitAgentEvent,
          deltas: ["he", "llo"],
          text: "hello",
        })) as never);

      const resDelta = await postResponses(port, {
        stream: true,
        model: "openclaw",
        input: "hi",
      });
      expect(resDelta.status).toBe(200);
      expect(resDelta.headers.get("content-type") ?? "").toContain("text/event-stream");

      const deltaText = await resDelta.text();
      const deltaEvents = parseSseEvents(deltaText);

      const eventTypes = deltaEvents.map((e) => e.event).filter(Boolean);
      expect(eventTypes).toContain("response.created");
      expect(eventTypes).toContain("response.output_item.added");
      expect(eventTypes).toContain("response.in_progress");
      expect(eventTypes).toContain("response.content_part.added");
      expect(eventTypes).toContain("response.output_text.delta");
      expect(eventTypes).toContain("response.output_text.done");
      expect(eventTypes).toContain("response.content_part.done");
      expect(eventTypes).toContain("response.completed");
      expect(deltaEvents.some((e) => e.data === "[DONE]")).toBe(true);

      const deltas = deltaEvents
        .filter((e) => e.event === "response.output_text.delta")
        .map((e) => {
          const parsed = JSON.parse(e.data) as { delta?: string };
          return parsed.delta ?? "";
        })
        .join("");
      expect(deltas).toBe("hello");

      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "hello" }],
      } as never);

      const resFallback = await postResponses(port, {
        stream: true,
        model: "openclaw",
        input: "hi",
      });
      expect(resFallback.status).toBe(200);
      const fallbackText = await resFallback.text();
      expect(fallbackText).toContain("[DONE]");
      expect(fallbackText).toContain("hello");

      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "hello" }],
      } as never);

      const resTypeMatch = await postResponses(port, {
        stream: true,
        model: "openclaw",
        input: "hi",
      });
      expect(resTypeMatch.status).toBe(200);

      const typeText = await resTypeMatch.text();
      const typeEvents = parseSseEvents(typeText);
      for (const event of typeEvents) {
        if (event.data === "[DONE]") {
          continue;
        }
        const parsed = JSON.parse(event.data) as { type?: string };
        expect(event.event).toBe(parsed.type);
      }

      agentCommand.mockReset();
      agentCommand.mockImplementationOnce((async (opts: unknown) => {
        const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
        emitAgentEvent({
          runId,
          stream: "assistant",
          data: { delta: "I'll do it now." },
        });
        return {
          payloads: [{ text: "I'll do it now." }],
          meta: {
            stopReason: "tool_calls",
            pendingToolCalls: [
              {
                id: "call_direct_action",
                name: "exec",
                arguments: '{"command":"echo ready"}',
              },
            ],
          },
        };
      }) as never);

      const resToolCallAfterDelta = await postResponses(port, {
        stream: true,
        model: "openclaw",
        input: "run this",
        tools: [
          {
            type: "function",
            function: { name: "exec", description: "run command" },
          },
        ],
      });
      expect(resToolCallAfterDelta.status).toBe(200);

      const toolCallAfterDeltaText = await resToolCallAfterDelta.text();
      const toolCallAfterDeltaEvents = parseSseEvents(toolCallAfterDeltaText);
      const toolCallAfterDeltaTextDeltas = toolCallAfterDeltaEvents
        .filter((event) => event.event === "response.output_text.delta")
        .map((event) => {
          const parsed = JSON.parse(event.data) as { delta?: string };
          return parsed.delta ?? "";
        })
        .join("");
      expect(toolCallAfterDeltaTextDeltas).toBe("");
      const addedOutputItems = toolCallAfterDeltaEvents.filter(
        (event) => event.event === "response.output_item.added",
      );
      expect(
        addedOutputItems.some((event) => {
          const parsed = JSON.parse(event.data) as { item?: { type?: string; name?: string } };
          return parsed.item?.type === "function_call" && parsed.item?.name === "exec";
        }),
      ).toBe(true);

      const completedEvents = toolCallAfterDeltaEvents.filter(
        (event) => event.event === "response.completed",
      );
      expect(completedEvents).toHaveLength(1);
      const completedPayload = JSON.parse(completedEvents[0]?.data ?? "{}") as {
        response?: { status?: string; output?: Array<{ type?: string }> };
      };
      expect(completedPayload.response?.status).toBe("incomplete");
      expect(
        (completedPayload.response?.output ?? []).some((item) => item.type === "function_call"),
      ).toBe(true);
      expect((await readReliabilityMetrics()).toolCallAfterTextDelta).toBe(1);

      agentCommand.mockReset();
      agentCommand.mockImplementationOnce((async (opts: unknown) => {
        const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
        emitAgentEvent({
          runId,
          stream: "assistant",
          data: { delta: "I'll do it now." },
        });
        return {
          payloads: [{ text: "I'll do it now." }],
          meta: {
            stopReason: "stop",
          },
        };
      }) as never);

      const resRequiredStreamNoToolCall = await postResponses(port, {
        stream: true,
        model: "openclaw",
        input: "run this",
        tools: [
          {
            type: "function",
            function: { name: "exec", description: "run command" },
          },
        ],
        tool_choice: "required",
      });
      expect(resRequiredStreamNoToolCall.status).toBe(200);
      const requiredStreamNoToolCallText = await resRequiredStreamNoToolCall.text();
      const requiredStreamNoToolCallEvents = parseSseEvents(requiredStreamNoToolCallText);
      const failedEvents = requiredStreamNoToolCallEvents.filter(
        (event) => event.event === "response.failed",
      );
      expect(failedEvents).toHaveLength(1);
      const failedPayload = JSON.parse(failedEvents[0]?.data ?? "{}") as {
        response?: { error?: { code?: string; message?: string } };
      };
      expect(failedPayload.response?.error?.code).toBe("tool_choice_not_satisfied");
      expect(failedPayload.response?.error?.message ?? "").toMatch(/tool_choice=required/i);
      const failedDeltas = requiredStreamNoToolCallEvents
        .filter((event) => event.event === "response.output_text.delta")
        .map((event) => {
          const parsed = JSON.parse(event.data) as { delta?: string };
          return parsed.delta ?? "";
        })
        .join("");
      expect(failedDeltas).toBe("");
    } finally {
      // shared server
    }
  });

  it("blocks unsafe URL-based file/image inputs", async () => {
    const port = enabledPort;
    agentCommand.mockReset();

    const blockedPrivate = await postResponses(port, {
      model: "openclaw",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "read this" },
            {
              type: "input_file",
              source: { type: "url", url: "http://127.0.0.1:6379/info" },
            },
          ],
        },
      ],
    });
    expect(blockedPrivate.status).toBe(400);
    const blockedPrivateJson = (await blockedPrivate.json()) as {
      error?: { type?: string; message?: string };
    };
    expect(blockedPrivateJson.error?.type).toBe("invalid_request_error");
    expect(blockedPrivateJson.error?.message ?? "").toMatch(
      /invalid request|private|internal|blocked/i,
    );

    const blockedMetadata = await postResponses(port, {
      model: "openclaw",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "read this" },
            {
              type: "input_image",
              source: { type: "url", url: "http://metadata.google.internal/computeMetadata/v1" },
            },
          ],
        },
      ],
    });
    expect(blockedMetadata.status).toBe(400);
    const blockedMetadataJson = (await blockedMetadata.json()) as {
      error?: { type?: string; message?: string };
    };
    expect(blockedMetadataJson.error?.type).toBe("invalid_request_error");
    expect(blockedMetadataJson.error?.message ?? "").toMatch(
      /invalid request|blocked|metadata|internal/i,
    );

    const blockedScheme = await postResponses(port, {
      model: "openclaw",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "read this" },
            {
              type: "input_file",
              source: { type: "url", url: "file:///etc/passwd" },
            },
          ],
        },
      ],
    });
    expect(blockedScheme.status).toBe(400);
    const blockedSchemeJson = (await blockedScheme.json()) as {
      error?: { type?: string; message?: string };
    };
    expect(blockedSchemeJson.error?.type).toBe("invalid_request_error");
    expect(blockedSchemeJson.error?.message ?? "").toMatch(/invalid request|http or https/i);
    expect(agentCommand).not.toHaveBeenCalled();
  });

  it("enforces URL allowlist and URL part cap for responses inputs", async () => {
    const allowlistConfig = {
      gateway: {
        http: {
          endpoints: {
            responses: {
              enabled: true,
              maxUrlParts: 1,
              files: {
                allowUrl: true,
                urlAllowlist: ["cdn.example.com", "*.assets.example.com"],
              },
              images: {
                allowUrl: true,
                urlAllowlist: ["images.example.com"],
              },
            },
          },
        },
      },
    };
    await writeGatewayConfig(allowlistConfig);

    const allowlistPort = await getFreePort();
    const allowlistServer = await startServer(allowlistPort, { openResponsesEnabled: true });
    try {
      agentCommand.mockReset();

      const allowlistBlocked = await postResponses(allowlistPort, {
        model: "openclaw",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "fetch this" },
              {
                type: "input_file",
                source: { type: "url", url: "https://evil.example.org/secret.txt" },
              },
            ],
          },
        ],
      });
      expect(allowlistBlocked.status).toBe(400);
      const allowlistBlockedJson = (await allowlistBlocked.json()) as {
        error?: { type?: string; message?: string };
      };
      expect(allowlistBlockedJson.error?.type).toBe("invalid_request_error");
      expect(allowlistBlockedJson.error?.message ?? "").toMatch(
        /invalid request|allowlist|blocked/i,
      );
    } finally {
      await allowlistServer.close({ reason: "responses allowlist hardening test done" });
    }

    const capConfig = {
      gateway: {
        http: {
          endpoints: {
            responses: {
              enabled: true,
              maxUrlParts: 0,
              files: {
                allowUrl: true,
                urlAllowlist: ["cdn.example.com", "*.assets.example.com"],
              },
              images: {
                allowUrl: true,
                urlAllowlist: ["images.example.com"],
              },
            },
          },
        },
      },
    };
    await writeGatewayConfig(capConfig);

    const capPort = await getFreePort();
    const capServer = await startServer(capPort, { openResponsesEnabled: true });
    try {
      agentCommand.mockReset();
      const maxUrlBlocked = await postResponses(capPort, {
        model: "openclaw",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "fetch this" },
              {
                type: "input_file",
                source: { type: "url", url: "https://cdn.example.com/file-1.txt" },
              },
            ],
          },
        ],
      });
      expect(maxUrlBlocked.status).toBe(400);
      const maxUrlBlockedJson = (await maxUrlBlocked.json()) as {
        error?: { type?: string; message?: string };
      };
      expect(maxUrlBlockedJson.error?.type).toBe("invalid_request_error");
      expect(maxUrlBlockedJson.error?.message ?? "").toMatch(
        /invalid request|Too many URL-based input sources/i,
      );
      expect(agentCommand).not.toHaveBeenCalled();
    } finally {
      await capServer.close({ reason: "responses url cap hardening test done" });
    }
  });

  it("retries unmet tool_choice once and records retry success metrics", async () => {
    const port = enabledPort;
    agentCommand.mockReset();
    agentCommand
      .mockResolvedValueOnce({
        payloads: [{ text: "I can do that." }],
        meta: { stopReason: "stop" },
      } as never)
      .mockResolvedValueOnce({
        payloads: [{ text: "Calling tool." }],
        meta: {
          stopReason: "tool_calls",
          pendingToolCalls: [{ id: "call_retry_ok", name: "exec", arguments: '{"command":"pwd"}' }],
        },
      } as never);

    const res = await postResponses(port, {
      model: "openclaw",
      input: "run this",
      tools: [
        {
          type: "function",
          function: { name: "exec", description: "run command" },
        },
      ],
      tool_choice: "required",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status?: string;
      output?: Array<{ type?: string; name?: string }>;
    };
    expect(json.status).toBe("incomplete");
    expect((json.output ?? []).some((item) => item.type === "function_call")).toBe(true);
    expect((json.output ?? []).some((item) => item.name === "exec")).toBe(true);

    const metrics = await readReliabilityMetrics();
    expect(metrics.toolChoiceNotSatisfied).toBe(1);
    expect(metrics.toolChoiceRetryAttempted).toBe(1);
    expect(metrics.toolChoiceRetrySucceeded).toBe(1);
    expect(metrics.toolChoiceRetryFailed).toBe(0);
  });

  it("records retry failure metrics when tool_choice remains unmet", async () => {
    const port = enabledPort;
    agentCommand.mockReset();
    agentCommand
      .mockResolvedValueOnce({
        payloads: [{ text: "I'll do it." }],
        meta: { stopReason: "stop" },
      } as never)
      .mockResolvedValueOnce({
        payloads: [{ text: "Still no tool." }],
        meta: { stopReason: "stop" },
      } as never);

    const res = await postResponses(port, {
      model: "openclaw",
      input: "do it",
      tools: [
        {
          type: "function",
          function: { name: "exec", description: "run command" },
        },
      ],
      tool_choice: "required",
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as {
      status?: string;
      error?: { code?: string };
    };
    expect(json.status).toBe("failed");
    expect(json.error?.code).toBe("tool_choice_not_satisfied");

    const metrics = await readReliabilityMetrics();
    expect(metrics.toolChoiceNotSatisfied).toBe(2);
    expect(metrics.toolChoiceRetryAttempted).toBe(1);
    expect(metrics.toolChoiceRetrySucceeded).toBe(0);
    expect(metrics.toolChoiceRetryFailed).toBe(1);
  });

  it("does not auto-require tool calls for direct-action prompts when flag is disabled", async () => {
    const port = enabledPort;
    agentCommand.mockReset();
    agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "I'll do it." }],
      meta: { stopReason: "stop" },
    } as never);

    const res = await postResponses(port, {
      model: "openclaw",
      input: "do it",
      tools: [
        {
          type: "function",
          function: { name: "exec", description: "run command" },
        },
      ],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status?: string;
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    };
    expect(json.status).toBe("completed");
    const text = json.output?.[0]?.content?.[0]?.text ?? "";
    expect(text).toContain("I'll do it.");
    expect(agentCommand).toHaveBeenCalledTimes(1);
    const metrics = await readReliabilityMetrics();
    expect(metrics.toolChoiceRetryAttempted).toBe(0);
  });

  it("auto-requires tool calls for direct-action prompts in non-stream mode when enabled", async () => {
    const scopedServer = await startResponsesServerWithConfig({
      implicitToolChoiceRequiredForDirectAction: true,
    });
    try {
      agentCommand.mockReset();
      agentCommand
        .mockResolvedValueOnce({
          payloads: [{ text: "I'll do it." }],
          meta: { stopReason: "stop" },
        } as never)
        .mockResolvedValueOnce({
          payloads: [{ text: "Still no tool." }],
          meta: { stopReason: "stop" },
        } as never);

      const failed = await postResponses(scopedServer.port, {
        model: "openclaw",
        input: "do it",
        tools: [
          {
            type: "function",
            function: { name: "exec", description: "run command" },
          },
        ],
      });
      expect(failed.status).toBe(422);
      const failedJson = (await failed.json()) as {
        status?: string;
        error?: { code?: string; message?: string };
      };
      expect(failedJson.status).toBe("failed");
      expect(failedJson.error?.code).toBe("tool_choice_not_satisfied");
      expect(failedJson.error?.message ?? "").toMatch(/tool_choice=required/i);
      expect(agentCommand).toHaveBeenCalledTimes(2);

      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "calling exec" }],
        meta: {
          stopReason: "tool_calls",
          pendingToolCalls: [{ id: "call_direct_nonstream", name: "exec", arguments: "{}" }],
        },
      } as never);

      const succeeded = await postResponses(scopedServer.port, {
        model: "openclaw",
        input: "run this",
        tools: [
          {
            type: "function",
            function: { name: "exec", description: "run command" },
          },
        ],
      });
      expect(succeeded.status).toBe(200);
      const succeededJson = (await succeeded.json()) as {
        status?: string;
        output?: Array<{ type?: string; name?: string }>;
      };
      expect(succeededJson.status).toBe("incomplete");
      expect(
        (succeededJson.output ?? []).some(
          (item) => item.type === "function_call" && item.name === "exec",
        ),
      ).toBe(true);
    } finally {
      await scopedServer.close({
        reason: "direct-action non-stream implicit tool_choice test done",
      });
    }
  });

  it("auto-requires tool calls for direct-action prompts in stream mode when enabled", async () => {
    const scopedServer = await startResponsesServerWithConfig({
      implicitToolChoiceRequiredForDirectAction: true,
    });
    try {
      agentCommand.mockReset();
      agentCommand.mockImplementationOnce((async (opts: unknown) => {
        const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
        emitAgentEvent({
          runId,
          stream: "assistant",
          data: { delta: "I'll do it now." },
        });
        return {
          payloads: [{ text: "I'll do it now." }],
          meta: { stopReason: "stop" },
        };
      }) as never);

      const res = await postResponses(scopedServer.port, {
        stream: true,
        model: "openclaw",
        input: "check now",
        tools: [
          {
            type: "function",
            function: { name: "exec", description: "run command" },
          },
        ],
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const events = parseSseEvents(text);
      const failedEvents = events.filter((event) => event.event === "response.failed");
      expect(failedEvents).toHaveLength(1);
      const failedPayload = JSON.parse(failedEvents[0]?.data ?? "{}") as {
        response?: { error?: { code?: string; message?: string } };
      };
      expect(failedPayload.response?.error?.code).toBe("tool_choice_not_satisfied");
      expect(failedPayload.response?.error?.message ?? "").toMatch(/tool_choice=required/i);
      const deltas = events
        .filter((event) => event.event === "response.output_text.delta")
        .map((event) => {
          const parsed = JSON.parse(event.data) as { delta?: string };
          return parsed.delta ?? "";
        })
        .join("");
      expect(deltas).toBe("");
    } finally {
      await scopedServer.close({
        reason: "direct-action stream implicit tool_choice test done",
      });
    }
  });

  it("keeps Q&A prompts text-first with tools when direct-action auto-require is enabled", async () => {
    const scopedServer = await startResponsesServerWithConfig({
      implicitToolChoiceRequiredForDirectAction: true,
    });
    try {
      agentCommand.mockReset();
      agentCommand.mockResolvedValueOnce({
        payloads: [{ text: "It's currently 3 PM." }],
        meta: { stopReason: "stop" },
      } as never);

      const res = await postResponses(scopedServer.port, {
        model: "openclaw",
        input: "What time is it right now?",
        tools: [
          {
            type: "function",
            function: { name: "get_time", description: "Get current time" },
          },
        ],
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        status?: string;
        output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      expect(json.status).toBe("completed");
      const text = json.output?.[0]?.content?.[0]?.text ?? "";
      expect(text).toContain("3 PM");
      expect(agentCommand).toHaveBeenCalledTimes(1);
    } finally {
      await scopedServer.close({
        reason: "q-and-a direct-action heuristic false-positive test done",
      });
    }
  });

  it("streams tool_choice function mismatch as response.failed", async () => {
    const port = enabledPort;
    agentCommand.mockReset();
    agentCommand.mockImplementationOnce((async (opts: unknown) => {
      const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { delta: "Using weather tool." },
      });
      return {
        payloads: [{ text: "Using weather tool." }],
        meta: {
          stopReason: "tool_calls",
          pendingToolCalls: [{ id: "call_weather", name: "get_weather", arguments: "{}" }],
        },
      };
    }) as never);

    const res = await postResponses(port, {
      stream: true,
      model: "openclaw",
      input: "check now",
      tools: [
        {
          type: "function",
          function: { name: "get_weather", description: "Get weather" },
        },
        {
          type: "function",
          function: { name: "exec", description: "Run command" },
        },
      ],
      tool_choice: { type: "function", function: { name: "exec" } },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSseEvents(text);
    const failedEvents = events.filter((event) => event.event === "response.failed");
    expect(failedEvents).toHaveLength(1);
    const failedPayload = JSON.parse(failedEvents[0]?.data ?? "{}") as {
      response?: { error?: { code?: string; message?: string } };
    };
    expect(failedPayload.response?.error?.code).toBe("tool_choice_not_satisfied");
    expect(failedPayload.response?.error?.message ?? "").toMatch(
      /tool_choice\.function\.name="exec"/i,
    );
    const deltas = events
      .filter((event) => event.event === "response.output_text.delta")
      .map((event) => {
        const parsed = JSON.parse(event.data) as { delta?: string };
        return parsed.delta ?? "";
      })
      .join("");
    expect(deltas).toBe("");
  });

  it("exposes tool-call reliability diagnostics over authenticated HTTP", async () => {
    const port = enabledPort;
    const diagnosticsUrl = `http://127.0.0.1:${port}/v1/responses/diagnostics/tool-call-reliability`;

    const unauthenticated = await fetch(diagnosticsUrl);
    expect(unauthenticated.status).toBe(401);
    await ensureResponseConsumed(unauthenticated);

    const wrongMethod = await fetch(diagnosticsUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(wrongMethod.status).toBe(405);
    await ensureResponseConsumed(wrongMethod);

    agentCommand.mockReset();
    agentCommand
      .mockResolvedValueOnce({
        payloads: [{ text: "I'll do it." }],
        meta: { stopReason: "stop" },
      } as never)
      .mockResolvedValueOnce({
        payloads: [{ text: "Still no tool." }],
        meta: { stopReason: "stop" },
      } as never);

    const failed = await postResponses(port, {
      model: "openclaw",
      input: "do it",
      tools: [
        {
          type: "function",
          function: { name: "exec", description: "run command" },
        },
      ],
      tool_choice: "required",
    });
    expect(failed.status).toBe(422);
    await ensureResponseConsumed(failed);

    const diagnostics = await fetch(diagnosticsUrl, {
      headers: {
        authorization: "Bearer secret",
      },
    });
    expect(diagnostics.status).toBe(200);
    const diagnosticsJson = (await diagnostics.json()) as {
      object?: string;
      metrics?: {
        toolChoiceNotSatisfied?: number;
        toolChoiceRetryAttempted?: number;
        toolChoiceRetrySucceeded?: number;
        toolChoiceRetryFailed?: number;
      };
    };
    expect(diagnosticsJson.object).toBe("openresponses.tool_call_reliability");
    expect(diagnosticsJson.metrics?.toolChoiceNotSatisfied).toBe(2);
    expect(diagnosticsJson.metrics?.toolChoiceRetryAttempted).toBe(1);
    expect(diagnosticsJson.metrics?.toolChoiceRetrySucceeded).toBe(0);
    expect(diagnosticsJson.metrics?.toolChoiceRetryFailed).toBe(1);
  });
});
