import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Ambiente do app Bubble. `test` = branch de desenvolvimento (/version-test). */
export type BubbleEnv = "test" | "live";

/** Modos do servidor. O modo filtra quais tools são REGISTRADAS no startup. */
export const MODES = ["read-only", "read-write", "admin"] as const;
export type Mode = (typeof MODES)[number];

export function modeRank(mode: Mode): number {
  return MODES.indexOf(mode);
}

const ConfigSchema = z.object({
  appUrl: z
    .string({ error: "BUBBLE_APP_URL é obrigatório (ex.: https://meuapp.bubbleapps.io)" })
    .url("BUBBLE_APP_URL precisa ser uma URL completa, ex.: https://meuapp.bubbleapps.io")
    .refine((u) => u.startsWith("https://"), "BUBBLE_APP_URL precisa usar https://")
    .transform((u) => u.replace(/\/+$/, "")),
  token: z.string().min(1).optional(),
  env: z.enum(["test", "live"]).default("test"),
  mode: z.enum(MODES).default("read-only"),
  auditLog: z.string().optional(),
  exportDir: z.string().default("./exports"),
  maxRetries: z.coerce.number().int().min(0).max(10).default(4),
  timeoutMs: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  /** Teto de itens alcançáveis por cursor num GET (50.000 fora do Enterprise). */
  searchCap: z.coerce.number().int().min(100).default(50_000),
  /** Escrita no live exige opt-in explícito, além do modo. */
  allowLiveWrites: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Backend workflows que bubble_workflow_run pode disparar. Vazio = nenhum. */
  workflowAllowlist: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  /** Bearer do transporte remoto (serve --http). Sem ele, o servidor não sobe. */
  httpToken: z.string().min(16).optional(),
  httpHost: z.string().default("127.0.0.1"),
  httpPort: z.coerce.number().int().min(1024).max(65535).default(8787),
  /** Arquivo de clients (token por client). Tem precedência sobre httpToken. */
  clientsFile: z.string().optional(),
  /** Só true atrás de proxy confiável: o IP do rate limit vem do X-Forwarded-For. */
  trustProxy: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Origins de navegador aceitos no /mcp. Vazio = qualquer Origin presente é recusado. */
  allowedOrigins: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  /**
   * Cookie de sessão da conta Bubble — credencial do plano de design (editor).
   * Sem ele, as tools de editor ficam desregistradas: o token da API do app
   * não alcança o design. Nunca é registrado em log.
   */
  editorSession: z.string().min(1).optional(),
  /**
   * JWT do Firebase da conta Bubble (`meta-firebase_workflow`).
   *
   * O editor exige **os dois**: o cookie da sessão e este header. Sem o
   * header, o editor responde 401 mesmo com o cookie válido — é o motivo
   * mais comum de a escrita de design falhar.
   */
  editorFirebaseToken: z.string().min(1).optional(),
  /**
   * Base HTTP do **editor** — o host que serve o editor e a API interna de
   * design (`/appeditor/*`). É diferente do host da API do app (`/api/1.1`).
   */
  editorBase: z
    .string()
    .url("BUBBLE_EDITOR_BASE precisa ser uma URL completa, ex.: https://scheduled.bubble.io")
    .default("https://scheduled.bubble.io"),
  /**
   * @deprecated BUBBLE_EDITOR_API_BASE —use `BUBBLE_EDITOR_BASE`. Mantido só
   * como fallback para não quebrar quem já tinha a variável no ambiente.
   */
  editorApiBase: z
    .string()
    .url("BUBBLE_EDITOR_API_BASE precisa ser uma URL completa")
    .optional(),
  /**
   * App alvo no editor — o *appname* (slug) que o editor usa no caminho das
   * operações, ex.: `comprover`.
   */
  editorAppId: z.string().min(1).optional(),
  /** Branch do design alvo: dev (`version-test`) ou publicado (`version-live`). */
  editorBranch: z.enum(["version-test", "version-live"]).default("version-test"),
  /** Mapa de operações do editor: JSON inline ou caminho de arquivo. */
  editorOps: z.string().optional(),
});

/**
 * Versão do design (`app_version`) correspondente ao branch configurado.
 *
 * O editor chama o branch de desenvolvimento de `test` e o publicado de
 * `live` — é assim que os endpoints de design os nomeiam.
 */
export function editorAppVersion(cfg: BridgeConfig): "test" | "live" {
  return cfg.editorBranch === "version-live" ? "live" : "test";
}

export type BridgeConfig = z.infer<typeof ConfigSchema>;

/**
 * Lê a configuração do ambiente. Carrega `.env` do diretório atual (ou de
 * BUBBLE_ENV_FILE) quando existir. Nunca registra o token em log.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  if (env === process.env) {
    // BUBBLE_ENV_FILE > .env do cwd > .env na raiz do pacote (o agente pode iniciar o serve de qualquer pasta).
    const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const envFile = [env.BUBBLE_ENV_FILE, resolve(process.cwd(), ".env"), resolve(pkgRoot, ".env")].find(
      (f) => f && existsSync(f),
    );
    if (envFile) process.loadEnvFile(envFile);
  }
  const parsed = ConfigSchema.safeParse({
    appUrl: env.BUBBLE_APP_URL,
    token: env.BUBBLE_API_TOKEN || undefined,
    env: env.BUBBLE_ENV || undefined,
    mode: env.BUBBLE_MODE || undefined,
    auditLog: env.BUBBLE_AUDIT_LOG || undefined,
    exportDir: env.BUBBLE_EXPORT_DIR || undefined,
    maxRetries: env.BUBBLE_MAX_RETRIES || undefined,
    timeoutMs: env.BUBBLE_TIMEOUT_MS || undefined,
    searchCap: env.BUBBLE_SEARCH_CAP || undefined,
    allowLiveWrites: env.BUBBLE_ALLOW_LIVE_WRITES || undefined,
    workflowAllowlist: env.BUBBLE_WORKFLOW_ALLOWLIST || undefined,
    editorSession: env.BUBBLE_EDITOR_SESSION || undefined,
    editorFirebaseToken: env.BUBBLE_EDITOR_FIREBASE_TOKEN || undefined,
    editorBase: env.BUBBLE_EDITOR_BASE || env.BUBBLE_EDITOR_API_BASE || undefined,
    editorApiBase: env.BUBBLE_EDITOR_API_BASE || undefined,
    editorAppId: env.BUBBLE_EDITOR_APP_ID || undefined,
    editorBranch: env.BUBBLE_EDITOR_BRANCH || undefined,
    editorOps: env.BUBBLE_EDITOR_OPS || undefined,
    httpToken: env.BUBBLE_BRIDGE_HTTP_TOKEN || undefined,
    httpHost: env.BUBBLE_BRIDGE_HTTP_HOST || undefined,
    httpPort: env.BUBBLE_BRIDGE_HTTP_PORT || undefined,
    clientsFile: env.BUBBLE_BRIDGE_CLIENTS_FILE || undefined,
    trustProxy: env.BUBBLE_BRIDGE_TRUST_PROXY || undefined,
    allowedOrigins: env.BUBBLE_BRIDGE_ALLOWED_ORIGINS || undefined,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuração inválida do Bubble Bridge:\n${issues}`);
  }
  return parsed.data;
}

/** Visão segura da configuração para logs e para a tool bubble_config. */
export function redactedConfig(cfg: BridgeConfig): Record<string, unknown> {
  return {
    appUrl: cfg.appUrl,
    env: cfg.env,
    mode: cfg.mode,
    token: cfg.token ? `definido (${cfg.token.length} caracteres)` : "ausente — só dados públicos pelas privacy rules",
    auditLog: cfg.auditLog ?? "desligado",
    exportDir: cfg.exportDir,
    maxRetries: cfg.maxRetries,
    timeoutMs: cfg.timeoutMs,
    searchCap: cfg.searchCap,
    allowLiveWrites: cfg.allowLiveWrites,
    workflowAllowlist: cfg.workflowAllowlist,
    editor: {
      sessao: cfg.editorSession ? `definida (${cfg.editorSession.length} caracteres)` : "ausente — tools de design ficam indisponíveis",
      firebase: cfg.editorFirebaseToken
        ? `definido (${cfg.editorFirebaseToken.length} caracteres)`
        : "ausente — o editor exige o header meta-firebase_workflow; sem ele a escrita de design é recusada com 401",
      base: cfg.editorBase,
      app: cfg.editorAppId ?? "ausente",
      version: editorAppVersion(cfg),
      branch: cfg.editorBranch,
      ops: cfg.editorOps ? "definido (customizado)" : "padrão (operações medidas no editor)",
    },
    http: cfg.httpToken ? `token definido (${cfg.httpToken.length} caracteres)` : "desligado (serve --http recusa sem token)",
    httpHost: cfg.httpHost,
    httpPort: cfg.httpPort,
    clientsFile: cfg.clientsFile ?? "desligado",
    trustProxy: cfg.trustProxy,
    allowedOrigins: cfg.allowedOrigins,
  };
}
