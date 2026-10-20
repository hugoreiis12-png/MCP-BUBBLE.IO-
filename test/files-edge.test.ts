import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BubbleClient } from "../src/core/client.js";
import { exportToNdjson } from "../src/core/files.js";
import { fakeBubble, makeRows } from "./fake-bubble.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o700);
    rmSync(d, { recursive: true, force: true });
  }
});

describe("exportToNdjson: erro assíncrono do stream", () => {
  it("rejeita sem uncaughtException quando o arquivo não pode ser aberto", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-files-"));
    dirs.push(dir);
    chmodSync(dir, 0o500);
    const fake = fakeBubble({ pedido: makeRows(3) });
    const slow = async (u: string, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 50));
      return fake.fetch(u, init);
    };
    const config = loadConfig({ BUBBLE_APP_URL: "https://meuapp.bubbleapps.io", BUBBLE_MODE: "read-only" });
    const client = new BubbleClient({ appUrl: config.appUrl, env: config.env, fetch: slow });
    const isWin = process.platform === "win32";
    // No Windows, chmod 0o500 em diretório não impede a criação de arquivos.
    // A falha de abertura é provocada colocando um arquivo no caminho do
    // diretório alvo — o mkdir antes do stream rejeita com EEXIST.
    const badDir = isWin ? join(dir, "sem-permissao") : dir;
    if (isWin) writeFileSync(badDir, "bloqueio");
    else chmodSync(dir, 0o500);
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      await expect(exportToNdjson(client, "pedido", badDir, { searchCap: 1000 })).rejects.toThrow(/EACCES|EPERM|ENOENT|EEXIST/);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      if (isWin) rmSync(badDir, { force: true }); // o bloqueio não é do export; some antes da checagem
      process.off("uncaughtException", onUncaught);
    }
    expect(uncaught).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});
