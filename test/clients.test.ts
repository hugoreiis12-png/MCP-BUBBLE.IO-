import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AuditLog } from "../src/core/audit.js";
import { BubbleClient } from "../src/core/client.js";
import { ClientRegistry, addClient, effectiveMode, listClients, revokeClient, staticTokenAuth } from "../src/core/clients.js";
import { serveHttp, type HttpServerHandle } from "../src/mcp/http.js";
import { createBubbleMcpServer, createSharedState } from "../src/mcp/server.js";
import { fakeBubble, makeRows } from "./fake-bubble.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bb-clients-"));
  file = join(dir, "clients.json");
});

describe("registro de clients", () => {
  it("add devolve token que autentica; arquivo guarda só o hash", async () => {
    const token = addClient(file, "hugo", "read-write");
    expect(new ClientRegistry(file).authenticate(token)).toEqual({ name: "hugo", mode: "read-write" });
    expect(await readFile(file, "utf8")).not.toContain(token);
    expect(JSON.stringify(listClients(file))).not.toContain("token_sha256");
  });

  it("token desconhecido, nome duplicado e revogação", () => {
    const token = addClient(file, "a", "read-only");
    const registry = new ClientRegistry(file);
    expect(registry.authenticate("outro-token")).toBeNull();
    expect(() => addClient(file, "a", "admin")).toThrow(/já existe/);
    revokeClient(file, "a");
    expect(registry.authenticate(token)).toBeNull();
    expect(registry.activeCount()).toBe(0);
  });

  it("relê o arquivo quando muda em disco e falha fechado se corromper", async () => {
    const registry = new ClientRegistry(file);
    expect(registry.activeCount()).toBe(0);
    const token = addClient(file, "b", "read-only");
    expect(registry.authenticate(token)?.name).toBe("b");
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(file, "{quebrado");
    expect(() => registry.authenticate(token)).toThrow();
  });

  it("arquivo corrompido diz o que houve, não um SyntaxError cru", async () => {
    await writeFile(file, "{quebrado");
    expect(() => new ClientRegistry(file).activeCount()).toThrow(/ilegível/);
    await writeFile(file, JSON.stringify({ clients: [{ name: "x" }] }));
    expect(() => new ClientRegistry(file).activeCount()).toThrow(/inválido/);
  });

  it("modo efetivo nunca passa do servidor", () => {
    expect(effectiveMode("admin", "read-write")).toBe("read-write");
    expect(effectiveMode("read-only", "admin")).toBe("read-only");
  });

  it("staticTokenAuth vira o client default", () => {
    const auth = staticTokenAuth("token-unico-0123456789", "read-only");
    expect(auth("token-unico-0123456789")).toEqual({ name: "default", mode: "read-only" });
    expect(auth("token-unico-012345678")).toBeNull();
  });
});

describe("HTTP com token por client", () => {
  const fake = fakeBubble({ pedido: makeRows(2) });
  const handles: HttpServerHandle[] = [];
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.close()));
  });

  async function start(serverMode: string, extra: { trustProxy?: boolean; allowedOrigins?: string[]; ratePerMin?: number } = {}) {
    const config = loadConfig({ BUBBLE_APP_URL: "https://meuapp.bubbleapps.io", BUBBLE_MODE: serverMode, BUBBLE_AUDIT_LOG: join(dir, "audit.jsonl") });
    const client = new BubbleClient({ appUrl: config.appUrl, env: config.env, fetch: fake.fetch });
    const shared = createSharedState();
    const audit = new AuditLog(config.auditLog);
    const registry = new ClientRegistry(file);
    const h = await serveHttp({
      host: "127.0.0.1",
      port: 0,
      authenticate: registry.authenticate,
      factory: (identity) => createBubbleMcpServer({ config, client, audit, shared, identity }),
      ratePerMin: 0,
      ...extra,
    });
    handles.push(h);
    return h.url;
  }

  const rpc = (url: string, token: string, method: string, params: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

  async function toolNames(url: string, token: string): Promise<string[]> {
    const body = (await (await rpc(url, token, "tools/list")).json()) as { result: { tools: Array<{ name: string }> } };
    return body.result.tools.map((t) => t.name);
  }

  it("cada client vê as tools do próprio modo, com teto no servidor, e sem export remoto", async () => {
    const leitor = addClient(file, "leitor", "read-only");
    const chefe = addClient(file, "chefe", "admin");
    const url = await start("read-write");
    const deLeitor = await toolNames(url, leitor);
    expect(deLeitor).not.toContain("bubble_data_create");
    expect(deLeitor).not.toContain("bubble_data_export");
    const deChefe = await toolNames(url, chefe);
    expect(deChefe).toContain("bubble_data_create");
    expect(deChefe).not.toContain("bubble_data_delete");
  });

  it("revogado responde 401 sem reiniciar", async () => {
    const token = addClient(file, "temp", "read-only");
    const url = await start("read-only");
    expect((await rpc(url, token, "tools/list")).status).toBe(200);
    revokeClient(file, "temp");
    expect((await rpc(url, token, "tools/list")).status).toBe(401);
  });

  it("plan_id emitido para um client não é executável por outro", async () => {
    const a = addClient(file, "a", "read-write");
    const b = addClient(file, "b", "read-write");
    const url = await start("read-write");
    const dry = await rpc(url, a, "tools/call", {
      name: "bubble_data_create",
      arguments: { type: "pedido", fields: { n: 1 } },
    });
    const dryBody = (await dry.json()) as { result: { structuredContent: { plan_id: string } } };
    const planId = dryBody.result.structuredContent.plan_id;
    expect(planId).toBeTruthy();

    const exec = await rpc(url, b, "tools/call", {
      name: "bubble_data_create",
      arguments: { type: "pedido", fields: { n: 1 }, dry_run: false, plan_id: planId },
    });
    const execBody = (await exec.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(execBody.result.isError).toBe(true);
    expect(execBody.result.content[0]!.text).toMatch(/outro client/);
  });

  it("auditoria registra o nome do client e nunca o token", async () => {
    const token = addClient(file, "auditado", "read-only");
    const url = await start("read-only");
    await rpc(url, token, "tools/call", { name: "bubble_config", arguments: {} });
    const log = await readFile(join(dir, "audit.jsonl"), "utf8");
    expect(JSON.parse(log.trim().split("\n").at(-1)!)).toMatchObject({ tool: "bubble_config", client: "auditado", ok: true });
    expect(log).not.toContain(token);
  });

  it("Origin fora da lista é 403; sem Origin ou na lista passa", async () => {
    const token = addClient(file, "web", "read-only");
    const url = await start("read-only", { allowedOrigins: ["http://portal.interno"] });
    expect((await rpc(url, token, "tools/list", {}, { origin: "http://evil.example" })).status).toBe(403);
    expect((await rpc(url, token, "tools/list", {}, { origin: "http://portal.interno" })).status).toBe(200);
    expect((await rpc(url, token, "tools/list")).status).toBe(200);
  });

  it("X-Forwarded-For só separa a cota com trustProxy", async () => {
    const hit = (url: string, ip: string) => rpc(url, "errado", "tools/list", {}, { "x-forwarded-for": ip });
    const semProxy = await start("read-only", { ratePerMin: 1 });
    await hit(semProxy, "10.0.0.1");
    expect((await hit(semProxy, "10.0.0.2")).status).toBe(429);
    const comProxy = await start("read-only", { ratePerMin: 1, trustProxy: true });
    await hit(comProxy, "10.0.0.1");
    expect((await hit(comProxy, "10.0.0.2")).status).toBe(401);
  });
});
