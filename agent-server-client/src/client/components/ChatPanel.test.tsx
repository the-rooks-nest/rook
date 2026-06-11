import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpClientEvent } from "../acpClientTypes";
import { ChatPanel } from "./ChatPanel";

const remoteAgentMock = vi.hoisted(() => {
  const defaultRunImplementation = async (message: string) => {
    remoteAgentMock.lastOnAcpEvent?.({ type: "acp_user_message", text: message });
    remoteAgentMock.lastOnAcpEvent?.({ type: "acp_status_changed", status: "streaming", message: "Writing" });
    remoteAgentMock.lastOnAcpEvent?.({ type: "acp_agent_message_chunk", text: "Echo: " });
    remoteAgentMock.lastOnAcpEvent?.({ type: "acp_agent_message_chunk", text: message });
    remoteAgentMock.lastOnAcpEvent?.({ type: "acp_run_completed", stopReason: "end_turn" });
  };

  return {
    lastOnAcpEvent: null as ((event: AcpClientEvent) => void) | null,
    defaultRunImplementation,
    runMock: vi.fn(defaultRunImplementation),
  };
});

vi.mock("../remoteAgent", () => ({
  RemoteAgent: class {
    constructor(options?: { onAcpEvent?: (event: AcpClientEvent) => void }) {
      remoteAgentMock.lastOnAcpEvent = options?.onAcpEvent ?? null;
    }

    connect = vi.fn(async () => undefined);
    close = vi.fn();
    run = remoteAgentMock.runMock;
  },
}));

describe("ChatPanel", () => {
  beforeEach(() => {
    remoteAgentMock.lastOnAcpEvent = null;
    remoteAgentMock.runMock.mockReset();
    remoteAgentMock.runMock.mockImplementation(remoteAgentMock.defaultRunImplementation);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("submits a message through RemoteAgent and renders the streamed response", async () => {
    render(<ChatPanel agentBackend="PiAgent" initialSession={{ id: "s1", agent: "PiAgent", createdAt: "now", restart: {} }} />);

    expect(screen.getByText("No messages yet.")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("Type a message..."), "Hello");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(remoteAgentMock.runMock).toHaveBeenCalledWith("Hello"));
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Echo: Hello")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("does not submit messages while disabled", async () => {
    render(<ChatPanel agentBackend="PiAgent" initialSession={{ id: "s1", agent: "PiAgent", createdAt: "now", restart: {} }} disabled />);

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByPlaceholderText("Type a message...")).toBeDisabled();
    expect(remoteAgentMock.runMock).not.toHaveBeenCalled();
  });

  it("relays message_parent tool calls to the parent message target", async () => {
    const postMessage = vi.fn();
    remoteAgentMock.runMock.mockImplementationOnce(async () => {
      remoteAgentMock.lastOnAcpEvent?.({ type: "acp_tool_call_started", toolCallId: "tool-1", title: "message_parent", kind: "other", status: "pending", rawInput: "{\"message\":{\"kind\":\"ready\"}}" });
      remoteAgentMock.lastOnAcpEvent?.({ type: "acp_tool_call_update", toolCallId: "tool-1", status: "completed", toolName: "message_parent", output: "message sent" });
      remoteAgentMock.lastOnAcpEvent?.({ type: "acp_run_completed", stopReason: "end_turn" });
    });

    render(
      <ChatPanel
        agentBackend="PiAgent"
        initialSession={{ id: "s1", agent: "PiAgent", createdAt: "now", restart: {} }}
        onParentMessage={(message) => postMessage(message, "https://parent.example")}
      />,
    );

    await userEvent.type(screen.getByPlaceholderText("Type a message..."), "notify");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ kind: "ready" }, "https://parent.example"));
  });

  it("rebuilds prior conversation from replayed session events", () => {
    render(
      <ChatPanel
        agentBackend="PiAgent"
        initialSession={{ id: "s1", agent: "PiAgent", createdAt: "now", restart: {} }}
        replayEvents={[
          { type: "acp_user_message", text: "Earlier question" },
          { type: "acp_agent_message_chunk", text: "Earlier answer" },
          { type: "acp_run_completed", stopReason: "end_turn" },
        ]}
      />,
    );

    expect(screen.getByText("Earlier question")).toBeInTheDocument();
    expect(screen.getByText("Earlier answer")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("rebuilds prior tool activity from replayed session events", () => {
    render(
      <ChatPanel
        agentBackend="PiAgent"
        initialSession={{ id: "s1", agent: "PiAgent", createdAt: "now", restart: {} }}
        replayEvents={[
          { type: "acp_tool_call_started", toolCallId: "tool-1", title: "search_docs", kind: "other", status: "pending", rawInput: "{\"q\":\"agent\"}" },
          { type: "acp_tool_call_update", toolCallId: "tool-1", status: "completed", toolName: "search_docs", output: "Found docs" },
          { type: "acp_run_completed", stopReason: "end_turn" },
        ]}
      />,
    );

    expect(screen.getByText("search_docs")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("ignores replayed environment session events without breaking chat replay", () => {
    render(
      <ChatPanel
        agentBackend="PiAgent"
        initialSession={{ id: "s1", agent: "PiAgent", createdAt: "now", restart: {} }}
        replayEvents={[
          { type: "acp_environment_event", kind: "environment_entered", payload: { environmentId: "browser" } },
          { type: "acp_user_message", text: "Earlier question" },
          { type: "acp_agent_message_chunk", text: "Earlier answer" },
          { type: "acp_run_completed", stopReason: "end_turn" },
        ]}
      />,
    );

    expect(screen.getByText("Earlier question")).toBeInTheDocument();
    expect(screen.getByText("Earlier answer")).toBeInTheDocument();
  });

  it("notifies when an environment offer is resolved on the session websocket", async () => {
    const onEnvironmentOfferResolved = vi.fn();
    render(
      <ChatPanel
        agentBackend="PiAgent"
        initialSession={{ id: "s1", agent: "PiAgent", createdAt: "now", restart: {} }}
        onEnvironmentOfferResolved={onEnvironmentOfferResolved}
      />,
    );

    await waitFor(() => expect(remoteAgentMock.lastOnAcpEvent).not.toBeNull());

    remoteAgentMock.lastOnAcpEvent?.({
      type: "acp_environment_event",
      kind: "environment_offer_resolved",
      payload: { environmentId: "web:wikipedia", decision: "dismissed" },
    });

    expect(onEnvironmentOfferResolved).toHaveBeenCalledWith({
      environmentId: "web:wikipedia",
      decision: "dismissed",
    });
  });

  it("notifies when an environment offer becomes available on the session websocket", async () => {
    const onEnvironmentOfferAvailable = vi.fn();
    render(
      <ChatPanel
        agentBackend="PiAgent"
        initialSession={{ id: "s1", agent: "PiAgent", createdAt: "now", restart: {} }}
        onEnvironmentOfferAvailable={onEnvironmentOfferAvailable}
      />,
    );

    await waitFor(() => expect(remoteAgentMock.lastOnAcpEvent).not.toBeNull());

    remoteAgentMock.lastOnAcpEvent?.({
      type: "acp_environment_event",
      kind: "environment_offer_available",
      payload: { environmentId: "web:wikipedia" },
    });

    expect(onEnvironmentOfferAvailable).toHaveBeenCalledWith({ environmentId: "web:wikipedia" });
  });

  it("renders run failures as error blocks", async () => {
    remoteAgentMock.runMock.mockImplementationOnce(async (message: string) => {
      remoteAgentMock.lastOnAcpEvent?.({ type: "acp_user_message", text: message });
      remoteAgentMock.lastOnAcpEvent?.({ type: "acp_run_failed", error: "Network down" });
    });
    render(<ChatPanel agentBackend="PiAgent" initialSession={{ id: "s1", agent: "PiAgent", createdAt: "now", restart: {} }} />);

    await userEvent.type(screen.getByPlaceholderText("Type a message..."), "Hello");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("run error")).toBeInTheDocument();
    expect(screen.getAllByText("Network down")).toHaveLength(2);
  });
});
