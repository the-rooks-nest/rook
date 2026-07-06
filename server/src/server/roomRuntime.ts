import { createAgent } from "./agents/agentDiscovery.js";
import type { AgentSessionRecord } from "./agents/sessionLog.js";
import type { EnvironmentManager } from "./environment/EnvironmentManager.js";
import { SessionRoom } from "./realtime/SessionRoom.js";
import type { SessionRoomManager } from "./realtime/SessionRoomManager.js";
import { parentMessageToolExtensionPath } from "./serverPaths.js";

function mergeRestartSkillPaths(restart: Record<string, unknown>, skillPaths: string[]): Record<string, unknown> {
  if (skillPaths.length === 0) return restart;
  const existing = Array.isArray(restart.skillPaths)
    ? restart.skillPaths.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  return { ...restart, skillPaths: [...new Set([...existing, ...skillPaths])] };
}

function skillPathsFromRestartMetadata(restart: Record<string, unknown> | undefined): string[] {
  return Array.isArray(restart?.skillPaths)
    ? restart.skillPaths.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
}

export function attachRoomToEnvironments(room: SessionRoom, environmentManager: EnvironmentManager, baseSkillPaths: string[]): void {
  room.configureEnvironmentRuntime(baseSkillPaths, async (skillPaths) => {
    const restartMetadata = { ...room.session.restart, skillPaths };
    const appendSystemPrompt = environmentManager.runtimeInstructionsForSession(room.sessionId);
    const agent = createAgent(room.agentId, restartMetadata, {
      skillPaths,
      extensionPaths: skillPaths.length > 0 ? [parentMessageToolExtensionPath] : [],
      appendSystemPrompt,
    });
    await agent.ensureStarted();
    // If the rebuild had to start a fresh session (resume failed), track the new id so
    // the next rebuild resumes it instead of re-failing on the stale one.
    const effectiveRestart = agent.sessionId ? { ...restartMetadata, sessionId: agent.sessionId } : restartMetadata;
    return { session: { ...room.session, restart: effectiveRestart }, agentId: room.agentId, agent };
  });
  environmentManager.subscribe(room.sessionId, room);
}

export async function createOrReuseRoom(params: {
  agentId: string;
  roomManager: SessionRoomManager;
  environmentManager: EnvironmentManager;
  session?: AgentSessionRecord;
  sessionName?: string;
  restartExisting?: boolean;
  skillPaths?: string[];
}): Promise<SessionRoom> {
  const existingRoom = params.session ? params.roomManager.get(params.session.id) : undefined;
  if (existingRoom && !params.restartExisting) {
    attachRoomToEnvironments(existingRoom, params.environmentManager, []);
    return existingRoom;
  }

  const restartMetadata = params.session
    ? mergeRestartSkillPaths(params.session.restart, params.skillPaths ?? [])
    : undefined;
  const effectiveSkillPaths = [...new Set([...(params.skillPaths ?? []), ...skillPathsFromRestartMetadata(restartMetadata)])];
  const agent = createAgent(params.agentId, restartMetadata, {
    skillPaths: params.skillPaths,
    extensionPaths: effectiveSkillPaths.length > 0 ? [parentMessageToolExtensionPath] : [],
    appendSystemPrompt: params.session ? params.environmentManager.runtimeInstructionsForSession(params.session.id) : undefined,
  });
  if (params.sessionName) agent.setSessionName(params.sessionName);

  const isRestoredSession = Boolean(params.session);
  if (!isRestoredSession) await agent.ensureStarted();
  const session = params.session ? { ...params.session, restart: restartMetadata ?? params.session.restart } : agent.record;
  if (!session) throw new Error("Agent did not register a session.");

  if (existingRoom) await existingRoom.runtime.agent.stop();
  const room = await params.roomManager.upsert({ session, agentId: params.agentId, agent });
  attachRoomToEnvironments(room, params.environmentManager, effectiveSkillPaths);
  return room;
}
