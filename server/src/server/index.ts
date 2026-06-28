import dotenv from "dotenv";
import fastify from "fastify";
import websocket from "@fastify/websocket";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EnvironmentDecisionStore } from "./environment/EnvironmentDecisionStore.js";
import { EnvironmentManager } from "./environment/EnvironmentManager.js";
import { LocalEnvironmentRepository } from "./environment/LocalEnvironmentRepository.js";
import { EnvironmentIdentifier } from "./location/EnvironmentIdentifier.js";
import { MockBuildingSkillSuggester } from "./location/BuildingSkillSuggester.js";
import { PtilesPoiLookupProvider } from "./location/PtilesPoiLookupProvider.js";
import { LocationRegistrar } from "./location/LocationRegistrar.js";
import type { FetchRange } from "./location/ptiles/PtilesRangeSource.js";
import type { PoiLookupProvider } from "./location/PoiLookupProvider.js";
import { REPO_ROOT } from "./paths.js";
import { SessionRoomManager } from "./realtime/SessionRoomManager.js";
import { registerAgentRoutes } from "./routes/agentRoutes.js";
import { registerEnvironmentRoutes } from "./routes/environmentRoutes.js";
import { registerPtilesProxyRoutes } from "./routes/ptilesProxyRoutes.js";
import { registerWebsocketRoute } from "./routes/websocketRoute.js";

dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

export interface BuildServerOptions {
  enableClient?: boolean; // legacy no-op; the server no longer hosts a web client
  logger?: Parameters<typeof fastify>[0]["logger"];
  roomIdleTimeoutMs?: number;
  /** SQLite location for persistent environment decisions; ":memory:" in tests. */
  environmentDecisionStoreLocation?: string;
  /** Override the POI lookup provider (defaults to the ptiles provider via the proxy route). */
  poiProvider?: PoiLookupProvider;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const app = fastify({ logger: options.logger ?? true });
  const environmentRepository = new LocalEnvironmentRepository();
  const environmentDecisionStore = new EnvironmentDecisionStore(options.environmentDecisionStoreLocation);
  const environmentManager = new EnvironmentManager(environmentRepository, environmentDecisionStore);
  // Range-fetch ptiles data through the in-process proxy route (single egress).
  const fetchRange: FetchRange = async (file, start, endInclusive) => {
    const res = await app.inject({
      method: "GET",
      url: `/api/ptiles/proxy?file=${encodeURIComponent(file)}`,
      headers: { range: `bytes=${start}-${endInclusive}` },
    });
    return { status: res.statusCode, body: new Uint8Array(res.rawPayload) };
  };
  const environmentIdentifier = new EnvironmentIdentifier({
    poiProvider: options.poiProvider ?? new PtilesPoiLookupProvider({ fetchRange }),
    repository: environmentRepository,
    skillSuggester: new MockBuildingSkillSuggester(),
  });
  const locationRegistrar = new LocationRegistrar(environmentManager);
  const roomManager = new SessionRoomManager({
    idleTimeoutMs: options.roomIdleTimeoutMs,
    onRoomRemoved: (sessionId) => environmentManager.unsubscribe(sessionId),
  });

  await app.register(websocket);

  app.addHook("onClose", async () => {
    await roomManager.closeAll();
  });

  await registerAgentRoutes(app, { roomManager, environmentManager });
  await registerPtilesProxyRoutes(app);
  await registerEnvironmentRoutes(app, environmentManager, environmentIdentifier, locationRegistrar);
  await registerWebsocketRoute(app, roomManager);

  return app;
}

const isMain = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isMain) {
  const app = await buildServer();
  await app.listen({ host, port });
  console.log(`Agent Station listening at http://${host}:${port}`);
}
