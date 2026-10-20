import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BubbleClient } from "../src/core/client.js";
import { generateTypes } from "../src/core/codegen.js";
import { BubbleApiError } from "../src/core/errors.js";
import { exportAll } from "../src/core/export.js";
import { exportToNdjson, safeSegment } from "../src/core/files.js";
import { parseRetryAfter, requestJson } from "../src/core/http.js";
import { normalizeSwagger } from "../src/core/schema.js";
import { fakeBubble, makeRows } from "./fake-bubble.js";

const noSleep = async () => undefined;

function client(fetch: ReturnType<typeof fakeBubble>["fetch"], extra: Partial<ConstructorParameters<typeof BubbleClient>[0]> = {}) {
  return new BubbleClient({ appUrl: "https://meuapp.bubbleapps.io/", env: "test", fetch, sleep: noSleep, ...extra });
}

describe("config", () => {
  it("aplica padrões seguros: test + read-only", () => {
    const cfg = loadConfig({ BUBBLE_APP_URL: "https://meuapp.bubbleapps.io/" });
    expect(cfg).toMatchObject({ env: "test", mode: "read-only", appUrl: "https://meuapp.bubbleapps.io", searchCap: 50_000 });
  });
  it("recusa http:// e modo desconhecido com mensagem clara", () => {
    expect(() => loadConfig({ BUBBLE_APP_URL: "http://meuapp.bubbleapps.io" })).toThrow(/https/);
    expect(() => loadConfig({ BUBBLE_APP_URL: "https://a.io", BUBBLE_MODE: "root" })).toThrow(/mode/);
    expect(() => loadConfig({})).toThrow(/BUBBLE_APP_URL/);
  });
});

describe("http", () => {
  it("interpreta Retry-After em segundos e em data", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter("lixo")).toBeUndefined();
  });

  it("repete GET em 429 e então responde", async () => {
    const fake = fakeBubble({ pedido: makeRows(3) }, { throttle: 2 });
    const retries: number[] = [];
    const c = client(fake.fetch, { onRetry: (i) => retries.push(i.attempt) });
    const page = await c.list("pedido");
    expect(page.count).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  it("desiste após maxRetries com erro 429 e dica", async () => {
    const fake = fakeBubble({ pedido: [] }, { throttle: 10 });
    const err = await client(fake.fetch, { maxRetries: 1 }).list("pedido").catch((e) => e);
    expect(err).toBeInstanceOf(BubbleApiError);
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/rate limit/);
  });

  it("nunca repete POST (evita duplicar registro ou workflow)", async () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return new Response("", { status: 503 });
    };
    await expect(requestJson("https://a.io/x", { method: "POST", body: {} }, { fetch, sleep: noSleep })).rejects.toThrow(/503/);
    expect(calls).toBe(1);
  });

  it("extrai a mensagem dos dois formatos de erro do Bubble", async () => {
    const fake = fakeBubble({ pedido: makeRows(1) }, { token: "certo" });
    const e401 = await client(fake.fetch, { token: "errado" }).list("pedido").catch((e) => e);
    expect(e401.message).toMatch(/401.*You do not have permission/);
    const e404 = await client(fake.fetch, { token: "certo" }).getThing("pedido", "nao-existe").catch((e) => e);
    expect(e404.message).toMatch(/MISSING_DATA: missing/);
    expect(e404.message).not.toContain("certo");
  });
});

describe("client", () => {
  it("monta URLs de test e live e envia constraints como JSON", async () => {
    const fake = fakeBubble({ pedido: makeRows(5) });
    await client(fake.fetch).list("pedido", {
      constraints: [{ key: "n", constraint_type: "equals", value: 2 }],
      sortField: "Created Date",
      limit: 500,
    });
    const url = new URL(fake.calls[0]!);
    expect(url.pathname).toBe("/version-test/api/1.1/obj/pedido");
    expect(JSON.parse(url.searchParams.get("constraints")!)).toEqual([{ key: "n", constraint_type: "equals", value: 2 }]);
    expect(url.searchParams.get("limit")).toBe("100"); // limit é limitado a 100
    const live = new BubbleClient({ appUrl: "https://meuapp.bubbleapps.io", env: "live" });
    expect(live.apiRoot).toBe("https://meuapp.bubbleapps.io/api/1.1");
  });

  it("codifica tipos com espaço e recusa nomes com barra", async () => {
    const fake = fakeBubble({ "item do pedido": makeRows(1) });
    const c = client(fake.fetch);
    await c.list("item do pedido");
    expect(fake.calls[0]).toContain("/obj/item%20do%20pedido");
    await expect(c.list("../meta")).rejects.toThrow(/inválido/);
  });

  it("iterate percorre páginas até remaining = 0 e respeita maxItems", async () => {
    const fake = fakeBubble({ pedido: makeRows(250) });
    const c = client(fake.fetch);
    const all: string[] = [];
    for await (const t of c.iterate("pedido")) all.push(t._id);
    expect(all).toHaveLength(250);
    expect(new Set(all).size).toBe(250);
    const some: string[] = [];
    for await (const t of c.iterate("pedido", {}, 130)) some.push(t._id);
    expect(some).toHaveLength(130);
  });
});

describe("exportAll (janelas de Created Date)", () => {
  for (const remaining of ["capped", "total"] as const) {
    it(`passa do teto por cursor sem perder nem duplicar (remaining ${remaining})`, async () => {
      const rows = makeRows(1_050);
      const fake = fakeBubble({ pedido: rows }, { cap: 300, remaining });
      const seen: string[] = [];
      const res = await exportAll(client(fake.fetch), "pedido", (t) => void seen.push(t._id), { searchCap: 300 });
      expect(res.total).toBe(1_050);
      expect(res.windows).toBeGreaterThan(1);
      expect(seen).toEqual(rows.map((r) => r._id));
    });

    it(`não perde registros com o mesmo Created Date na fronteira (remaining ${remaining})`, async () => {
      const rows = makeRows(1_000, 7); // grupos de 7 registros com a mesma data
      const fake = fakeBubble({ pedido: rows }, { cap: 300, remaining });
      const seen: string[] = [];
      await exportAll(client(fake.fetch), "pedido", (t) => void seen.push(t._id), { searchCap: 300 });
      expect(seen.length).toBe(1_000);
      expect([...seen].sort()).toEqual(rows.map((r) => r._id).sort());
    });
  }

  it("encerra quando o total cai exatamente no teto", async () => {
    const rows = makeRows(300);
    const fake = fakeBubble({ pedido: rows }, { cap: 300 });
    const res = await exportAll(client(fake.fetch), "pedido", () => undefined, { searchCap: 300 });
    expect(res.total).toBe(300);
  });

  it("falha alto quando o teto inteiro tem a mesma data", async () => {
    const fake = fakeBubble({ pedido: makeRows(500, 500) }, { cap: 300 });
    await expect(exportAll(client(fake.fetch), "pedido", () => undefined, { searchCap: 300 })).rejects.toThrow(/mesmo Created Date/);
  });

  it("respeita max_items e grava NDJSON dentro do diretório", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-"));
    const fake = fakeBubble({ pedido: makeRows(120) });
    const res = await exportToNdjson(client(fake.fetch), "pedido", dir, { searchCap: 50_000, maxItems: 42 });
    expect(res.total).toBe(42);
    expect(res.file.startsWith(dir)).toBe(true);
    const lines = (await readFile(res.file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(42);
    expect(JSON.parse(lines[0]!)._id).toBe("id000000");
    expect(safeSegment("../../etc/passwd")).not.toContain("/");
  });

  it("apaga o arquivo parcial quando o export falha", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-"));
    const rows = makeRows(5);
    delete (rows[3] as Record<string, unknown>)["Created Date"]; // força erro no meio do export
    const fake = fakeBubble({ pedido: rows });
    await expect(exportToNdjson(client(fake.fetch), "pedido", dir, { searchCap: 50_000 })).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("schema + codegen", () => {
  const swagger = JSON.parse(readFileSync(new URL("./fixtures/swagger.json", import.meta.url), "utf8"));

  it("normaliza tipos, campos, referências e workflows", () => {
    const s = normalizeSwagger(swagger);
    expect(s.format).toBe("swagger2");
    expect(s.types.map((t) => t.name)).toEqual(["item do pedido", "pedido", "user"]);
    const pedido = s.types.find((t) => t.name === "pedido")!;
    expect(pedido.fields).toContainEqual({ name: "Created Date", kind: "date", list: false });
    expect(pedido.fields).toContainEqual({ name: "cliente", kind: "string", list: false, ref: "User" });
    expect(pedido.fields).toContainEqual({ name: "itens", kind: "string", list: true, ref: "ItemDoPedido" });
    expect(s.types.find((t) => t.name === "user")!.fields.map((f) => f.name)).toEqual(["_id", "email"]);
    expect(s.workflows).toEqual([
      {
        name: "fechar_pedido",
        methods: ["POST"],
        params: [
          { name: "pedido", kind: "string", list: false },
          { name: "notificar", kind: "boolean", list: false },
        ],
      },
    ]);
    expect(s.warnings).toEqual(['tipo "item do pedido": campos não encontrados no swagger']);
  });

  it("tolera lixo sem lançar", () => {
    expect(normalizeSwagger(null).warnings[0]).toMatch(/não é um objeto/);
    expect(normalizeSwagger({ openapi: "3.0.0" }).format).toBe("openapi3");
  });

  it("gera TypeScript válido com nomes seguros", () => {
    const code = generateTypes(normalizeSwagger(swagger));
    expect(code).toContain("export interface Pedido {");
    expect(code).toContain('"Created Date"?: string /* ISO 8601 */;');
    expect(code).toContain("export interface ItemDoPedido {");
    expect(code).toContain('"item do pedido": ItemDoPedido;');
    expect(code).toContain("fechar_pedido: { pedido?: string; notificar?: boolean };");
  });
});
