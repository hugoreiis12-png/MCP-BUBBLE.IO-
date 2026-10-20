import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";
import { buildElement, checkParams, MARKER, type BuildResult } from "../src/element/build.js";

const ENTRY = resolve("elements/contador/index.tsx");
const FIXTURE = resolve("test/fixtures/plugin");

async function pluginCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bb-plugin-"));
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}

describe("element build → repositório do plugin", () => {
  it("grava os 5 arquivos na pasta do elemento certo, sem tocar no params.json", async () => {
    const repo = await pluginCopy();
    const paramsBefore = await readFile(join(repo, "elements/AAX-1/params.json"), "utf8");
    const r = await buildElement({ entry: ENTRY, pluginDir: repo });
    expect(r.target).toBe("plugin");
    expect(r.elementDir).toBe(join(repo, "elements/AAX-1"));
    expect(r.files.map((f) => f.split(/[\\/]/).pop()).sort()).toEqual(["headers.html", "initialize.js", "preview.js", "reset.js", "update.js"]);
    expect(await readFile(join(repo, "elements/AAX-1/params.json"), "utf8")).toBe(paramsBefore);
    const init = await readFile(join(r.elementDir, "initialize.js"), "utf8");
    expect(init.startsWith("function(instance, context) {")).toBe(true);
    expect(init).toContain(MARKER);
    // field "cor" existe no editor e não é lido; estados/eventos não confirmáveis no fixture
    expect(r.warnings.join("\n")).toMatch(/não lê: cor/);
    expect(r.warnings.join("\n")).toMatch(/confirmar os estados/);
    expect(r.warnings.join("\n")).toMatch(/confirmar os eventos/);
    // rodar de novo sobrescreve os próprios arquivos sem --force
    await expect(buildElement({ entry: ENTRY, pluginDir: repo })).resolves.toBeTruthy();
  });

  it("falha se o código usa field que o Plugin Editor não declarou", async () => {
    const repo = await pluginCopy();
    const p = join(repo, "elements/AAX-1/params.json");
    const params = JSON.parse(await readFile(p, "utf8"));
    delete params.fields.AAc; // remove "passo"
    await writeFile(p, JSON.stringify(params));
    await expect(buildElement({ entry: ENTRY, pluginDir: repo })).rejects.toThrow(/ausentes no Plugin Editor: passo/);
  });

  it("não sobrescreve código escrito à mão sem --force", async () => {
    const repo = await pluginCopy();
    await writeFile(join(repo, "elements/AAX-1/update.js"), "function(instance, properties, context) {\n  alert(1);\n}\n");
    await expect(buildElement({ entry: ENTRY, pluginDir: repo })).rejects.toThrow(/escrito à mão em: update.js/);
    await expect(buildElement({ entry: ENTRY, pluginDir: repo, force: true })).resolves.toBeTruthy();
  });

  it("diz quais elementos existem quando o display não bate", async () => {
    const repo = await pluginCopy();
    const p = join(repo, "elements/AAX-1/params.json");
    const params = JSON.parse(await readFile(p, "utf8"));
    params.display = "Outro nome";
    await writeFile(p, JSON.stringify(params));
    await expect(buildElement({ entry: ENTRY, pluginDir: repo })).rejects.toThrow(/Encontrados: .*Outro nome/);
  });

  it("checkParams confirma estados e eventos quando o bloco existe", () => {
    const m = { name: "x", display: "X", properties: {}, states: ["valor"], events: ["mudou"] };
    expect(checkParams(m, { fields: {}, states: { AAz: { name: "valor" } }, events: { AAw: { caption: "mudou" } } })).toEqual([]);
    expect(checkParams(m, { fields: {}, states: { AAz: { name: "outro" } }, events: {} })[0]).toMatch(/states .*valor/);
  });
});

describe("runtime no navegador (jsdom simulando a página Bubble)", () => {
  let r: BuildResult;
  let files: Record<string, string>;
  beforeAll(async () => {
    const out = await mkdtemp(join(tmpdir(), "bb-el-"));
    r = await buildElement({ entry: ENTRY, outDir: out });
    files = {};
    for (const f of ["headers.html", "initialize.js", "update.js", "reset.js", "preview.js"]) {
      files[f] = await readFile(join(r.elementDir, f), "utf8");
    }
  });

  function page() {
    const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { runScripts: "outside-only" });
    const w = dom.window as unknown as Window & { eval(code: string): any };
    const script = /<script>\n([\s\S]*)\n<\/script>/.exec(files["headers.html"]!)![1]!;
    w.eval(script);
    const fn = (f: string) => w.eval(`(${files[f]})`) as (...a: unknown[]) => void;
    const instance = () => {
      const canvas = w.document.createElement("div");
      w.document.body.appendChild(canvas);
      const calls = { states: [] as Array<[string, unknown]>, events: [] as string[] };
      return {
        canvas,
        calls,
        // o Bubble entrega o canvas como objeto jQuery: simulado como array-like
        inst: {
          canvas: { 0: canvas },
          data: {},
          publishState: (n: string, v: unknown) => calls.states.push([n, v]),
          triggerEvent: (n: string) => calls.events.push(n),
        },
      };
    };
    return { w, fn, instance };
  }

  const tick = () => new Promise((res) => setTimeout(res, 0));

  it("o manifest reflete o defineElement e o bundle é autocontido", () => {
    expect(r.manifest).toEqual({
      name: "contador",
      display: "Contador BB",
      properties: { titulo: "text", inicial: "number", passo: "number" },
      states: ["valor"],
      events: ["mudou"],
    });
    expect(files["headers.html"]).not.toMatch(/\bimport\s|require\(/);
    expect(r.bundleBytes).toBeLessThan(400_000);
  });

  it("initialize + update renderizam, clique publica estado e dispara evento", async () => {
    const { fn, instance } = page();
    const { canvas, calls, inst } = instance();
    fn("initialize.js")(inst, {});
    expect(calls.states).toEqual([["valor", 0]]); // initialStates
    fn("update.js")(inst, { titulo: "Pedidos", inicial: 5, passo: 2, cor: "#fff" }, {});
    expect(canvas.textContent).toContain("Pedidos");
    await tick();
    expect(canvas.querySelector("output")!.textContent).toBe("5");
    canvas.querySelector<HTMLButtonElement>('button[aria-label="aumentar"]')!.click();
    await tick();
    expect(canvas.querySelector("output")!.textContent).toBe("7");
    expect(calls.states.at(-1)).toEqual(["valor", 7]);
    expect(calls.events).toEqual(["mudou"]);
  });

  it("nova propriedade vinda do Bubble re-renderiza; dois elementos na mesma página são independentes", async () => {
    const { fn, instance } = page();
    const a = instance();
    const b = instance();
    for (const x of [a, b]) fn("initialize.js")(x.inst, {});
    fn("update.js")(a.inst, { titulo: "A", inicial: 1, passo: 1 }, {});
    fn("update.js")(b.inst, { titulo: "B", inicial: 100, passo: 10 }, {});
    await tick();
    a.canvas.querySelector<HTMLButtonElement>('button[aria-label="aumentar"]')!.click();
    await tick();
    expect(a.canvas.querySelector("output")!.textContent).toBe("2");
    expect(b.canvas.querySelector("output")!.textContent).toBe("100");
    fn("update.js")(a.inst, { titulo: "A", inicial: 50, passo: 1 }, {});
    await tick();
    expect(a.canvas.querySelector("output")!.textContent).toBe("50");
    expect(b.calls.events).toEqual([]);
  });

  it("valor null do Bubble vira o padrão do componente; reset volta ao estado inicial", async () => {
    const { fn, instance } = page();
    const { canvas, inst } = instance();
    fn("initialize.js")(inst, {});
    fn("update.js")(inst, { titulo: null, inicial: null, passo: null }, {});
    await tick();
    expect(canvas.textContent).toContain("Contador");
    const plus = () => canvas.querySelector<HTMLButtonElement>('button[aria-label="aumentar"]')!.click();
    plus();
    plus();
    await tick();
    expect(canvas.querySelector("output")!.textContent).toBe("2");
    fn("reset.js")(inst, {});
    await tick();
    expect(canvas.querySelector("output")!.textContent).toBe("0");
  });

  it("erro dentro do componente aparece no canvas, sem derrubar a página", async () => {
    const { fn, instance } = page();
    const { canvas, inst } = instance();
    fn("initialize.js")(inst, {});
    // objeto como filho de JSX lança no React: erro real de render
    fn("update.js")(inst, { titulo: { objeto: "inválido" }, inicial: 0, passo: 1 }, {});
    await tick();
    expect(canvas.querySelector('[role="alert"]')!.textContent).toMatch(/Erro no elemento contador/);
  });

  it("sem o header carregado, os .js logam erro em vez de quebrar a página", () => {
    const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
    const w = dom.window as unknown as { eval(c: string): any; console: Console };
    const errors: unknown[] = [];
    w.console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    w.eval(`(${files["initialize.js"]})`)({ canvas: [], data: {} }, {});
    expect(String(errors[0])).toMatch(/não carregou/);
  });

  it("preview desenha um placeholder sem depender do bundle", () => {
    const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
    const w = dom.window as unknown as { eval(c: string): any; document: Document };
    const canvas = w.document.createElement("div");
    w.eval(`(${files["preview.js"]})`)({ canvas: [canvas] }, {});
    expect(canvas.textContent).toBe("Contador BB · bubble-bridge");
  });
});
