// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const mockSession = { id: "s-mock", agent: "PiAgent", createdAt: "now", restart: {} };
const olderSession = { id: "s-old", agent: "PiAgent", createdAt: "2025-12-31T00:00:00.000Z", restart: {} };
const myPiOpenAiSession = { id: "s1", agent: "MyPiOpenAiAgent", createdAt: "2026-01-01T00:00:00.000Z", restart: { sessionId: "abc" } };

const agentDiscoveryMock = vi.hoisted(() => ({
  createAgentMock: vi.fn(),
}));

const serverAgentMock = vi.hoisted(() => ({
  lastPermissionSink: null as ((_request: unknown) => void) | null,
  respondToPermissionRequestMock: vi.fn(),
  setModeMock: vi.fn(async (modeId: string) => ({ modes: { currentModeId: modeId, availableModes: [{ id: "ask", name: "Ask" }, { id: modeId, name: modeId }] } })),
  setConfigOptionMock: vi.fn(async (configId: string, value: string) => ({ configOptions: [{ id: configId, name: configId, type: "select", currentValue: value, options: [{ value, name: value }] }] })),
}));

vi.mock("./agents/agentDiscovery.js", () => ({
  getAgentDefinitions: () => [],
  isKnownAgent: (id: string) => id === "PiAgent" || id === "MyPiOpenAiAgent" || id === "PiAgent",
  createAgent: agentDiscoveryMock.createAgentMock.mockImplementation((id: string, restart?: Record<string, unknown>) => {
    let acpEventSink: ((notification: Record<string, unknown>) => void) | undefined;

    const emitAcp = (update: Record<string, unknown>) => {
      acpEventSink?.({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: (id === "PiAgent" ? mockSession : myPiOpenAiSession).id, update },
      });
    };

    return {
      get record() {
        return id === "PiAgent" ? mockSession : { ...myPiOpenAiSession, agent: id, restart: restart ?? myPiOpenAiSession.restart };
      },
      setAcpEventSink(nextSink: ((_notification: unknown) => void) | undefined) {
        acpEventSink = nextSink;
      },
      setAcpPermissionRequestSink(nextSink: ((_request: unknown) => void) | undefined) {
        serverAgentMock.lastPermissionSink = nextSink ?? null;
      },
      async ensureStarted() {
        if (restart?.sessionId) {
          emitAcp({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier question" } });
          emitAcp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier answer" } });
          emitAcp({ sessionUpdate: "_rookery_run_completed" });
        }
        return undefined;
      },
      async stop() {
        return undefined;
      },
      async run(message: string) {
        emitAcp({ sessionUpdate: "user_message_chunk", content: { type: "text", text: message } });
        emitAcp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
        emitAcp({ sessionUpdate: "_rookery_run_completed" });
      },
      setMode: serverAgentMock.setModeMock,
      setConfigOption: serverAgentMock.setConfigOptionMock,
      respondToPermissionRequest: serverAgentMock.respondToPermissionRequestMock,
    };
  }),
}));

vi.mock("./agents/sessionLog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agents/sessionLog.js")>();
  return {
    ...actual,
    readSessionRecords: async () => [myPiOpenAiSession, olderSession],
  };
});

const { buildServer } = await import("./index");
const { StubPoiLookupProvider } = await import("./location/StubPoiLookupProvider.js");

async function listen(app: Awaited<ReturnType<typeof buildServer>>): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Server did not expose an address.");
  return `http://127.0.0.1:${address.port}`;
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open.")), { once: true });
  });
  return socket;
}

async function collectJsonMessages(socket: WebSocket, count: number): Promise<any[]> {
  return await new Promise<any[]>((resolve, reject) => {
    const messages: any[] = [];
    const timeout = setTimeout(() => reject(new Error(`Timed out after receiving ${messages.length}/${count} websocket messages.`)), 3_000);
    const onMessage = (event: MessageEvent) => {
      messages.push(JSON.parse(String(event.data)));
      if (messages.length >= count) {
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage);
        resolve(messages);
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("server", () => {
  afterEach(async () => {
    agentDiscoveryMock.createAgentMock.mockClear();
    serverAgentMock.lastPermissionSink = null;
    serverAgentMock.respondToPermissionRequestMock.mockClear();
    serverAgentMock.setModeMock.mockClear();
    serverAgentMock.setConfigOptionMock.mockClear();
    vi.restoreAllMocks();
  });

  it("serves health status", async () => {
    const app = await buildServer({ enableClient: false });
    const response = await app.inject({ method: "GET", url: "/api/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "agent-station" });
  });

  it("starts the selected agent and returns its session", async () => {
    const app = await buildServer({ enableClient: false });
    const response = await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "PiAgent" } });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, agent: "PiAgent", session: mockSession });
  });

  it("starts from a provided session bolus", async () => {
    const app = await buildServer({ enableClient: false });
    const response = await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "MyPiOpenAiAgent", session: myPiOpenAiSession } });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ ok: true, agent: "MyPiOpenAiAgent", session: myPiOpenAiSession }));
  });

  it("lists saved sessions for an agent", async () => {
    const app = await buildServer({ enableClient: false });
    const response = await app.inject({ method: "GET", url: "/api/agent/sessions?agent=MyPiOpenAiAgent" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().sessions).toEqual([{ ...myPiOpenAiSession, running: false, connectedClients: 0 }]);
  });

  it("returns the most recent saved session across agents", async () => {
    const app = await buildServer({ enableClient: false });
    const response = await app.inject({ method: "GET", url: "/api/agent/session/recent" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ session: { ...myPiOpenAiSession, running: false, connectedClients: 0 } });
  });

  it("marks active sessions as running", async () => {
    const app = await buildServer({ enableClient: false });
    await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "MyPiOpenAiAgent", session: myPiOpenAiSession } });
    const response = await app.inject({ method: "GET", url: "/api/agent/sessions?agent=MyPiOpenAiAgent" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().sessions).toEqual([{ ...myPiOpenAiSession, running: true, connectedClients: 0 }]);
  });

  it("automatically stops a room after the last websocket client leaves", async () => {
    const app = await buildServer({ enableClient: false, roomIdleTimeoutMs: 25 });
    const baseUrl = await listen(app);
    await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "MyPiOpenAiAgent", session: myPiOpenAiSession } });

    const socket = await openWebSocket(`${baseUrl.replace("http", "ws")}/api/ws?sessionId=${myPiOpenAiSession.id}`);
    socket.close();
    await delay(120);

    const response = await app.inject({ method: "GET", url: "/api/agent/sessions?agent=MyPiOpenAiAgent" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().sessions).toEqual([{ ...myPiOpenAiSession, running: false, connectedClients: 0 }]);
  });

  it("keeps a session alive when a client rejoins before idle shutdown", async () => {
    const app = await buildServer({ enableClient: false, roomIdleTimeoutMs: 80 });
    const baseUrl = await listen(app);
    await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "MyPiOpenAiAgent", session: myPiOpenAiSession } });

    const wsUrl = `${baseUrl.replace("http", "ws")}/api/ws?sessionId=${myPiOpenAiSession.id}`;
    const firstSocket = await openWebSocket(wsUrl);
    firstSocket.close();
    await delay(30);

    const secondSocket = await openWebSocket(wsUrl);
    await delay(10);
    const response = await app.inject({ method: "GET", url: "/api/agent/sessions?agent=MyPiOpenAiAgent" });

    secondSocket.close();
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().sessions).toEqual([{ ...myPiOpenAiSession, running: true, connectedClients: 1 }]);
  });

  it("restarts an active session", async () => {
    const app = await buildServer({ enableClient: false });
    await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "MyPiOpenAiAgent", session: myPiOpenAiSession } });
    const response = await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "MyPiOpenAiAgent", session: myPiOpenAiSession, restartExisting: true } });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ ok: true, agent: "MyPiOpenAiAgent", session: myPiOpenAiSession }));
  });

  it("does not return replay events from start for restored sessions", async () => {
    const app = await buildServer({ enableClient: false });
    const response = await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "MyPiOpenAiAgent", session: myPiOpenAiSession, restartExisting: true } });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ ok: true, agent: "MyPiOpenAiAgent", session: myPiOpenAiSession }));
    expect(response.json()).not.toHaveProperty("replayMessages");
  });

  it("streams restored session history over the websocket", async () => {
    const app = await buildServer({ enableClient: false });
    const baseUrl = await listen(app);
    await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "MyPiOpenAiAgent", session: myPiOpenAiSession, restartExisting: true } });

    const socket = await openWebSocket(`${baseUrl.replace("http", "ws")}/api/ws?sessionId=${myPiOpenAiSession.id}`);
    const replayed = await collectJsonMessages(socket, 3);
    socket.close();
    await app.close();

    expect(replayed).toEqual([
      expect.objectContaining({ method: "session/update", params: expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier question" } }) }) }),
      expect.objectContaining({ method: "session/update", params: expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier answer" } }) }) }),
      expect.objectContaining({ method: "session/update", params: expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: "_rookery_run_completed" }) }) }),
    ]);
  });

  it("handles session/set_mode over the websocket", async () => {
    const app = await buildServer({ enableClient: false });
    const baseUrl = await listen(app);
    await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "PiAgent" } });

    const socket = await openWebSocket(`${baseUrl.replace("http", "ws")}/api/ws?sessionId=${mockSession.id}`);
    const responsePromise = collectJsonMessages(socket, 1);
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: "mode-1",
      method: "session/set_mode",
      params: { sessionId: mockSession.id, modeId: "code" },
    }));

    const [response] = await responsePromise;
    socket.close();
    await app.close();

    expect(serverAgentMock.setModeMock).toHaveBeenCalledWith("code");
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: "mode-1",
      result: { modes: { currentModeId: "code", availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "code" }] } },
    });
  });

  it("handles session/set_config_option over the websocket", async () => {
    const app = await buildServer({ enableClient: false });
    const baseUrl = await listen(app);
    await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "PiAgent" } });

    const socket = await openWebSocket(`${baseUrl.replace("http", "ws")}/api/ws?sessionId=${mockSession.id}`);
    const responsePromise = collectJsonMessages(socket, 1);
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: "config-1",
      method: "session/set_config_option",
      params: { sessionId: mockSession.id, configId: "model", value: "smart" },
    }));

    const [response] = await responsePromise;
    socket.close();
    await app.close();

    expect(serverAgentMock.setConfigOptionMock).toHaveBeenCalledWith("model", "smart");
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: "config-1",
      result: { configOptions: [{ id: "model", name: "model", type: "select", currentValue: "smart", options: [{ value: "smart", name: "smart" }] }] },
    });
  });

  it("forwards permission responses from websocket clients back to the agent", async () => {
    const app = await buildServer({ enableClient: false });
    const baseUrl = await listen(app);
    await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "PiAgent" } });

    const socket = await openWebSocket(`${baseUrl.replace("http", "ws")}/api/ws?sessionId=${mockSession.id}`);
    const requestPromise = collectJsonMessages(socket, 1);
    serverAgentMock.lastPermissionSink?.({
      jsonrpc: "2.0",
      id: "perm-1",
      method: "session/request_permission",
      params: {
        sessionId: mockSession.id,
        toolCall: { toolCallId: "tool-1", title: "Write file", kind: "edit", status: "pending" },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      },
    });

    const [requestMessage] = await requestPromise;
    expect(requestMessage).toEqual({
      jsonrpc: "2.0",
      id: "perm-1",
      method: "session/request_permission",
      params: {
        sessionId: mockSession.id,
        toolCall: { toolCallId: "tool-1", title: "Write file", kind: "edit", status: "pending" },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      },
    });

    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: "perm-1",
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    }));
    await delay(10);

    socket.close();
    await app.close();

    expect(serverAgentMock.respondToPermissionRequestMock).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: "perm-1",
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });
  });

  it("rejects unknown agents", async () => {
    const app = await buildServer({ enableClient: false });
    const response = await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "unknown" } });
    await app.close();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Unknown agent" });
  });

  it("pushes an environment offer over the websocket and resolves it on decision", async () => {
    const app = await buildServer({ enableClient: false, environmentDecisionStoreLocation: ":memory:" });
    const baseUrl = await listen(app);
    await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "PiAgent" } });
    const socket = await openWebSocket(`${baseUrl.replace("http", "ws")}/api/ws?sessionId=s-mock`);

    const offerPromise = collectJsonMessages(socket, 1);
    const register = await app.inject({ method: "POST", url: "/api/environments/register", payload: { id: "demo:demo", sourceName: "Demo" } });
    expect(register.json()).toEqual({ ok: true, id: "demo:demo" });
    const [offer] = await offerPromise;
    expect(offer).toMatchObject({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "_rookery_environment_event",
          kind: "environment_offer_available",
          payload: { environmentId: "demo:demo", sourceName: "Demo" },
        },
      },
    });

    // Accepting enters the env (entered event) and resolves the offer (resolved event).
    const resolvedPromise = collectJsonMessages(socket, 2);
    const decision = await app.inject({ method: "POST", url: "/api/environments/decision", payload: { environmentId: "demo:demo", decision: "accept" } });
    expect(decision.statusCode).toBe(200);
    const messages = await resolvedPromise;
    expect(messages.some((m) => m.params?.update?.sessionUpdate === "_rookery_environment_event" && m.params?.update?.kind === "environment_offer_resolved" && m.params?.update?.payload?.decision === "approved")).toBe(true);

    socket.close();
    await app.close();
  });

  it("registers the identified location and auto-enters the current env over the websocket", async () => {
    const app = await buildServer({ enableClient: false, environmentDecisionStoreLocation: ":memory:", poiProvider: new StubPoiLookupProvider() });
    const baseUrl = await listen(app);
    await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "PiAgent" } });
    const socket = await openWebSocket(`${baseUrl.replace("http", "ws")}/api/ws?sessionId=s-mock`);

    const eventsPromise = collectJsonMessages(socket, 3);
    const response = await app.inject({
      method: "POST",
      url: "/api/environments/identify-available",
      payload: { latitude: 37.3318, longitude: -122.0312, isStationary: true },
    });
    expect(response.statusCode).toBe(200);

    const currentId = "loc:target.com/123-main-st-springfield-il/store-1842";
    const events = await eventsPromise;
    const kinds = events.map((m) => m.params?.update?.kind);
    // current is offered (sourceName carried) then auto-entered.
    expect(events.some((m) => m.params?.update?.kind === "environment_offer_available" && m.params?.update?.payload?.environmentId === currentId && m.params?.update?.payload?.sourceName === "Target")).toBe(true);
    expect(kinds).toContain("environment_entered");

    socket.close();
    await app.close();
  });

  it("validates environment decision input", async () => {
    const app = await buildServer({ enableClient: false, environmentDecisionStoreLocation: ":memory:" });
    const bad = await app.inject({ method: "POST", url: "/api/environments/decision", payload: { environmentId: "demo:demo", decision: "maybe" } });
    expect(bad.statusCode).toBe(400);
    const unreg = await app.inject({ method: "POST", url: "/api/environments/unregister", payload: { id: "demo:demo" } });
    expect(unreg.statusCode).toBe(200);
    await app.close();
  });

  it("identifies available environments from a location", async () => {
    const app = await buildServer({ enableClient: false, poiProvider: new StubPoiLookupProvider() });
    const response = await app.inject({
      method: "POST",
      url: "/api/environments/identify-available",
      payload: {
        latitude: 37.3318,
        longitude: -122.0312,
        horizontalAccuracy: 18,
        source: "visit",
        dwellSeconds: 540,
        isStationary: true,
        speedMetersPerSecond: 0.2,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { candidates: Array<{ environmentId: string; confidence: number }> };
    expect(body.candidates.length).toBeGreaterThanOrEqual(1);
    expect(body.candidates[0].environmentId).toBe("loc:target.com/123-main-st-springfield-il/store-1842");
    await app.close();
  });

  it("rejects identify-available without coordinates", async () => {
    const app = await buildServer({ enableClient: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/environments/identify-available",
      payload: { longitude: -122.0312 },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("returns environment skill previews", async () => {
    const app = await buildServer({ enableClient: false });
    const register = await app.inject({
      method: "POST",
      url: "/api/environments/register",
      payload: { id: "demo:demo" },
    });
    expect(register.statusCode).toBe(200);

    const preview = await app.inject({ method: "GET", url: "/api/environments/preview?environmentId=demo:demo" });
    expect(preview.statusCode).toBe(200);
    const body = preview.json() as { environmentId: string; skills: Array<{ id: string; files: Record<string, string> }> };
    expect(body.environmentId).toBe("demo:demo");
    expect(body.skills.some((skill) => skill.id === "testing-fixture" && skill.files["testing-fixture/SKILL.md"]?.includes("testing purposes"))).toBe(true);

    await app.close();
  });

  it("returns wikipedia environment skill previews from the repository", async () => {
    const app = await buildServer({ enableClient: false });
    const register = await app.inject({
      method: "POST",
      url: "/api/environments/register",
      payload: { id: "web:en.wikipedia.org" },
    });
    expect(register.statusCode).toBe(200);

    const preview = await app.inject({ method: "GET", url: "/api/environments/preview?environmentId=web:en.wikipedia.org" });
    expect(preview.statusCode).toBe(200);
    const body = preview.json() as { environmentId: string; skills: Array<{ id: string }> };
    expect(body.environmentId).toBe("web:en.wikipedia.org");
    expect(body.skills.some((skill) => skill.id === "wikipedia-discovery")).toBe(true);

    await app.close();
  });

  it("reports connected websocket client counts in session listings", async () => {
    const app = await buildServer({ enableClient: false, roomIdleTimeoutMs: 1_000 });
    const baseUrl = await listen(app);
    await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "MyPiOpenAiAgent", session: myPiOpenAiSession } });

    const wsUrl = `${baseUrl.replace("http", "ws")}/api/ws?sessionId=${myPiOpenAiSession.id}`;
    const socketA = await openWebSocket(wsUrl);
    const socketB = await openWebSocket(wsUrl);
    await delay(10);

    const response = await app.inject({ method: "GET", url: "/api/agent/sessions?agent=MyPiOpenAiAgent" });

    socketA.close();
    socketB.close();
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().sessions).toEqual([{ ...myPiOpenAiSession, running: true, connectedClients: 2 }]);
  });

  it("broadcasts websocket session events to all subscribers", async () => {
    const app = await buildServer({ enableClient: false });
    const baseUrl = await listen(app);
    await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "PiAgent" } });

    const wsUrl = `${baseUrl.replace("http", "ws")}/api/ws?sessionId=${mockSession.id}`;
    const socketA = await openWebSocket(wsUrl);
    const socketB = await openWebSocket(wsUrl);
    const messagesA = collectJsonMessages(socketA, 4);
    const messagesB = collectJsonMessages(socketB, 3);
    await delay(20);

    socketA.send(JSON.stringify({
      jsonrpc: "2.0",
      id: "prompt-1",
      method: "session/prompt",
      params: { sessionId: mockSession.id, prompt: [{ type: "text", text: "hello" }] },
    }));

    const [eventsA, eventsB] = await Promise.all([messagesA, messagesB]);
    socketA.close();
    socketB.close();
    await app.close();

    expect(eventsA).toContainEqual({ jsonrpc: "2.0", id: "prompt-1", result: { stopReason: "end_turn" } });
    expect(eventsA.filter((event) => event.method === "session/update")).toEqual(eventsB);
    expect(eventsB).toEqual([
      expect.objectContaining({ method: "session/update", params: expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } }) }) }),
      expect.objectContaining({ method: "session/update", params: expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }) }) }),
      expect.objectContaining({ method: "session/update", params: expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: "_rookery_run_completed" }) }) }),
    ]);
  });

  it("does not replay prior websocket transcript messages on reconnect", async () => {
    const app = await buildServer({ enableClient: false });
    const baseUrl = await listen(app);
    await app.inject({ method: "POST", url: "/api/agent/start", payload: { agent: "MyPiOpenAiAgent", session: myPiOpenAiSession } });

    const firstSocket = await openWebSocket(`${baseUrl.replace("http", "ws")}/api/ws?sessionId=${myPiOpenAiSession.id}`);
    const firstMessages = collectJsonMessages(firstSocket, 7);
    firstSocket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: "prompt-1",
      method: "session/prompt",
      params: { sessionId: myPiOpenAiSession.id, prompt: [{ type: "text", text: "hello" }] },
    }));
    await firstMessages;
    firstSocket.close();

    const replaySocket = await openWebSocket(`${baseUrl.replace("http", "ws")}/api/ws?sessionId=${myPiOpenAiSession.id}`);
    const noMessages = await Promise.race([
      collectJsonMessages(replaySocket, 1).then(() => false),
      delay(100).then(() => true),
    ]);
    replaySocket.close();
    await app.close();

    expect(noMessages).toBe(true);
  });
});
