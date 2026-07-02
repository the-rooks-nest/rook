import dotenv from "dotenv";
import fastify from "fastify";
import websocket from "@fastify/websocket";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EnvironmentDecisionStore } from "./environment/EnvironmentDecisionStore.js";
import { EnvironmentManager } from "./environment/EnvironmentManager.js";
import { CompositeEnvironmentRepository } from "./environment/CompositeEnvironmentRepository.js";
import { DirectoryEnvironmentRepository } from "./environment/DirectoryEnvironmentRepository.js";
import { LocationContextRepository } from "./environment/LocationContextRepository.js";
import { EnvironmentRepositoryService } from "./environment/EnvironmentRepositoryService.js";
import { EnvironmentIdentifier } from "./location/EnvironmentIdentifier.js";
import { MockBuildingSkillSuggester } from "./location/BuildingSkillSuggester.js";
import { PtilesPoiLookupProvider } from "./location/PtilesPoiLookupProvider.js";
import { LocationRegistrar } from "./location/LocationRegistrar.js";
import { createUpstreamFetchRange } from "./location/ptiles/ptilesFetch.js";
import type { PoiLookupProvider } from "./location/PoiLookupProvider.js";
import { REPO_ROOT } from "./paths.js";
import { SessionRoomManager } from "./realtime/SessionRoomManager.js";
import { registerAgentRoutes } from "./routes/agentRoutes.js";
import { registerEnvironmentRoutes } from "./routes/environmentRoutes.js";
import { registerWebsocketRoute } from "./routes/websocketRoute.js";
import { ServerAuth } from "./auth.js";
import { startRemoteProxy } from "./remoteProxy.js";

dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const loopbackHost = "127.0.0.1";
const remoteBindIp = process.env.ROOK_BIND_IP ?? process.env.ROOK_TAILSCALE_IP;
const port = Number(process.env.PORT ?? 3000);

export interface BuildServerOptions {
  enableClient?: boolean; // legacy no-op; the server no longer hosts a web client
  logger?: Parameters<typeof fastify>[0]["logger"];
  roomIdleTimeoutMs?: number;
  /** SQLite location for persistent environment decisions; ":memory:" in tests. */
  environmentDecisionStoreLocation?: string;
  /** Override the POI lookup provider (defaults to the ptiles provider via the proxy route). */
  poiProvider?: PoiLookupProvider;
  /** Optional bearer token for non-loopback requests. */
  authToken?: string;
  /** Test hook: require auth even for loopback requests. */
  trustLoopbackWithoutAuth?: boolean;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const app = fastify({ logger: options.logger ?? true });
  const auth = new ServerAuth({
    token: options.authToken ?? process.env.ROOK_AUTH_TOKEN,
    trustLoopbackWithoutAuth: options.trustLoopbackWithoutAuth,
  });
  // Programmatic repo for the synthesized location-context bundle (no extraSkillPaths).
  const locationContextRepository = new LocationContextRepository();
  const environmentRepository = new CompositeEnvironmentRepository([
    new DirectoryEnvironmentRepository(path.join(REPO_ROOT, "environment-repository")),
    new DirectoryEnvironmentRepository(path.join(os.homedir(), ".rook", "environment-repository")),
    locationContextRepository,
  ]);
  const environmentRepositoryService = new EnvironmentRepositoryService(environmentRepository);
  const environmentDecisionStore = new EnvironmentDecisionStore(options.environmentDecisionStoreLocation);
  const environmentManager = new EnvironmentManager(environmentRepositoryService, environmentDecisionStore);
  // Ptiles is an internal geo-identification detail: fetch byte ranges directly from
  // the upstream host (single egress, allowlisted file names) — no public route.
  const fetchRange = createUpstreamFetchRange();
  const environmentIdentifier = new EnvironmentIdentifier({
    poiProvider: options.poiProvider ?? new PtilesPoiLookupProvider({ fetchRange }),
    repository: environmentRepositoryService,
    skillSuggester: new MockBuildingSkillSuggester(),
  });
  const locationRegistrar = new LocationRegistrar(environmentManager, locationContextRepository);
  const roomManager = new SessionRoomManager({
    idleTimeoutMs: options.roomIdleTimeoutMs,
    onRoomRemoved: (sessionId) => environmentManager.unsubscribe(sessionId),
  });

  await app.register(websocket);

  app.addHook("onRequest", async (request, reply) => {
    const authorization = auth.authorizeRequest(request.raw);
    if (authorization.ok) return;
    reply.code(authorization.statusCode).send({ error: authorization.error });
  });

  app.addHook("onClose", async () => {
    await roomManager.closeAll();
  });

  await registerAgentRoutes(app, { roomManager, environmentManager });
  await registerEnvironmentRoutes(app, environmentManager, environmentIdentifier, locationRegistrar);
  await registerWebsocketRoute(app, roomManager, auth);

  return app;
}

const isMain = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isMain) {
  const app = await buildServer();
  await app.listen({ host: loopbackHost, port });

  let remoteProxy: Awaited<ReturnType<typeof startRemoteProxy>> | null = null;
  if (remoteBindIp && remoteBindIp !== loopbackHost && remoteBindIp !== "localhost") {
    remoteProxy = await startRemoteProxy({
      bindIp: remoteBindIp,
      port,
      targetHost: loopbackHost,
      targetPort: port,
    });
  }

  const shutdown = async () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    try {
      await remoteProxy?.close();
    } finally {
      await app.close();
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`Rook listening at http://${loopbackHost}:${port}`);
  if (remoteProxy) {
    console.log(`Rook remote proxy listening at http://${remoteBindIp}:${port}`);
  }
}
