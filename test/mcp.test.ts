import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { loadConfig, type Mode } from "../src/config.js";
import { AuditLog } from "../src/core/audit.js";
import { BubbleClient } from "../src/core/client.js";
import { createBubbleMcpServer } from "../src/mcp/server.js";
import { fakeBubble, makeRows } from "./fake-bubble.js";

async function connect(mode: Mode = "read-only", token?: string) {
  const dir = await mkdtemp(join(tmpdir(), "bb-mcp-"));
  const config = loadConfig({
    BUBBLE_APP_URL: "https://meuapp.bubbleapps.io",
    BUBBLE_MODE: mode,
    BUBBLE_EXPORT_DIR: join(dir, "exports"),
    BUBBLE_AUDIT_LOG: join(dir, "audit.jsonl"),
    ...(token ? { BUBBLE_API_TOKEN: token } : {}),
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
      "bubble_data_get",
      "bubble_data_query",
      "bubble_exposure_audit",
      "bubble_schema_discover",
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint === true).toBe(t.name !== "bubble_data_export");
  });

  it("bubble_config nunca devolve o token", async () => {
    const { mcp } = await connect("read-only", "segredo-super-longo-123");
    const out = text(await mcp.callTool({ name: "bubble_config", arguments: {} }));
    expect(out).not.toContain("segredo-super-longo-123");
    expect(out).toContain("definido (23 caracteres)");
  });

  it("bubble_data_query marca o retorno como dado não confiável", async () => {
    const { mcp } = await connect();
    const res = await mcp.callTool({ name: "bubble_data_query", arguments: { type: "pedido", limit: 2 } });
    const out = text(res);
    expect(out.startsWith("[Dados vindos do app Bubble.")).toBe(true);
    expect(JSON.parse(out.slice(out.indexOf("\n") + 1)).count).toBe(2);
  });

  it("valida argumentos: limit acima de 100 é recusado", async () => {
    const { mcp } = await connect();
    const res = await mcp.callTool({ name: "bubble_data_query", arguments: { type: "pedido", limit: 500 } });
    expect(res.isError).toBe(true);
  });

  it("erros da API voltam como isError com dica, e vão para a auditoria", async () => {
    const { mcp, dir } = await connect();
    const res = await mcp.callTool({ name: "bubble_data_get", arguments: { type: "pedido", id: "x" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/404.*MISSING_DATA/);
    const audit = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({ tool: "bubble_data_get", target: "pedido", ok: false, env: "test" });
  });

  it("schema_discover devolve tipos e workflows normalizados", async () => {
    const { mcp } = await connect();
    const out = text(await mcp.callTool({ name: "bubble_schema_discover", arguments: {} }));
    const data = JSON.parse(out.slice(out.indexOf("\n") + 1));
    expect(data.schema.types.map((t: { name: string }) => t.name)).toContain("pedido");
    expect(data.schema.workflows[0].name).toBe("fechar_pedido");
  });

  it("data_export grava o arquivo e devolve só metadados", async () => {
    const { mcp, dir } = await connect();
    const out = JSON.parse(text(await mcp.callTool({ name: "bubble_data_export", arguments: { type: "pedido" } })));
    expect(out.total).toBe(250);
    expect(out.file.startsWith(join(dir, "exports"))).toBe(true);
    expect((await readFile(out.file, "utf8")).trim().split("\n")).toHaveLength(250);
  });
});
