import type { IncomingMessage } from "node:http";

export interface ServerAuthOptions {
  token?: string;
  trustLoopbackWithoutAuth?: boolean;
}

export class ServerAuth {
  private readonly token?: string;
  private readonly trustLoopbackWithoutAuth: boolean;

  constructor(options: ServerAuthOptions = {}) {
    this.token = options.token?.trim() || undefined;
    this.trustLoopbackWithoutAuth = options.trustLoopbackWithoutAuth ?? true;
  }

  get enabled(): boolean {
    return Boolean(this.token);
  }

  authorizeRequest(request: IncomingMessage): { ok: true } | { ok: false; statusCode: 401; error: string } {
    if (!this.enabled) return { ok: true };
    if (
      this.trustLoopbackWithoutAuth
      && isLoopbackAddress(request.socket.remoteAddress)
      && !hasForwardedRemote(request)
    ) {
      return { ok: true };
    }
    const expected = `Bearer ${this.token}`;
    const provided = request.headers.authorization;
    if (constantTimeEquals(provided, expected)) return { ok: true };
    return { ok: false, statusCode: 401, error: "Unauthorized" };
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1";
}

function hasForwardedRemote(request: IncomingMessage): boolean {
  const forwarded = request.headers["x-forwarded-for"];
  return typeof forwarded === "string" ? forwarded.trim().length > 0 : Array.isArray(forwarded) && forwarded.length > 0;
}

function constantTimeEquals(left: string | undefined, right: string | undefined): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}
