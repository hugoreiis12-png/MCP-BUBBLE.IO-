import type { BubbleEnv } from "../config.js";
import { requestJson, type HttpOptions } from "./http.js";

/** Tipos de constraint aceitos pela Data API (manual: Data API requests). */
export const CONSTRAINT_TYPES = [
  "equals",
  "not equal",
  "is_empty",
  "is_not_empty",
  "text contains",
  "not text contains",
  "greater than",
  "less than",
  "in",
  "not in",
  "contains",
  "not contains",
  "empty",
  "not empty",
  "geographic_search",
] as const;
export type ConstraintType = (typeof CONSTRAINT_TYPES)[number];

export interface Constraint {
  key: string;
  constraint_type: ConstraintType;
  value?: unknown;
}

export interface SortField {
  sort_field: string;
  descending?: boolean;
}

export interface ListOptions {
  constraints?: Constraint[];
  sortField?: string;
  descending?: boolean;
  additionalSortFields?: SortField[];
  cursor?: number;
  limit?: number;
  /** Não conta os itens restantes — poupa capacidade em tabelas grandes. */
  excludeRemaining?: boolean;
}

/** Registro do Bubble: sempre tem `_id`; os demais campos dependem do tipo. */
export type BubbleThing = { _id: string } & Record<string, unknown>;

export interface ListPage {
  cursor: number;
  results: BubbleThing[];
  count: number;
  /** Ausente quando `excludeRemaining` é usado. */
  remaining?: number;
}

/**
 * Tamanho máximo de página que usamos. O manual não fixa o teto do `limit`;
 * 100 é o valor amplamente observado — <VERIFICAR> contra o app real na PoC-1.
 */
export const MAX_PAGE_LIMIT = 100;

export interface ClientOptions extends HttpOptions {
  appUrl: string;
  env: BubbleEnv;
  token?: string;
}

/** Raiz da API 1.1: `/version-test` no branch de desenvolvimento, app publicado no live. */
export function apiRootFor(appUrl: string, env: BubbleEnv): string {
  const base = appUrl.replace(/\/+$/, "");
  return env === "test" ? `${base}/version-test/api/1.1` : `${base}/api/1.1`;
}

/** Cliente somente-leitura da Data API e do endpoint /meta. */
export class BubbleClient {
  readonly env: BubbleEnv;
  readonly apiRoot: string;
  private readonly token?: string;
  private readonly http: HttpOptions;

  constructor(opts: ClientOptions) {
    this.env = opts.env;
    this.token = opts.token;
    this.apiRoot = apiRootFor(opts.appUrl, opts.env);
    const { appUrl: _a, env: _e, token: _t, ...http } = opts;
    this.http = http;
  }

  /** Opções de transporte injetadas (fetch de teste, backoff). Usado pela auditoria de exposição. */
  get httpOptions(): HttpOptions {
    return this.http;
  }

  /** Lista de tipos e workflows expostos (formato não documentado — retornado cru). */
  meta(): Promise<unknown> {
    return this.get(`${this.apiRoot}/meta`);
  }

  /** Especificação Swagger gerada pelo Bubble (exige "Enable Swagger documentation" nas settings). */
  swagger(): Promise<unknown> {
    return this.get(`${this.apiRoot}/meta/swagger.json`);
  }

  async getThing(type: string, id: string): Promise<BubbleThing> {
    const res = await this.get<{ response: BubbleThing }>(`${this.objUrl(type)}/${encodeURIComponent(id)}`);
    return res.response;
  }

  async list(type: string, opts: ListOptions = {}): Promise<ListPage> {
    const limit = clampLimit(opts.limit);
    const qs = new URLSearchParams();
    if (opts.constraints?.length) qs.set("constraints", JSON.stringify(opts.constraints));
    if (opts.sortField) qs.set("sort_field", opts.sortField);
    if (opts.descending !== undefined) qs.set("descending", String(opts.descending));
    if (opts.additionalSortFields?.length) qs.set("additional_sort_fields", JSON.stringify(opts.additionalSortFields));
    qs.set("cursor", String(Math.max(0, opts.cursor ?? 0)));
    qs.set("limit", String(limit));
    if (opts.excludeRemaining) qs.set("exclude_remaining", "true");

    const res = await this.get<{ response: ListPage }>(`${this.objUrl(type)}?${qs.toString()}`);
    if (!res?.response || !Array.isArray(res.response.results)) {
      throw new Error(`Resposta inesperada da Data API para o tipo "${type}": falta response.results`);
    }
    return res.response;
  }

  /**
   * Percorre todas as páginas de uma busca. Para quando `remaining` chega a 0,
   * quando uma página volta incompleta ou quando `maxItems` é atingido.
   * Não contorna o teto de 50.000 itens por cursor — para isso use exportAll.
   */
  async *iterate(type: string, opts: ListOptions = {}, maxItems = Infinity): AsyncGenerator<BubbleThing> {
    const limit = clampLimit(opts.limit ?? MAX_PAGE_LIMIT);
    let cursor = opts.cursor ?? 0;
    let yielded = 0;
    while (yielded < maxItems) {
      const page = await this.list(type, { ...opts, cursor, limit });
      for (const item of page.results) {
        if (yielded >= maxItems) return;
        yield item;
        yielded++;
      }
      cursor += page.count;
      const done = page.remaining !== undefined ? page.remaining <= 0 : page.count < limit;
      if (done || page.count === 0) return;
    }
  }

  // ---- Escrita. Nunca repetida automaticamente (ver http.ts). Guardas ficam em writes.ts. ----

  /** POST /obj/{type} → id do registro criado. */
  async create(type: string, fields: Record<string, unknown>): Promise<string> {
    const res = await this.send<{ status: string; id: string }>("POST", this.objUrl(type), fields);
    if (!res?.id) throw new Error(`Criação em "${type}" não devolveu id`);
    return res.id;
  }

  /**
   * POST /obj/{type}/bulk (text/plain, um JSON por linha, até 1.000).
   * Devolve uma linha de status por item, na ordem enviada; itens aceitos são
   * criados mesmo que outros falhem.
   */
  async bulkCreate(type: string, items: Record<string, unknown>[]): Promise<BulkLine[]> {
    if (items.length === 0) return [];
    if (items.length > BULK_MAX) throw new Error(`Bulk aceita no máximo ${BULK_MAX} itens por requisição`);
    const body = items.map((i) => JSON.stringify(i)).join("\n");
    const text = await requestJson<string>(
      `${this.objUrl(type)}/bulk`,
      { method: "POST", token: this.token, rawBody: body, contentType: "text/plain", responseType: "text" },
      this.http,
    );
    return parseBulkResponse(text, items.length);
  }

  /** PATCH /obj/{type}/{id} — altera só os campos enviados. PUT nunca é usado (zera os omitidos). */
  async update(type: string, id: string, fields: Record<string, unknown>): Promise<void> {
    await this.send("PATCH", `${this.objUrl(type)}/${encodeURIComponent(id)}`, fields);
  }

  async delete(type: string, id: string): Promise<void> {
    await this.send("DELETE", `${this.objUrl(type)}/${encodeURIComponent(id)}`);
  }

  /** POST /wf/{name} — executa um backend workflow exposto. */
  runWorkflow(name: string, params: Record<string, unknown>): Promise<unknown> {
    if (!name || /[\/?#]/.test(name)) throw new Error(`Nome de workflow inválido: "${name}"`);
    return this.send("POST", `${this.apiRoot}/wf/${encodeURIComponent(name)}`, params);
  }

  private send<T>(method: "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
    return requestJson<T>(url, { method, token: this.token, body }, this.http);
  }

  private objUrl(type: string): string {
    if (!type || /[\/?#]/.test(type)) throw new Error(`Nome de tipo inválido: "${type}"`);
    return `${this.apiRoot}/obj/${encodeURIComponent(type)}`;
  }

  private get<T>(url: string): Promise<T> {
    return requestJson<T>(url, { method: "GET", token: this.token }, this.http);
  }
}

/** Teto documentado do endpoint /bulk. */
export const BULK_MAX = 1000;

export type BulkLine = { status: "success"; id: string } | { status: "error"; message: string };

/** Uma linha JSON por item; linha ilegível vira erro daquele item, não da chamada inteira. */
export function parseBulkResponse(text: string, expected: number): BulkLine[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const out: BulkLine[] = lines.map((l) => {
    try {
      const o = JSON.parse(l) as { status?: string; id?: string; message?: string };
      return o.status === "success" && o.id
        ? { status: "success", id: o.id }
        : { status: "error", message: o.message ?? l.slice(0, 200) };
    } catch {
      return { status: "error", message: `linha ilegível: ${l.slice(0, 200)}` };
    }
  });
  if (out.length !== expected) {
    // Erro genérico (timeout, falta de capacidade) pode vir sem uma linha por item.
    throw new Error(
      `Bulk devolveu ${out.length} linhas para ${expected} itens — resultado incerto; confira no banco antes de reenviar. Resposta: ${text.slice(0, 300)}`,
    );
  }
  return out;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_PAGE_LIMIT;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(limit)));
}
