import { describe, expect, it } from "vitest";
import { BubbleClient } from "../src/core/client.js";
import { classify, fieldIndex, normalizeDesign, typeReferences } from "../src/core/design.js";
import { fakeBubble, makeRows } from "./fake-bubble.js";

/** Formato do /meta real do Bubble (292 tipos, 192 workflows) reduzido ao essencial. */
const META = {
  get: ["produto", "pedido"],
  post: [
    {
      endpoint: "admin",
      method: "post",
      auth_unecessary: true,
      parameters: [{ key: "_wf_request_data", value: "api_wf_data.bXOXT", optional: false, param_in: "body" }],
      return_btype: { executáveis: "list.custom.meusexecutáveisedocumentos" },
    },
    {
      endpoint: "login",
      method: "post",
      auth_unecessary: false,
      parameters: [{ key: "_wf_request_data", value: "api_wf_data.bUWEg0", optional: false, param_in: "body" }],
      return_btype: { empresa: "user", token: "text", expires: "number" },
    },
  ],
  types: {
    produto: {
      display: "produto",
      fields: [
        { id: "produto_f_nome_custom", display: "nome", type: "text" },
        { id: "produto_f_preco_number", display: "preço", type: "number" },
        { id: "produto_f_ativo_boolean", display: "ativo", type: "boolean" },
        { id: "produto_f_criador_user", display: "criador", type: "user" },
        { id: "produto_f_pedidos_list_pedido", display: "pedidos", type: "list.custom.pedido" },
        { id: "produto_f_status_option_status", display: "status", type: "option.status" },
      ],
    },
    pedido: {
      display: "pedido",
      fields: [
        { id: "pedido_f_total_number", display: "total", type: "number" },
        { id: "pedido_f_cliente_list_custom_produto", display: "cliente", type: "list.custom.produto" },
        { id: "pedido_f_anexo_file", display: "anexo", type: "file" },
      ],
    },
  },
  app_data: { appname: "comprover", app_version: "test", use_captions_for_get: true },
};

describe("contrato de design", () => {
  it("normaliza tipos, ids internos e taxonomia de campos", () => {
    const d = normalizeDesign(META);
    expect(d.counts.types).toBe(2);
    expect(d.counts.fields).toBe(9);
    expect(d.counts.readable).toBe(2);
    expect(d.counts.workflows).toBe(2);
    expect(d.counts.publicWorkflows).toBe(1);

    const produto = d.types.find((t) => t.name === "produto")!;
    expect(produto.readable).toBe(true);
    const nome = produto.fields.find((f) => f.id === "produto_f_nome_custom")!;
    expect(nome).toMatchObject({ display: "nome", kind: "text", list: false });
    const pedidos = produto.fields.find((f) => f.id === "produto_f_pedidos_list_pedido")!;
    expect(pedidos).toMatchObject({ kind: "reference", ref: "pedido", list: true, rawType: "list.custom.pedido" });
    const status = produto.fields.find((f) => f.id === "produto_f_status_option_status")!;
    expect(status).toMatchObject({ kind: "option", ref: "status" });
    expect(d.app.appname).toBe("comprover");
  });

  it("separa workflows públicos dos que exigem autenticação", () => {
    const d = normalizeDesign(META);
    const admin = d.workflows.find((w) => w.name === "admin")!;
    expect(admin.public).toBe(true);
    expect(admin.returns).toEqual({ executáveis: "list.custom.meusexecutáveisedocumentos" });
    expect(admin.params[0]).toMatchObject({ key: "_wf_request_data", optional: false, paramIn: "body" });
    const login = d.workflows.find((w) => w.name === "login")!;
    expect(login.public).toBe(false);
    expect(login.returns).toHaveProperty("token");
  });

  it("classifica a taxonomia do Bubble", () => {
    expect(classify("text")).toEqual({ kind: "text", list: false });
    expect(classify("list.custom.pedido")).toEqual({ kind: "reference", ref: "pedido", list: true });
    expect(classify("option.status")).toEqual({ kind: "option", ref: "status", list: false });
    expect(classify("list.list.custom.pedido")).toEqual({ kind: "reference", ref: "pedido", list: true });
    expect(classify("geographic_address").kind).toBe("geographic_address");
    expect(classify("desconhecido").kind).toBe("unknown");
  });

  it("não quebra com /meta fora do formato: vira warning, não exceção", () => {
    const d = normalizeDesign("não é json");
    expect(d.types).toHaveLength(0);
    expect(d.warnings.length).toBeGreaterThan(0);
    const d2 = normalizeDesign({ get: ["fantasma"], types: {}, post: "nope" });
    expect(d2.warnings.some((w) => w.includes("fantasma"))).toBe(true);
    expect(d2.warnings.some((w) => w.includes("workflows"))).toBe(true);
  });

  it("gera índice de campos e mapa de referências", () => {
    const d = normalizeDesign(META);
    const idx = fieldIndex(d);
    expect(idx.length).toBe(9);
    expect(idx.find((f) => f.fieldId === "pedido_f_cliente_list_custom_produto")).toMatchObject({ type: "pedido", ref: "produto", list: true });
    const refs = typeReferences(d);
    expect(refs.produto).toEqual(["pedido"]);
    expect(refs.pedido).toEqual(["produto"]);
  });

  it("lê o contrato de design do app pelo /meta real do fake", async () => {
    const fake = fakeBubble({ pedido: makeRows(3) });
    const client = new BubbleClient({ appUrl: "https://meuapp.bubbleapps.io", env: "test", fetch: fake.fetch });
    const d = normalizeDesign(await client.meta());
    expect(d.types.map((t) => t.name)).toContain("pedido");
    expect(d.counts.publicWorkflows).toBe(1);
    expect(d.workflows.find((w) => w.name === "admin")!.public).toBe(true);
  });
});
