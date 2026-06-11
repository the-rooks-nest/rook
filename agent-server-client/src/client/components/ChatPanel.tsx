import { useEffect, useReducer, useRef, useState } from "react";
import { Block, UserMessageBlock, ThinkingBlock, AgentTextBlock, ToolBlock } from "../types";
import {
  AgentBackend,
  AgentRunStatus,
  AgentSessionSummary,
} from "../agent";
import { RemoteAgent, type RemoteSessionEvent } from "../remoteAgent";
import type { AcpClientEvent } from "../acpClientTypes";
import {
  ENVIRONMENT_OFFER_AVAILABLE_KIND,
  ENVIRONMENT_OFFER_RESOLVED_KIND,
  type EnvironmentOfferAvailablePayload,
  type EnvironmentOfferResolvedPayload,
} from "../../shared/environment";
import { MessageThread } from "./MessageThread";
import { ComposeBox } from "./ComposeBox";
import { BlockModal } from "./BlockModal";
import {
  createParentMessageToolState,
  maybePostParentMessageToolCall,
  recordParentMessageToolInputDelta,
  recordParentMessageToolStart,
  type ParentMessagePoster,
} from "../parentMessageTool";

type StatusState = { status: AgentRunStatus | "queued"; message: string };
type QueuedMessage = { id: string; text: string };
type State = {
  blocks: Block[];
  isAgentProcessing: boolean;
  status: StatusState;
  queuedMessages: QueuedMessage[];
};

type Action =
  | { type: "STATUS_CHANGED"; status: AgentRunStatus; message?: string }
  | { type: "USER_MESSAGE_QUEUED"; message: QueuedMessage }
  | { type: "USER_MESSAGE_DEQUEUED"; id: string }
  | { type: "USER_MESSAGE"; text: string; messageId?: string }
  | { type: "AGENT_MESSAGE_CHUNK"; text: string }
  | { type: "AGENT_THOUGHT_CHUNK"; text: string }
  | { type: "TOOL_CALL_STARTED"; toolCallId: string; toolName: string; rawInput?: string }
  | { type: "TOOL_INPUT_DELTA"; toolCallId: string; toolName?: string; delta: string }
  | { type: "TOOL_RUNNING"; toolCallId: string }
  | { type: "TOOL_OUTPUT_DELTA"; toolCallId: string; toolName?: string; delta: string }
  | { type: "TOOL_COMPLETED"; toolCallId: string; toolName: string; output: string }
  | { type: "TOOL_ERROR"; toolCallId: string; toolName: string; error: string }
  | { type: "RUN_COMPLETED" }
  | { type: "RUN_FAILED"; error: string; source?: "run" | "connection" | "protocol" };

function finalizeStreamingBlocks(blocks: Block[]): Block[] {
  return blocks.map((b) => {
    if (b.type === "toolBlock") {
      const status = b.status === "input_streaming" ? "ready" : b.status;
      return b.argumentsStreaming ? { ...b, status, argumentsStreaming: false } : { ...b, status };
    }
    if (b.type === "text" || b.type === "thinking") return b.isStreaming ? { ...b, isStreaming: false } : b;
    return b;
  });
}

function updateLastToolBlock(blocks: Block[], toolCallId: string, update: (block: ToolBlock) => ToolBlock): Block[] {
  const next = [...blocks];
  const idx = next.findLastIndex((b) => b.type === "toolBlock" && b.id === toolCallId);
  if (idx === -1) return blocks;
  next[idx] = update(next[idx] as ToolBlock);
  return next;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "STATUS_CHANGED":
      return {
        ...state,
        status: { status: action.status, message: action.message ?? action.status },
        isAgentProcessing: action.status !== "idle" && action.status !== "error",
      };

    case "USER_MESSAGE_QUEUED":
      return {
        ...state,
        status: { status: "queued", message: `${state.queuedMessages.length + 1} queued message${state.queuedMessages.length === 0 ? "" : "s"}` },
        queuedMessages: [...state.queuedMessages, action.message],
      };

    case "USER_MESSAGE_DEQUEUED":
      return {
        ...state,
        queuedMessages: state.queuedMessages.filter((message) => message.id !== action.id),
      };

    case "USER_MESSAGE": {
      const block: UserMessageBlock = { type: "text", role: "user", text: action.text, isStreaming: false };
      return { ...state, blocks: [...finalizeStreamingBlocks(state.blocks), block] };
    }

    case "AGENT_MESSAGE_CHUNK": {
      const blocks = [...state.blocks];
      const last = blocks[blocks.length - 1];
      if (last && last.type === "text" && last.role === "assistant" && last.isStreaming) {
        blocks[blocks.length - 1] = { ...last, text: last.text + action.text };
      } else {
        blocks.push({ type: "text", role: "assistant", text: action.text, isStreaming: true } as AgentTextBlock);
      }
      return { ...state, blocks };
    }

    case "AGENT_THOUGHT_CHUNK": {
      const blocks = [...state.blocks];
      const last = blocks[blocks.length - 1];
      if (last && last.type === "thinking" && last.isStreaming) {
        blocks[blocks.length - 1] = { ...last, thinking: last.thinking + action.text };
      } else {
        blocks.push({ type: "thinking", thinking: action.text, isStreaming: true } as ThinkingBlock);
      }
      return { ...state, blocks };
    }

    case "TOOL_CALL_STARTED": {
      const exists = state.blocks.some((b) => b.type === "toolBlock" && b.id === action.toolCallId);
      if (exists) return state;

      return {
        ...state,
        blocks: [
          ...state.blocks,
          {
            type: "toolBlock",
            id: action.toolCallId,
            name: action.toolName,
            status: "input_streaming",
            arguments: action.rawInput ?? "",
            argumentsStreaming: !!action.rawInput,
            result: null,
            isError: false,
          },
        ],
      };
    }

    case "TOOL_INPUT_DELTA": {
      const blocks = [...state.blocks];
      const idx = blocks.findLastIndex((b) => b.type === "toolBlock" && b.id === action.toolCallId);
      if (idx !== -1) {
        const existing = blocks[idx] as ToolBlock;
        blocks[idx] = { ...existing, status: "input_streaming", arguments: existing.arguments + action.delta };
      } else {
        blocks.push({
          type: "toolBlock",
          id: action.toolCallId,
          name: action.toolName ?? "tool",
          status: "input_streaming",
          arguments: action.delta,
          argumentsStreaming: true,
          result: null,
          isError: false,
        });
      }
      return { ...state, blocks };
    }

    case "TOOL_RUNNING":
      return {
        ...state,
        blocks: updateLastToolBlock(state.blocks, action.toolCallId, (b) => ({ ...b, status: "running", argumentsStreaming: false })),
      };

    case "TOOL_OUTPUT_DELTA":
      return {
        ...state,
        blocks: updateLastToolBlock(state.blocks, action.toolCallId, (b) => ({
          ...b,
          status: "running",
          result: action.delta,
          isError: false,
          argumentsStreaming: false,
        })),
      };

    case "TOOL_COMPLETED":
      return {
        ...state,
        blocks: updateLastToolBlock(state.blocks, action.toolCallId, (b) => ({
          ...b,
          status: "completed",
          result: action.output,
          isError: false,
          argumentsStreaming: false,
        })),
      };

    case "TOOL_ERROR":
      return {
        ...state,
        blocks: updateLastToolBlock(state.blocks, action.toolCallId, (b) => ({
          ...b,
          status: "error",
          result: action.error,
          isError: true,
          argumentsStreaming: false,
        })),
      };

    case "RUN_COMPLETED":
      return {
        ...state,
        isAgentProcessing: false,
        status: state.queuedMessages.length > 0
          ? { status: "queued", message: `${state.queuedMessages.length} queued message${state.queuedMessages.length === 1 ? "" : "s"}` }
          : { status: "idle", message: "Ready" },
        blocks: finalizeStreamingBlocks(state.blocks),
      };

    case "RUN_FAILED":
      return {
        ...state,
        isAgentProcessing: false,
        status: { status: "error", message: action.error },
        blocks: [
          ...finalizeStreamingBlocks(state.blocks),
          { type: "error", source: action.source ?? "run", message: action.error },
        ],
      };

    default:
      return state;
  }
}

interface ChatPanelProps {
  agentBackend: AgentBackend;
  initialSession: AgentSessionSummary | null;
  disabled?: boolean;
  onParentMessage?: ParentMessagePoster | null;
  onEnvironmentOfferAvailable?: (payload: EnvironmentOfferAvailablePayload) => void;
  onEnvironmentOfferResolved?: (payload: EnvironmentOfferResolvedPayload) => void;
  replayEvents?: RemoteSessionEvent[];
}

export function ChatPanel({
  agentBackend,
  initialSession,
  disabled = false,
  onParentMessage = null,
  onEnvironmentOfferAvailable,
  onEnvironmentOfferResolved,
  replayEvents = [],
}: ChatPanelProps) {
  const [state, dispatch] = useReducer(reducer, {
    blocks: [],
    isAgentProcessing: false,
    status: { status: "idle", message: "Ready" },
    queuedMessages: [],
  });
  const [selectedBlock, setSelectedBlock] = useState<Block | null>(null);
  const agentRef = useRef<RemoteAgent | null>(null);
  const queueRef = useRef<QueuedMessage[]>([]);
  const isAgentProcessingRef = useRef(false);
  const messageIdRef = useRef(0);
  const parentMessageToolStateRef = useRef(createParentMessageToolState());
  const replayAppliedRef = useRef(false);

  const handleRunCompletion = () => {
    dispatch({ type: "RUN_COMPLETED" });
    const nextMessage = queueRef.current.shift();
    if (nextMessage) {
      dispatch({ type: "USER_MESSAGE_DEQUEUED", id: nextMessage.id });
      window.setTimeout(() => startAgentRun(nextMessage.text), 120);
    } else {
      isAgentProcessingRef.current = false;
    }
  };

  const applyAcpEvent = (event: AcpClientEvent) => {
    switch (event.type) {
      case "acp_status_changed":
        dispatch({ type: "STATUS_CHANGED", status: event.status, message: event.message });
        break;
      case "acp_user_message":
        dispatch({ type: "USER_MESSAGE", text: event.text, messageId: event.messageId });
        break;
      case "acp_user_message_chunk":
        // User message chunks are the server replaying queued messages; skip duplicates
        break;
      case "acp_agent_message_chunk":
        dispatch({ type: "AGENT_MESSAGE_CHUNK", text: event.text });
        break;
      case "acp_agent_thought_chunk":
        dispatch({ type: "AGENT_THOUGHT_CHUNK", text: event.text });
        break;
      case "acp_tool_call_started": {
        const toolName = event.title;
        recordParentMessageToolStart(parentMessageToolStateRef.current, {
          toolCallId: event.toolCallId,
          toolName,
          rawInput: event.rawInput,
        });
        dispatch({
          type: "TOOL_CALL_STARTED",
          toolCallId: event.toolCallId,
          toolName,
          rawInput: event.rawInput,
        });
        break;
      }
      case "acp_tool_call_update": {
        const tc = event;
        switch (tc.status) {
          case "in_progress": {
            if (tc.output !== undefined) {
              // Tool output delta
              dispatch({
                type: "TOOL_OUTPUT_DELTA",
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                delta: tc.output,
              });
            } else {
              dispatch({ type: "TOOL_RUNNING", toolCallId: tc.toolCallId });
            }
            break;
          }
          case "completed": {
            // Trigger parent message relay for message_parent tool calls
            maybePostParentMessageToolCall(
              parentMessageToolStateRef.current,
              { toolCallId: tc.toolCallId, toolName: tc.toolName },
              onParentMessage,
            );
            dispatch({
              type: "TOOL_COMPLETED",
              toolCallId: tc.toolCallId,
              toolName: tc.toolName ?? "tool",
              output: tc.output ?? "",
            });
            break;
          }
          case "failed":
          case "cancelled":
            dispatch({
              type: "TOOL_ERROR",
              toolCallId: tc.toolCallId,
              toolName: tc.toolName ?? "tool",
              error: tc.output ?? tc.status,
            });
            break;
        }
        break;
      }
      case "acp_run_completed":
        handleRunCompletion();
        break;
      case "acp_run_failed":
        isAgentProcessingRef.current = false;
        dispatch({ type: "RUN_FAILED", error: event.error, source: "run" });
        break;
      case "acp_connection_error":
        isAgentProcessingRef.current = false;
        dispatch({ type: "RUN_FAILED", error: event.error, source: "connection" });
        break;
      case "acp_environment_event":
        if (event.kind === ENVIRONMENT_OFFER_AVAILABLE_KIND && onEnvironmentOfferAvailable) {
          const payload = event.payload;
          if (payload && typeof payload === "object" && "environmentId" in payload && typeof payload.environmentId === "string") {
            const offer = payload as { environmentId: string; sourceName?: unknown; canonicalSourceUrl?: unknown };
            onEnvironmentOfferAvailable({
              environmentId: offer.environmentId,
              ...(typeof offer.sourceName === "string" ? { sourceName: offer.sourceName } : {}),
              ...(typeof offer.canonicalSourceUrl === "string" ? { canonicalSourceUrl: offer.canonicalSourceUrl } : {}),
            });
          }
        }
        if (event.kind === ENVIRONMENT_OFFER_RESOLVED_KIND && onEnvironmentOfferResolved) {
          const payload = event.payload;
          if (
            payload
            && typeof payload === "object"
            && "environmentId" in payload
            && typeof payload.environmentId === "string"
            && "decision" in payload
            && (payload.decision === "approved" || payload.decision === "dismissed" || payload.decision === "unavailable")
          ) {
            onEnvironmentOfferResolved({
              environmentId: payload.environmentId,
              decision: payload.decision,
            });
          }
        }
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    if (replayAppliedRef.current) return;
    replayAppliedRef.current = true;
    if (replayEvents.length === 0) return;
    for (const event of replayEvents) applyAcpEvent(event);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    let connectTimer = 0;

    const activeAgent = new RemoteAgent({
      backend: agentBackend,
      session: initialSession ?? undefined,
      onAcpEvent: applyAcpEvent,
    });

    agentRef.current = activeAgent;
    connectTimer = window.setTimeout(() => {
      if (cancelled) return;
      void activeAgent.connect().catch(() => undefined);
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(connectTimer);
      if (agentRef.current === activeAgent) agentRef.current = null;
      activeAgent.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentBackend, initialSession?.id]);

  const startAgentRun = (text: string) => {
    isAgentProcessingRef.current = true;
    const activeAgent = agentRef.current;
    if (!activeAgent) return;
    void activeAgent.run(text);
  };

  const handleSubmit = (text: string) => {
    if (disabled) return;

    if (isAgentProcessingRef.current) {
      messageIdRef.current += 1;
      const queuedMessage = { id: `queued-${messageIdRef.current}`, text };
      queueRef.current.push(queuedMessage);
      dispatch({ type: "USER_MESSAGE_QUEUED", message: queuedMessage });
      return;
    }

    startAgentRun(text);
  };

  return (
    <div className="cwa-panel">
      <MessageThread blocks={state.blocks} isStreaming={state.isAgentProcessing} onOpenBlock={setSelectedBlock} />
      {state.queuedMessages.length > 0 && (
        <div className="cwa-queue" aria-label="Queued messages">
          <div className="cwa-queue__label">Queued</div>
          <ol className="cwa-queue__list">
            {state.queuedMessages.map((message) => (
              <li key={message.id} className="cwa-queue__item">{message.text}</li>
            ))}
          </ol>
        </div>
      )}
      <div className={`cwa-status-line cwa-status-line--${state.status.status}`}>
        <span className="cwa-status-line__dot" />
        <span className="cwa-status-line__label">{state.status.message}</span>
      </div>
      <ComposeBox onSubmit={handleSubmit} isQueueing={state.isAgentProcessing} disabled={disabled} />
      <BlockModal block={selectedBlock} onClose={() => setSelectedBlock(null)} />
    </div>
  );
}
