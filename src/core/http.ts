import { BubbleApiError, extractBubbleMessage, hintForStatus } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: FetchLike;
  maxRetries?: number;
  timeoutMs?: number;
  /** Atraso base do backoff exponencial, em ms. */
  baseDelayMs?: number;
  /** Teto de espera entre tentativas, em ms. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Chamado a cada nova tentativa — usado para log em stderr. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string; endpoint: string }) => void;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Interpreta Retry-After em segundos ou data HTTP. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

function endpointOf(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

/**
 * GET/POST com JSON, timeout e retry. Só repete métodos idempotentes (GET):
 * repetir um POST poderia duplicar um registro ou disparar um workflow duas vezes.
 */
export interface RequestInitLike {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  token?: string;
  /** Corpo serializado como JSON. */
  body?: unknown;
  /** Corpo já serializado (ex.: NDJSON do /bulk). Exclui `body`. */
  rawBody?: string;
  contentType?: string;
  /** `text` devolve o corpo cru (o /bulk responde text/plain, uma linha por item). */
  responseType?: "json" | "text";
  /** Headers extras (ex.: Cookie de sessão do editor). Sobrepõem os padrão. */
  headers?: Record<string, string>;
}

export async function requestJson<T = unknown>(url: string, init: RequestInitLike, opts: HttpOptions = {}): Promise<T> {
  const doFetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const maxRetries = opts.maxRetries ?? 4;
  const baseDelay = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  const method = init.method ?? "GET";
  const idempotent = method === "GET";
  const endpoint = endpointOf(url);

  const headers: Record<string, string> = { Accept: init.responseType === "text" ? "text/plain, application/json" : "application/json" };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  Object.assign(headers, init.headers ?? {});
  const payload = init.rawBody !== undefined ? init.rawBody : init.body === undefined ? undefined : JSON.stringify(init.body);
  if (payload !== undefined) headers["Content-Type"] = init.contentType ?? "application/json";

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (idempotent && attempt < maxRetries) {
        const delayMs = backoff(attempt, baseDelay, maxDelay);
        opts.onRetry?.({ attempt: attempt + 1, delayMs, reason, endpoint });
        await sleep(delayMs);
        continue;
      }
      const hint = idempotent
        ? "verifique BUBBLE_APP_URL e a conectividade"
        : "resultado incerto: a escrita pode ter sido aplicada; confira no banco antes de reenviar";
      throw new BubbleApiError(0, endpoint, `falha de rede: ${reason}`, hint);
    }

    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (init.responseType === "text") return text as T;
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new BubbleApiError(res.status, endpoint, `resposta não é JSON: ${text.slice(0, 200)}`);
      }
    }

    if (idempotent && RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
      const fromHeader = parseRetryAfter(res.headers.get("retry-after"));
      const delayMs = Math.min(fromHeader ?? backoff(attempt, baseDelay, maxDelay), maxDelay);
      await res.body?.cancel().catch(() => undefined);
      opts.onRetry?.({ attempt: attempt + 1, delayMs, reason: `HTTP ${res.status}`, endpoint });
      await sleep(delayMs);
      continue;
    }

    const raw = await res.text().catch(() => "");
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : raw;
    } catch {
      /* corpo não-JSON: usa o texto cru */
    }
    throw new BubbleApiError(
      res.status,
      endpoint,
      extractBubbleMessage(parsed, raw.slice(0, 300) || res.statusText),
      hintForStatus(res.status),
    );
  }
}

/** Backoff exponencial com jitter total (AWS "full jitter"). */
function backoff(attempt: number, base: number, cap: number): number {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.floor(Math.random() * ceiling) + 1;
}
