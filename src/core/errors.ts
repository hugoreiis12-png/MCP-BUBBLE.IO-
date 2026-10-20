/** Erro de uma chamada à API do Bubble, com contexto suficiente para diagnóstico. */
export class BubbleApiError extends Error {
  constructor(
    readonly status: number,
    /** Endpoint sem query string (a query pode conter dados sensíveis). */
    readonly endpoint: string,
    readonly bubbleMessage: string,
    readonly hint?: string,
  ) {
    super(`Bubble API ${status} em ${endpoint}: ${bubbleMessage}${hint ? ` — ${hint}` : ""}`);
    this.name = "BubbleApiError";
  }
}

/**
 * Extrai a mensagem dos dois formatos de erro documentados pelo Bubble:
 * `{statusCode, body: {status, message}}` e `{error_class, translation}`.
 */
export function extractBubbleMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const inner = b.body as Record<string, unknown> | undefined;
    if (inner && typeof inner.message === "string") {
      return typeof inner.status === "string" ? `${inner.status}: ${inner.message}` : inner.message;
    }
    if (typeof b.translation === "string") return b.translation;
    if (typeof b.message === "string") return b.message;
  }
  return fallback;
}

/** Dica de correção por status, baseada nas listas de "Errors and solutions" do manual. */
export function hintForStatus(status: number): string | undefined {
  switch (status) {
    case 400:
      return "confira nome e formato dos campos e o tipo de constraint";
    case 401:
      return "token ausente/errado ou privacy rule não permite a operação via API";
    case 404:
      return "tipo não ativado na Data API, settings não deployadas para live, id inexistente ou ambiente (test/live) errado";
    case 429:
      return "rate limit do app atingido; reduza o ritmo ou o tamanho dos lotes";
    default:
      return undefined;
  }
}
