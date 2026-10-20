import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * Compila um elemento TS/React para os arquivos que o Plugin Editor do Bubble usa
 * (headers.html + initialize/update/reset/preview.js) e, opcionalmente, os grava
 * na pasta do elemento dentro de um repositório de plugin sincronizado com o GitHub.
 *
 * O params.json (fields, ids, estados, eventos) NUNCA é escrito: os ids são
 * referenciados pelos apps e só o Plugin Editor deve criá-los.
 */

export const MARKER = "bubble-bridge:generated";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const HASH_RE = new RegExp(`${MARKER} hash=([0-9a-f]{64})`);

/** Separa a linha do marker do resto; o hash do marker cobre só o resto. */
function splitMarker(text: string): { line: string; rest: string } {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.includes(MARKER));
  if (i < 0) return { line: "", rest: text };
  const [line] = lines.splice(i, 1);
  return { line: line!, rest: lines.join("\n") };
}

/** Embute no marker o sha256 do conteúdo sem a linha do marker. */
function stamp(text: string): string {
  const { rest } = splitMarker(text);
  return text.replace(MARKER, `${MARKER} hash=${sha(rest)}`);
}
const CODE_FILES = ["initialize.js", "update.js", "reset.js", "preview.js"] as const;

export interface ElementManifest {
  name: string;
  display: string;
  properties: Record<string, string>;
  states: string[];
  events: string[];
}

export interface BuildOptions {
  /** Arquivo .tsx/.ts que faz `export default defineElement({...})`. */
  entry: string;
  /** Raiz de um repositório de plugin Bubble (com elements/<id>/params.json). */
  pluginDir?: string;
  /** Sem pluginDir: diretório de saída (padrão ./build/elements). */
  outDir?: string;
  minify?: boolean;
  /** Sobrescreve código escrito à mão no elemento do plugin. */
  force?: boolean;
}

export interface BuildResult {
  manifest: ElementManifest;
  elementDir: string;
  target: "plugin" | "out";
  files: string[];
  bundleBytes: number;
  sha256: string;
  warnings: string[];
}

function runtimePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const js = join(here, "react.js");
  return existsSync(js) ? js : join(here, "react.ts");
}

export async function buildElement(opts: BuildOptions): Promise<BuildResult> {
  const entry = resolve(opts.entry);
  if (!existsSync(entry)) throw new Error(`Entrada não encontrada: ${entry}`);
  const manifest = await readManifest(entry);
  const bundle = await bundleBrowser(entry, opts.minify ?? true);
  const sha256 = createHash("sha256").update(bundle).digest("hex");
  const files = Object.fromEntries(Object.entries(generateFiles(manifest, bundle, sha256)).map(([f, c]) => [f, stamp(c)]));
  const warnings: string[] = [];

  let elementDir: string;
  let target: BuildResult["target"];
  if (opts.pluginDir) {
    target = "plugin";
    const found = await findElementDir(resolve(opts.pluginDir), manifest.display);
    elementDir = found.dir;
    warnings.push(...checkParams(manifest, found.params));
    await guardOverwrite(elementDir, opts.force ?? false);
  } else {
    target = "out";
    elementDir = resolve(opts.outDir ?? "build/elements", manifest.name);
    await mkdir(elementDir, { recursive: true });
    await writeFile(join(elementDir, "manifest.json"), JSON.stringify({ ...manifest, sha256, bundleBytes: bundle.length }, null, 2));
  }

  const written: string[] = [];
  for (const [file, content] of Object.entries(files)) {
    const path = join(elementDir, file);
    await writeFile(path, content, "utf8");
    written.push(path);
  }
  return { manifest, elementDir, target, files: written, bundleBytes: bundle.length, sha256, warnings };
}

/** Importa o elemento no Node para ler nome, fields, estados e eventos declarados. */
export async function readManifest(entry: string): Promise<ElementManifest> {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    jsx: "automatic",
    write: false,
    logLevel: "silent",
  });
  // Grava ao lado da entrada para que `react` resolva no node_modules do projeto.
  const tmp = join(dirname(entry), `.bb-manifest-${process.pid}-${Date.now()}.mjs`);
  await writeFile(tmp, out.outputFiles[0]!.text);
  try {
    const mod = (await import(pathToFileURL(tmp).href)) as { default?: Record<string, unknown> };
    const def = mod.default;
    if (!def || typeof def.render !== "function" || typeof def.name !== "string") {
      throw new Error(`${entry} precisa fazer "export default defineElement({...})"`);
    }
    if (typeof def.display !== "string" || !def.display) throw new Error("defineElement precisa de `display` (nome no Plugin Editor)");
    if (!/^[A-Za-z0-9_-]+$/.test(def.name)) throw new Error(`Nome de elemento inválido ${JSON.stringify(def.name)}: use apenas letras, números, "_" e "-"`);
    return {
      name: def.name,
      display: def.display,
      properties: { ...(def.properties as Record<string, string>) },
      states: [...((def.states as string[] | undefined) ?? [])],
      events: [...((def.events as string[] | undefined) ?? [])],
    };
  } finally {
    await rm(tmp, { force: true });
  }
}

async function bundleBrowser(entry: string, minify: boolean): Promise<string> {
  const contents =
    `import def from ${JSON.stringify(entry)};\n` +
    `import { registerElement } from ${JSON.stringify(runtimePath())};\n` +
    `registerElement(def);\n`;
  const out = await build({
    stdin: { contents, resolveDir: dirname(entry), loader: "ts", sourcefile: "bubble-bridge-entry.ts" },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    minify,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
    write: false,
    logLevel: "silent",
  });
  // Um "</script" literal dentro do bundle fecharia a tag do header.
  return out.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script");
}

/** Código das abas do Plugin Editor. Cada .js é uma expressão `function(...) {...}`, como o editor espera. */
export function generateFiles(m: ElementManifest, bundle: string, sha256: string): Record<string, string> {
  const key = JSON.stringify(m.name);
  const missing = JSON.stringify(`[bubble-bridge] bundle do elemento "${m.name}" não carregou — confira o headers.html do elemento`);
  const lookup = `var r = window.__bubbleBridge && window.__bubbleBridge[${key}];\n  if (!r) { console.error(${missing}); return; }`;
  return {
    "headers.html": `<!-- ${MARKER} element=${m.name} sha256=${sha256} -->\n<script>\n${bundle}\n</script>\n`,
    "initialize.js": `function(instance, context) {\n  // ${MARKER} ${m.name}\n  ${lookup}\n  r.initialize(instance, context);\n}\n`,
    "update.js": `function(instance, properties, context) {\n  // ${MARKER} ${m.name}\n  ${lookup}\n  r.update(instance, properties, context);\n}\n`,
    "reset.js": `function(instance, context) {\n  // ${MARKER} ${m.name}\n  ${lookup}\n  r.reset(instance, context);\n}\n`,
    "preview.js":
      `function(instance, properties) {\n  // ${MARKER} ${m.name} — prévia estática no editor, não depende do bundle\n` +
      `  var c = instance.canvas && instance.canvas.appendChild ? instance.canvas : instance.canvas[0];\n` +
      `  var d = document.createElement("div");\n` +
      `  d.style.cssText = "width:100%;height:100%;display:flex;align-items:center;justify-content:center;font:12px sans-serif;border:1px dashed #98a2b3;color:#475467;box-sizing:border-box";\n` +
      `  d.textContent = ${JSON.stringify(`${m.display} · bubble-bridge`)};\n` +
      `  c.appendChild(d);\n}\n`,
  };
}

interface FoundElement {
  dir: string;
  params: Record<string, unknown>;
}

async function findElementDir(pluginDir: string, display: string): Promise<FoundElement> {
  const elementsDir = join(pluginDir, "elements");
  if (!existsSync(elementsDir)) {
    throw new Error(`${pluginDir} não tem a pasta elements/. Crie o elemento no Plugin Editor e sincronize com o GitHub antes.`);
  }
  const matches: FoundElement[] = [];
  const seen: string[] = [];
  for (const id of await readdir(elementsDir)) {
    const p = join(elementsDir, id, "params.json");
    if (!existsSync(p)) continue;
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`${p} não é um JSON válido: ${err instanceof Error ? err.message : String(err)}`);
    }
    seen.push(String(params.display));
    if (params.display === display) matches.push({ dir: join(elementsDir, id), params });
  }
  if (matches.length === 0) {
    throw new Error(
      `Nenhum elemento com display "${display}" em ${elementsDir}. Encontrados: ${seen.join(", ") || "nenhum"}. ` +
        "Crie o elemento no Plugin Editor (mesmo nome), declare fields, estados e eventos e sincronize.",
    );
  }
  if (matches.length > 1) throw new Error(`Mais de um elemento com display "${display}" — renomeie um deles no Plugin Editor.`);
  return matches[0]!;
}

/**
 * Compara o contrato do código com o params.json. Fields têm formato verificado
 * (fields.<id>.name); estados e eventos não têm exemplo público confirmado, então
 * a checagem é tolerante e avisa quando não consegue confirmar.
 */
export function checkParams(m: ElementManifest, params: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const fields = (params.fields ?? {}) as Record<string, { name?: string }>;
  const bubbleNames = new Set(Object.values(fields).map((f) => f.name).filter((n): n is string => !!n));
  const missing = Object.keys(m.properties).filter((p) => !bubbleNames.has(p));
  if (missing.length) {
    throw new Error(
      `Fields usados no código e ausentes no Plugin Editor: ${missing.join(", ")}. ` +
        `Declare-os no elemento "${m.display}" (o "name" do field precisa ser igual) e sincronize. Existentes: ${[...bubbleNames].join(", ") || "nenhum"}.`,
    );
  }
  const unused = [...bubbleNames].filter((n) => !(n in m.properties));
  if (unused.length) warnings.push(`Fields do Plugin Editor que o código não lê: ${unused.join(", ")}`);

  for (const [kind, declared] of [
    ["states", m.states],
    ["events", m.events],
  ] as const) {
    if (!declared.length) continue;
    const block = params[kind];
    if (!block || typeof block !== "object") {
      warnings.push(
        `Não foi possível confirmar ${kind === "states" ? "os estados" : "os eventos"} no params.json (${declared.join(", ")}). ` +
          "Confira no Plugin Editor que existem com esses nomes exatos.",
      );
      continue;
    }
    const names = new Set(
      Object.entries(block as Record<string, unknown>).flatMap(([k, v]) => {
        const o = (v ?? {}) as Record<string, unknown>;
        return [k, o.name, o.caption].filter((x): x is string => typeof x === "string");
      }),
    );
    const absent = declared.filter((d) => !names.has(d));
    if (absent.length) warnings.push(`${kind} no código e não encontrados no params.json: ${absent.join(", ")}`);
  }
  return warnings;
}

/** Não sobrescreve código escrito à mão: só arquivos cujo hash no marker bate com o conteúdo atual ou funções vazias do template. */
async function guardOverwrite(dir: string, force: boolean): Promise<void> {
  if (force) return;
  const blocked: string[] = [];
  for (const file of ["headers.html", ...CODE_FILES]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const text = await readFile(path, "utf8");
    const { line, rest } = splitMarker(text);
    if (HASH_RE.exec(line)?.[1] === sha(rest)) continue;
    const compact = text.replace(/\s+/g, "");
    if (compact === "" || /^function\([^)]*\)\{\}$/.test(compact)) continue;
    blocked.push(file);
  }
  if (blocked.length) {
    throw new Error(
      `O elemento em ${dir} tem código escrito à mão em: ${blocked.join(", ")}. ` +
        "Mova esse código para o componente ou rode com --force para substituí-lo.",
    );
  }
}
