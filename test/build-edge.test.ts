import { cp, mkdir, readdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildElement } from "../src/element/build.js";

const ENTRY = resolve("elements/contador/index.tsx");

async function pluginCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bb-edge-"));
  await cp(resolve("test/fixtures/plugin"), dir, { recursive: true });
  return dir;
}

describe("build: edição manual e nome do elemento", () => {
  it("gerado e depois editado à mão: recusa sem --force, aceita com --force", async () => {
    const repo = await pluginCopy();
    await buildElement({ entry: ENTRY, pluginDir: repo });
    const f = join(repo, "elements/AAX-1/update.js");
    await writeFile(f, (await readFile(f, "utf8")) + "// meu ajuste\n");
    await expect(buildElement({ entry: ENTRY, pluginDir: repo })).rejects.toThrow(/escrito à mão em: update\.js.*--force/s);
    await buildElement({ entry: ENTRY, pluginDir: repo, force: true });
    expect(await readFile(f, "utf8")).not.toContain("meu ajuste");
  });

  it("rebuild sem --force ok; sem arquivo de lock", async () => {
    const repo = await pluginCopy();
    await buildElement({ entry: ENTRY, pluginDir: repo });
    await buildElement({ entry: ENTRY, pluginDir: repo });
    expect(await readdir(join(repo, "elements/AAX-1"))).not.toContain(".bubble-bridge.json");
  });

  it("editar update.js e headers.html => recusa citando ambos", async () => {
    const repo = await pluginCopy();
    await buildElement({ entry: ENTRY, pluginDir: repo });
    for (const f of ["update.js", "headers.html"]) {
      const p = join(repo, "elements/AAX-1", f);
      await writeFile(p, (await readFile(p, "utf8")) + "\n// x\n");
    }
    await expect(buildElement({ entry: ENTRY, pluginDir: repo })).rejects.toThrow(/headers\.html, update\.js.*--force/s);
  });

  it("params.json inválido => erro cita o arquivo", async () => {
    const repo = await pluginCopy();
    const p = join(repo, "elements/AAX-1/params.json");
    await writeFile(p, "{ quebrado");
    await expect(buildElement({ entry: ENTRY, pluginDir: repo })).rejects.toThrow(/AAX-1.params\.json não é um JSON válido/);
  });

  it.each(["hash=zzz", "hash=" + "0".repeat(64), ""])("marker adulterado (%j) => recusa sem exceção de parse", async (bad) => {
    const repo = await pluginCopy();
    await buildElement({ entry: ENTRY, pluginDir: repo });
    const f = join(repo, "elements/AAX-1/reset.js");
    await writeFile(f, (await readFile(f, "utf8")).replace(/hash=[0-9a-f]{64}/, bad));
    await expect(buildElement({ entry: ENTRY, pluginDir: repo })).rejects.toThrow(/escrito à mão em: reset\.js.*--force/s);
  });

  it.each(["../x", "a\nb"])("nome inválido %j => erro", async (name) => {
    const dir = await mkdtemp(join(tmpdir(), "bb-name-"));
    await mkdir(dir, { recursive: true });
    const entry = join(dir, "e.ts");
    await writeFile(entry, `export default { name: ${JSON.stringify(name)}, display: "X", render() {} };\n`);
    await expect(buildElement({ entry, outDir: join(dir, "out") })).rejects.toThrow(/Nome de elemento inválido/);
  });
});
