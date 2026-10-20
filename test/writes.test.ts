import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AuditLog } from "../src/core/audit.js";
import { BubbleClient, parseBulkResponse } from "../src/core/client.js";
import { canonicalJson, resetPlans } from "../src/core/writes.js";
import { createBubbleMcpServer } from "../src/mcp/server.js";
import { fakeBubble, makeRows } from "./fake-bubble.js";

async function setup(env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bb-w-"));
  const config = loadConfig({
    BUBBLE_APP_URL: "https://meuapp.bubbleapps.io",
    BUBBLE_MODE: "read-write",
    BUBBLE_EXPORT_DIR: join(dir, "exports"),
    BUBBLE_AUDIT_LOG: join(dir, "audit.jsonl"),
    ...env,
  });
  const fake = fakeBubble({ pedido: makeRows(3) });
  const bubble = new BubbleClient({ appUrl: config.appUrl, env: config.env, fetch: fake.fetch, sleep: async () => undefined });
  const { server, tools } = createBubbleMcpServer({ config, client: bubble, audit: new AuditLog(config.auditLog) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await mcp.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: !!res.isError, text, json };
  };
  return { call, fake, tools, dir };
}

describe("modos", () => {
  it("read-only não registra escrita; read-write registra sem delete; admin registra delete", async () => {
    expect((await setup({ BUBBLE_MODE: "read-only" })).tools).not.toContain("bubble_data_create");
    const rw = (await setup()).tools;
    expect(rw).toEqual(expect.arrayContaining(["bubble_data_create", "bubble_data_bulk_create", "bubble_data_update", "bubble_workflow_run"]));
    expect(rw).not.toContain("bubble_data_delete");
    expect((await setup({ BUBBLE_MODE: "admin" })).tools).toContain("bubble_data_delete");
  });
});

describe("fluxo dry-run → plan_id → execução", () => {
  beforeEach(() => resetPlans());

  it("dry-run é o padrão e não toca o banco", async () => {
    const { call, fake } = await setup();
    const r = await call("bubble_data_create", { type: "pedido", fields: { total: 10 } });
    expect(r.isError).toBe(false);
    expect(r.json.plan_id).toMatch(/^[0-9a-f]{16}$/);
    expect(r.json.method).toBe("POST");
    expect(fake.writes).toHaveLength(0);
  });

  it("executar sem plan_id ou com payload alterado é recusado", async () => {
    const { call, fake } = await setup();
    const plan = (await call("bubble_data_create", { type: "pedido", fields: { total: 10 } })).json;
    const semId = await call("bubble_data_create", { type: "pedido", fields: { total: 10 }, dry_run: false });
    expect(semId.isError).toBe(true);
    expect(semId.text).toMatch(/sem plan_id/);
    const outro = await call("bubble_data_create", { type: "pedido", fields: { total: 9999 }, dry_run: false, plan_id: plan.plan_id });
    expect(outro.isError).toBe(true);
    expect(outro.text).toMatch(/payload mudou/);
    expect(fake.writes).toHaveLength(0);
  });

  it("com o plan_id certo executa uma vez e audita sem o payload", async () => {
    const { call, fake, dir } = await setup();
    const args = { type: "pedido", fields: { total: 10, cliente: "x" } };
    const plan = (await call("bubble_data_create", args)).json;
    // ordem diferente dos campos gera o mesmo plano
    const r = await call("bubble_data_create", { type: "pedido", fields: { cliente: "x", total: 10 }, dry_run: false, plan_id: plan.plan_id });
    expect(r.isError).toBe(false);
    expect(r.json.created_id).toMatch(/^new/);
    expect(fake.writes).toHaveLength(1);
    const audit = await readFile(join(dir, "audit.jsonl"), "utf8");
    expect(audit).toContain(plan.plan_id);
    expect(audit).not.toContain("cliente");
  });
});

describe("guardas", () => {
  it("live bloqueado sem BUBBLE_ALLOW_LIVE_WRITES, mesmo em dry-run", async () => {
    const { call } = await setup({ BUBBLE_ENV: "live" });
    const r = await call("bubble_data_create", { type: "pedido", fields: {} });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/live bloqueada/);
    const ok = await (await setup({ BUBBLE_ENV: "live", BUBBLE_ALLOW_LIVE_WRITES: "true" })).call("bubble_data_create", { type: "pedido", fields: {} });
    expect(ok.isError).toBe(false);
  });

  it("workflow fora da allowlist é recusado; dentro executa com plano", async () => {
    const vazio = await setup();
    expect((await vazio.call("bubble_workflow_run", { name: "fechar_pedido" })).text).toMatch(/fora da allowlist.*nenhum/);
    const { call, fake } = await setup({ BUBBLE_WORKFLOW_ALLOWLIST: "fechar_pedido, outro" });
    const args = { name: "fechar_pedido", params: { pedido: "id1" } };
    const plan = (await call("bubble_workflow_run", args)).json;
    expect(plan.endpoint).toBe("https://meuapp.bubbleapps.io/version-test/api/1.1/wf/fechar_pedido");
    const r = await call("bubble_workflow_run", { ...args, dry_run: false, plan_id: plan.plan_id });
    expect(r.json.response.response.echo).toEqual({ pedido: "id1" });
    expect(fake.writes.map((w) => w.path)).toEqual(["/api/1.1/wf/fechar_pedido"]);
  });
});

describe("operações", () => {
  it("update usa PATCH e preserva campos não enviados", async () => {
    const { call, fake } = await setup();
    const args = { type: "pedido", id: "id000001", fields: { status: "fechado" } };
    const plan = (await call("bubble_data_update", args)).json;
    expect(plan.method).toBe("PATCH");
    await call("bubble_data_update", { ...args, dry_run: false, plan_id: plan.plan_id });
    expect(fake.writes[0]!.method).toBe("PATCH");
    const row = fake.data.pedido!.find((r) => r._id === "id000001")!;
    expect(row).toMatchObject({ status: "fechado", n: 1 });
  });

  it("bulk divide em lotes e separa sucessos de falhas por item", async () => {
    const { call, fake } = await setup();
    const items = Array.from({ length: 25 }, (_, i) => (i === 7 ? { invalid: true } : { n: i }));
    const args = { type: "pedido", items, chunk_size: 10 };
    const plan = (await call("bubble_data_bulk_create", args)).json;
    expect(plan.summary).toMatch(/25 registros.*3 lote/);
    expect(plan.payload_preview.total_items).toBe(25);
    const r = await call("bubble_data_bulk_create", { ...args, dry_run: false, plan_id: plan.plan_id });
    expect(r.json).toMatchObject({ created: 24, failed: 1, errors: [{ index: 7, message: "Permission denied" }] });
    expect(fake.writes).toHaveLength(3);
  });

  it("delete salva snapshot antes de apagar (modo admin)", async () => {
    const { call, fake } = await setup({ BUBBLE_MODE: "admin" });
    const args = { type: "pedido", id: "id000002" };
    const plan = (await call("bubble_data_delete", args)).json;
    const r = await call("bubble_data_delete", { ...args, dry_run: false, plan_id: plan.plan_id });
    expect(r.isError).toBe(false);
    const snap = JSON.parse(await readFile(r.json.snapshot, "utf8"));
    expect(snap.record._id).toBe("id000002");
    expect(fake.data.pedido!.some((x) => x._id === "id000002")).toBe(false);
  });

  it("delete de id inexistente falha no snapshot e não apaga nada", async () => {
    const { call, fake } = await setup({ BUBBLE_MODE: "admin" });
    const args = { type: "pedido", id: "nao-existe" };
    const plan = (await call("bubble_data_delete", args)).json;
    const r = await call("bubble_data_delete", { ...args, dry_run: false, plan_id: plan.plan_id });
    expect(r.isError).toBe(true);
    expect(fake.writes).toHaveLength(0);
  });
});

describe("parseBulkResponse e canonicalJson", () => {
  it("linhas a menos que itens = resultado incerto", () => {
    expect(() => parseBulkResponse('{"status":"success","id":"a"}', 2)).toThrow(/incerto/);
    expect(parseBulkResponse('{"status":"success","id":"a"}\nlixo', 2)[1]).toMatchObject({ status: "error" });
  });
  it("ordena chaves em qualquer profundidade", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: 0 } })).toBe('{"a":{"c":0,"d":[{"x":2,"y":1}]},"b":1}');
  });
});
