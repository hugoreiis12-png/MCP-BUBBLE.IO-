#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, redactedConfig, type BridgeConfig } from "./config.js";
import { AuditLog } from "./core/audit.js";
import { BubbleClient, type Constraint } from "./core/client.js";
import { generateTypes } from "./core/codegen.js";
import { exportToNdjson } from "./core/files.js";
import { normalizeSwagger } from "./core/schema.js";
import { createBubbleMcpServer, SERVER_VERSION } from "./mcp/server.js";

const HELP = `bubble-bridge ${SERVER_VERSION} — Motor 1 (runtime) + Motor 3 (elementos)

Uso: bubble-bridge <comando> [opções]

Comandos
  serve                         Inicia o servidor MCP em stdio (OpenCode, Claude Code)
  doctor                        Valida configuração e acesso a /meta e ao swagger
  discover                      Imprime tipos e workflows expostos (JSON)
  types [--out arquivo.ts]      Gera interfaces TypeScript dos data types
  query --type T [--limit N] [--cursor N] [--sort CAMPO] [--desc] [--constraints JSON]
  get --type T --id ID
  export --type T [--max N] [--constraints JSON]
  element build --entry elemento.tsx [--plugin-dir repo-do-plugin] [--out dir] [--force]
                                Compila um elemento React para os arquivos do Plugin Editor
  exposure [--type T] [--live]   PoC: lê um tipo SEM token e diz se está exposto
  exposure [--all] [--live]     Varre a Data API sem token e classifica a gravidade
  serve --http [--host H] [--port N]
                                Serve o MCP por HTTP (Streamable HTTP) em vez de stdio.
                                Exige BUBBLE_BRIDGE_HTTP_TOKEN (openssl rand -hex 32).

Configuração por variáveis de ambiente (ou .env no diretório atual):
  BUBBLE_APP_URL     https://meuapp.bubbleapps.io        (obrigatório)
  BUBBLE_API_TOKEN   token da aba Settings > API          (opcional)
  BUBBLE_ENV         test | live                          (padrão: test)
  BUBBLE_MODE        read-only | read-write | admin       (padrão: read-only)
  BUBBLE_AUDIT_LOG   caminho do log JSONL de auditoria    (padrão: desligado)
  BUBBLE_EXPORT_DIR  diretório das exportações            (padrão: ./exports)
`;

const log = (msg: string) => process.stderr.write(`[bubble-bridge] ${msg}\n`);

function makeClient(cfg: BridgeConfig): BubbleClient {
  return new BubbleClient({
    appUrl: cfg.appUrl,
    env: cfg.env,
    token: cfg.token,
    maxRetries: cfg.maxRetries,
    timeoutMs: cfg.timeoutMs,
    onRetry: ({ attempt, delayMs, reason, endpoint }) =>
      log(`tentativa ${attempt} em ${delayMs} ms (${reason}) — ${endpoint}`),
  });
}

function parseConstraints(raw: string | undefined): Constraint[] | undefined {
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("--constraints precisa ser um array JSON");
  return parsed as Constraint[];
}

function print(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      entry: { type: "string" },
      "plugin-dir": { type: "string" },
      force: { type: "boolean", default: false },
      type: { type: "string" },
      id: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      sort: { type: "string" },
      desc: { type: "boolean", default: false },
      constraints: { type: "string" },
      "max": { type: "string" },
      out: { type: "string" },
      http: { type: "boolean", default: false },
      host: { type: "string" },
      port: { type: "string" },
      sample: { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      concurrency: { type: "string" },
    },
    strict: true,
  });

  const need = (v: string | undefined, flag: string): string => {
    if (!v) throw new Error(`faltou ${flag}`);
    return v;
  };

  // Build de elemento não fala com o app: não exige BUBBLE_APP_URL.
  if (command === "element") {
    if (positionals[0] !== "build") throw new Error('uso: bubble-bridge element build --entry <arquivo.tsx> [--plugin-dir <repo>] [--out <dir>] [--force]');
    const { buildElement } = await import("./element/build.js");
    const result = await buildElement({
      entry: need(values.entry, "--entry"),
      pluginDir: values["plugin-dir"],
      outDir: values.out,
      force: values.force,
    });
    for (const w of result.warnings) log(`aviso: ${w}`);
    print({
      element: result.manifest,
      target: result.target,
      elementDir: result.elementDir,
      files: result.files,
      bundleKB: Math.round(result.bundleBytes / 1024),
      sha256: result.sha256,
    });
    return 0;
  }
  if (positionals.length) throw new Error(`argumento inesperado: ${positionals[0]}`);

  const cfg = loadConfig();
  const client = makeClient(cfg);

  switch (command) {
    case "serve": {
      const factory = () => createBubbleMcpServer({ config: cfg, client, audit: new AuditLog(cfg.auditLog) });
      if (values.http) {
        if (!cfg.httpToken) {
          throw new Error(
            "serve --http exige BUBBLE_BRIDGE_HTTP_TOKEN (mín. 16 caracteres). " +
              "Gerar: openssl rand -hex 32. Sem esse token o BUBBLE_API_TOKEN viraria uma API pública.",
          );
        }
        const { serveHttp } = await import("./mcp/http.js");
        const handle = await serveHttp({
          host: values.host ?? cfg.httpHost,
          port: values.port ? Number(values.port) : cfg.httpPort,
          token: cfg.httpToken,
          factory,
          log,
        });
        log(`tools: ${factory().tools.join(", ")}`);
        await new Promise<void>(() => undefined); // serve até o processo ser encerrado
        void handle;
        return -1;
      }
      const { server, tools } = factory();
      if (cfg.mode !== "read-only") {
        const live = cfg.env === "live" ? (cfg.allowLiveWrites ? "LIVE COM ESCRITA LIBERADA" : "live bloqueado para escrita") : "test";
        log(`modo ${cfg.mode} (${live}); workflows liberados: ${cfg.workflowAllowlist.join(", ") || "nenhum"}`);
      }
      await server.connect(new StdioServerTransport());
      log(`servidor MCP ativo (${cfg.env}, ${cfg.mode}) — tools: ${tools.join(", ")}`);
      return -1; // mantém o processo vivo
    }
    case "exposure": {
      const { apiRootFor } = await import("./core/client.js");
      const { SENSITIVE_TYPE_RE, probeAnonymous, sweepAnonymous } = await import("./core/recon.js");
      const env = values.live ? "live" : cfg.env;
      const apiRoot = apiRootFor(cfg.appUrl, env);
      if (values.type) {
        const r = await probeAnonymous({ apiRoot, type: values.type, includeSample: true, http: client.httpOptions });
        print(r);
        return r.exposed ? 1 : 0;
      }
      const schema = normalizeSwagger(await client.swagger());
      const names = schema.types.map((t) => t.name);
      const candidates = values.all ? names : names.filter((n) => SENSITIVE_TYPE_RE.test(n));
      log(`varrendo ${candidates.length} tipos em ${apiRoot} sem token…`);
      const sweep = await sweepAnonymous({
        apiRoot,
        types: candidates,
        concurrency: values.concurrency ? Number(values.concurrency) : 4,
        includeSample: values.sample,
        http: client.httpOptions,
        onProgress: (done, total, type) => {
          if (done % 10 === 0 || done === total) log(`  ${done}/${total} — ${type}`);
        },
      });
      print({
        apiRoot,
        varridos: sweep.probed,
        expostos: sweep.exposed,
        criticos: sweep.critical,
        altos: sweep.high,
        erros: sweep.errors.length,
        vazamentos: sweep.leaks.map((l) => ({
          tipo: l.type,
          nivel: l.level,
          registros: l.remaining,
          campos: l.fields.length,
          dados_personalizados: l.findings.map((f) => `${f.field} (${f.label})`),
          amostra: l.sample,
        })),
      });
      return sweep.critical > 0 ? 1 : sweep.exposed > 0 ? 2 : 0;
    }
    case "doctor": {
      print({ config: redactedConfig(cfg), apiRoot: client.apiRoot });
      let ok = true;
      try {
        const schema = normalizeSwagger(await client.swagger());
        print({ swagger: "ok", format: schema.format, types: schema.types.length, workflows: schema.workflows.length, warnings: schema.warnings });
      } catch (err) {
        ok = false;
        print({ swagger: "falhou", error: String(err instanceof Error ? err.message : err) });
      }
      try {
        const meta = await client.meta();
        print({ meta: "ok", topLevelKeys: meta && typeof meta === "object" ? Object.keys(meta) : typeof meta });
      } catch (err) {
        ok = false;
        print({ meta: "falhou", error: String(err instanceof Error ? err.message : err) });
      }
      return ok ? 0 : 1;
    }
    case "discover":
      print(normalizeSwagger(await client.swagger()));
      return 0;
    case "types": {
      const code = generateTypes(normalizeSwagger(await client.swagger()));
      if (values.out) {
        await writeFile(values.out, code, "utf8");
        log(`tipos gravados em ${values.out}`);
      } else process.stdout.write(code);
      return 0;
    }
    case "query":
      print(
        await client.list(need(values.type, "--type"), {
          limit: values.limit ? Number(values.limit) : 20,
          cursor: values.cursor ? Number(values.cursor) : 0,
          sortField: values.sort,
          descending: values.sort ? values.desc : undefined,
          constraints: parseConstraints(values.constraints),
        }),
      );
      return 0;
    case "get":
      print(await client.getThing(need(values.type, "--type"), need(values.id, "--id")));
      return 0;
    case "export": {
      const type = need(values.type, "--type");
      const result = await exportToNdjson(client, type, cfg.exportDir, {
        constraints: parseConstraints(values.constraints),
        maxItems: values.max ? Number(values.max) : undefined,
        searchCap: cfg.searchCap,
        onProgress: ({ total, window }) => log(`${type}: ${total} registros (janela ${window})`),
      });
      print(result);
      return 0;
    }
    default:
      process.stderr.write(`Comando desconhecido: ${command}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    log(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
