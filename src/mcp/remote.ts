import type { BridgeConfig } from "../config.js";
import { AuditLog } from "../core/audit.js";
import type { BubbleClient } from "../core/client.js";
import { ClientRegistry, staticTokenAuth, type Authenticator } from "../core/clients.js";
import { serveHttp, type HttpServerHandle } from "./http.js";
import { createBubbleMcpServer, createSharedState } from "./server.js";

export interface RemoteOptions {
  config: BridgeConfig;
  client: BubbleClient;
  host: string;
  port: number;
  log: (msg: string) => void;
}

/** Clients por arquivo têm precedência; sem ele, o token único vira o client "default". */
function buildAuthenticator(cfg: BridgeConfig, log: (msg: string) => void): Authenticator {
  if (cfg.clientsFile) {
    const registry = new ClientRegistry(cfg.clientsFile);
    const active = registry.activeCount();
    log(`clients: ${active} ativo(s) em ${cfg.clientsFile}`);
    if (!active) log("nenhum client ativo — todo /mcp responde 401 até rodar `clients add <nome>`");
    return registry.authenticate;
  }
  if (cfg.httpToken) return staticTokenAuth(cfg.httpToken, cfg.mode);
  throw new Error(
    "serve --http exige BUBBLE_BRIDGE_CLIENTS_FILE (token por client) ou BUBBLE_BRIDGE_HTTP_TOKEN (mín. 16 caracteres). " +
      "Sem isso o BUBBLE_API_TOKEN viraria uma API aberta.",
  );
}

/** Sobe o MCP por HTTP com estado compartilhado entre requisições e encerra limpo em SIGTERM/SIGINT. */
export async function startRemote(opts: RemoteOptions): Promise<HttpServerHandle> {
  const { config, client, log } = opts;
  const authenticate = buildAuthenticator(config, log);
  const shared = createSharedState();
  const audit = new AuditLog(config.auditLog);
  const handle = await serveHttp({
    host: opts.host,
    port: opts.port,
    authenticate,
    factory: (identity) => createBubbleMcpServer({ config, client, audit, shared, identity }),
    trustProxy: config.trustProxy,
    allowedOrigins: config.allowedOrigins,
    log,
  });
  log(`modo do servidor: ${config.mode} (${config.env}) — teto para todos os clients`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      log(`${signal} recebido, encerrando`);
      void handle.close().then(() => process.exit(0));
    });
  }
  return handle;
}
