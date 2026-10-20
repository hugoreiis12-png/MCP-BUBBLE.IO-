import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTypes } from "../src/core/codegen.js";
import { normalizeSwagger } from "../src/core/schema.js";

const f = (name: string) => ({ name, kind: "string" as const, list: false });
const schema = (names: string[]) => ({
  format: "swagger2" as const,
  types: names.map((name) => ({ name, operations: [], fields: [f("a")] })),
  workflows: [],
  warnings: [],
});
// typescript 7 não expõe API JS: compila via CLI tsc do pacote local
// (spawn de "npx" direto falha com ENOENT no Windows, pois é um .cmd).
const tsc = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
const errors = (code: string): string[] => {
  const dir = mkdtempSync(join(tmpdir(), "cg-"));
  writeFileSync(join(dir, "x.ts"), code);
  const r = spawnSync(process.execPath, [tsc, "--noEmit", "--ignoreConfig", "--strict", "--types", "", join(dir, "x.ts")], { encoding: "utf8" });
  rmSync(dir, { recursive: true });
  return r.status === 0 ? [] : [r.stdout || r.stderr || "tsc falhou sem saída"];
};

describe("codegen edge", () => {
  it("neutraliza */ e quebras de linha no comentário", () => {
    const out = generateTypes(schema(["x */\nexport const pwn = 1; /*"]));
    expect(out).not.toContain("\nexport const pwn");
    expect(out.split("\n").filter((l) => l.startsWith("/** Data API")).every((l) => l.endsWith("*/") && l.indexOf("*/") === l.length - 2)).toBe(true);
  });

  it("path com % inválido não lança e avisa", () => {
    const r = normalizeSwagger({ swagger: "2.0", paths: { "/obj/100%": { get: {} }, "/wf/a%": { post: {} } } });
    expect(r.types[0]!.name).toBe("100%");
    expect(r.workflows[0]!.name).toBe("a%");
    expect(r.warnings.filter((w) => w.includes("inválido"))).toHaveLength(2);
  });

  it("nomes colidentes com globais/fixos compilam", () => {
    const out = generateTypes(schema(["record", "bubble types", "date"]));
    expect(out).toContain("interface Record2");
    expect(errors(out)).toEqual([]);
  });

  it("parâmetro duplicado (query+body) é deduplicado", () => {
    const r = normalizeSwagger({
      swagger: "2.0",
      paths: {
        "/wf/go": {
          post: {
            parameters: [
              { name: "x", in: "query", type: "string" },
              { in: "body", schema: { properties: { x: { type: "string" } } } },
            ],
          },
        },
      },
    });
    expect(r.workflows[0]!.params.map((p) => p.name)).toEqual(["x"]);
    expect(errors(generateTypes(r))).toEqual([]);
  });
});
