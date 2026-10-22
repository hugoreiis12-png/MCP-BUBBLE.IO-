import { describe, expect, it } from "vitest";
import {
  BubbleEditorSession,
  DEFAULT_EDITOR_OPS,
  capDesignNode,
  canonicalJson,
  diffDesign,
  diffDesignJson,
  expand,
  expandObject,
  expandPath,
  parseEditorOps,
  redactDesignSecrets,
  shrink,
  shrinkObject,
  shrinkPath,
} from "../src/core/editor.js";
import { normalizeDesign } from "../src/core/design.js";
import { sweepAnonymousWorkflows } from "../src/core/recon.js";
import type { FetchLike } from "../src/core/http.js";

function session(ops: Record<string, { method: "GET" | "POST"; path: string }>, fetchImpl?: FetchLike) {
  return new BubbleEditorSession({
    session: "meta_live_u2main=abc",
    appId: "comprover",
    appVersion: "test",
    base: "https://scheduled.bubble.io",
    ops: ops as never,
    http: fetchImpl ? { fetch: fetchImpl } : {},
  });
}

/** Sessão com o mapa padrão medido no editor. */
function realSession(fetchImpl: FetchLike) {
  return new BubbleEditorSession({
    session: "meta_live_u2main=abc",
    appId: "comprover",
    appVersion: "test",
    base: "https://scheduled.bubble.io",
    http: { fetch: fetchImpl },
  });
}

describe("codec do editor (caminhos encolhidos)", () => {
  it("encolhe os nomes reservados para a forma curta do editor", () => {
    expect(shrink("pages")).toBe("%p3");
    expect(shrink("element_definitions")).toBe("%ed");
    expect(shrink("elements")).toBe("%el");
    expect(shrink("properties")).toBe("%p");
    expect(shrink("name")).toBe("%nm");
    expect(shrink("description")).toBe("%d3");
    expect(shrink("default")).toBe("%d1");
  });

  it("não encolhe identificadores", () => {
    for (const id of ["id", "_id", "val", "provider", "actions", "value_id", "redirects"]) {
      expect(shrink(id)).toBe(id);
    }
    expect(shrink("AAW")).toBe("AAW");
  });

  it("desencolhe voltando ao nome original", () => {
    expect(expand("%p3")).toBe("pages");
    expect(expand("%nm")).toBe("name");
    expect(expand("pages")).toBe("pages");
    expect(expand("%desconhecido")).toBe("%desconhecido");
  });

  it("faz round-trip em caminho com ids", () => {
    const path = "pages.AAW.properties.meu_campo";
    expect(shrinkPath(path)).toBe("%p3.AAW.%p.meu_campo");
    expect(expandPath(shrinkPath(path))).toBe(path);
  });

  it("encolhe as chaves do valor recursivamente", () => {
    expect(shrinkObject({ name: "x", id: "y", children: [{ properties: { name: "z" } }] })).toEqual({
      "%nm": "x",
      id: "y",
      children: [{ "%p": { "%nm": "z" } }],
    });
    expect(expandObject({ "%nm": "x", id: "y" })).toEqual({ name: "x", id: "y" });
  });
});

describe("mapa de operações do editor", () => {
  it("aceita JSON inline e normaliza o método", () => {
    const ops = parseEditorOps('{"read_design":{"method":"get","path":"/wf/load"}, "write_design":{"method":"POST","path":"/wf/save"}}');
    expect(ops.read_design).toEqual({ method: "GET", path: "/wf/load" });
    expect(ops.write_design).toEqual({ method: "POST", path: "/wf/save" });
  });

  it("lê o mapa de um arquivo", () => {
    const ops = parseEditorOps("qualquer.txt", () => '{"read_design":{"method":"GET","path":"/wf/load"}}');
    expect(Object.keys(ops)).toEqual(["read_design"]);
  });

  it("rejeita mapa inválido com mensagem acionável", () => {
    expect(() => parseEditorOps("{isso não é json")).toThrow(/JSON válido/);
    expect(() => parseEditorOps("sem-arquivo.txt")).toThrow(/JSON inline ou um caminho/);
    expect(() => parseEditorOps('{"a":{"method":"TRACE","path":"/x"}}')).toThrow(/method inválido/);
    expect(() => parseEditorOps('{"a":{"method":"GET","path":"sem-barra"}}')).toThrow(/começar com/);
    expect(() => parseEditorOps("[]")).toThrow(/objeto/);
  });

  it("sem configuração, usa as operações medidas no editor", () => {
    const ops = parseEditorOps(undefined);
    expect(Object.keys(ops)).toEqual(Object.keys(DEFAULT_EDITOR_OPS));
    expect(ops.read_design!.path).toBe("/appeditor/load_multiple_paths/{app}/{version}");
    expect(ops.write_design!.path).toBe("/appeditor/write");
  });
});

describe("sessão do editor", () => {
  it("resolve os placeholders de app e versão na URL", () => {
    const s = session({ read_design: { method: "POST", path: "/appeditor/load_multiple_paths/{app}/{version}" } });
    expect(s.resolveUrlFor("read_design")).toBe("https://scheduled.bubble.io/appeditor/load_multiple_paths/comprover/test");
  });

  it("operação fora do mapa falha fechado, com a lista do que é permitido", () => {
    const s = session({ read_design: { method: "GET", path: "/wf/load" } });
    expect(() => s.resolveUrlFor("write_design")).toThrow(/não está no mapa aprovado/);
    expect(() => s.resolveUrlFor("write_design")).toThrow(/read_design/);
  });

  it("envia o cookie da conta e nenhum token da API do app", async () => {
    let seen: { url: string; headers: Record<string, string>; body?: string } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = {
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      return new Response(JSON.stringify({ last_change: "1", data: [{ data: {} }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const s = realSession(fetchImpl);
    await s.readDesign(["settings"]);
    expect(seen!.url).toBe("https://scheduled.bubble.io/appeditor/load_multiple_paths/comprover/test");
    expect(seen!.headers.Cookie).toBe("meta_live_u2main=abc");
    expect(seen!.headers.Authorization).toBeUndefined();
  });

  it("lê encolhendo o caminho e desencolhendo a resposta", async () => {
    let body: any;
    const fetchImpl: FetchLike = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ last_change: "7", data: [{ data: { "%nm": "home", id: "AAW" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const s = realSession(fetchImpl);
    const res = await s.readDesign(["pages.AAW"]);
    expect(body.path_arrays).toEqual([["%p3", "AAW"]]);
    expect(res.lastChange).toBe("7");
    expect(res.nodes[0]!.data).toEqual({ name: "home", id: "AAW" });
  });

  it("nó grande volta como chunkKeys, com os filhos legíveis", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ last_change: "7", data: [{ keys: ["%el", "%p"] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const s = realSession(fetchImpl);
    const res = await s.readDesign(["pages.AAW"]);
    expect(res.nodes[0]!.chunkKeys).toEqual(["elements", "properties"]);
    expect(res.nodes[0]!.data).toBeNull();
  });

  it("desce um nível e devolve os filhos de um nó grande", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body.path_arrays[0].join("."));
      if (calls.length === 1) {
        return new Response(JSON.stringify({ last_change: "7", data: [{ keys: ["%el"] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ last_change: "7", data: [{ data: { "%nm": "titulo" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const s = realSession(fetchImpl);
    const res = await s.readDesign(["pages.AAW"], { children: 1 });
    expect(calls).toEqual(["%p3.AAW", "%p3.AAW.%el"]);
    expect(res.nodes[0]!.data).toEqual({ elements: { name: "titulo" } });
  });

  it("escreve encolhendo caminho e valor, e apaga com body nulo", async () => {
    const bodies: any[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ last_change: "9", last_change_date: "10", id_counter: "11" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const s = realSession(fetchImpl);
    const res = await s.writeDesign([{ path: "pages.AAW.properties.meu_campo", value: { name: "Título" } }]);
    expect(bodies[0].appname).toBe("comprover");
    expect(bodies[0].app_version).toBe("test");
    expect(bodies[0].changes[0].path_array).toEqual(["%p3", "AAW", "%p", "meu_campo"]);
    expect(bodies[0].changes[0].body).toEqual({ "%nm": "Título" });
    expect(res.lastChange).toBe("9");

    await s.deleteNode("pages.AAW.properties.meu_campo");
    expect(bodies[1].changes[0].body).toBeNull();
    expect(bodies[1].changes[0].path_array).toEqual(["%p3", "AAW", "%p", "meu_campo"]);
  });

  it("o dry-run mostra método, URL e corpo sem enviar nada", async () => {
    let chamadas = 0;
    const fetchImpl: FetchLike = async () => {
      chamadas++;
      return new Response("{}", { status: 200 });
    };
    const s = realSession(fetchImpl);
    const preview = s.previewWrite([{ path: "settings.chave", value: { name: "x" } }]);
    expect(preview.method).toBe("POST");
    expect(preview.endpoint).toBe("https://scheduled.bubble.io/appeditor/write");
    expect((preview.body as any).changes[0].path_array).toEqual(["settings", "chave"]);
    expect(chamadas).toBe(0);
  });

  it("probe diz se a sessão da conta ainda responde, usando a operação aprovada", async () => {
    let url = "";
    const fetchImpl: FetchLike = async (u) => {
      url = u;
      return new Response(JSON.stringify({ path_version_hash: "abc" }), { status: 200 });
    };
    const ok = realSession(fetchImpl);
    const p1 = await ok.probe();
    expect(p1.reachable).toBe(true);
    expect(p1.pathVersionHash).toBe("abc");
    expect(url).toContain("/appeditor/load_single_path/comprover/test");

    const expirada = realSession(async () =>
      new Response(JSON.stringify({ error_class: "Unauthorized", translation: "Session expired" }), { status: 401 }),
    );
    const p = await expirada.probe();
    expect(p.reachable).toBe(false);
    expect(p.status).toBe(401);
    expect(p.error).toMatch(/401/);
  });

  it("sem operação de sondagem aprovada, o probe falha fechado em vez de adivinhar URL", async () => {
    const s = session({}, async () => new Response("{}", { status: 200 }));
    const p = await s.probe();
    expect(p.reachable).toBe(false);
    expect(p.error).toMatch(/nenhuma operação de sondagem/);
  });

  it("manda o header do Firebase além do cookie — o editor exige os dois", async () => {
    const headers: Array<Record<string, string>> = [];
    const fetchImpl: FetchLike = async (_u, init) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ last_change: "9" }), { status: 200 });
    };
    const s = new BubbleEditorSession({
      session: "meta_test_u2main=abc",
      firebaseToken: "jwt-firebase",
      appId: "comprover",
      appVersion: "test",
      base: "https://scheduled.bubble.io",
      http: { fetch: fetchImpl },
    });
    await s.writeDesign([{ path: "settings.x", value: 1 }]);
    await s.probe();
    expect(headers.length).toBe(2);
    for (const h of headers) {
      expect(h["Cookie"]).toBe("meta_test_u2main=abc");
      expect(h["meta-firebase_workflow"]).toBe("jwt-firebase");
    }
  });

  it("sem o header do Firebase, a requisição leva só o cookie", async () => {
    const headers: Array<Record<string, string>> = [];
    const fetchImpl: FetchLike = async (_u, init) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return new Response("{}", { status: 200 });
    };
    const s = realSession(fetchImpl);
    await s.writeDesign([{ path: "settings.x", value: 1 }]);
    expect(headers[0]!["Cookie"]).toBe("meta_live_u2main=abc");
    expect(headers[0]!["meta-firebase_workflow"]).toBeUndefined();
  });

  it("a descoberta mapeia a raiz sem baixar o nó api inteiro", async () => {
    const bodies: any[] = [];
    const fetchImpl: FetchLike = async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      // O editor responde com a lista de filhos quando o pedido é sem chunking.
      return new Response(JSON.stringify({ last_change: "9", data: [{ keys: ["AAW"] }, { keys: ["wf1"] }] }), { status: 200 });
    };
    const s = realSession(fetchImpl);
    const d = await s.discover();
    const leitura = bodies.find((b) => Array.isArray(b.path_arrays));
    expect(leitura!.no_chunking).toBe(false);
    expect(d.reachable).toBe(true);
    // A raiz responde com os filhos, não com o conteúdo.
    expect(d.roots.some((r) => r.path === "api")).toBe(true);
  });

  it("exporta o design inteiro pelo editor", async () => {
    let url = "";
    const fetchImpl: FetchLike = async (u) => {
      url = u;
      return new Response("{\"pages\":{}}", { status: 200 });
    };
    const s = realSession(fetchImpl);
    const raw = await s.exportDesign();
    expect(url).toBe("https://scheduled.bubble.io/appeditor/export/test/comprover.bubble");
    expect(raw).toContain("pages");
  });

  it("reconhece operação de publish: publicar o branch dev já é deploy no live", () => {
    const s = session({
      read_design: { method: "POST", path: "/appeditor/load_multiple_paths/{app}/{version}" },
      write_design: { method: "POST", path: "/appeditor/write" },
      publish_design: { method: "POST", path: "/appeditor/deploy_new_code" },
      deploy: { method: "POST", path: "/wf/anything" },
    });
    expect(s.isPublishOp("publish_design")).toBe(true);
    expect(s.isPublishOp("deploy")).toBe(true);
    expect(s.isPublishOp("write_design")).toBe(false);
    expect(s.isPublishOp("read_design")).toBe(false);
    expect(s.isPublishOp("op_inexistente")).toBe(false);
  });

  it("erro do editor volta com o contexto da operação", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ error_class: "Unauthorized", translation: "Session expired" }), { status: 401 });
    const s = realSession(fetchImpl);
    await expect(s.writeDesign([{ path: "settings.x", value: 1 }])).rejects.toThrow(/write_design/);
  });
});

describe("diffs de design", () => {
  it("diff do contrato aponta tipo e campo novos", () => {
    const before = normalizeDesign({
      get: ["a"],
      post: [],
      types: { a: { display: "a", fields: [{ id: "a_f_x_text", display: "x", type: "text" }] } },
    });
    const after = normalizeDesign({
      get: ["a", "b"],
      post: [],
      types: {
        a: { display: "a", fields: [{ id: "a_f_x_text", display: "x", type: "text" }] },
        b: { display: "b", fields: [{ id: "b_f_y_text", display: "y", type: "text" }] },
      },
    });
    const d = diffDesign(before, after);
    expect(d.changed).toBe(true);
    expect(d.typesAdded).toEqual(["b"]);
    expect(d.fieldsAdded).toEqual([{ type: "b", fieldId: "b_f_y_text", display: "y", kind: "text" }]);
  });

  it("diff do documento cru lista caminhos alterados, adicionados e removidos", () => {
    const d = diffDesignJson(
      { pages: { home: { titulo: "antes", oculto: true } }, versao: 1 },
      { pages: { home: { titulo: "depois" }, sobre: {} }, versao: 2 },
    );
    expect(d.changed).toBe(true);
    expect(d.modified).toContain("pages.home.titulo");
    expect(d.modified).toContain("versao");
    expect(d.removed).toContain("pages.home.oculto");
    expect(d.added).toContain("pages.sobre");
  });

  it("diff sem mudança não acusa nada", () => {
    expect(diffDesignJson({ a: 1 }, { a: 1 }).changed).toBe(false);
  });
});

describe("exposição anônima de workflows", () => {
  const fetchImpl = (status: number, body: unknown): FetchLike => async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("401 significa workflow protegido", async () => {
    const r = await sweepAnonymousWorkflows({
      apiRoot: "https://x.bubbleapps.io/version-test/api/1.1",
      workflows: ["login"],
      http: { fetch: fetchImpl(401, { error_class: "Unauthorized", translation: "You must authenticate to call this method" }) },
    });
    expect(r.exposed).toBe(0);
    expect(r.leaks).toHaveLength(0);
  });

  it("400 também prova alcance: o atacante só precisa do payload", async () => {
    const r = await sweepAnonymousWorkflows({
      apiRoot: "https://x.bubbleapps.io/version-test/api/1.1",
      workflows: ["admin"],
      http: { fetch: fetchImpl(400, { statusCode: 400, reason: "NO_EMAIL", message: "Favor informar um endereço de email." }) },
    });
    expect(r.exposed).toBe(1);
    expect(r.leaks[0]!.workflow).toBe("admin");
  });

  it("ignora nomes destrutivos a menos que o operador peça", async () => {
    let chamadas = 0;
    const counting: FetchLike = async () => {
      chamadas++;
      return new Response("{}", { status: 200 });
    };
    const r = await sweepAnonymousWorkflows({
      apiRoot: "https://x.bubbleapps.io/version-test/api/1.1",
      workflows: ["admin", "desativar_robot", "apagar_tudo"],
      http: { fetch: counting },
    });
    expect(r.probed).toBe(1);
    expect(chamadas).toBe(1);

    const r2 = await sweepAnonymousWorkflows({
      apiRoot: "https://x.bubbleapps.io/version-test/api/1.1",
      workflows: ["admin", "desativar_robot", "apagar_tudo"],
      allowDestructive: true,
      http: { fetch: counting },
    });
    expect(r2.probed).toBe(3);
  });
});
