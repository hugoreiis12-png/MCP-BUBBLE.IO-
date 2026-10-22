import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { loadConfig, type Mode } from "../src/config.js";
import { AuditLog } from "../src/core/audit.js";
import { BubbleClient } from "../src/core/client.js";
import type { FetchLike } from "../src/core/http.js";
import { createBubbleMcpServer, fitToCap, InflightLimiter, MAX_OUTPUT_CHARS } from "../src/mcp/server.js";
import { fakeBubble, makeRows } from "./fake-bubble.js";

async function connect(
  mode: Mode = "read-only",
  token?: string,
  allowlist?: string,
  editor?: { session?: string; appId?: string; ops?: string; firebase?: string; fetch?: FetchLike },
  extraEnv?: Record<string, string>,
) {
  const dir = await mkdtemp(join(tmpdir(), "bb-mcp-"));
  const config = loadConfig({
    BUBBLE_APP_URL: "https://meuapp.bubbleapps.io",
    BUBBLE_MODE: mode,
    BUBBLE_EXPORT_DIR: join(dir, "exports"),
    BUBBLE_AUDIT_LOG: join(dir, "audit.jsonl"),
    ...(token ? { BUBBLE_API_TOKEN: token } : {}),
    ...(allowlist ? { BUBBLE_WORKFLOW_ALLOWLIST: allowlist } : {}),
    ...(editor?.session ? { BUBBLE_EDITOR_SESSION: editor.session } : {}),
    ...(editor?.appId ? { BUBBLE_EDITOR_APP_ID: editor.appId } : {}),
    ...(editor?.ops ? { BUBBLE_EDITOR_OPS: editor.ops } : {}),
    ...(editor?.firebase ? { BUBBLE_EDITOR_FIREBASE_TOKEN: editor.firebase } : {}),
    ...(extraEnv ?? {}),
  });
  const fake = fakeBubble({ pedido: makeRows(250) }, token ? { token } : {});
  // O editor vive em outro host: a chamada vai para o fetch do editor, o resto para a Data API.
  const fetchImpl: FetchLike = editor?.fetch
    ? async (url, init) => (String(url).includes("/api/1.1") ? fake.fetch(url, init) : editor.fetch!(url, init))
    : fake.fetch;
  const bubble = new BubbleClient({ appUrl: config.appUrl, env: config.env, token: config.token, fetch: fetchImpl, sleep: async () => undefined });
  const { server, tools } = createBubbleMcpServer({ config, client: bubble, audit: new AuditLog(config.auditLog) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "teste", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return { mcp, tools, dir, fake };
}

function text(res: Awaited<ReturnType<Client["callTool"]>>): string {
  return (res.content as Array<{ type: string; text: string }>)[0]!.text;
}

/**
 * Editor falso: responde às operações /appeditor do editor do Bubble.
 * `onWrite` roda quando o design é gravado — é o gancho para simular que o
 * contrato de design (/meta) mudou depois da escrita.
 */
function fakeEditor(opts: { onWrite?: () => void } = {}) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? init.body : undefined });
    const path = new URL(url).pathname;
    if (path.endsWith("/_index")) return jsonRes({ last_change: "9", path_version_hash: "v9" });
    if (path.endsWith(".bubble")) return new Response('{"pages":{"AAW":{}}}', { status: 200 });
    if (path === "/appeditor/write") {
      opts.onWrite?.();
      return jsonRes({ last_change: "10" });
    }
    if (path.startsWith("/appeditor/load_multiple_paths")) {
      return jsonRes({ last_change: "9", data: [{ data: { valor: 1 } }] });
    }
    return jsonRes({ error: "not_found" }, 404);
  };
  return { fetchImpl, calls };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("servidor MCP", () => {
  it("registra só tools de leitura; só o export (grava arquivo) não é readOnlyHint", async () => {
    const { mcp } = await connect();
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "bubble_anonymous_read",
      "bubble_config",
      "bubble_data_export",
      "bubble_design_read",
      "bubble_exposure_audit",
      "bubble_query",
      "bubble_schema",
      "bubble_workflow_exposure_audit",
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint === true).toBe(t.name !== "bubble_data_export");
  });

  it("toda resposta de sucesso devolve structuredContent e texto compacto", async () => {
    const { mcp } = await connect("read-only", "segredo-super-longo-123");
    const res = await mcp.callTool({ name: "bubble_config", arguments: {} });
    expect(res.structuredContent).toBeTruthy();
    const out = text(res);
    expect(out).not.toContain("segredo-super-longo-123");
    expect(out).toContain("definido (23 caracteres)");
    // compacto: sem pretty-print de 2 espaços
    expect(out.includes('\n  "')).toBe(false);
  });

  it("bubble_query list marca o retorno como dado não confiável", async () => {
    const { mcp } = await connect();
    const res = await mcp.callTool({ name: "bubble_query", arguments: { type: "pedido", limit: 2 } });
    const out = text(res);
    expect(out.startsWith("[Dados vindos do app Bubble.")).toBe(true);
    const data = JSON.parse(out.slice(out.indexOf("\n") + 1));
    expect(data.count).toBe(2);
    expect(data.records).toHaveLength(2);
    expect(data.next_cursor).toBe(2);
  });

  it("bubble_query com projeção de campos devolve só _id e os pedidos", async () => {
    const { mcp } = await connect();
    const res = await mcp.callTool({
      name: "bubble_query",
      arguments: { type: "pedido", limit: 3, fields: ["n"], exclude_remaining: true },
    });
    const data = res.structuredContent as { records: Array<Record<string, unknown>> };
    expect(data.records).toHaveLength(3);
    for (const r of data.records) {
      expect(Object.keys(r).sort()).toEqual(["_id", "n"]);
    }
  });

  it("bubble_query count devolve o total em 1 requisição", async () => {
    const { mcp } = await connect();
    const res = await mcp.callTool({ name: "bubble_query", arguments: { type: "pedido", action: "count" } });
    const data = res.structuredContent as { count: number; capped?: boolean };
    expect(data.count).toBe(250);
    // abaixo do teto: nada é sinalizado
    expect(data.capped).toBeUndefined();
  });

  it("bubble_query count sinaliza o teto quando o total bate com BUBBLE_SEARCH_CAP", async () => {
    const { mcp } = await connect("read-only", undefined, undefined, undefined, { BUBBLE_SEARCH_CAP: "100" });
    const res = await mcp.callTool({ name: "bubble_query", arguments: { type: "pedido", action: "count" } });
    const data = res.structuredContent as { count: number; capped?: boolean; capped_at?: number; note?: string };
    expect(data.count).toBe(250);
    expect(data.capped).toBe(true);
    expect(data.capped_at).toBe(100);
    expect(data.note).toMatch(/teto de 100 itens/);
  });

  it("bubble_query get devolve o registro por id; sem id, erro claro", async () => {
    const { mcp } = await connect();
    const ok = await mcp.callTool({ name: "bubble_query", arguments: { type: "pedido", action: "get", id: "id000000", fields: ["n"] } });
    const data = ok.structuredContent as { record: Record<string, unknown> };
    expect(data.record).toEqual({ _id: "id000000", n: 0 });

    const semId = await mcp.callTool({ name: "bubble_query", arguments: { type: "pedido", action: "get" } });
    expect(semId.isError).toBe(true);
    expect(text(semId)).toMatch(/action=get exige o parâmetro id/);
  });

  it("valida argumentos: limit acima de 100 é recusado", async () => {
    const { mcp } = await connect();
    const res = await mcp.callTool({ name: "bubble_query", arguments: { type: "pedido", limit: 500 } });
    expect(res.isError).toBe(true);
  });

  it("erros da API voltam como isError com envelope estruturado, e vão para a auditoria", async () => {
    const { mcp, dir } = await connect();
    const res = await mcp.callTool({ name: "bubble_query", arguments: { type: "pedido", action: "get", id: "x" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/404.*MISSING_DATA/);
    const envd = res.structuredContent as { code: string; retryable: boolean };
    expect(envd.code).toBe("bubble_404");
    expect(envd.retryable).toBe(false);
    const audit = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({ tool: "bubble_query", target: "pedido", ok: false, env: "test" });
  });

  it("bubble_schema por fatia: list_types, get_type e get_workflow", async () => {
    const { mcp } = await connect();
    const list = await mcp.callTool({ name: "bubble_schema", arguments: { action: "list_types" } });
    const tipos = list.structuredContent as { types: Array<{ name: string }> };
    expect(tipos.types.map((t) => t.name)).toContain("pedido");

    const tipo = await mcp.callTool({ name: "bubble_schema", arguments: { action: "get_type", type: "pedido" } });
    const t = tipo.structuredContent as { fields: Array<{ name: string }> };
    expect(t.fields.length).toBeGreaterThan(0);

    const wfs = await mcp.callTool({ name: "bubble_schema", arguments: { action: "list_workflows" } });
    const wl = wfs.structuredContent as { workflows: Array<{ name: string }> };
    expect(JSON.stringify(wl.workflows)).toContain("fechar_pedido");

    const wf = await mcp.callTool({ name: "bubble_schema", arguments: { action: "get_workflow", workflow: "fechar_pedido" } });
    const w = wf.structuredContent as { name: string };
    expect(w.name).toBe("fechar_pedido");

    const inexistente = await mcp.callTool({ name: "bubble_schema", arguments: { action: "get_type", type: "zzz" } });
    expect(inexistente.isError).toBe(true);
    expect(text(inexistente)).toMatch(/Use action=list_types/);
  });

  it("bubble_workflow_create (read-write): dry-run devolve plan_id; execução cria e dispara em sequência", async () => {
    const { mcp } = await connect("read-write", "tok", "fechar_pedido");
    const dry = await mcp.callTool({
      name: "bubble_workflow_create",
      arguments: { type: "pedido", fields: { n: 1 }, workflow: "fechar_pedido", params: { motivo: "teste" } },
    });
    const plano = dry.structuredContent as { plan_id: string; summary: string };
    expect(plano.plan_id).toBeTruthy();
    expect(plano.summary).toMatch(/fechar_pedido/);

    const res = await mcp.callTool({
      name: "bubble_workflow_create",
      arguments: { type: "pedido", fields: { n: 1 }, workflow: "fechar_pedido", params: { motivo: "teste" }, dry_run: false, plan_id: plano.plan_id },
    });
    const data = res.structuredContent as { created_id: string; workflow: string; sequence: string[] };
    expect(data.created_id).toMatch(/^new/);
    expect(data.workflow).toBe("fechar_pedido");
    expect(data.sequence).toEqual(["create", "workflow"]);
  });

  it("bubble_workflow_run_many para no primeiro disparo que falha e devolve os anteriores", async () => {
    const { mcp } = await connect("read-write", "tok", "fechar_pedido");
    const dry = await mcp.callTool({
      name: "bubble_workflow_run_many",
      arguments: { name: "fechar_pedido", runs: [{ a: 1 }, { a: 2 }] },
    });
    const plano = dry.structuredContent as { plan_id: string };
    expect(plano.plan_id).toBeTruthy();
    const res = await mcp.callTool({
      name: "bubble_workflow_run_many",
      arguments: { name: "fechar_pedido", runs: [{ a: 1 }, { a: 2 }], dry_run: false, plan_id: plano.plan_id },
    });
    const data = res.structuredContent as { executed: number; results: unknown[] };
    expect(data.executed).toBe(2);
    expect(data.results).toHaveLength(2);
  });

  it("workflow fora da allowlist é recusado com envelope write_refused", async () => {
    const { mcp } = await connect("read-write", "tok", "fechar_pedido");
    const res = await mcp.callTool({
      name: "bubble_workflow_run",
      arguments: { name: "outro", params: {} },
    });
    expect(res.isError).toBe(true);
    const envd = res.structuredContent as { code: string };
    expect(envd.code).toBe("write_refused");
  });

  it("data_export grava o arquivo e devolve só metadados", async () => {
    const { mcp, dir } = await connect();
    const res = await mcp.callTool({ name: "bubble_data_export", arguments: { type: "pedido" } });
    const out = res.structuredContent as { total: number; file: string };
    expect(out.total).toBe(250);
    expect(out.file.startsWith(join(dir, "exports"))).toBe(true);
    expect((await readFile(out.file, "utf8")).trim().split("\n")).toHaveLength(250);
  });

  it("fitToCap corta arrays e marca _truncated quando passa do teto", () => {
    const big = { records: Array.from({ length: 4000 }, (_, i) => ({ _id: `id-${i}`, x: "y".repeat(30) })) };
    const { value, truncated } = fitToCap(big);
    expect(truncated).toBe(true);
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(value._truncated).toBeTruthy();
    const pequeno = { olá: "mundo" };
    expect(fitToCap(pequeno)).toEqual({ value: pequeno, truncated: false });
  });

  it("InflightLimiter respeita o teto de execuções em voo", async () => {
    const limiter = new InflightLimiter(2);
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe("tools de design e de exposição de workflows", () => {
  it("bubble_design_read devolve o contrato de design lido do /meta", async () => {
    const { mcp } = await connect();
    const res = await mcp.callTool({ name: "bubble_design_read", arguments: { action: "list_types" } });
    const data = res.structuredContent as { types: Array<{ name: string }>; total: number };
    expect(data.total).toBe(1);
    expect(data.types[0]!.name).toBe("pedido");

    const wf = await mcp.callTool({ name: "bubble_design_read", arguments: { action: "list_workflows" } });
    const wfd = wf.structuredContent as { publicos: number; workflows: Array<{ name: string; public: boolean }> };
    expect(wfd.publicos).toBe(1);
    expect(wfd.workflows.find((w) => w.name === "admin")!.public).toBe(true);
  });

  it("bubble_workflow_exposure_audit em modo declared não gera tráfego de escrita", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-wf-"));
    const config = loadConfig({
      BUBBLE_APP_URL: "https://meuapp.bubbleapps.io",
      BUBBLE_MODE: "read-only",
      BUBBLE_API_TOKEN: "t",
      BUBBLE_EXPORT_DIR: join(dir, "exports"),
    });
    const fake = fakeBubble({ pedido: makeRows(2) }, { token: "t", publicWorkflows: ["admin"] });
    const bubble = new BubbleClient({ appUrl: config.appUrl, env: config.env, token: config.token, fetch: fake.fetch });
    const { server } = createBubbleMcpServer({ config, client: bubble, audit: new AuditLog(config.auditLog) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "teste", version: "0" });
    await Promise.all([server.connect(a), mcp.connect(b)]);

    const res = await mcp.callTool({ name: "bubble_workflow_exposure_audit", arguments: { mode: "declared" } });
    const data = res.structuredContent as { publicos: number };
    expect(data.publicos).toBe(1);
    expect(fake.writes).toHaveLength(0);

    const active = await mcp.callTool({ name: "bubble_workflow_exposure_audit", arguments: { mode: "active" } });
    const ad = active.structuredContent as { total_expostos: number };
    expect(ad.total_expostos).toBe(1);
  });

  it("publicar o branch dev é recusado sem BUBBLE_ALLOW_LIVE_WRITES, mesmo em dry-run", async () => {
    const { mcp } = await connect("admin", undefined, undefined, {
      session: "meta_test_u2main=abc",
      appId: "app-123",
      ops: '{"write_design":{"method":"POST","path":"/wf/save"},"publish":{"method":"POST","path":"/wf/publish_branch"}}',
    });
    const res = await mcp.callTool({ name: "bubble_editor_write", arguments: { op: "publish" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/publish/i);
    expect(text(res)).toMatch(/BUBBLE_ALLOW_LIVE_WRITES=true/);
  });

  it("as tools de editor só existem com sessão de conta, e a escrita só no modo admin", async () => {
    const semSessao = await connect("admin");
    expect(semSessao.tools).not.toContain("bubble_editor_read");

    const comSessao = await connect("read-only", undefined, undefined, {
      session: "meta_test_u2main=abc",
      appId: "app-123",
      ops: '{"read_design":{"method":"GET","path":"/wf/load"}}',
    });
    expect(comSessao.tools).toContain("bubble_editor_discover");
    expect(comSessao.tools).toContain("bubble_editor_read");
    expect(comSessao.tools).not.toContain("bubble_editor_write");

    const admin = await connect("admin", undefined, undefined, {
      session: "meta_test_u2main=abc",
      appId: "app-123",
      ops: '{"read_design":{"method":"GET","path":"/wf/load"}}',
    });
    expect(admin.tools).toContain("bubble_editor_write");
  });

  it("bubble_editor_export grava o .bubble no disco e devolve caminho, bytes e sha256", async () => {
    const editor = fakeEditor();
    const { mcp, dir } = await connect("read-only", undefined, undefined, {
      session: "meta_test_u2main=abc",
      appId: "comprover",
      fetch: editor.fetchImpl,
    });
    const res = await mcp.callTool({ name: "bubble_editor_export", arguments: { head: 12 } });
    const out = res.structuredContent as { file: string; bytes: number; sha256: string; head: string; app: string; branch: string };
    expect(out.app).toBe("comprover");
    expect(out.branch).toBe("version-test");
    expect(out.file.startsWith(join(dir, "exports", "design"))).toBe(true);
    expect(out.file.endsWith(".bubble")).toBe(true);
    // o arquivo existe de fato, com o conteúdo que o editor devolveu
    const conteudo = await readFile(out.file, "utf8");
    expect(conteudo).toBe('{"pages":{"AAW":{}}}');
    expect(out.bytes).toBe(Buffer.byteLength(conteudo, "utf8"));
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.head).toBe('{"pages":{"A');
  });

  it("bubble_editor_write com verify=schema devolve o diff do contrato de design", async () => {
    // O /meta é do host da Data API; o editor falso só responde /appeditor/*.
    // O gancho da escrita acrescenta um tipo novo no /meta — é o que o diff vê.
    const holder: { fake?: ReturnType<typeof fakeBubble> } = {};
    const editor = fakeEditor({
      onWrite: () => {
        holder.fake!.data.novo_tipo = [];
      },
    });
    const { mcp, fake } = await connect("admin", undefined, undefined, {
      session: "meta_test_u2main=abc",
      appId: "app-123",
      fetch: editor.fetchImpl,
    });
    holder.fake = fake;

    const args = { path: "pages.AAW.properties.x", value: { name: "novo" }, verify: "schema" };
    const dry = await mcp.callTool({ name: "bubble_editor_write", arguments: args });
    const plano = dry.structuredContent as { plan_id: string };
    expect(plano.plan_id).toBeTruthy();

    const res = await mcp.callTool({
      name: "bubble_editor_write",
      arguments: { ...args, dry_run: false, plan_id: plano.plan_id },
    });
    const data = res.structuredContent as {
      aplicado: boolean;
      verificado: boolean;
      schema_diff: { mudou: boolean; tipos_adicionados: string[]; tipos_removidos: string[] };
      nota: string;
    };
    expect(data.aplicado).toBe(true);
    expect(data.schema_diff.mudou).toBe(true);
    expect(data.schema_diff.tipos_adicionados).toEqual(["novo_tipo"]);
    expect(data.schema_diff.tipos_removidos).toEqual([]);
    expect(data.verificado).toBe(true);
    expect(data.nota).toMatch(/contrato de design mudou/);
  });

  it("bubble_editor_write com verify=schema avisa quando o /meta não reflete o branch de desenvolvimento", async () => {
    // Sem o gancho de escrita, o /meta não muda: o diff fica vazio e a nota
    // explica que o /meta só reflete o branch publicado.
    const editor = fakeEditor();
    const { mcp } = await connect("admin", undefined, undefined, {
      session: "meta_test_u2main=abc",
      appId: "app-123",
      fetch: editor.fetchImpl,
    });
    const args = { path: "pages.AAW.properties.x", value: { name: "novo" }, verify: "schema" };
    const dry = await mcp.callTool({ name: "bubble_editor_write", arguments: args });
    const plano = dry.structuredContent as { plan_id: string };
    const res = await mcp.callTool({
      name: "bubble_editor_write",
      arguments: { ...args, dry_run: false, plan_id: plano.plan_id },
    });
    const data = res.structuredContent as { verificado: boolean; schema_diff: { mudou: boolean }; nota: string };
    expect(data.schema_diff.mudou).toBe(false);
    expect(data.verificado).toBe(false);
    expect(data.nota).toMatch(/branch publicado/);
  });
});
