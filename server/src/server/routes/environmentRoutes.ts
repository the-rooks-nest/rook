import type { FastifyInstance } from "fastify";
import type { EnvironmentManager } from "../environment/EnvironmentManager.js";
import type { EnvironmentDecision } from "../environment/types.js";
import type { EnvironmentIdentifier } from "../location/EnvironmentIdentifier.js";
import type { LocationRegistrar } from "../location/LocationRegistrar.js";
import type { IdentifyAvailableRequest, IdentifySource } from "../../shared/environment.js";

export async function registerEnvironmentRoutes(
  app: FastifyInstance,
  environmentManager: EnvironmentManager,
  environmentIdentifier: EnvironmentIdentifier,
  locationRegistrar: LocationRegistrar,
): Promise<void> {
  app.post<{ Body: { id?: unknown; metadata?: unknown; canonicalSourceUrl?: unknown; sourceName?: unknown } }>("/api/environments/register", async (request, reply) => {
    const id = request.body?.id;
    if (typeof id !== "string" || !id.trim()) {
      reply.code(400).send({ error: "Missing environment id" });
      return;
    }

    const metadata = request.body?.metadata;
    if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
      reply.code(400).send({ error: "Invalid metadata" });
      return;
    }

    const canonicalSourceUrl = typeof request.body?.canonicalSourceUrl === "string" ? request.body.canonicalSourceUrl : undefined;
    const sourceName = typeof request.body?.sourceName === "string" ? request.body.sourceName : undefined;

    const trimmedId = id.trim();
    request.log.info({ environmentId: trimmedId, sourceName, canonicalSourceUrl }, "environment registered");

    await environmentManager.registerAvailableEnvironment(
      { id: trimmedId, metadata: (metadata ?? {}) as Record<string, unknown> },
      { ...(canonicalSourceUrl ? { canonicalSourceUrl } : {}), ...(sourceName ? { sourceName } : {}) },
    );
    const registeredAt = new Date().toISOString();
    return { ok: true, id: trimmedId, registeredAt };
  });

  app.post<{ Body: { environmentId?: unknown; bundleHash?: unknown; decision?: unknown; sessionId?: unknown } }>("/api/environments/decision", async (request, reply) => {
    const environmentId = request.body?.environmentId;
    const bundleHash = typeof request.body?.bundleHash === "string" && request.body.bundleHash.trim() ? request.body.bundleHash.trim() : undefined;
    const decision = request.body?.decision;
    const sessionId = typeof request.body?.sessionId === "string" && request.body.sessionId.trim() ? request.body.sessionId.trim() : undefined;
    if (typeof environmentId !== "string" || !environmentId.trim()) {
      reply.code(400).send({ error: "Missing environmentId" });
      return;
    }
    if (decision !== "accept" && decision !== "approve" && decision !== "ignore" && decision !== "reject") {
      reply.code(400).send({ error: "Invalid decision" });
      return;
    }
    const trimmedEnvironmentId = environmentId.trim();
    request.log.info({ environmentId: trimmedEnvironmentId, bundleHash, decision, sessionId }, "environment decision recorded");
    environmentManager.decideEnvironment(trimmedEnvironmentId, decision as EnvironmentDecision, bundleHash, sessionId);
    return { ok: true };
  });

  app.get<{ Querystring: { environmentId?: string } }>("/api/environments/preview", async (request, reply) => {
    const environmentId = typeof request.query.environmentId === "string" ? request.query.environmentId.trim() : "";
    if (!environmentId) {
      reply.code(400).send({ error: "Missing environmentId" });
      return;
    }
    const preview = await environmentManager.getEnvironmentPreview(environmentId);
    return preview;
  });

  function parseIdentifyRequest(body: Record<string, unknown>): IdentifyAvailableRequest | null {
    const latitude = body.latitude;
    const longitude = body.longitude;
    if (typeof latitude !== "number" || !Number.isFinite(latitude) || typeof longitude !== "number" || !Number.isFinite(longitude)) {
      return null;
    }
    const source = body.source;
    return {
      latitude,
      longitude,
      ...(typeof body.horizontalAccuracy === "number" ? { horizontalAccuracy: body.horizontalAccuracy } : {}),
      ...(source === "visit" || source === "region" || source === "manual" ? { source: source as IdentifySource } : {}),
      ...(typeof body.dwellSeconds === "number" ? { dwellSeconds: body.dwellSeconds } : {}),
      ...(typeof body.isStationary === "boolean" ? { isStationary: body.isStationary } : {}),
      ...(typeof body.speedMetersPerSecond === "number" ? { speedMetersPerSecond: body.speedMetersPerSecond } : {}),
      ...(typeof body.observedAt === "string" ? { observedAt: body.observedAt } : {}),
    };
  }

  // Read-only: reverse-resolve a coordinate to candidate `loc:` environments. No side effects.
  app.post<{ Body: Record<string, unknown> }>("/api/environments/identify", async (request, reply) => {
    const identifyRequest = parseIdentifyRequest(request.body ?? {});
    if (!identifyRequest) {
      reply.code(400).send({ error: "Missing or invalid latitude/longitude" });
      return;
    }
    return { candidates: await environmentIdentifier.identifyAvailableEnvironments(identifyRequest) };
  });

  // Committing: identify, then register/auto-enter the dwell set into the SessionRoom/agent.
  app.post<{ Body: Record<string, unknown> }>("/api/environments/register-location", async (request, reply) => {
    const identifyRequest = parseIdentifyRequest(request.body ?? {});
    if (!identifyRequest) {
      reply.code(400).send({ error: "Missing or invalid latitude/longitude" });
      return;
    }
    const candidates = await environmentIdentifier.identifyAvailableEnvironments(identifyRequest);
    try {
      await locationRegistrar.sync(candidates, {
        isStationary: identifyRequest.isStationary,
        dwellSeconds: identifyRequest.dwellSeconds,
        speedMetersPerSecond: identifyRequest.speedMetersPerSecond,
      });
    } catch (error) {
      app.log.warn(`location registration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { candidates };
  });

  app.post<{ Body: { sessionId?: unknown; environmentId?: unknown } }>("/api/environments/enter", async (request, reply) => {
    const sessionId = request.body?.sessionId;
    const environmentId = request.body?.environmentId;
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      reply.code(400).send({ error: "Missing sessionId" });
      return;
    }
    if (typeof environmentId !== "string" || !environmentId.trim()) {
      reply.code(400).send({ error: "Missing environmentId" });
      return;
    }
    const entered = environmentManager.enterEnvironment(sessionId.trim(), environmentId.trim());
    return { ok: true, entered };
  });

  app.post<{ Body: { sessionId?: unknown; environmentId?: unknown } }>("/api/environments/exit", async (request, reply) => {
    const sessionId = request.body?.sessionId;
    const environmentId = request.body?.environmentId;
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      reply.code(400).send({ error: "Missing sessionId" });
      return;
    }
    if (typeof environmentId !== "string" || !environmentId.trim()) {
      reply.code(400).send({ error: "Missing environmentId" });
      return;
    }
    const entered = environmentManager.exitEnvironment(sessionId.trim(), environmentId.trim());
    return { ok: true, entered };
  });

  app.get<{ Querystring: { sessionId?: string } }>("/api/environments/list", async (request, reply) => {
    const sessionId = typeof request.query.sessionId === "string" ? request.query.sessionId.trim() : "";
    if (!sessionId) {
      reply.code(400).send({ error: "Missing sessionId" });
      return;
    }
    return environmentManager.environmentList(sessionId);
  });
}
