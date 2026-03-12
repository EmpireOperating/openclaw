/**
 * OpenAI WebSocket StreamFn Integration
 *
 * Wraps `OpenAIWebSocketManager` in a `StreamFn` that can be plugged into the
 * pi-embedded-runner agent in place of the default `streamSimple` HTTP function.
 *
 * Key behaviours:
 *  - Per-session `OpenAIWebSocketManager` (keyed by sessionId)
 *  - Tracks `previous_response_id` to send only incremental tool-result inputs
 *  - Falls back to `streamSimple` (HTTP) if the WebSocket connection fails
 *  - Cleanup helpers for releasing sessions after the run completes
 *
 * Complexity budget & risk mitigation:
 *  - **Transport aware**: respects `transport` (`auto` | `websocket` | `sse`)
 *  - **Transparent fallback in `auto` mode**: connect/send failures fall back to
 *    the existing HTTP `streamSimple`; forced `websocket` mode surfaces WS errors
 *  - **Zero shared state**: per-session registry; session cleanup on dispose prevents leaks
 *  - **Full parity**: all generation options (temperature, top_p, max_output_tokens,
 *    tool_choice, reasoning) forwarded identically to the HTTP path
 *
 * @see src/agents/openai-ws-connection.ts for the connection manager
 */

import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  Message,
  StopReason,
  TextContent,
  ToolCall,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, streamSimple } from "@mariozechner/pi-ai";
import {
  OpenAIWebSocketManager,
  type ContentPart,
  type FunctionToolDefinition,
  type InputItem,
  type OpenAIWebSocketManagerOptions,
  type ResponseObject,
} from "./openai-ws-connection.js";
import { log } from "./pi-embedded-runner/logger.js";
import {
  buildAssistantMessage,
  buildAssistantMessageWithZeroUsage,
  buildUsageWithNoCost,
  buildStreamErrorAssistantMessage,
} from "./stream-message-shared.js";

// ─────────────────────────────────────────────────────────────────────────────
// Per-session state
// ─────────────────────────────────────────────────────────────────────────────

interface WsSession {
  manager: OpenAIWebSocketManager;
  /** Number of messages that were in context.messages at the END of the last streamFn call. */
  lastContextLength: number;
  /** Stable snapshot of the boundary message at lastContextLength-1. */
  lastContextBoundaryKey: string | null;
  /** True if the connection has been established at least once. */
  everConnected: boolean;
  /** True once a best-effort warm-up attempt has run for this session. */
  warmUpAttempted: boolean;
  /** True if the session is permanently broken (no more reconnect). */
  broken: boolean;
}

/** Module-level registry: sessionId → WsSession */
const wsRegistry = new Map<string, WsSession>();

// ─────────────────────────────────────────────────────────────────────────────
// Public registry helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Release and close the WebSocket session for the given sessionId.
 * Call this after the agent run completes to free the connection.
 */
export function releaseWsSession(sessionId: string): void {
  const session = wsRegistry.get(sessionId);
  if (session) {
    try {
      session.manager.close();
    } catch {
      // Ignore close errors — connection may already be gone.
    }
    wsRegistry.delete(sessionId);
  }
}

/**
 * Returns true if a live WebSocket session exists for the given sessionId.
 */
export function hasWsSession(sessionId: string): boolean {
  const s = wsRegistry.get(sessionId);
  return !!(s && !s.broken && s.manager.isConnected());
}

// ─────────────────────────────────────────────────────────────────────────────
// Message format converters
// ─────────────────────────────────────────────────────────────────────────────

type AnyMessage = Message & { role: string; content: unknown };

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOpenAiResponsesCallId(value: unknown): string | null {
  const callId = toNonEmptyString(value);
  if (!callId) {
    return null;
  }
  if (!callId.startsWith("call_")) {
    return callId;
  }
  const separatorIndex = callId.indexOf("|");
  return separatorIndex === -1 ? callId : callId.slice(0, separatorIndex);
}

function isMissingToolCallOutputErrorMessage(message: string): boolean {
  return message.includes("No tool call found for function call output with call_id");
}

function collectAssistantToolCallIds(messages: Message[]): Set<string> {
  const callIds = new Set<string>();

  for (const message of messages) {
    const m = message as AnyMessage;
    if (m.role !== "assistant" || !Array.isArray(m.content)) {
      continue;
    }
    for (const block of m.content as Array<{ type?: string; id?: string }>) {
      if (block.type !== "toolCall") {
        continue;
      }
      const callId = normalizeOpenAiResponsesCallId(block.id);
      if (callId) {
        callIds.add(callId);
      }
    }
  }

  return callIds;
}

function collectDeclaredFunctionCallIds(input: InputItem[]): Set<string> {
  const declaredCallIds = new Set<string>();
  for (const item of input) {
    if (item.type === "function_call" && item.call_id) {
      declaredCallIds.add(item.call_id);
    }
  }
  return declaredCallIds;
}

function dropOrphanFunctionCallOutputs(input: InputItem[]): {
  sanitized: InputItem[];
  droppedCallIds: string[];
} {
  const declaredCallIds = collectDeclaredFunctionCallIds(input);

  const dropped = new Set<string>();
  const sanitized = input.filter((item) => {
    if (item.type !== "function_call_output") {
      return true;
    }
    if (declaredCallIds.has(item.call_id)) {
      return true;
    }
    dropped.add(item.call_id);
    return false;
  });

  return { sanitized, droppedCallIds: Array.from(dropped) };
}

const TRACE_TEXT_PREVIEW_LIMIT = 120;
const TRACE_ARRAY_PREVIEW_LIMIT = 10;

function previewText(value: string, limit = TRACE_TEXT_PREVIEW_LIMIT): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function serializeTrace(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeMessageForTrace(message: Message, index: number): Record<string, unknown> {
  const m = message as AnyMessage;
  if (m.role === "user") {
    const text = contentToText(m.content);
    return {
      index,
      role: "user",
      textLength: text.length,
      textPreview: previewText(text),
    };
  }

  if (m.role === "toolResult") {
    const tr = m as unknown as {
      toolCallId?: string;
      toolUseId?: string;
      toolName?: string;
      content: unknown;
      isError?: boolean;
    };
    const callId =
      normalizeOpenAiResponsesCallId(tr.toolCallId) ??
      normalizeOpenAiResponsesCallId(tr.toolUseId);
    const text = contentToText(tr.content);
    return {
      index,
      role: "toolResult",
      toolName: tr.toolName ?? null,
      callId,
      isError: tr.isError ?? false,
      outputLength: text.length,
      outputPreview: previewText(text),
    };
  }

  if (m.role === "assistant") {
    const content = Array.isArray(m.content) ? m.content : [];
    const objectBlocks = (content as unknown[]).filter(
      (block): block is Record<string, unknown> => typeof block === "object" && block !== null,
    );
    const toolCalls = objectBlocks
      .filter((block) => block.type === "toolCall")
      .map((block) => ({
        name: typeof block.name === "string" ? block.name : null,
        callId: normalizeOpenAiResponsesCallId(block.id),
      }));
    const text = contentToText(content);
    return {
      index,
      role: "assistant",
      blockTypes: content
        .map((block) => (typeof block === "object" && block && "type" in block ? block.type : typeof block))
        .slice(0, TRACE_ARRAY_PREVIEW_LIMIT),
      toolCalls: toolCalls.slice(0, TRACE_ARRAY_PREVIEW_LIMIT),
      textLength: text.length,
      textPreview: previewText(text),
    };
  }

  return { index, role: (message as AnyMessage).role };
}

function summarizeMessagesForTrace(messages: Message[], startIndex = 0): Array<Record<string, unknown>> {
  return messages
    .slice(startIndex)
    .map((message, offset) => summarizeMessageForTrace(message, startIndex + offset));
}

function summarizeInputItemsForTrace(inputItems: InputItem[]): Array<Record<string, unknown>> {
  return inputItems.slice(0, TRACE_ARRAY_PREVIEW_LIMIT).map((item, index) => {
    if (item.type === "message") {
      const text = typeof item.content === "string" ? item.content : serializeTrace(item.content);
      return {
        index,
        type: item.type,
        role: item.role,
        textLength: text.length,
        textPreview: previewText(text),
      };
    }

    if (item.type === "function_call") {
      return {
        index,
        type: item.type,
        callId: item.call_id,
        name: item.name,
        argumentsLength: item.arguments.length,
        argumentsPreview: previewText(item.arguments),
      };
    }

    if (item.type === "function_call_output") {
      return {
        index,
        type: item.type,
        callId: item.call_id,
        outputLength: item.output.length,
        outputPreview: previewText(item.output),
      };
    }

    return { index, type: item.type };
  });
}

function summarizeResponseOutputForTrace(response: ResponseObject): Array<Record<string, unknown>> {
  return (response.output ?? []).slice(0, TRACE_ARRAY_PREVIEW_LIMIT).map((item, index) => {
    if (item.type === "function_call") {
      return {
        index,
        type: item.type,
        callId: item.call_id ?? null,
        name: item.name ?? null,
      };
    }
    if (item.type === "message") {
      const text = (item.content ?? [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text ?? "")
        .join("");
      return {
        index,
        type: item.type,
        role: item.role ?? null,
        textLength: text.length,
        textPreview: previewText(text),
      };
    }
    return { index, type: item.type };
  });
}

/** Convert pi-ai content (string | ContentPart[]) to plain text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as Array<{ type?: string; text?: string }>)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/** Convert pi-ai content to OpenAI ContentPart[]. */
function contentToOpenAIParts(content: unknown): ContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: ContentPart[] = [];
  for (const part of content as Array<{
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "input_text", text: part.text });
    } else if (part.type === "image" && typeof part.data === "string") {
      parts.push({
        type: "input_image",
        source: {
          type: "base64",
          media_type: part.mimeType ?? "image/jpeg",
          data: part.data,
        },
      });
    }
  }
  return parts;
}

/** Convert pi-ai tool array to OpenAI FunctionToolDefinition[]. */
export function convertTools(tools: Context["tools"]): FunctionToolDefinition[] {
  if (!tools || tools.length === 0) {
    return [];
  }
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      parameters: (tool.parameters ?? {}) as Record<string, unknown>,
    },
  }));
}

/**
 * Convert the full pi-ai message history to an OpenAI `input` array.
 * Handles user messages, assistant text+tool-call messages, and tool results.
 */
export function convertMessagesToInputItems(messages: Message[]): InputItem[] {
  const items: InputItem[] = [];

  for (const msg of messages) {
    const m = msg as AnyMessage;

    if (m.role === "user") {
      const parts = contentToOpenAIParts(m.content);
      items.push({
        type: "message",
        role: "user",
        content:
          parts.length === 1 && parts[0]?.type === "input_text"
            ? (parts[0] as { type: "input_text"; text: string }).text
            : parts,
      });
      continue;
    }

    if (m.role === "assistant") {
      const content = m.content;
      if (Array.isArray(content)) {
        // Collect text blocks and tool calls separately
        const textParts: string[] = [];
        for (const block of content as Array<{
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          arguments?: Record<string, unknown>;
          thinking?: string;
        }>) {
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block.type === "thinking" && typeof block.thinking === "string") {
            // Skip thinking blocks — not sent back to the model
          } else if (block.type === "toolCall") {
            // Push accumulated text first
            if (textParts.length > 0) {
              items.push({
                type: "message",
                role: "assistant",
                content: textParts.join(""),
              });
              textParts.length = 0;
            }
            const callId = normalizeOpenAiResponsesCallId(block.id);
            const toolName = toNonEmptyString(block.name);
            if (!callId || !toolName) {
              continue;
            }
            // Push function_call item
            items.push({
              type: "function_call",
              call_id: callId,
              name: toolName,
              arguments:
                typeof block.arguments === "string"
                  ? block.arguments
                  : JSON.stringify(block.arguments ?? {}),
            });
          }
        }
        if (textParts.length > 0) {
          items.push({
            type: "message",
            role: "assistant",
            content: textParts.join(""),
          });
        }
      } else {
        const text = contentToText(m.content);
        if (text) {
          items.push({
            type: "message",
            role: "assistant",
            content: text,
          });
        }
      }
      continue;
    }

    if (m.role === "toolResult") {
      const tr = m as unknown as {
        toolCallId?: string;
        toolUseId?: string;
        content: unknown;
        isError: boolean;
      };
      const callId =
        normalizeOpenAiResponsesCallId(tr.toolCallId) ??
        normalizeOpenAiResponsesCallId(tr.toolUseId);
      if (!callId) {
        continue;
      }
      const outputText = contentToText(tr.content);
      items.push({
        type: "function_call_output",
        call_id: callId,
        output: outputText,
      });
      continue;
    }
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response object → AssistantMessage
// ─────────────────────────────────────────────────────────────────────────────

export function buildAssistantMessageFromResponse(
  response: ResponseObject,
  modelInfo: { api: string; provider: string; id: string },
): AssistantMessage {
  const content: (TextContent | ToolCall)[] = [];

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) {
          content.push({ type: "text", text: part.text });
        }
      }
    } else if (item.type === "function_call") {
      const toolName = toNonEmptyString(item.name);
      if (!toolName) {
        continue;
      }
      content.push({
        type: "toolCall",
        id: toNonEmptyString(item.call_id) ?? `call_${randomUUID()}`,
        name: toolName,
        arguments: (() => {
          try {
            return JSON.parse(item.arguments) as Record<string, unknown>;
          } catch {
            return {} as Record<string, unknown>;
          }
        })(),
      });
    }
    // "reasoning" items are informational only; skip.
  }

  const hasToolCalls = content.some((c) => c.type === "toolCall");
  const stopReason: StopReason = hasToolCalls ? "toolUse" : "stop";

  return buildAssistantMessage({
    model: modelInfo,
    content,
    stopReason,
    usage: buildUsageWithNoCost({
      input: response.usage?.input_tokens ?? 0,
      output: response.usage?.output_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// StreamFn factory
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenAIWebSocketStreamOptions {
  /** Manager options (url override, retry counts, etc.) */
  managerOptions?: OpenAIWebSocketManagerOptions;
  /** Abort signal forwarded from the run. */
  signal?: AbortSignal;
}

type WsTransport = "sse" | "websocket" | "auto";
const WARM_UP_TIMEOUT_MS = 8_000;

function resolveWsTransport(options: Parameters<StreamFn>[2]): WsTransport {
  const transport = (options as { transport?: unknown } | undefined)?.transport;
  return transport === "sse" || transport === "websocket" || transport === "auto"
    ? transport
    : "auto";
}

type WsOptions = Parameters<StreamFn>[2] & { openaiWsWarmup?: unknown; signal?: AbortSignal };

function resolveWsWarmup(options: Parameters<StreamFn>[2]): boolean {
  const warmup = (options as WsOptions | undefined)?.openaiWsWarmup;
  return warmup === true;
}

async function runWarmUp(params: {
  manager: OpenAIWebSocketManager;
  modelId: string;
  tools: FunctionToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.signal?.aborted) {
    throw new Error("aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`warm-up timed out after ${WARM_UP_TIMEOUT_MS}ms`));
    }, WARM_UP_TIMEOUT_MS);

    const abortHandler = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    const closeHandler = (code: number, reason: string) => {
      cleanup();
      reject(new Error(`warm-up closed (code=${code}, reason=${reason || "unknown"})`));
    };
    const unsubscribe = params.manager.onMessage((event) => {
      if (event.type === "response.completed") {
        cleanup();
        resolve();
      } else if (event.type === "response.failed") {
        cleanup();
        const errMsg = event.response?.error?.message ?? "Response failed";
        reject(new Error(`warm-up failed: ${errMsg}`));
      } else if (event.type === "error") {
        cleanup();
        reject(new Error(`warm-up error: ${event.message} (code=${event.code})`));
      }
    });

    const cleanup = () => {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", abortHandler);
      params.manager.off("close", closeHandler);
      unsubscribe();
    };

    params.signal?.addEventListener("abort", abortHandler, { once: true });
    params.manager.on("close", closeHandler);
    params.manager.warmUp({
      model: params.modelId,
      tools: params.tools.length > 0 ? params.tools : undefined,
      instructions: params.instructions,
    });
  });
}

/**
 * Creates a `StreamFn` backed by a persistent WebSocket connection to the
 * OpenAI Responses API.  The first call for a given `sessionId` opens the
 * connection; subsequent calls reuse it, sending only incremental tool-result
 * inputs with `previous_response_id`.
 *
 * If the WebSocket connection is unavailable, the function falls back to the
 * standard `streamSimple` HTTP path and logs a warning.
 *
 * @param apiKey     OpenAI API key
 * @param sessionId  Agent session ID (used as the registry key)
 * @param opts       Optional manager + abort signal overrides
 */
export function createOpenAIWebSocketStreamFn(
  apiKey: string,
  sessionId: string,
  opts: OpenAIWebSocketStreamOptions = {},
): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    let traceSnapshot = serializeTrace({ phase: "init", sessionId });

    const run = async () => {
      const transport = resolveWsTransport(options);
      if (transport === "sse") {
        return fallbackToHttp(model, context, options, eventStream, opts.signal);
      }

      // ── 1. Get or create session state ──────────────────────────────────
      let session = wsRegistry.get(sessionId);

      if (!session) {
        const manager = new OpenAIWebSocketManager(opts.managerOptions);
        session = {
          manager,
          lastContextLength: 0,
          lastContextBoundaryKey: null,
          everConnected: false,
          warmUpAttempted: false,
          broken: false,
        };
        wsRegistry.set(sessionId, session);
      }

      // ── 2. Ensure connection is open ─────────────────────────────────────
      if (!session.manager.isConnected() && !session.broken) {
        try {
          await session.manager.connect(apiKey);
          session.everConnected = true;
          log.debug(`[ws-stream] connected for session=${sessionId}`);
        } catch (connErr) {
          // Cancel any background reconnect attempts before marking as broken.
          try {
            session.manager.close();
          } catch {
            /* ignore */
          }
          session.broken = true;
          wsRegistry.delete(sessionId);
          if (transport === "websocket") {
            throw connErr instanceof Error ? connErr : new Error(String(connErr));
          }
          log.warn(
            `[ws-stream] WebSocket connect failed for session=${sessionId}; falling back to HTTP. error=${String(connErr)}`,
          );
          // Fall back to HTTP immediately
          return fallbackToHttp(model, context, options, eventStream, opts.signal);
        }
      }

      if (session.broken || !session.manager.isConnected()) {
        if (transport === "websocket") {
          throw new Error("WebSocket session disconnected");
        }
        log.warn(`[ws-stream] session=${sessionId} broken/disconnected; falling back to HTTP`);
        // Clean up stale session to prevent next turn from using stale
        // previousResponseId / lastContextLength after a mid-request drop.
        try {
          session.manager.close();
        } catch {
          /* ignore */
        }
        wsRegistry.delete(sessionId);
        return fallbackToHttp(model, context, options, eventStream, opts.signal);
      }

      const signal = opts.signal ?? (options as WsOptions | undefined)?.signal;

      if (resolveWsWarmup(options) && !session.warmUpAttempted) {
        session.warmUpAttempted = true;
        try {
          await runWarmUp({
            manager: session.manager,
            modelId: model.id,
            tools: convertTools(context.tools),
            instructions: context.systemPrompt ?? undefined,
            signal,
          });
          // Warm-up responses are synthetic probes and must never seed replay state.
          session.manager.clearPreviousResponseId();
          log.debug(`[ws-stream] warm-up completed for session=${sessionId}`);
        } catch (warmErr) {
          if (signal?.aborted) {
            throw warmErr instanceof Error ? warmErr : new Error(String(warmErr));
          }
          log.warn(
            `[ws-stream] warm-up failed for session=${sessionId}; continuing without warm-up. error=${String(warmErr)}`,
          );
        }
      }

      // ── 3. Compute incremental vs full input ─────────────────────────────
      let prevResponseId = session.manager.previousResponseId;
      let inputItems: InputItem[];
      let usePreviousResponseId = false;
      let replayWindow: Message[] = [];
      let knownCallIds: string[] = [];
      let declaredReplayCallIds: string[] = [];
      let outputIds: string[] = [];
      let unknownOutputs: string[] = [];
      let replayOrphanOutputs: string[] = [];
      let lastFullInputDroppedCallIds: string[] = [];

      const buildSanitizedFullInput = (): InputItem[] => {
        const fullInput = buildFullInput(context);
        const { sanitized, droppedCallIds } = dropOrphanFunctionCallOutputs(fullInput);
        lastFullInputDroppedCallIds = droppedCallIds;
        if (droppedCallIds.length > 0) {
          log.warn(
            `[ws-stream] session=${sessionId}: dropped orphan function_call_output item(s) without matching function_call in full input; dropped_call_ids=${droppedCallIds.join(",")} full_input=${serializeTrace(summarizeInputItemsForTrace(fullInput))}`,
          );
        }
        return sanitized;
      };

      const resetReplayState = (reason: string) => {
        log.warn(
          `[ws-stream] session=${sessionId}: ${reason} replay_window=${serializeTrace(summarizeMessagesForTrace(replayWindow, Math.max(0, context.messages.length - replayWindow.length)))} recent_context=${serializeTrace(summarizeMessagesForTrace(context.messages, Math.max(0, context.messages.length - 6)))}`,
        );
        session.manager.clearPreviousResponseId();
        prevResponseId = null;
        session.lastContextLength = 0;
        session.lastContextBoundaryKey = null;
      };

      // Validate replay boundary before attempting incremental send.
      if (prevResponseId && session.lastContextLength > 0) {
        const boundaryIndex = session.lastContextLength - 1;
        const boundaryMessage = boundaryIndex >= 0 ? context.messages[boundaryIndex] : null;
        const boundaryKey = boundaryMessage ? JSON.stringify(boundaryMessage) : null;
        if (
          session.lastContextBoundaryKey != null &&
          boundaryKey !== session.lastContextBoundaryKey
        ) {
          resetReplayState(
            "context boundary drift detected; clearing previous_response_id and replay cursor",
          );
        }
      }

      if (prevResponseId && session.lastContextLength > 0) {
        replayWindow = context.messages.slice(session.lastContextLength);

        if (replayWindow.length === 0) {
          resetReplayState(
            "no incremental messages available for replay; resetting to full-context send",
          );
          inputItems = buildSanitizedFullInput();
          log.debug(
            `[ws-stream] session=${sessionId}: full context send (${inputItems.length} items) after replay reset`,
          );
        } else {
          inputItems = convertMessagesToInputItems(replayWindow);

          // Validate that every tool-result call_id maps to an assistant toolCall in context,
          // and that the incremental replay window is self-contained when it includes outputs.
          knownCallIds = Array.from(collectAssistantToolCallIds(context.messages));
          declaredReplayCallIds = Array.from(collectDeclaredFunctionCallIds(inputItems));
          outputIds = Array.from(
            new Set(
              inputItems
                .filter(
                  (i): i is Extract<InputItem, { type: "function_call_output" }> =>
                    i.type === "function_call_output",
                )
                .map((i) => i.call_id),
            ),
          );
          unknownOutputs = outputIds.filter((id) => !knownCallIds.includes(id));
          replayOrphanOutputs = outputIds.filter((id) => !declaredReplayCallIds.includes(id));

          if (unknownOutputs.length > 0) {
            resetReplayState(
              `replay has unknown call_id(s) without matching assistant toolCall in context; unknown=${unknownOutputs.join(",")}`,
            );
            inputItems = buildSanitizedFullInput();
            log.debug(
              `[ws-stream] session=${sessionId}: full context send (${inputItems.length} items) after replay call_id mismatch`,
            );
          } else if (replayOrphanOutputs.length > 0) {
            resetReplayState(
              `incremental replay has function_call_output item(s) without same-window function_call; orphan=${replayOrphanOutputs.join(",")}`,
            );
            inputItems = buildSanitizedFullInput();
            log.debug(
              `[ws-stream] session=${sessionId}: full context send (${inputItems.length} items) after replay self-consistency fallback`,
            );
          } else {
            usePreviousResponseId = true;
            log.debug(
              `[ws-stream] session=${sessionId}: incremental replay send (${inputItems.length} items) previous_response_id=${prevResponseId}`,
            );
          }
        }
      } else {
        // First turn or replay-state reset: send full context
        inputItems = buildSanitizedFullInput();
        log.debug(
          `[ws-stream] session=${sessionId}: full context send (${inputItems.length} items)`,
        );
      }

      // ── 4. Build & send response.create ──────────────────────────────────
      const tools = convertTools(context.tools);

      // Forward generation options that the HTTP path (openai-responses provider) also uses.
      // Cast to record since SimpleStreamOptions carries openai-specific fields as unknown.
      const streamOpts = options as
        | (Record<string, unknown> & {
            temperature?: number;
            maxTokens?: number;
            topP?: number;
            toolChoice?: unknown;
          })
        | undefined;
      const extraParams: Record<string, unknown> = {};
      if (streamOpts?.temperature !== undefined) {
        extraParams.temperature = streamOpts.temperature;
      }
      if (streamOpts?.maxTokens !== undefined) {
        extraParams.max_output_tokens = streamOpts.maxTokens;
      }
      if (streamOpts?.topP !== undefined) {
        extraParams.top_p = streamOpts.topP;
      }
      if (streamOpts?.toolChoice !== undefined) {
        extraParams.tool_choice = streamOpts.toolChoice;
      }
      if (streamOpts?.reasoningEffort || streamOpts?.reasoningSummary) {
        const reasoning: { effort?: string; summary?: string } = {};
        if (streamOpts.reasoningEffort !== undefined) {
          reasoning.effort = streamOpts.reasoningEffort as string;
        }
        if (streamOpts.reasoningSummary !== undefined) {
          reasoning.summary = streamOpts.reasoningSummary as string;
        }
        extraParams.reasoning = reasoning;
      }

      // Respect compat.supportsStore — providers like Gemini reject unknown
      // fields such as `store` with a 400 error.  Fixes #39086.
      const supportsStore = (model as { compat?: { supportsStore?: boolean } }).compat
        ?.supportsStore;

      const payload: Record<string, unknown> = {
        type: "response.create",
        model: model.id,
        ...(supportsStore !== false ? { store: false } : {}),
        input: inputItems,
        instructions: context.systemPrompt ?? undefined,
        tools: tools.length > 0 ? tools : undefined,
        ...(usePreviousResponseId && prevResponseId
          ? { previous_response_id: prevResponseId }
          : {}),
        ...extraParams,
      };
      traceSnapshot = serializeTrace({
        phase: "pre-send",
        sessionId,
        transport,
        modelId: model.id,
        contextLength: context.messages.length,
        lastContextLength: session.lastContextLength,
        previousResponseId: prevResponseId,
        usePreviousResponseId,
        warmUpAttempted: session.warmUpAttempted,
        lastContextBoundaryKey: session.lastContextBoundaryKey,
        replayWindowLength: replayWindow.length,
        replayWindow: summarizeMessagesForTrace(
          replayWindow,
          Math.max(0, context.messages.length - replayWindow.length),
        ),
        recentContext: summarizeMessagesForTrace(context.messages, Math.max(0, context.messages.length - 8)),
        inputItems: summarizeInputItemsForTrace(inputItems),
        knownCallIds,
        declaredReplayCallIds,
        outputIds,
        unknownOutputs,
        replayOrphanOutputs,
        droppedFullInputCallIds: lastFullInputDroppedCallIds,
      });
      log.info(`[ws-stream][trace] ${traceSnapshot}`);
      options?.onPayload?.(payload);

      try {
        session.manager.send(payload as Parameters<OpenAIWebSocketManager["send"]>[0]);
      } catch (sendErr) {
        if (transport === "websocket") {
          throw sendErr instanceof Error ? sendErr : new Error(String(sendErr));
        }
        log.warn(
          `[ws-stream] send failed for session=${sessionId}; falling back to HTTP. error=${String(sendErr)}`,
        );
        // Fully reset session state so the next WS turn doesn't use stale
        // previous_response_id or lastContextLength from before the failure.
        try {
          session.manager.close();
        } catch {
          /* ignore */
        }
        wsRegistry.delete(sessionId);
        return fallbackToHttp(model, context, options, eventStream, opts.signal);
      }

      eventStream.push({
        type: "start",
        partial: buildAssistantMessageWithZeroUsage({
          model,
          content: [],
          stopReason: "stop",
        }),
      });

      // ── 5. Wait for response.completed ───────────────────────────────────
      const capturedContextLength = context.messages.length;

      await new Promise<void>((resolve, reject) => {
        // Honour abort signal
        const abortHandler = () => {
          cleanup();
          reject(new Error("aborted"));
        };
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", abortHandler, { once: true });

        // If the WebSocket drops mid-request, reject so we don't hang forever.
        const closeHandler = (code: number, reason: string) => {
          cleanup();
          reject(
            new Error(`WebSocket closed mid-request (code=${code}, reason=${reason || "unknown"})`),
          );
        };
        session.manager.on("close", closeHandler);

        const cleanup = () => {
          signal?.removeEventListener("abort", abortHandler);
          session.manager.off("close", closeHandler);
          unsubscribe();
        };

        const unsubscribe = session.manager.onMessage((event) => {
          if (event.type === "response.completed") {
            cleanup();
            // Update session state
            session.lastContextLength = capturedContextLength;
            const boundaryIndex = capturedContextLength - 1;
            const boundaryMessage = boundaryIndex >= 0 ? context.messages[boundaryIndex] : null;
            session.lastContextBoundaryKey = boundaryMessage
              ? JSON.stringify(boundaryMessage)
              : null;
            log.info(
              `[ws-stream][trace][completed] session=${sessionId} response_id=${event.response.id ?? "unknown"} previous_response_id=${session.manager.previousResponseId ?? ""} output=${serializeTrace(summarizeResponseOutputForTrace(event.response))} pre_send=${traceSnapshot}`,
            );
            // Build and emit the assistant message
            const assistantMsg = buildAssistantMessageFromResponse(event.response, {
              api: model.api,
              provider: model.provider,
              id: model.id,
            });
            const reason: Extract<StopReason, "stop" | "length" | "toolUse"> =
              assistantMsg.stopReason === "toolUse" ? "toolUse" : "stop";
            eventStream.push({ type: "done", reason, message: assistantMsg });
            resolve();
          } else if (event.type === "response.failed") {
            cleanup();
            const errMsg = event.response?.error?.message ?? "Response failed";
            log.warn(
              `[ws-stream][trace][response.failed] session=${sessionId} response_id=${event.response?.id ?? "unknown"} error=${errMsg} response_output=${serializeTrace(summarizeResponseOutputForTrace(event.response))} pre_send=${traceSnapshot}`,
            );
            reject(new Error(`OpenAI WebSocket response failed: ${errMsg}`));
          } else if (event.type === "error") {
            cleanup();
            log.warn(
              `[ws-stream][trace][socket-error] session=${sessionId} message=${event.message} code=${event.code} pre_send=${traceSnapshot}`,
            );
            reject(new Error(`OpenAI WebSocket error: ${event.message} (code=${event.code})`));
          } else if (event.type === "response.output_text.delta") {
            // Stream partial text updates for responsive UI
            const partialMsg: AssistantMessage = buildAssistantMessageWithZeroUsage({
              model,
              content: [{ type: "text", text: event.delta }],
              stopReason: "stop",
            });
            eventStream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: event.delta,
              partial: partialMsg,
            });
          }
        });
      });
    };

    queueMicrotask(() =>
      run().catch((err) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (isMissingToolCallOutputErrorMessage(errorMessage)) {
          const session = wsRegistry.get(sessionId);
          if (session) {
            session.manager.clearPreviousResponseId();
            session.lastContextLength = 0;
            session.lastContextBoundaryKey = null;
            log.warn(
              `[ws-stream] session=${sessionId}: cleared replay state after missing-tool-call-output error trace=${traceSnapshot}`,
            );
          }
        }
        log.warn(
          `[ws-stream] session=${sessionId} run error: ${errorMessage} trace=${traceSnapshot} context_tail=${serializeTrace(summarizeMessagesForTrace(context.messages, Math.max(0, context.messages.length - 8)))}`,
        );
        eventStream.push({
          type: "error",
          reason: "error",
          error: buildStreamErrorAssistantMessage({
            model,
            errorMessage,
          }),
        });
        eventStream.end();
      }),
    );

    return eventStream;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build full input items from context (system prompt is passed via `instructions` field). */
function buildFullInput(context: Context): InputItem[] {
  return convertMessagesToInputItems(context.messages);
}

/**
 * Fall back to HTTP (`streamSimple`) and pipe events into the existing stream.
 * This is called when the WebSocket is broken or unavailable.
 */
async function fallbackToHttp(
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
  eventStream: ReturnType<typeof createAssistantMessageEventStream>,
  signal?: AbortSignal,
): Promise<void> {
  const mergedOptions = signal ? { ...options, signal } : options;
  const httpStream = streamSimple(model, context, mergedOptions);
  for await (const event of httpStream) {
    eventStream.push(event);
  }
}
