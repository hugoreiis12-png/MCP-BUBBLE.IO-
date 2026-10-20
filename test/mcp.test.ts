import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { loadConfig, type Mode } from "../src/config.js";
import { AuditLog } from "../src/core/audit.js";
import { BubbleClient } from "../src/core/client.js";
import { createBubbleMcpServer, fitToCap, InflightLimiter, MAX_OUTPUT_CHARS } from "../src/mcp/server.js";
import { fakeBubble, makeRows } from "./fake-bubble.js";

async function connect(mode: Mode = "read-only", token?: string, allowlist?: string) {
  const dir = await mkdtemp(join(tmpdir(), "bb-mcp-"));
  const config = loadConfig({
    BUBBLE_APP_URL: "https://meuapp.bubbleapps.io",
    BUBBLE_MODE: mode,
    BUBBLE_EXPORT_DIR: join(dir, "exports"),
    BUBBLE_AUDIT_LOG: join(dir, "audit.jsonl"),
    ...(token ? { BUBBLE_API_TOKEN: token } : {}),
    ...(allowlist ? { BUBBLE_WORKFLOW_ALLOWLIST: allowlist } : {}),
  });
  const fake = fakeBubble({ pedido: makeRows(250) }, token ? { token } : {});
  const bubble = new BubbleClient({ appUrl: config.appUrl, env: config.env, token: config.token, fetch: fake.fetch, sleep: async () => undefined });
  const { server, tools } = createBubbleMcpServer({ config, client: bubble, audit: new AuditLog(config.auditLog) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "teste", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return { mcp, tools, dir };
}

function text(res: Awaited<ReturnType<Client["callTool"]>>): string {
  return (res.content as Array<{ type: string; text: string }>)[0]!.text;
}

describe("servidor MCP", () => {
  it("registra só tools de leitura; só o export (grava arquivo) não é readOnlyHint", async () => {
    const { mcp } = await connect();
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "bubble_anonymous_read",
      "bubble_config",
      "bubble_data_export",
      "bubble_exposure_audit",
      "bubble_query",
      "bubble_schema",
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
    const data = res.structuredContent as { count: number };
    expect(data.count).toBe(250);
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
