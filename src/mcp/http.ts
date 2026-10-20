import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Transporte remoto do Bubble Bridge (MCP Streamable HTTP, modo stateless).
 *
 * Por que não expor o stdio na internet: o servidor carrega o BUBBLE_API_TOKEN.
 * Publicá-lo sem autenticação transformaria o seu token admin em API da internet.
 * Por isso o token HTTP é obrigatório, comparação é constant-time e o bind padrão
 * é loopback — para uso real, coloque um reverse proxy com TLS na frente.
 */

export interface HttpServeOptions {
  host: string;
  port: number;
  /** Bearer obrigatório. Recusa o start sem ele. */
  token: string;
  /** Cria um McpServer novo por requisição (exigência do modo stateless). */
  factory: () => { server: McpServer; tools: string[] };
  log?: (msg: string) => void;
  maxBodyBytes?: number;
  maxInflight?: number;
  /** Requisições por minuto por IP. 0 desliga. */
  ratePerMin?: number;
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
    if (!rateOk(hits, req.socket.remoteAddress ?? "?", rateLimit)) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      res.end(JSON.stringify({ error: "rate_limited" }));
      return;
    }
    if (!authorized(req, opts.token)) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="bubble-bridge"' });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (inflight >= maxInflight) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "5" });
      res.end(JSON.stringify({ error: "too_many_inflight" }));
      return;
    }
    inflight++;
    try {
      await dispatch(req, res);
    } finally {
      inflight--;
    }
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { server: mcp, tools } = opts.factory();
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
    log(`${method} /mcp → ${tools.length} tools`);
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      const url = `http://${opts.host}:${port}/mcp`;
      log(`MCP remoto em ${url} (autenticado por Bearer; health em /healthz)`);
      if (opts.host !== "127.0.0.1" && opts.host !== "localhost") {
        log(`ATENÇÃO: bind em ${opts.host} expõe o token do Bubble para a rede — use TLS e rede privada.`);
      }
      resolve({
        url,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function authorized(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization ?? "";
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
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
