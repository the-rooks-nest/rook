import type { FastifyInstance } from "fastify";
import type {
  AcpPromptRequest,
  AcpSetConfigOptionRequest,
  AcpSetModeRequest,
  JsonRpcFailure,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcSuccess,
} from "../../shared/acp.js";
import type { SessionRoomManager } from "../realtime/SessionRoomManager.js";
import { errorMessage } from "../serverHelpers.js";
import type { ServerAuth } from "../auth.js";

function jsonRpcError(message: string, id: string | number | null = null, code = -32000): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function jsonRpcSuccess(id: string | number, result: Record<string, unknown>): JsonRpcSuccess<Record<string, unknown>> {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function isPromptRequest(message: JsonRpcMessage): message is AcpPromptRequest {
  return "id" in message && "method" in message && message.method === "session/prompt";
}

function isSetModeRequest(message: JsonRpcMessage): message is AcpSetModeRequest {
  return "id" in message && "method" in message && message.method === "session/set_mode";
}

function isSetConfigOptionRequest(message: JsonRpcMessage): message is AcpSetConfigOptionRequest {
  return "id" in message && "method" in message && message.method === "session/set_config_option";
}

function isCancelMessage(message: JsonRpcMessage): boolean {
  return "method" in message && message.method === "session/cancel";
}

function isSteeringMessageRequest(message: JsonRpcMessage): message is JsonRpcRequest & { params?: { sessionId?: string; text?: string } } {
  return "id" in message && "method" in message && message.method === "_rookery/steering_prompt";
}

function isJsonRpcSuccessMessage(message: JsonRpcMessage): message is JsonRpcSuccess {
  return "id" in message && "result" in message;
}

function isJsonRpcFailureMessage(message: JsonRpcMessage): message is JsonRpcFailure {
  return "error" in message;
}

function requestSessionId(message: AcpPromptRequest | AcpSetModeRequest | AcpSetConfigOptionRequest): string | undefined {
  return typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined;
}

export async function registerWebsocketRoute(app: FastifyInstance, roomManager: SessionRoomManager, auth: ServerAuth): Promise<void> {
  app.get<{ Querystring: { sessionId?: string } }>("/api/ws", { websocket: true }, (socket, request) => {
    const authorization = auth.authorizeRequest(request.raw);
    if (!authorization.ok) {
      socket.send(JSON.stringify(jsonRpcError(authorization.error)));
      socket.close();
      return;
    }

    const sessionId = typeof request.query.sessionId === "string" ? request.query.sessionId.trim() : "";
    if (!sessionId) {
      socket.send(JSON.stringify(jsonRpcError("Missing sessionId")));
      socket.close();
      return;
    }

    const room = roomManager.get(sessionId);
    if (!room) {
      socket.send(JSON.stringify(jsonRpcError("Unknown or inactive session")));
      socket.close();
      return;
    }

    const send = (payload: unknown) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify(payload));
    };

    let unsubscribe: () => void = () => {};
    let closed = false;
    const onRoomEvent = (event: { type: string; [key: string]: unknown }) => {
      try {
        if (event.type === "acp_message") {
          send(event.message);
        }
      } catch {
        unsubscribe();
        socket.close();
      }
    };

    unsubscribe = room.subscribe(onRoomEvent as never);
    void (async () => {
      try {
        if (!room.hasStarted) await room.ensureStarted();
        if (closed) unsubscribe();
      } catch (error) {
        send(jsonRpcError(errorMessage(error)));
        socket.close();
      }
    })();

    socket.on("message", (raw: unknown) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(String(raw)) as JsonRpcMessage;
      } catch (error) {
        send(jsonRpcError(`Invalid websocket payload: ${errorMessage(error)}`));
        return;
      }

      if (isJsonRpcSuccessMessage(message) || isJsonRpcFailureMessage(message)) {
        room.respondToPermissionRequest(message);
        return;
      }

      if (isCancelMessage(message)) {
        void room.cancel().catch(() => {});
        return;
      }

      if (isSteeringMessageRequest(message)) {
        if (typeof message.params?.sessionId !== "string" || message.params.sessionId !== sessionId) {
          send(jsonRpcError("sessionId does not match websocket session", message.id));
          return;
        }
        if (typeof message.params?.text !== "string" || message.params.text.trim().length === 0) {
          send(jsonRpcError("Missing steering message text", message.id));
          return;
        }
        void room.sendSteeringMessage(message.params.text)
          .then(() => {
            send(jsonRpcSuccess(message.id, { accepted: true }));
          })
          .catch((error) => {
            send(jsonRpcError(errorMessage(error), message.id));
          });
        return;
      }

      if (isSetModeRequest(message)) {
        if (requestSessionId(message) !== sessionId) {
          send(jsonRpcError("sessionId does not match websocket session", message.id));
          return;
        }
        if (typeof message.params?.modeId !== "string" || message.params.modeId.trim().length === 0) {
          send(jsonRpcError("Missing modeId", message.id));
          return;
        }
        void room.setMode(message.params.modeId)
          .then((result) => {
            send(jsonRpcSuccess(message.id, typeof result === "object" && result !== null ? result as Record<string, unknown> : {}));
          })
          .catch((error) => {
            send(jsonRpcError(errorMessage(error), message.id));
          });
        return;
      }

      if (isSetConfigOptionRequest(message)) {
        if (requestSessionId(message) !== sessionId) {
          send(jsonRpcError("sessionId does not match websocket session", message.id));
          return;
        }
        if (typeof message.params?.configId !== "string" || message.params.configId.trim().length === 0) {
          send(jsonRpcError("Missing configId", message.id));
          return;
        }
        if (typeof message.params?.value !== "string") {
          send(jsonRpcError("Missing config option value", message.id));
          return;
        }
        void room.setConfigOption(message.params.configId, message.params.value)
          .then((result) => {
            send(jsonRpcSuccess(message.id, typeof result === "object" && result !== null ? result as Record<string, unknown> : {}));
          })
          .catch((error) => {
            send(jsonRpcError(errorMessage(error), message.id));
          });
        return;
      }

      if (!isPromptRequest(message)) {
        const id = "id" in message ? message.id : null;
        send(jsonRpcError("Unsupported message type", id === undefined ? null : id));
        return;
      }

      const promptText = (message.params?.prompt ?? [])
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n\n")
        .trim();

      if (message.params?.sessionId !== sessionId) {
        send(jsonRpcError("sessionId does not match websocket session", message.id));
        return;
      }
      if (!promptText) {
        send(jsonRpcError("Missing text prompt", message.id));
        return;
      }

      void room.run(promptText)
        .then((result) => {
          if (!result.ok) {
            send(jsonRpcError(result.error, message.id));
            return;
          }
          send(jsonRpcSuccess(message.id, { stopReason: result.stopReason }));
        })
        .catch((error) => {
          send(jsonRpcError(errorMessage(error), message.id));
        });
    });

    socket.on("close", () => {
      closed = true;
      unsubscribe();
    });
    socket.on("error", () => {
      closed = true;
      unsubscribe();
    });
  });
}
