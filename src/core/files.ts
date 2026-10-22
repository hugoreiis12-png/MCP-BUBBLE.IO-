import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import type { BubbleClient } from "./client.js";
import { exportAll, type ExportOptions, type ExportResult } from "./export.js";

/** Nome de arquivo seguro: sem separadores de caminho nem caracteres de controle. */
export function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, 80) || "tipo";
}

/** Exporta um tipo para NDJSON dentro de `exportDir`; o caminho final nunca sai desse diretório. */
export async function exportToNdjson(
  client: BubbleClient,
  type: string,
  exportDir: string,
  opts: ExportOptions,
): Promise<ExportResult & { file: string }> {
  const dir = resolve(exportDir);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${safeSegment(type)}-${client.env}-${stamp}.ndjson`);
  const out = createWriteStream(file, { encoding: "utf8", mode: 0o600 });
  let streamErr: Error | undefined;
  out.on("error", (e) => (streamErr ??= e)); // sem listener, erro assíncrono derruba o processo
  try {
    const result = await exportAll(
      client,
      type,
      async (thing) => {
        if (streamErr) throw streamErr;
        if (!out.write(JSON.stringify(thing) + "\n")) await once(out, "drain");
      },
      opts,
    );
    if (streamErr) throw streamErr;
    out.end();
    await once(out, "finish");
    return { ...result, file };
  } catch (err) {
    out.destroy();
    await rm(file, { force: true }); // não deixa export parcial passar por completo
    throw err;
  }
}

/**
 * Grava o design exportado pelo editor (o arquivo `.bubble`).
 *
 * É a entrada do Motor 2 (compilador TS → `.bubble`): o export real do app é
 * a única fonte que descreve o formato de design que o Bubble aceita.
 * Fica em texto claro no disco, como os exports de dados — o diretório é
 * ignorado pelo git.
 */
export async function writeDesignExport(
  content: string,
  exportDir: string,
  appId: string,
  version: string,
): Promise<{ file: string; bytes: number; sha256: string }> {
  const dir = resolve(exportDir, "design");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${safeSegment(appId)}-${safeSegment(version)}-${stamp}.bubble`);
  await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  return {
    file,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}
