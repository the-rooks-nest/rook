import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

export interface RemoteProxyOptions {
  bindIp: string;
  port: number;
  targetHost: string;
  targetPort: number;
}

export interface RemoteProxyHandle {
  close(): Promise<void>;
}

export async function startRemoteProxy(options: RemoteProxyOptions): Promise<RemoteProxyHandle> {
  const server = http.createServer((request, response) => {
    proxyHttpRequest(request, response, options);
  });

  server.on("upgrade", (request, socket, head) => {
    proxyUpgradeRequest(request, socket, head, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.bindIp, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

function proxyHttpRequest(request: IncomingMessage, response: ServerResponse, options: RemoteProxyOptions): void {
  const headers = { ...request.headers, "x-forwarded-for": request.socket.remoteAddress ?? "" };
  const upstream = http.request({
    host: options.targetHost,
    port: options.targetPort,
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json" });
    }
    response.end(JSON.stringify({ error: "Upstream unavailable" }));
  });

  request.pipe(upstream);
}

function proxyUpgradeRequest(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: RemoteProxyOptions,
): void {
  const upstream = net.connect(options.targetPort, options.targetHost, () => {
    upstream.write(renderUpgradeRequest(request));
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  const closeBoth = () => {
    socket.destroy();
    upstream.destroy();
  };

  upstream.on("error", closeBoth);
  socket.on("error", closeBoth);
}

function renderUpgradeRequest(request: IncomingMessage): string {
  let raw = `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n`;
  const headerNames = new Set<string>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const key = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (!key || value === undefined) continue;
    if (key.toLowerCase() === "x-forwarded-for") continue;
    headerNames.add(key.toLowerCase());
    raw += `${key}: ${value}\r\n`;
  }
  if (!headerNames.has("x-forwarded-for")) {
    raw += `x-forwarded-for: ${request.socket.remoteAddress ?? ""}\r\n`;
  }
  raw += "\r\n";
  return raw;
}
