import { afterAll, describe, expect, it } from "vitest";
import { serveHttp, type HttpServerHandle } from "../src/mcp/http.js";
import { createBubbleMcpServer } from "../src/mcp/server.js";
import { loadConfig } from "../src/config.js";
import { staticTokenAuth } from "../src/core/clients.js";
import { BubbleClient } from "../src/core/client.js";
import { fakeBubble, makeRows } from "./fake-bubble.js";

const TOKEN = "bearer-de-teste-0123456789abcdef";
const fake = fakeBubble({ pedido: makeRows(2) });

function factory() {
  const config = loadConfig({ BUBBLE_APP_URL: "https://meuapp.bubbleapps.io", BUBBLE_MODE: "read-only" });
  const client = new BubbleClient({ appUrl: config.appUrl, env: config.env, fetch: fake.fetch });
  return createBubbleMcpServer({ config, client });
}

function rpc(url: string, token: string | null, method: string, params: unknown) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

let handle: HttpServerHandle;
afterAll(async () => {
  await handle?.close();
});

describe("transporte HTTP autenticado", () => {
  it("recusa sem token, aceita com token e responde initialize/tools/list", async () => {
    handle = await serveHttp({ host: "127.0.0.1", port: 0, authenticate: staticTokenAuth(TOKEN, "read-only"), factory, ratePerMin: 0 });
    const url = handle.url;

    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await rpc(url, "token-errado", "tools/list", {})).status).toBe(401);

    const init = await rpc(url, TOKEN, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    });
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(initBody.result?.serverInfo?.name).toBe("bubble-bridge");

    const list = await rpc(url, TOKEN, "tools/list", {});
    const body = (await list.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toContain("bubble_exposure_audit");
    expect(body.result.tools.map((t) => t.name)).not.toContain("bubble_data_delete");
  });

  it("healthz é público e não revela nada além de status", async () => {
    const res = await fetch(handle!.url.replace("/mcp", "/healthz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"status":"ok"}');
  });

  it("corta com 429 quando o IP estoura a cota por minuto", async () => {
    const limited = await serveHttp({ host: "127.0.0.1", port: 0, authenticate: staticTokenAuth(TOKEN, "read-only"), factory, ratePerMin: 2 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await rpc(limited.url, TOKEN, "tools/list", {})).status);
      expect(codes.slice(0, 2).every((c) => c !== 429)).toBe(true);
      expect(codes.at(-1)).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it("404 em caminho desconhecido", async () => {
    const res = await fetch(handle!.url.replace("/mcp", "/outra"), { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });
});
