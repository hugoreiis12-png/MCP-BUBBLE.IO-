import type { BubbleClient, BubbleThing, Constraint } from "./client.js";
import { MAX_PAGE_LIMIT } from "./client.js";

export const CREATED_DATE = "Created Date";

export interface ExportOptions {
  constraints?: Constraint[];
  /** Teto de itens por cursor (50.000 fora do Enterprise). */
  searchCap: number;
  maxItems?: number;
  pageLimit?: number;
  onProgress?: (info: { total: number; window: number }) => void;
}

export interface ExportResult {
  total: number;
  /** Quantas janelas de Created Date foram necessárias. */
  windows: number;
  lastCreatedDate?: string;
}

/**
 * Exporta todos os registros de um tipo, contornando o teto de itens por cursor.
 *
 * Ordena por Created Date crescente e, ao se aproximar do teto, abre uma nova
 * busca a partir da última data vista. A nova janela começa 1 ms antes dessa data
 * e descarta os ids já emitidos naquele instante — assim registros com o mesmo
 * Created Date na fronteira não são perdidos nem duplicados.
 */
export async function exportAll(
  client: BubbleClient,
  type: string,
  sink: (thing: BubbleThing) => void | Promise<void>,
  opts: ExportOptions,
): Promise<ExportResult> {
  const pageLimit = Math.min(opts.pageLimit ?? MAX_PAGE_LIMIT, MAX_PAGE_LIMIT);
  const maxItems = opts.maxItems ?? Infinity;
  // Constraints do usuário são mantidas e combinadas (AND) com a da janela.
  const base = opts.constraints ?? [];

  let total = 0;
  let windows = 0;
  let lowerBound: string | undefined;
  let lastDate: string | undefined;
  let idsAtLastDate = new Set<string>();

  for (;;) {
    windows++;
    const windowStart = lowerBound;
    const constraints: Constraint[] = lowerBound
      ? [...base, { key: CREATED_DATE, constraint_type: "greater than", value: minusOneMs(lowerBound) }]
      : base;

    let cursor = 0;
    let newInWindow = 0;
    let hitCap = false;
    for (;;) {
      const page = await client.list(type, {
        constraints,
        sortField: CREATED_DATE,
        descending: false,
        cursor,
        limit: pageLimit,
      });

      for (const thing of page.results) {
        const created = thing[CREATED_DATE];
        if (typeof created !== "string") {
          throw new Error(`Registro ${thing._id} de "${type}" sem "${CREATED_DATE}" — exportação por janelas exige esse campo`);
        }
        if (created === lastDate && idsAtLastDate.has(thing._id)) continue; // já emitido na janela anterior
        if (total >= maxItems) return { total, windows, lastCreatedDate: lastDate };
        await sink(thing);
        total++;
        newInWindow++;
        if (created === lastDate) {
          idsAtLastDate.add(thing._id);
        } else {
          lastDate = created;
          idsAtLastDate = new Set([thing._id]);
        }
      }
      opts.onProgress?.({ total, window: windows });

      cursor += page.count;
      if (total >= maxItems) return { total, windows, lastCreatedDate: lastDate };
      // O teto vem antes de `remaining`: perto dele não se sabe se o Bubble conta
      // os itens restantes além do teto ou só até ele. Na dúvida, abre nova janela;
      // uma janela sem nenhum registro novo encerra a exportação.
      if (cursor + pageLimit > opts.searchCap) {
        hitCap = true;
        break;
      }
      const exhausted = page.count === 0 || (page.remaining !== undefined ? page.remaining <= 0 : page.count < pageLimit);
      if (exhausted) break;
    }

    if (!hitCap) return { total, windows, lastCreatedDate: lastDate };
    // Bateu no teto sem avançar a data: registros além do teto são inalcançáveis.
    if (newInWindow === 0 || lastDate === undefined || lastDate === windowStart) {
      throw new Error(
        `Mais de ${opts.searchCap} registros de "${type}" com o mesmo Created Date (${lastDate}); ` +
          "a exportação por janelas não consegue avançar. Adicione uma constraint que divida o conjunto.",
      );
    }
    lowerBound = lastDate;
  }
}

function minusOneMs(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`Created Date inválido: ${iso}`);
  return new Date(t - 1).toISOString();
}
