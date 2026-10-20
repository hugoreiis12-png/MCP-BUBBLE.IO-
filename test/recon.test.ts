import { describe, expect, it } from "vitest";
import { classify, levelOf, probeAnonymous, redactSample, sweepAnonymous } from "../src/core/recon.js";
import type { FetchLike } from "../src/core/http.js";

const API = "https://meuapp.bubbleapps.io/version-test/api/1.1";

interface FakeBubble {
  exposed: Record<string, Record<string, unknown>[]>;
  restricted: string[];
  seen: Array<{ url: string; auth?: string }>;
}

function fakeBubble(opts: FakeBubble): FetchLike {
  return async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const type = decodeURIComponent(String(input).split("/obj/")[1]?.split("?")[0] ?? "");
    opts.seen.push({ url: String(input), auth: headers.Authorization });
    const rows = opts.exposed[type];
    if (rows && !headers.Authorization) {
      return new Response(
        JSON.stringify({ response: { cursor: 0, results: rows, count: rows.length, remaining: 500_000 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (opts.restricted.includes(type)) {
      return new Response(JSON.stringify({ statusCode: 401, body: { status: "UNAUTHORIZED", message: "You do not have permission" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ response: { cursor: 0, results: [], count: 0, remaining: 0 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const base = { apiRoot: API };
const httpOf = (fetch: FetchLike) => ({ fetch, sleep: async () => undefined });

// Varredura em lote: ordenação, classificação e invariante de contagem.
describe("sweepAnonymous", () => {
  const FIXTURES = {
    colaboradores: [{ _id: "c1", ativo: true }],
    tabela_log_alteracao_rh: [{ _id: "l1", "chave de atenticacao": "abc123456" }],
    notas_comprove: [{ _id: "n1", nota: 123 }],
  };

  it("varre todos os tipos, conta corretamente e separa expostos de bloqueados", async () => {
    const fetch = fakeBubble({ exposed: FIXTURES, restricted: ["contacorrente"], seen: [] });
    const r = await sweepAnonymous({ ...base, http: httpOf(fetch), types: ["colaboradores", "tabela_log_alteracao_rh", "notas_comprove", "contacorrente"], concurrency: 2 });
    expect(r.probed).toBe(4);
    expect(r.exposed).toBe(3);
    expect(r.closed).toBe(0);
    expect(r.exposed + r.closed + r.errors.length).toBe(r.probed); // nenhum tipo some no caminho
    expect(r.leaks.map((l) => l.type).sort()).toEqual(["colaboradores", "notas_comprove", "tabela_log_alteracao_rh"]);
    expect(r.errors.map((e) => e.type)).toEqual(["contacorrente"]);
    expect(r.errors[0]!.status).toBe(401);
  });

  it("é reproduzível: três varreduras seguidas devolvem o mesmo conjunto", async () => {
    const resultados = await Promise.all(
      [0, 1, 2].map(async () => {
        const fetch = fakeBubble({ exposed: FIXTURES, restricted: ["contacorrente"], seen: [] });
        const r = await sweepAnonymous({ ...base, http: httpOf(fetch), types: ["colaboradores", "tabela_log_alteracao_rh", "notas_comprove", "contacorrente"], concurrency: 2 });
        return r.leaks.map((l) => l.type).sort().join(",");
      }),
    );
    expect(resultados[0]).toBe("colaboradores,notas_comprove,tabela_log_alteracao_rh");
    expect(new Set(resultados).size).toBe(1);
  });

  it("respeita a fila e reporta progresso de todos os tipos", async () => {
    const fetch = fakeBubble({ exposed: {}, restricted: [], seen: [] });
    const done: number[] = [];
    await sweepAnonymous({ ...base, http: httpOf(fetch), types: ["a", "b", "c", "d", "e"], concurrency: 3, onProgress: (d) => done.push(d) });
    expect(done.sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("probeAnonymous", () => {
  it("detecta tipo exposto e classifica dado pessoal", async () => {
    const fetch = fakeBubble({
      exposed: { colaboradores: [{ _id: "c1", ativo: true, "Data de nascimento": "1990-01-01T00:00:00.000Z" }] },
      restricted: [],
      seen: [],
    });
    const r = await probeAnonymous({ ...base, http: httpOf(fetch), type: "colaboradores" });
    expect(r.status).toBe(200);
    expect(r.exposed).toBe(true);
    expect(r.remaining).toBe(500_000);
    expect(r.level).toBe("high");
    expect(r.findings).toContainEqual({ field: "Data de nascimento", kind: "pii", label: "dado pessoal (LGPD art. 5º)" });
    expect(r.sample).toBeUndefined(); // sem include_sample não devolve valor
  });

  it("credencial exposta eleva para critical", async () => {
    const fetch = fakeBubble({
      exposed: { tabela_log_alteracao_rh: [{ _id: "l1", "chave de atenticacao": "ZdHYU843hulj" }] },
      restricted: [],
      seen: [],
    });
    const r = await probeAnonymous({ ...base, http: httpOf(fetch), type: "tabela_log_alteracao_rh", includeSample: true });
    expect(r.level).toBe("critical");
    expect(r.findings[0]!.kind).toBe("credential");
    expect(r.sample!["chave de atenticacao"]).toBe("Zd…lj (12 car.)");
    expect(r.sample!["chave de atenticacao"]).not.toContain("ZdHYU843hulj");
  });

  it("tipo bloqueado por privacy rule não é exposição", async () => {
    const fetch = fakeBubble({ exposed: {}, restricted: ["contacorrente"], seen: [] });
    const r = await probeAnonymous({ ...base, http: httpOf(fetch), type: "contacorrente" });
    expect(r.exposed).toBe(false);
    expect(r.level).toBe("none");
    expect(r.status).toBe(401);
    expect(r.error).toMatch(/do not have permission/);
  });

  it("tipo vazio não é exposição", async () => {
    const fetch = fakeBubble({ exposed: {}, restricted: [], seen: [] });
    const r = await probeAnonymous({ ...base, http: httpOf(fetch), type: "documentos" });
    expect(r.exposed).toBe(false);
    expect(r.level).toBe("none");
  });

  it("nunca envia o header Authorization — é o teste do atacante, não do dono", async () => {
    const seen: FakeBubble["seen"] = [];
    const fetch = fakeBubble({ exposed: { user: [{ _id: "u1" }] }, restricted: [], seen });
    await probeAnonymous({ ...base, http: httpOf(fetch), type: "user" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBeUndefined();
    expect(seen[0]!.url).toContain("limit=");
  });
});

describe("classificação", () => {
  it("mapeia nomes de campo e ordena por gravidade (credencial > pessoal > sensível)", () => {
    expect(classify(["boleto", "cpf", "chave de atenticacao"])).toEqual([
      { field: "chave de atenticacao", kind: "credential", label: "credencial/segredo reutilizável" },
      { field: "cpf", kind: "pii", label: "dado pessoal (LGPD art. 5º)" },
      { field: "boleto", kind: "sensitive", label: "dado sensível de negócio" },
    ]);
  });
  it("classifica nomes capitalizados (case-insensitive)", () => {
    const r = classify(["CPF", "Email", "Nome", "Telefone", "Data de Nascimento", "Senha"]);
    expect(r.map((f) => [f.field, f.kind])).toEqual([
      ["Senha", "credential"],
      ["CPF", "pii"],
      ["Email", "pii"],
      ["Nome", "pii"],
      ["Telefone", "pii"],
      ["Data de Nascimento", "pii"],
    ]);
  });
  it("nível não exposto é sempre none", () => {
    expect(levelOf(false, [])).toBe("none");
    expect(levelOf(true, [])).toBe("low");
  });
  it("amostra mascara valores e conta itens de lista", () => {
    const s = redactSample({ nome: "Maria Silva", n: 42, lista: [1, 2, 3], nulo: null });
    expect(s).toEqual({ nome: "Ma…va (11 car.)", n: "42", lista: "[3 itens]", nulo: "null" });
  });
});
