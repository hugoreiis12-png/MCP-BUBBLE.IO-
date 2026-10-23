import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BubbleClient } from "../src/core/client.js";
import { deployPage, checkPageContract, slugFromFile } from "../src/core/pages.js";
import { WriteRefused } from "../src/core/writes.js";
import { fakeBubble } from "./fake-bubble.js";
import type { NormalizedSchema } from "../src/core/schema.js";

const CONFIG = loadConfig({
  BUBBLE_APP_URL: "https://meuapp.bubbleapps.io",
  BUBBLE_EXPORT_DIR: "exports",
});

const PAGE_TYPE: NormalizedSchema = {
  format: "swagger2",
  types: [
    {
      name: "paginas",
      operations: ["GET collection", "POST collection", "PATCH by-id"],
      fields: [
        { name: "pagina", kind: "string", list: false },
        { name: "html", kind: "string", list: false },
      ],
    },
  ],
  workflows: [],
  warnings: [],
};

function clientFor(data: Record<string, Array<Record<string, unknown>>>, env: "test" | "live" = "test") {
  const fake = fakeBubble(data as never);
  const client = new BubbleClient({
    appUrl: "https://meuapp.bubbleapps.io",
    env,
    fetch: fake.fetch,
    sleep: async () => undefined,
  });
  return { client, fake };
}

async function page(dir: string, html = "<html><body>dashboard</body></html>"): Promise<string> {
  const file = join(dir, "dashboard.html");
  await writeFile(file, html, "utf8");
  return file;
}

describe("slugFromFile", () => {
  it("derive slug do nome do arquivo", () => {
    expect(slugFromFile("pages\\Minha Página 2.html")).toBe("minha-pagina-2");
    expect(slugFromFile("/tmp/index.html")).toBe("index");
  });
});

describe("checkPageContract", () => {
  it("erro quando tipo não está na Data API", () => {
    expect(checkPageContract({ ...PAGE_TYPE, types: [] }, "paginas", "pagina", "html").errors).toHaveLength(1);
  });
  it("erro quando campo não está exposto", () => {
    expect(checkPageContract({ ...PAGE_TYPE, types: [{ ...PAGE_TYPE.types[0]!, fields: [] }] }, "paginas", "pagina", "html").errors.some((e) => e.includes("pagina, html"))).toBe(true);
  });
  it("erro quando POST não está exposto e aviso quando PATCH não está", () => {
    const ops = { ...PAGE_TYPE, types: [{ ...PAGE_TYPE.types[0]!, operations: ["GET collection"] }] };
    const c = checkPageContract(ops, "paginas", "pagina", "html");
    expect(c.errors).toHaveLength(1);
    expect(c.warnings).toHaveLength(1);
  });
});

describe("deployPage", () => {
  it("dry-run cria plano sem escrever", async () => {
    const { client, fake } = clientFor({ paginas: [{ _id: "p1", "pagina": "dashboard", "html": "velho" }] });
    const file = await page(tmpdir());
    const r = await deployPage(CONFIG, client, {
      file,
      type: "paginas",
      keyField: "pagina",
      htmlField: "html",
      slug: "dashboard",
      schema: PAGE_TYPE,
      execute: false,
    });
    expect(r.action).toBe("update");
    expect(r.id).toBe("p1");
    expect(r.dry_run).toBe(true);
    expect(fake.writes).toHaveLength(0);
    expect(r.aviso).toContain("--execute");
  });

  it("executa criação quando slug ainda não existe", async () => {
    const { client, fake } = clientFor({ paginas: [] });
    const file = await page(tmpdir());
    const r = await deployPage(CONFIG, client, {
      file,
      type: "paginas",
      keyField: "pagina",
      htmlField: "html",
      slug: "dashboard",
      schema: PAGE_TYPE,
      execute: true,
    });
    expect(r.action).toBe("create");
    expect(r.id).toBeTruthy();
    expect(fake.writes).toHaveLength(1);
    const body = JSON.parse(fake.writes[0]!.body!);
    expect(body.pagina).toBe("dashboard");
    expect(body.html).toContain("dashboard");
  });

  it("executa update quando o registro já existe e evita duplicata", async () => {
    const { client, fake } = clientFor({ paginas: [{ _id: "p1", "pagina": "dashboard", "html": "velho" }] });
    const file = await page(tmpdir(), "<html>NOVO</html>");
    const r = await deployPage(CONFIG, client, {
      file,
      type: "paginas",
      keyField: "pagina",
      htmlField: "html",
      slug: "dashboard",
      schema: PAGE_TYPE,
      execute: true,
    });
    expect(r.action).toBe("update");
    expect(r.id).toBe("p1");
    const patch = fake.writes.find((w) => w.method === "PATCH");
    expect(patch).toBeTruthy();
    expect(JSON.parse(patch!.body!).html).toContain("NOVO");
  });

  it("avisa quando há registros duplicados com a mesma chave", async () => {
    const { client } = clientFor({
      paginas: [
        { _id: "p1", "pagina": "dashboard" },
        { _id: "p2", "pagina": "dashboard" },
      ],
    });
    const file = await page(tmpdir());
    const r = await deployPage(CONFIG, client, {
      file,
      type: "paginas",
      keyField: "pagina",
      htmlField: "html",
      slug: "dashboard",
      schema: PAGE_TYPE,
      execute: false,
    });
    expect(r.action).toBe("update");
    expect(r.warnings.some((w) => w.includes("2 registros"))).toBe(true);
  });

  it("bloqueia deploy no live sem BUBBLE_ALLOW_LIVE_WRITES", async () => {
    const liveConfig = loadConfig({ BUBBLE_APP_URL: "https://meuapp.bubbleapps.io", BUBBLE_ENV: "live" });
    const { client } = clientFor({ paginas: [] }, "live");
    const file = await page(tmpdir());
    await expect(
      deployPage(liveConfig, client, {
        file,
        type: "paginas",
        keyField: "pagina",
        htmlField: "html",
        slug: "dashboard",
        schema: PAGE_TYPE,
        execute: true,
      }),
    ).rejects.toBeInstanceOf(WriteRefused);
  });

  it("recusa quando o contrato do swagger reprovou o tipo", async () => {
    const { client } = clientFor({ paginas: [] });
    const file = await page(tmpdir());
    await expect(
      deployPage(CONFIG, client, {
        file,
        type: "outro_tipo",
        keyField: "pagina",
        htmlField: "html",
        slug: "dashboard",
        schema: PAGE_TYPE,
        execute: true,
      }),
    ).rejects.toThrow(/não está exposto/);
  });

  it("segue com aviso quando o swagger não está disponível", async () => {
    const { client, fake } = clientFor({ paginas: [] });
    const file = await page(tmpdir());
    const r = await deployPage(CONFIG, client, {
      file,
      type: "paginas",
      keyField: "pagina",
      htmlField: "html",
      slug: "dashboard",
      // swagger indisponível no app — validação degenera em aviso
      schema: undefined,
      execute: true,
    });
    expect(r.warnings.some((w) => w.includes("swagger indisponível"))).toBe(true);
    expect(r.action).toBe("create");
    expect(fake.writes).toHaveLength(1);
  });
});
