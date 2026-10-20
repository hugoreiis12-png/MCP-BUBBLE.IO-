import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPlans } from "../src/core/writes.js";
import { loadConfig } from "../src/config.js";
import { AuditLog } from "../src/core/audit.js";
import { BubbleClient } from "../src/core/client.js";
import type { FetchLike } from "../src/core/http.js";
import { createBubbleMcpServer } from "../src/mcp/server.js";
import { fakeBubble, makeRows } from "./fake-bubble.js";

async function setup(env: Record<string, string> = {}, failPosts = false) {
  const dir = await mkdtemp(join(tmpdir(), "bb-we-"));
  const config = loadConfig({
    BUBBLE_APP_URL: "https://meuapp.bubbleapps.io",
    BUBBLE_MODE: "read-write",
    BUBBLE_EXPORT_DIR: join(dir, "exports"),
    BUBBLE_AUDIT_LOG: join(dir, "audit.jsonl"),
    ...env,
  });
  const fake = fakeBubble({ pedido: makeRows(3) });
  let postAttempts = 0;
  const fetch: FetchLike = async (url, init) => {
    if (failPosts && init?.method === "POST") {
      postAttempts++;
      throw new Error("timeout");
    }
    return fake.fetch(url, init);
  };
  const bubble = new BubbleClient({ appUrl: config.appUrl, env: config.env, fetch, sleep: async () => undefined });
  const { server } = createBubbleMcpServer({ config, client: bubble, audit: new AuditLog(config.auditLog) });
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
  return { call, fake, posts: () => postAttempts };
}

describe("escrita: casos de borda (caracterização)", () => {
  beforeEach(() => resetPlans());
  afterEach(() => vi.useRealTimers());

  it("execução sem dry-run prévio é recusada", async () => {
    const { call, fake } = await setup();
    const { planId } = await import("../src/core/writes.js");
    const { BubbleClient } = await import("../src/core/client.js");
    const c = new BubbleClient({ appUrl: "https://meuapp.bubbleapps.io", env: "test", fetch: fake.fetch });
    const args = { type: "pedido", fields: { total: 10 } };
    const r = await call("bubble_data_create", { ...args, dry_run: false, plan_id: planId("bubble_data_create", c, args) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/sem dry-run prévio/);
    expect(fake.writes).toHaveLength(0);
  });

  it("plan_id expira após 15 min", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { call, fake } = await setup();
    const args = { type: "pedido", fields: { total: 10 } };
    const plan = (await call("bubble_data_create", args)).json;
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1);
    const r = await call("bubble_data_create", { ...args, dry_run: false, plan_id: plan.plan_id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/expirado/);
    expect(fake.writes).toHaveLength(0);
  });

  it("segunda execução com o mesmo plan_id é recusada e só 1 write ocorre", async () => {
    const { call, fake } = await setup();
    const args = { type: "pedido", fields: { total: 10 } };
    const plan = (await call("bubble_data_create", args)).json;
    const exec = { ...args, dry_run: false, plan_id: plan.plan_id };
    const r1 = await call("bubble_data_create", exec);
    const r2 = await call("bubble_data_create", exec);
    expect(r1.isError).toBe(false);
    expect(r2.isError).toBe(true);
    expect(r2.text).toMatch(/já executado/);
    expect(fake.writes).toHaveLength(1);
  });

  it("plan_id de argumentos diferentes é recusado", async () => {
    const { call, fake } = await setup();
    const plan = (await call("bubble_data_create", { type: "pedido", fields: { total: 1 } })).json;
    const r = await call("bubble_data_create", { type: "pedido", fields: { total: 2 }, dry_run: false, plan_id: plan.plan_id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/payload mudou/);
    expect(fake.writes).toHaveLength(0);
  });

  it("live sem BUBBLE_ALLOW_LIVE_WRITES recusa até em dry-run", async () => {
    const { call, fake } = await setup({ BUBBLE_ENV: "live" });
    const r = await call("bubble_data_create", { type: "pedido", fields: {}, dry_run: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/live bloqueada/);
    expect(fake.writes).toHaveLength(0);
  });

  it("workflow fora da allowlist é recusado", async () => {
    const { call, fake } = await setup({ BUBBLE_WORKFLOW_ALLOWLIST: "permitido" });
    const r = await call("bubble_workflow_run", { name: "proibido" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/fora da allowlist/);
    expect(fake.writes).toHaveLength(0);
  });

  it("falha de rede em POST não é repetida; mensagem atual é 'falha de rede'", async () => {
    const { call, posts } = await setup({}, true);
    const args = { type: "pedido", fields: { total: 10 } };
    const plan = (await call("bubble_data_create", args)).json;
    const r = await call("bubble_data_create", { ...args, dry_run: false, plan_id: plan.plan_id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/falha de rede/);
    expect(posts()).toBe(1);
  });

  // Desejado: avisar que o resultado é incerto (o POST pode ter sido aplicado).
  it("falha de rede em POST avisa que o resultado é incerto", async () => {
    const { call } = await setup({}, true);
    const args = { type: "pedido", fields: { total: 10 } };
    const plan = (await call("bubble_data_create", args)).json;
    const r = await call("bubble_data_create", { ...args, dry_run: false, plan_id: plan.plan_id });
    expect(r.text).toMatch(/incerto/);
    expect(r.text).toMatch(/novo dry-run/);
    const again = await call("bubble_data_create", { ...args, dry_run: false, plan_id: plan.plan_id });
    expect(again.text).toMatch(/já executado/);
  });

  it("delete grava snapshot antes de apagar", async () => {
    const { call, fake } = await setup({ BUBBLE_MODE: "admin" });
    const args = { type: "pedido", id: "id000001" };
    const plan = (await call("bubble_data_delete", args)).json;
    const r = await call("bubble_data_delete", { ...args, dry_run: false, plan_id: plan.plan_id });
    expect(r.isError).toBe(false);
    const snap = JSON.parse(await readFile(r.json.snapshot, "utf8"));
    expect(snap.record._id).toBe("id000001");
    expect(fake.writes.map((w) => w.method)).toEqual(["DELETE"]);
    expect(fake.data.pedido!.some((x) => x._id === "id000001")).toBe(false);
  });
});
