import type { FastifyInstance } from "fastify";
import { getAgentDefinitions } from "../agents/agentDiscovery.js";
import { readSessionRecords } from "../agents/sessionLog.js";
import type { EnvironmentManager } from "../environment/EnvironmentManager.js";
import type { SessionRoomManager } from "../realtime/SessionRoomManager.js";
import { createOrReuseRoom } from "../roomRuntime.js";
import { isSessionRecord, rejectUnknownAgent } from "../serverHelpers.js";

export async function registerAgentRoutes(app: FastifyInstance, deps: {
  roomManager: SessionRoomManager;
  environmentManager: EnvironmentManager;
}): Promise<void> {
  app.get("/api/health", async () => ({ ok: true, service: "rook" }));
  app.get("/api/agents", async () => ({ agents: getAgentDefinitions() }));

  app.get<{ Querystring: { agent?: string } }>("/api/agent/sessions", async (request, reply) => {
    const agentId = request.query.agent;
    if (!rejectUnknownAgent(agentId, reply)) return;

    const sessions = (await readSessionRecords())
      .filter((record) => record.agent === agentId)
      .map((record) => ({
        ...record,
        running: deps.roomManager.has(record.id),
        connectedClients: deps.roomManager.subscriberCount(record.id),
      }));
    return { sessions };
  });

  app.get("/api/agent/session/recent", async () => {
    const session = (await readSessionRecords())[0];
    if (!session) return { session: null };
    return {
      session: {
        ...session,
        running: deps.roomManager.has(session.id),
        connectedClients: deps.roomManager.subscriberCount(session.id),
      },
    };
  });

  app.post<{ Body: { agent?: unknown; session?: unknown; sessionName?: unknown; includeReplayEvents?: unknown; restartExisting?: unknown } }>("/api/agent/start", async (request, reply) => {
    const agentId = request.body?.agent;
    if (!rejectUnknownAgent(agentId, reply)) return;

    const session = request.body?.session;
    if (session !== undefined && !isSessionRecord(session)) {
      reply.code(400).send({ error: "Invalid session" });
      return;
    }
    if (session && session.agent !== agentId) {
      reply.code(400).send({ error: "Session does not match agent" });
      return;
    }

    const sessionName = typeof request.body?.sessionName === "string" ? request.body.sessionName.trim() || "default" : undefined;
    const restartExisting = request.body?.restartExisting === true;
    try {
      const room = await createOrReuseRoom({
        agentId,
        roomManager: deps.roomManager,
        environmentManager: deps.environmentManager,
        session,
        sessionName,
        restartExisting,
      });
      return { ok: true, agent: agentId, session: room.session };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400).send({ error: message });
      return;
    }
  });
}
