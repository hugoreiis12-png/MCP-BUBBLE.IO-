import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { serveHttp, type HttpServeOptions, type HttpServerHandle } from "../src/mcp/http.js";
import { createBubbleMcpServer } from "../src/mcp/server.js";
import { loadConfig } from "../src/config.js";
import { BubbleClient } from "../src/core/client.js";
import { fakeBubble, makeRows } from "./fake-bubble.js";

const TOKEN = "bearer-de-teste-0123456789abcdef";
const fake = fakeBubble({ pedido: makeRows(2) });

function factory() {
  const config = loadConfig({ BUBBLE_APP_URL: "https://meuapp.bubbleapps.io", BUBBLE_MODE: "read-only" });
  const client = new BubbleClient({ appUrl: config.appUrl, env: config.env, fetch: fake.fetch });
  return createBubbleMcpServer({ config, client });
}

const handles: HttpServerHandle[] = [];
async function start(extra: Partial<HttpServeOptions> = {}) {
  const h = await serveHttp({ host: "127.0.0.1", port: 0, token: TOKEN, factory, ratePerMin: 0, ...extra });
  handles.push(h);
  return h.url;
}
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
});

const post = (url: string, token: string | null, body: string) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

describe("serveHttp: bordas", () => {
  it("401 para bearer ausente, errado, de tamanho diferente e esquema errado", async () => {
    const url = await start();
    expect((await post(url, null, LIST)).status).toBe(401);
    expect((await post(url, "x".repeat(TOKEN.length), LIST)).status).toBe(401);
    expect((await post(url, "curto", LIST)).status).toBe(401);
    expect((await post(url, TOKEN + "extra", LIST)).status).toBe(401);
    const basic = await fetch(url, { method: "POST", headers: { authorization: `Basic ${TOKEN}` }, body: LIST });
    expect(basic.status).toBe(401);
    expect((await post(url, null, LIST)).headers.get("www-authenticate")).toContain("Bearer");
  });

  it("404 em rota desconhecida (mesmo com auth) e /healthz sem auth é 200", async () => {
    const url = await start();
    expect((await fetch(url.replace("/mcp", "/nada"))).status).toBe(404);
    expect((await fetch(url.replace("/mcp", "/mcp2"))).status).toBe(404);
    expect((await fetch(url.replace("/mcp", "/healthz?x=1"))).status).toBe(200);
  });

  it("413 quando o corpo passa de maxBodyBytes", async () => {
    const url = await start({ maxBodyBytes: 64 });
    const res = await post(url, TOKEN, JSON.stringify({ pad: "a".repeat(500) }));
    expect(res.status).toBe(413);
  });

  it("400 para JSON inválido", async () => {
    const url = await start();
    const res = await post(url, TOKEN, "{nao e json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("POST com corpo vazio responde 400", async () => {
    const url = await start();
    const res = await post(url, TOKEN, "");
    expect(res.status).toBe(400);
  }, 5000);

  it("429 depois de N requisições autenticadas", async () => {
    const url = await start({ ratePerMin: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await post(url, TOKEN, LIST)).status);
    expect(codes.slice(0, 3)).not.toContain(429);
    expect(codes.slice(3)).toEqual([429, 429]);
  });

  // rateOk() roda antes de authorized(): 401 consome cota e o brute-force do token toma 429.
  it("401 também deve contar no rate limit", async () => {
    const url = await start({ ratePerMin: 2 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await post(url, "errado", LIST)).status);
    expect(codes).toContain(429);
  });

  // Hipótese (b) não testável via rede: hits.clear() em >5000 chaves exige 5000 IPs de origem
  // distintos e o loopback só entrega 127.0.0.1. Pelo código, clear() zera a cota de todos
  // (inclusive de quem está no limite), então um atacante com muitos IPs reseta o limite.

  it("503 quando maxInflight está ocupado por uma requisição pendurada", async () => {
    const url = await start({ maxInflight: 1 });
    const u = new URL(url);
    const hang = request({
      host: u.hostname,
      port: u.port,
      path: "/mcp",
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "content-length": "1000" },
    });
    hang.on("error", () => undefined);
    hang.write("{"); // corpo incompleto: segura o slot em readBody
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect((await post(url, TOKEN, LIST)).status).toBe(503);
    } finally {
      hang.destroy();
    }
  });
});
