/**
 * OpenResponses HTTP Handler
 *
 * Implements the OpenResponses `/v1/responses` endpoint for OpenClaw Gateway.
 *
 * @see https://www.open-responses.com/
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientToolDefinition } from "../agents/pi-embedded-runner/run/params.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import type { ImageContent } from "../commands/agent/types.js";
import type { GatewayHttpResponsesConfig } from "../config/types.gateway.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DEFAULT_INPUT_IMAGE_MAX_BYTES,
  DEFAULT_INPUT_IMAGE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_TIMEOUT_MS,
  extractFileContentFromSource,
  extractImageContentFromSource,
  normalizeMimeList,
  resolveInputFileLimits,
  type InputFileLimits,
  type InputImageLimits,
  type InputImageSource,
} from "../media/input-files.js";
import { defaultRuntime } from "../runtime.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import {
  buildAgentMessageFromConversationEntries,
  type ConversationEntry,
} from "./agent-prompt.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";
import { sendJson, sendMethodNotAllowed, setSseHeaders, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { resolveAgentIdForRequest, resolveSessionKey } from "./http-utils.js";
import {
  CreateResponseBodySchema,
  type ContentPart,
  type CreateResponseBody,
  type ItemParam,
  type OutputItem,
  type ResponseResource,
  type StreamingEvent,
  type Usage,
} from "./open-responses.schema.js";

type OpenResponsesHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  config?: GatewayHttpResponsesConfig;
  trustedProxies?: string[];
  rateLimiter?: AuthRateLimiter;
};

const DEFAULT_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_URL_PARTS = 8;
const OPENRESPONSES_TOOL_CALL_RELIABILITY_PATH = "/v1/responses/diagnostics/tool-call-reliability";
const openResponsesLog = createSubsystemLogger("gateway/openresponses");
const DIRECT_ACTION_LEAD_VERBS = new Set([
  "run",
  "do",
  "check",
  "execute",
  "fix",
  "install",
  "update",
  "restart",
  "deploy",
  "verify",
  "test",
  "build",
]);

export type OpenResponsesToolCallReliabilityMetrics = {
  toolChoiceNotSatisfied: number;
  toolChoiceRetryAttempted: number;
  toolChoiceRetrySucceeded: number;
  toolChoiceRetryFailed: number;
  toolCallAfterTextDelta: number;
};

const toolCallReliabilityMetrics: OpenResponsesToolCallReliabilityMetrics = {
  toolChoiceNotSatisfied: 0,
  toolChoiceRetryAttempted: 0,
  toolChoiceRetrySucceeded: 0,
  toolChoiceRetryFailed: 0,
  toolCallAfterTextDelta: 0,
};

function incrementToolCallReliabilityMetric(key: keyof OpenResponsesToolCallReliabilityMetrics) {
  toolCallReliabilityMetrics[key] += 1;
}

export function getOpenResponsesToolCallReliabilityMetrics(): OpenResponsesToolCallReliabilityMetrics {
  return { ...toolCallReliabilityMetrics };
}

export function resetOpenResponsesToolCallReliabilityMetrics() {
  toolCallReliabilityMetrics.toolChoiceNotSatisfied = 0;
  toolCallReliabilityMetrics.toolChoiceRetryAttempted = 0;
  toolCallReliabilityMetrics.toolChoiceRetrySucceeded = 0;
  toolCallReliabilityMetrics.toolChoiceRetryFailed = 0;
  toolCallReliabilityMetrics.toolCallAfterTextDelta = 0;
}

function describeToolChoiceRequirement(requirement?: ToolChoiceRequirement): string {
  if (!requirement) {
    return "none";
  }
  if (requirement.kind === "specific") {
    return `function:${requirement.toolName}`;
  }
  return "required";
}

function writeSseEvent(res: ServerResponse, event: StreamingEvent) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function extractTextContent(content: string | ContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === "input_text") {
        return part.text;
      }
      if (part.type === "output_text") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractLatestUserInputText(input: string | ItemParam[]): string {
  if (typeof input === "string") {
    return input.trim();
  }

  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (item.type !== "message" || item.role !== "user") {
      continue;
    }
    const text = extractTextContent(item.content).trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function isDirectActionPrompt(inputText: string): boolean {
  const normalized = inputText.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (
    /\b(run this|do it|check now|do that|go ahead)\b/.test(normalized) ||
    /^(please\s+)?(run|do|check)\s+(this|it|now)\b/.test(normalized)
  ) {
    return true;
  }

  if (/^(what|why|how|when|where|who)\b/.test(normalized)) {
    return false;
  }

  const words = normalized
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 8) {
    return false;
  }

  const firstWord = words[0];
  return DIRECT_ACTION_LEAD_VERBS.has(firstWord);
}

type ResolvedResponsesLimits = {
  maxBodyBytes: number;
  maxUrlParts: number;
  implicitToolChoiceRequiredForDirectAction: boolean;
  files: InputFileLimits;
  images: InputImageLimits;
};

function normalizeHostnameAllowlist(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function resolveResponsesLimits(
  config: GatewayHttpResponsesConfig | undefined,
): ResolvedResponsesLimits {
  const files = config?.files;
  const images = config?.images;
  const fileLimits = resolveInputFileLimits(files);
  return {
    maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_BODY_BYTES,
    maxUrlParts:
      typeof config?.maxUrlParts === "number"
        ? Math.max(0, Math.floor(config.maxUrlParts))
        : DEFAULT_MAX_URL_PARTS,
    implicitToolChoiceRequiredForDirectAction:
      config?.implicitToolChoiceRequiredForDirectAction === true,
    files: {
      ...fileLimits,
      urlAllowlist: normalizeHostnameAllowlist(files?.urlAllowlist),
    },
    images: {
      allowUrl: images?.allowUrl ?? true,
      urlAllowlist: normalizeHostnameAllowlist(images?.urlAllowlist),
      allowedMimes: normalizeMimeList(images?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
      maxBytes: images?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES,
      maxRedirects: images?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
      timeoutMs: images?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    },
  };
}

function extractClientTools(body: CreateResponseBody): ClientToolDefinition[] {
  return (body.tools ?? []) as ClientToolDefinition[];
}

type ToolChoiceRequirement =
  | { kind: "any" }
  | {
      kind: "specific";
      toolName: string;
    };

function applyToolChoice(params: {
  tools: ClientToolDefinition[];
  toolChoice: CreateResponseBody["tool_choice"];
  autoRequireToolCall?: boolean;
}): {
  tools: ClientToolDefinition[];
  extraSystemPrompt?: string;
  requirement?: ToolChoiceRequirement;
} {
  const { tools, toolChoice, autoRequireToolCall } = params;
  if (!toolChoice) {
    if (autoRequireToolCall && tools.length > 0) {
      return {
        tools,
        extraSystemPrompt: "You must call one of the available tools before responding.",
        requirement: { kind: "any" },
      };
    }
    return { tools };
  }

  if (toolChoice === "none") {
    return { tools: [] };
  }

  if (toolChoice === "required") {
    if (tools.length === 0) {
      throw new Error("tool_choice=required but no tools were provided");
    }
    return {
      tools,
      extraSystemPrompt: "You must call one of the available tools before responding.",
      requirement: { kind: "any" },
    };
  }

  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const targetName = toolChoice.function?.name?.trim();
    if (!targetName) {
      throw new Error("tool_choice.function.name is required");
    }
    const matched = tools.filter((tool) => tool.function?.name === targetName);
    if (matched.length === 0) {
      throw new Error(`tool_choice requested unknown tool: ${targetName}`);
    }
    return {
      tools: matched,
      extraSystemPrompt: `You must call the ${targetName} tool before responding.`,
      requirement: { kind: "specific", toolName: targetName },
    };
  }

  return { tools };
}

export function buildAgentPrompt(input: string | ItemParam[]): {
  message: string;
  extraSystemPrompt?: string;
} {
  if (typeof input === "string") {
    return { message: input };
  }

  const systemParts: string[] = [];
  const conversationEntries: ConversationEntry[] = [];

  for (const item of input) {
    if (item.type === "message") {
      const content = extractTextContent(item.content).trim();
      if (!content) {
        continue;
      }

      if (item.role === "system" || item.role === "developer") {
        systemParts.push(content);
        continue;
      }

      const normalizedRole = item.role === "assistant" ? "assistant" : "user";
      const sender = normalizedRole === "assistant" ? "Assistant" : "User";

      conversationEntries.push({
        role: normalizedRole,
        entry: { sender, body: content },
      });
    } else if (item.type === "function_call_output") {
      conversationEntries.push({
        role: "tool",
        entry: { sender: `Tool:${item.call_id}`, body: item.output },
      });
    }
    // Skip reasoning and item_reference for prompt building (Phase 1)
  }

  const message = buildAgentMessageFromConversationEntries(conversationEntries);

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function resolveOpenResponsesSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
}): string {
  return resolveSessionKey({ ...params, prefix: "openresponses" });
}

function createEmptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

function toUsage(
  value:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      }
    | undefined,
): Usage {
  if (!value) {
    return createEmptyUsage();
  }
  const input = value.input ?? 0;
  const output = value.output ?? 0;
  const cacheRead = value.cacheRead ?? 0;
  const cacheWrite = value.cacheWrite ?? 0;
  const total = value.total ?? input + output + cacheRead + cacheWrite;
  return {
    input_tokens: Math.max(0, input),
    output_tokens: Math.max(0, output),
    total_tokens: Math.max(0, total),
  };
}

function extractUsageFromResult(result: unknown): Usage {
  const meta = (result as { meta?: { agentMeta?: { usage?: unknown } } } | null)?.meta;
  const usage = meta && typeof meta === "object" ? meta.agentMeta?.usage : undefined;
  return toUsage(
    usage as
      | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
      | undefined,
  );
}

type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
};

type ToolChoiceResolution = {
  selectedCall?: PendingToolCall;
  errorMessage?: string;
};

function extractToolCallMetaFromResult(result: unknown): {
  stopReason?: string;
  pendingToolCalls?: PendingToolCall[];
} {
  const meta = (result as { meta?: unknown } | null)?.meta;
  if (!meta || typeof meta !== "object") {
    return {};
  }

  const stopReasonRaw = (meta as { stopReason?: unknown }).stopReason;
  const stopReason = typeof stopReasonRaw === "string" ? stopReasonRaw : undefined;

  const pendingRaw = (meta as { pendingToolCalls?: unknown }).pendingToolCalls;
  const pendingToolCalls = Array.isArray(pendingRaw)
    ? pendingRaw.filter((entry): entry is PendingToolCall => {
        if (!entry || typeof entry !== "object") {
          return false;
        }
        const candidate = entry as {
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        return (
          typeof candidate.id === "string" &&
          typeof candidate.name === "string" &&
          typeof candidate.arguments === "string"
        );
      })
    : undefined;

  return {
    stopReason,
    pendingToolCalls,
  };
}

function resolveToolChoiceRequirement(params: {
  requirement?: ToolChoiceRequirement;
  stopReason?: string;
  pendingToolCalls?: PendingToolCall[];
}): ToolChoiceResolution {
  const requirement = params.requirement;
  const toolCalls =
    params.stopReason === "tool_calls" && Array.isArray(params.pendingToolCalls)
      ? params.pendingToolCalls
      : [];

  if (!requirement) {
    return { selectedCall: toolCalls[0] };
  }

  if (requirement.kind === "any") {
    if (toolCalls.length > 0) {
      return { selectedCall: toolCalls[0] };
    }
    return {
      errorMessage:
        "tool_choice=required was not satisfied: assistant finished without a tool call.",
    };
  }

  if (toolCalls.length === 0) {
    return {
      errorMessage:
        `tool_choice.function.name="${requirement.toolName}" was not satisfied: ` +
        "assistant finished without a tool call.",
    };
  }

  const matched = toolCalls.find((call) => call.name === requirement.toolName);
  if (matched) {
    return { selectedCall: matched };
  }

  const received = toolCalls.map((call) => call.name).join(", ");
  return {
    errorMessage:
      `tool_choice.function.name="${requirement.toolName}" was not satisfied: ` +
      `assistant called ${received || "an unexpected tool"}.`,
  };
}

function createResponseResource(params: {
  id: string;
  model: string;
  status: ResponseResource["status"];
  output: OutputItem[];
  usage?: Usage;
  error?: { code: string; message: string };
}): ResponseResource {
  return {
    id: params.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: params.status,
    model: params.model,
    output: params.output,
    usage: params.usage ?? createEmptyUsage(),
    error: params.error,
  };
}

function createAssistantOutputItem(params: {
  id: string;
  text: string;
  status?: "in_progress" | "completed";
}): OutputItem {
  return {
    type: "message",
    id: params.id,
    role: "assistant",
    content: [{ type: "output_text", text: params.text }],
    status: params.status,
  };
}

async function runResponsesAgentCommand(params: {
  message: string;
  images: ImageContent[];
  clientTools: ClientToolDefinition[];
  extraSystemPrompt: string;
  streamParams: { maxTokens: number } | undefined;
  sessionKey: string;
  runId: string;
  deps: ReturnType<typeof createDefaultDeps>;
}) {
  return agentCommand(
    {
      message: params.message,
      images: params.images.length > 0 ? params.images : undefined,
      clientTools: params.clientTools.length > 0 ? params.clientTools : undefined,
      extraSystemPrompt: params.extraSystemPrompt || undefined,
      streamParams: params.streamParams ?? undefined,
      sessionKey: params.sessionKey,
      runId: params.runId,
      deliver: false,
      messageChannel: "webchat",
      bestEffortDeliver: false,
    },
    defaultRuntime,
    params.deps,
  );
}

function buildToolChoiceRetryPrompt(requirement: ToolChoiceRequirement): string {
  if (requirement.kind === "specific") {
    return (
      `RETRY INSTRUCTION: Your previous response failed tool_choice enforcement. ` +
      `Call ONLY the ${requirement.toolName} tool now and output no assistant text.`
    );
  }
  return (
    "RETRY INSTRUCTION: Your previous response failed tool_choice enforcement. " +
    "Call one available tool now and output no assistant text."
  );
}

async function runResponsesAgentCommandWithToolChoiceRetry(params: {
  message: string;
  images: ImageContent[];
  clientTools: ClientToolDefinition[];
  extraSystemPrompt: string;
  streamParams: { maxTokens: number } | undefined;
  sessionKey: string;
  runId: string;
  deps: ReturnType<typeof createDefaultDeps>;
  toolChoiceRequirement?: ToolChoiceRequirement;
}): Promise<{
  result: unknown;
  stopReason?: string;
  pendingToolCalls?: PendingToolCall[];
  toolChoiceResolution: ToolChoiceResolution;
}> {
  const firstResult = await runResponsesAgentCommand({
    message: params.message,
    images: params.images,
    clientTools: params.clientTools,
    extraSystemPrompt: params.extraSystemPrompt,
    streamParams: params.streamParams,
    sessionKey: params.sessionKey,
    runId: params.runId,
    deps: params.deps,
  });
  const firstMeta = extractToolCallMetaFromResult(firstResult);
  const firstResolution = resolveToolChoiceRequirement({
    requirement: params.toolChoiceRequirement,
    stopReason: firstMeta.stopReason,
    pendingToolCalls: firstMeta.pendingToolCalls,
  });

  if (!params.toolChoiceRequirement || !firstResolution.errorMessage) {
    return {
      result: firstResult,
      stopReason: firstMeta.stopReason,
      pendingToolCalls: firstMeta.pendingToolCalls,
      toolChoiceResolution: firstResolution,
    };
  }

  incrementToolCallReliabilityMetric("toolChoiceNotSatisfied");
  incrementToolCallReliabilityMetric("toolChoiceRetryAttempted");
  openResponsesLog.warn("tool_choice retry started", {
    runId: params.runId,
    requirement: describeToolChoiceRequirement(params.toolChoiceRequirement),
    reason: firstResolution.errorMessage,
    stopReason: firstMeta.stopReason,
    pendingToolCalls: (firstMeta.pendingToolCalls ?? []).map((call) => call.name),
  });

  const retryPrompt = buildToolChoiceRetryPrompt(params.toolChoiceRequirement);
  const retrySystemPrompt = [params.extraSystemPrompt, retryPrompt].filter(Boolean).join("\n\n");

  try {
    const retryResult = await runResponsesAgentCommand({
      message: params.message,
      images: params.images,
      clientTools: params.clientTools,
      extraSystemPrompt: retrySystemPrompt,
      streamParams: params.streamParams,
      sessionKey: params.sessionKey,
      runId: params.runId,
      deps: params.deps,
    });
    const retryMeta = extractToolCallMetaFromResult(retryResult);
    const retryResolution = resolveToolChoiceRequirement({
      requirement: params.toolChoiceRequirement,
      stopReason: retryMeta.stopReason,
      pendingToolCalls: retryMeta.pendingToolCalls,
    });

    if (retryResolution.errorMessage) {
      incrementToolCallReliabilityMetric("toolChoiceNotSatisfied");
      incrementToolCallReliabilityMetric("toolChoiceRetryFailed");
      openResponsesLog.warn("tool_choice retry failed", {
        runId: params.runId,
        requirement: describeToolChoiceRequirement(params.toolChoiceRequirement),
        reason: retryResolution.errorMessage,
        stopReason: retryMeta.stopReason,
        pendingToolCalls: (retryMeta.pendingToolCalls ?? []).map((call) => call.name),
      });
    } else {
      incrementToolCallReliabilityMetric("toolChoiceRetrySucceeded");
      openResponsesLog.info("tool_choice retry succeeded", {
        runId: params.runId,
        requirement: describeToolChoiceRequirement(params.toolChoiceRequirement),
        selectedToolCall: retryResolution.selectedCall?.name,
      });
    }

    return {
      result: retryResult,
      stopReason: retryMeta.stopReason,
      pendingToolCalls: retryMeta.pendingToolCalls,
      toolChoiceResolution: retryResolution,
    };
  } catch (err) {
    incrementToolCallReliabilityMetric("toolChoiceRetryFailed");
    openResponsesLog.warn("tool_choice retry errored", {
      runId: params.runId,
      requirement: describeToolChoiceRequirement(params.toolChoiceRequirement),
      error: String(err),
    });
    throw err;
  }
}

export async function handleOpenResponsesHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenResponsesHttpOptions,
): Promise<boolean> {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (requestUrl.pathname === OPENRESPONSES_TOOL_CALL_RELIABILITY_PATH) {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    const authorized = await authorizeGatewayBearerRequestOrReply({
      req,
      res,
      auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      rateLimiter: opts.rateLimiter,
    });
    if (!authorized) {
      return true;
    }

    sendJson(res, 200, {
      object: "openresponses.tool_call_reliability",
      metrics: getOpenResponsesToolCallReliabilityMetrics(),
    });
    return true;
  }

  const limits = resolveResponsesLimits(opts.config);
  const maxBodyBytes =
    opts.maxBodyBytes ??
    (opts.config?.maxBodyBytes
      ? limits.maxBodyBytes
      : Math.max(limits.maxBodyBytes, limits.files.maxBytes * 2, limits.images.maxBytes * 2));
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/responses",
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  // Validate request body with Zod
  const parseResult = CreateResponseBodySchema.safeParse(handled.body);
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0];
    const message = issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request body";
    sendJson(res, 400, {
      error: { message, type: "invalid_request_error" },
    });
    return true;
  }

  const payload: CreateResponseBody = parseResult.data;
  const stream = Boolean(payload.stream);
  const model = payload.model;
  const user = payload.user;

  // Extract images + files from input (Phase 2)
  let images: ImageContent[] = [];
  let fileContexts: string[] = [];
  let urlParts = 0;
  const markUrlPart = () => {
    urlParts += 1;
    if (urlParts > limits.maxUrlParts) {
      throw new Error(
        `Too many URL-based input sources: ${urlParts} (limit: ${limits.maxUrlParts})`,
      );
    }
  };
  try {
    if (Array.isArray(payload.input)) {
      for (const item of payload.input) {
        if (item.type === "message" && typeof item.content !== "string") {
          for (const part of item.content) {
            if (part.type === "input_image") {
              const source = part.source as {
                type?: string;
                url?: string;
                data?: string;
                media_type?: string;
              };
              const sourceType =
                source.type === "base64" || source.type === "url" ? source.type : undefined;
              if (!sourceType) {
                throw new Error("input_image must have 'source.url' or 'source.data'");
              }
              if (sourceType === "url") {
                markUrlPart();
              }
              const imageSource: InputImageSource = {
                type: sourceType,
                url: source.url,
                data: source.data,
                mediaType: source.media_type,
              };
              const image = await extractImageContentFromSource(imageSource, limits.images);
              images.push(image);
              continue;
            }

            if (part.type === "input_file") {
              const source = part.source as {
                type?: string;
                url?: string;
                data?: string;
                media_type?: string;
                filename?: string;
              };
              const sourceType =
                source.type === "base64" || source.type === "url" ? source.type : undefined;
              if (!sourceType) {
                throw new Error("input_file must have 'source.url' or 'source.data'");
              }
              if (sourceType === "url") {
                markUrlPart();
              }
              const file = await extractFileContentFromSource({
                source: {
                  type: sourceType,
                  url: source.url,
                  data: source.data,
                  mediaType: source.media_type,
                  filename: source.filename,
                },
                limits: limits.files,
              });
              if (file.text?.trim()) {
                fileContexts.push(`<file name="${file.filename}">\n${file.text}\n</file>`);
              } else if (file.images && file.images.length > 0) {
                fileContexts.push(
                  `<file name="${file.filename}">[PDF content rendered to images]</file>`,
                );
              }
              if (file.images && file.images.length > 0) {
                images = images.concat(file.images);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    logWarn(`openresponses: request parsing failed: ${String(err)}`);
    sendJson(res, 400, {
      error: { message: "invalid request", type: "invalid_request_error" },
    });
    return true;
  }

  const clientTools = extractClientTools(payload);
  const latestUserInputText = extractLatestUserInputText(payload.input);
  const autoRequireToolCall =
    !payload.tool_choice &&
    limits.implicitToolChoiceRequiredForDirectAction &&
    isDirectActionPrompt(latestUserInputText) &&
    clientTools.length > 0;
  let toolChoicePrompt: string | undefined;
  let toolChoiceRequirement: ToolChoiceRequirement | undefined;
  let resolvedClientTools = clientTools;
  try {
    const toolChoiceResult = applyToolChoice({
      tools: clientTools,
      toolChoice: payload.tool_choice,
      autoRequireToolCall,
    });
    resolvedClientTools = toolChoiceResult.tools;
    toolChoicePrompt = toolChoiceResult.extraSystemPrompt;
    toolChoiceRequirement = toolChoiceResult.requirement;
  } catch (err) {
    logWarn(`openresponses: tool configuration failed: ${String(err)}`);
    sendJson(res, 400, {
      error: { message: "invalid tool configuration", type: "invalid_request_error" },
    });
    return true;
  }
  const agentId = resolveAgentIdForRequest({ req, model });
  const sessionKey = resolveOpenResponsesSessionKey({ req, agentId, user });

  // Build prompt from input
  const prompt = buildAgentPrompt(payload.input);

  const fileContext = fileContexts.length > 0 ? fileContexts.join("\n\n") : undefined;
  const toolChoiceContext = toolChoicePrompt?.trim();

  // Handle instructions + file context as extra system prompt
  const extraSystemPrompt = [
    payload.instructions,
    prompt.extraSystemPrompt,
    toolChoiceContext,
    fileContext,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!prompt.message) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `input`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const responseId = `resp_${randomUUID()}`;
  const outputItemId = `msg_${randomUUID()}`;
  const deps = createDefaultDeps();
  const streamParams =
    typeof payload.max_output_tokens === "number"
      ? { maxTokens: payload.max_output_tokens }
      : undefined;

  if (!stream) {
    try {
      const runOutcome = await runResponsesAgentCommandWithToolChoiceRetry({
        message: prompt.message,
        images,
        clientTools: resolvedClientTools,
        extraSystemPrompt,
        streamParams,
        sessionKey,
        runId: responseId,
        deps,
        toolChoiceRequirement,
      });
      const result = runOutcome.result;

      const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
      const usage = extractUsageFromResult(result);
      const toolChoiceResolution = runOutcome.toolChoiceResolution;

      if (toolChoiceResolution.errorMessage) {
        const response = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          usage,
          error: {
            code: "tool_choice_not_satisfied",
            message: toolChoiceResolution.errorMessage,
          },
        });
        sendJson(res, 422, response);
        return true;
      }

      // If agent called a client tool, return function_call instead of text
      if (toolChoiceResolution.selectedCall) {
        const functionCall = toolChoiceResolution.selectedCall;
        const functionCallItemId = `call_${randomUUID()}`;
        const response = createResponseResource({
          id: responseId,
          model,
          status: "incomplete",
          output: [
            {
              type: "function_call",
              id: functionCallItemId,
              call_id: functionCall.id,
              name: functionCall.name,
              arguments: functionCall.arguments,
            },
          ],
          usage,
        });
        sendJson(res, 200, response);
        return true;
      }

      const content =
        Array.isArray(payloads) && payloads.length > 0
          ? payloads
              .map((p) => (typeof p.text === "string" ? p.text : ""))
              .filter(Boolean)
              .join("\n\n")
          : "No response from OpenClaw.";

      const response = createResponseResource({
        id: responseId,
        model,
        status: "completed",
        output: [
          createAssistantOutputItem({ id: outputItemId, text: content, status: "completed" }),
        ],
        usage,
      });

      sendJson(res, 200, response);
    } catch (err) {
      logWarn(`openresponses: non-stream response failed: ${String(err)}`);
      const response = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: { code: "api_error", message: "internal error" },
      });
      sendJson(res, 500, response);
    }
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Streaming mode
  // ─────────────────────────────────────────────────────────────────────────

  setSseHeaders(res);

  let accumulatedText = "";
  const shouldBufferAssistantText =
    Boolean(toolChoiceRequirement) || resolvedClientTools.length > 0;
  let sawAssistantDelta = false;
  let emittedAssistantDelta = false;
  let closed = false;
  let unsubscribe = () => {};
  let finalUsage: Usage | undefined;
  let lifecyclePhase: "end" | "error" | null = null;
  let runFinished = false;
  let stopReason: string | undefined;
  let pendingToolCalls: PendingToolCall[] | undefined;
  let toolChoiceResolution: ToolChoiceResolution | undefined;

  const maybeFinalize = () => {
    if (closed) {
      return;
    }
    if (!runFinished || !lifecyclePhase) {
      return;
    }
    if (!finalUsage) {
      return;
    }
    const usage = finalUsage;
    if (toolChoiceResolution?.errorMessage) {
      const failedResponse = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        usage,
        error: {
          code: "tool_choice_not_satisfied",
          message: toolChoiceResolution.errorMessage,
        },
      });
      closed = true;
      unsubscribe();
      writeSseEvent(res, { type: "response.failed", response: failedResponse });
      writeDone(res);
      res.end();
      return;
    }

    const pendingToolCall = toolChoiceResolution?.selectedCall;

    closed = true;
    unsubscribe();

    if (pendingToolCall) {
      writeSseEvent(res, {
        type: "response.output_text.done",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        text: "",
      });
      writeSseEvent(res, {
        type: "response.content_part.done",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" },
      });

      const completedItem = createAssistantOutputItem({
        id: outputItemId,
        text: "",
        status: "completed",
      });
      writeSseEvent(res, {
        type: "response.output_item.done",
        output_index: 0,
        item: completedItem,
      });

      const functionCallItemId = `call_${randomUUID()}`;
      const functionCallItem = {
        type: "function_call" as const,
        id: functionCallItemId,
        call_id: pendingToolCall.id,
        name: pendingToolCall.name,
        arguments: pendingToolCall.arguments,
      };
      writeSseEvent(res, {
        type: "response.output_item.added",
        output_index: 1,
        item: functionCallItem,
      });
      writeSseEvent(res, {
        type: "response.output_item.done",
        output_index: 1,
        item: { ...functionCallItem, status: "completed" as const },
      });

      const incompleteResponse = createResponseResource({
        id: responseId,
        model,
        status: "incomplete",
        output: [completedItem, functionCallItem],
        usage,
      });

      writeSseEvent(res, { type: "response.completed", response: incompleteResponse });
      writeDone(res);
      res.end();
      return;
    }

    const finalText = accumulatedText || "No response from OpenClaw.";
    const finalStatus = lifecyclePhase === "error" ? "failed" : "completed";

    if (shouldBufferAssistantText && finalText && !emittedAssistantDelta) {
      emittedAssistantDelta = true;
      writeSseEvent(res, {
        type: "response.output_text.delta",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        delta: finalText,
      });
    }

    writeSseEvent(res, {
      type: "response.output_text.done",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      text: finalText,
    });

    writeSseEvent(res, {
      type: "response.content_part.done",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: finalText },
    });

    const completedItem = createAssistantOutputItem({
      id: outputItemId,
      text: finalText,
      status: "completed",
    });

    writeSseEvent(res, {
      type: "response.output_item.done",
      output_index: 0,
      item: completedItem,
    });

    const finalResponse = createResponseResource({
      id: responseId,
      model,
      status: finalStatus,
      output: [completedItem],
      usage,
    });

    writeSseEvent(res, { type: "response.completed", response: finalResponse });
    writeDone(res);
    res.end();
  };

  // Send initial events
  const initialResponse = createResponseResource({
    id: responseId,
    model,
    status: "in_progress",
    output: [],
  });

  writeSseEvent(res, { type: "response.created", response: initialResponse });
  writeSseEvent(res, { type: "response.in_progress", response: initialResponse });

  // Add output item
  const outputItem = createAssistantOutputItem({
    id: outputItemId,
    text: "",
    status: "in_progress",
  });

  writeSseEvent(res, {
    type: "response.output_item.added",
    output_index: 0,
    item: outputItem,
  });

  // Add content part
  writeSseEvent(res, {
    type: "response.content_part.added",
    item_id: outputItemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });

  unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== responseId) {
      return;
    }
    if (closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const content = resolveAssistantStreamDeltaText(evt);
      if (!content) {
        return;
      }

      sawAssistantDelta = true;
      accumulatedText += content;

      if (shouldBufferAssistantText) {
        return;
      }
      emittedAssistantDelta = true;
      writeSseEvent(res, {
        type: "response.output_text.delta",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        delta: content,
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "error") {
        lifecyclePhase = "error";
        maybeFinalize();
        return;
      }
      if (phase === "end" && !lifecyclePhase) {
        lifecyclePhase = "end";
        maybeFinalize();
      }
    }
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const runOutcome = await runResponsesAgentCommandWithToolChoiceRetry({
        message: prompt.message,
        images,
        clientTools: resolvedClientTools,
        extraSystemPrompt,
        streamParams,
        sessionKey,
        runId: responseId,
        deps,
        toolChoiceRequirement,
      });
      const result = runOutcome.result;

      finalUsage = extractUsageFromResult(result);
      stopReason = runOutcome.stopReason;
      pendingToolCalls = runOutcome.pendingToolCalls;
      toolChoiceResolution = runOutcome.toolChoiceResolution;
      if (sawAssistantDelta && toolChoiceResolution.selectedCall) {
        incrementToolCallReliabilityMetric("toolCallAfterTextDelta");
      }
      runFinished = true;
      maybeFinalize();

      if (closed) {
        return;
      }

      // Fallback: if no streaming deltas were received, send the full response
      const hasPendingToolCall =
        stopReason === "tool_calls" && Boolean(toolChoiceResolution?.selectedCall);
      if (!sawAssistantDelta && !hasPendingToolCall && !toolChoiceResolution?.errorMessage) {
        const resultAny = result as { payloads?: Array<{ text?: string }>; meta?: unknown };
        const payloads = resultAny.payloads;

        const content =
          Array.isArray(payloads) && payloads.length > 0
            ? payloads
                .map((p) => (typeof p.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join("\n\n")
            : "No response from OpenClaw.";

        accumulatedText = content;
        sawAssistantDelta = true;

        if (!shouldBufferAssistantText) {
          emittedAssistantDelta = true;
          writeSseEvent(res, {
            type: "response.output_text.delta",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            delta: content,
          });
        }
      }

      maybeFinalize();
    } catch (err) {
      logWarn(`openresponses: streaming response failed: ${String(err)}`);
      if (closed) {
        return;
      }

      finalUsage = finalUsage ?? createEmptyUsage();
      runFinished = true;
      const errorResponse = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: { code: "api_error", message: "internal error" },
        usage: finalUsage,
      });

      writeSseEvent(res, { type: "response.failed", response: errorResponse });
      emitAgentEvent({
        runId: responseId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
    } finally {
      if (!closed) {
        // Emit lifecycle end to trigger completion
        emitAgentEvent({
          runId: responseId,
          stream: "lifecycle",
          data: { phase: "end" },
        });
      }
    }
  })();

  return true;
}
