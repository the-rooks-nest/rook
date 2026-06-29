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
    return { ok: true, id: trimmedId };
  });

  app.post<{ Body: { id?: unknown } }>("/api/environments/unregister", async (request, reply) => {
    const id = request.body?.id;
    if (typeof id !== "string" || !id.trim()) {
      reply.code(400).send({ error: "Missing environment id" });
      return;
    }
    const trimmedId = id.trim();
    request.log.info({ environmentId: trimmedId }, "environment unregistered");
    environmentManager.unregister(trimmedId);
    return { ok: true };
  });

  app.post<{ Body: { environmentId?: unknown; decision?: unknown } }>("/api/environments/decision", async (request, reply) => {
    const environmentId = request.body?.environmentId;
    const decision = request.body?.decision;
    if (typeof environmentId !== "string" || !environmentId.trim()) {
      reply.code(400).send({ error: "Missing environmentId" });
      return;
    }
    if (decision !== "accept" && decision !== "approve" && decision !== "ignore" && decision !== "reject") {
      reply.code(400).send({ error: "Invalid decision" });
      return;
    }
    const trimmedEnvironmentId = environmentId.trim();
    request.log.info({ environmentId: trimmedEnvironmentId, decision }, "environment decision recorded");
    environmentManager.decideEnvironment(trimmedEnvironmentId, decision as EnvironmentDecision);
    return { ok: true };
  });

  app.get<{ Querystring: { environmentId?: string } }>("/api/environments/preview", async (request, reply) => {
    const environmentId = typeof request.query.environmentId === "string" ? request.query.environmentId.trim() : "";
    if (!environmentId) {
      reply.code(400).send({ error: "Missing environmentId" });
      return;
    }
    const skills = await environmentManager.getSkillPreviews(environmentId);
    return { environmentId, skills };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/environments/identify-available", async (request, reply) => {
    const body = request.body ?? {};
    const latitude = body.latitude;
    const longitude = body.longitude;
    if (typeof latitude !== "number" || !Number.isFinite(latitude) || typeof longitude !== "number" || !Number.isFinite(longitude)) {
      reply.code(400).send({ error: "Missing or invalid latitude/longitude" });
      return;
    }

    const source = body.source;
    const identifyRequest: IdentifyAvailableRequest = {
      latitude,
      longitude,
      ...(typeof body.horizontalAccuracy === "number" ? { horizontalAccuracy: body.horizontalAccuracy } : {}),
      ...(source === "visit" || source === "region" || source === "manual" ? { source: source as IdentifySource } : {}),
      ...(typeof body.dwellSeconds === "number" ? { dwellSeconds: body.dwellSeconds } : {}),
      ...(typeof body.isStationary === "boolean" ? { isStationary: body.isStationary } : {}),
      ...(typeof body.speedMetersPerSecond === "number" ? { speedMetersPerSecond: body.speedMetersPerSecond } : {}),
      ...(typeof body.observedAt === "string" ? { observedAt: body.observedAt } : {}),
    };

    const candidates = await environmentIdentifier.identifyAvailableEnvironments(identifyRequest);
    // Make the identified set available to the SessionRoom/agent on a real dwell (best-effort).
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
}
