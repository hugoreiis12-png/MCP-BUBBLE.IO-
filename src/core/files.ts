import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
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
