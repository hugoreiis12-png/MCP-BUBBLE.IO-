import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Authenticator, ClientIdentity } from "../core/clients.js";

/**
 * Transporte remoto do Bubble Bridge (MCP Streamable HTTP, modo stateless).
 *
 * Por que não expor o stdio na internet: o servidor carrega o BUBBLE_API_TOKEN.
 * Publicá-lo sem autenticação transformaria o seu token admin em API da internet.
 * Por isso todo /mcp exige bearer de um client cadastrado (hash comparado em tempo
 * constante) e o bind padrão é loopback.
 */

export interface HttpServeOptions {
  host: string;
  port: number;
  /** Resolve o bearer para um client; null vira 401. */
  authenticate: Authenticator;
  /** Cria um McpServer novo por requisição (exigência do modo stateless), já no modo do client. */
  factory: (identity: ClientIdentity) => { server: McpServer; tools: string[] };
  log?: (msg: string) => void;
  maxBodyBytes?: number;
  maxInflight?: number;
  /** Requisições por minuto, por IP (antes da auth) e por client (depois). 0 desliga. */
  ratePerMin?: number;
  /** Atrás de proxy confiável: IP do rate limit vem do último hop do X-Forwarded-For. */
  trustProxy?: boolean;
  /** Origins de navegador aceitos. Origin presente e fora da lista = 403 (DNS rebinding). */
  allowedOrigins?: string[];
}

const DEFAULT_MAX_BODY = 8 * 1024 * 1024;

export interface HttpServerHandle {
  url: string;
  close: () => Promise<void>;
}

export function serveHttp(opts: HttpServeOptions): Promise<HttpServerHandle> {
  const log = opts.log ?? (() => undefined);
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const maxInflight = opts.maxInflight ?? 32;
  const rateLimit = opts.ratePerMin ?? 120;
  let inflight = 0;
  const hits = new Map<string, number[]>();

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log(`erro não tratado: ${String(err)}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "erro interno");
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (!originAllowed(req, opts.allowedOrigins ?? [])) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "origin_not_allowed" }));
      return;
    }
    if (!rateOk(hits, `ip:${clientIp(req, opts.trustProxy ?? false)}`, rateLimit)) return tooMany(res);
    const identity = identify(req, opts.authenticate);
    if (!identity) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="bubble-bridge"' });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (!rateOk(hits, `client:${identity.name}`, rateLimit)) return tooMany(res);
    if (inflight >= maxInflight) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "5" });
      res.end(JSON.stringify({ error: "too_many_inflight" }));
      return;
    }
    inflight++;
    try {
      await dispatch(req, res, identity);
    } finally {
      inflight--;
    }
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse, identity: ClientIdentity): Promise<void> {
    const { server: mcp, tools } = opts.factory(identity);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: sem estado entre requisições
      enableJsonResponse: true, // request/response simples, sem stream SSE
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    const method = req.method ?? "GET";
    const body = method === "POST" ? await readBody(req, res, maxBody) : undefined;
    if (body === undefined && method === "POST") return; // corpo inválido ou vazio: já respondeu
    await transport.handleRequest(req, res, body);
    log(`${method} /mcp ${identity.name} → ${tools.length} tools`);
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      const url = `http://${opts.host}:${port}/mcp`;
      log(`MCP remoto em ${url} (autenticado por Bearer; health em /healthz)`);
      if (opts.host !== "127.0.0.1" && opts.host !== "localhost") {
        log(`ATENÇÃO: bind em ${opts.host} expõe o servidor para a rede — mantenha-o em rede privada.`);
      }
      resolve({
        url,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

function identify(req: IncomingMessage, authenticate: Authenticator): ClientIdentity | null {
  const header = req.headers.authorization ?? "";
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return null;
  return authenticate(value);
}

function originAllowed(req: IncomingMessage, allowed: string[]): boolean {
  const origin = req.headers.origin;
  return !origin || allowed.includes(origin);
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = req.headers["x-forwarded-for"];
  const hops = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "")).split(",").map((h) => h.trim()).filter(Boolean);
  if (trustProxy && hops.length) return hops.at(-1)!;
  return req.socket.remoteAddress ?? "?";
}

function tooMany(res: ServerResponse): void {
  res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
  res.end(JSON.stringify({ error: "rate_limited" }));
}

/** Janela fixa de 1 minuto por IP. */
function rateOk(hits: Map<string, number[]>, ip: string, perMin: number): boolean {
  if (perMin <= 0) return true;
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= perMin) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (now - (v[v.length - 1] ?? 0) >= 60_000) hits.delete(k);
    if (hits.size > 5000) hits.delete(hits.keys().next().value as string); // ponytail: mais antiga por inserção
  }
  return true;
}

async function readBody(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      jsonRpcError(res, 413, -32600, `corpo acima de ${maxBytes} bytes`);
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) {
    jsonRpcError(res, 400, -32600, "corpo vazio");
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    jsonRpcError(res, 400, -32700, "JSON inválido");
    return undefined;
  }
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}
