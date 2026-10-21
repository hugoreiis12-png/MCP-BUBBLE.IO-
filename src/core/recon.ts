import { requestJson, type HttpOptions } from "./http.js";
import { BubbleApiError } from "./errors.js";

/** Categorias que definem a gravidade de um campo lido por um atacante anônimo. */
export type FindingKind = "credential" | "pii" | "sensitive";

export interface FieldPattern {
  kind: FindingKind;
  label: string;
  re: RegExp;
}

/**
 * Heurística de classificação por nome de campo. Não substitui análise jurídica:
 * serve para ordenar o que atacar primeiro. "sensitive" = segredo operacional,
 * "pii" = dado pessoal (LGPD art. 5º), "credential" = segredo reutilizável.
 */
export const FIELD_PATTERNS: FieldPattern[] = [
  {
    kind: "credential",
    label: "credencial/segredo reutilizável",
    re: /senha|password|passwd|\btoken\b|secret|api[\s_-]?key|chave\s*(de\s*)?(atentic|autoriz|autent|privada)|private[\s_-]?key/i,
  },
  {
    kind: "pii",
    label: "dado pessoal (LGPD art. 5º)",
    re: /\bcpf\b|\bcnpj\b|\brg\b|passaporte|nascimento|nascid|\bnome\b|sobrenome|email|e-mail|telefone|celular|\bcel\b|whats|endereco|\brua\b|\bcep\b|cidade|\buf\b|matricula|carteira|beneficiario|dependente|salario|remuneracao|placa|latitude|longetude|\blat\b|\blong\b|\bgps\b/i,
  },
  {
    kind: "sensitive",
    label: "dado sensível de negócio",
    re: /chave|assinatura|assinado|contacorrente|\bconta\b|agencia|\bsaldo\b|\bbanco\b|\bpix\b|cartao|boleto|nota\s*fiscal|contrato|curriculo|medico|saude|diagnost/i,
  },
];

/** Nomes de tipo que sugerem dado sensível — usado pelo escopo `sensitive` do sweep. */
export const SENSITIVE_TYPE_RE =
  /cpf|cnpj|\brg\b|senha|password|token|chave|secret|assinatur|document|colaborador|funcionari|contacorrente|conta|agencia|salario|saude|medic|diagnost|endereco|telefone|celular|email|veicul|placa|rh\b|ponto|ferram|documento|log_|auditoria/i;

export type ExposureLevel = "none" | "low" | "high" | "critical";

const RANK: Record<ExposureLevel, number> = { none: 0, low: 1, high: 2, critical: 3 };

export interface FieldFinding {
  field: string;
  kind: FindingKind;
  label: string;
}

export interface ExposureResult {
  type: string;
  apiRoot: string;
  status: number;
  /** true = respondeu 200 com pelo menos um registro para um GET sem token. */
  exposed: boolean;
  count: number;
  remaining: number;
  fields: string[];
  findings: FieldFinding[];
  level: ExposureLevel;
  /** Valores mascarados; só presente quando include_sample=true. */
  sample?: Record<string, string>;
  error?: string;
}

export interface ProbeOptions {
  apiRoot: string;
  type: string;
  /** Transportes injetados (fetch de teste, timeout, backoff). */
  http?: HttpOptions;
  /** Registros lidos só para extrair nomes de campo. Não grava nada. */
  fieldScanLimit?: number;
  includeSample?: boolean;
}

const SAMPLE_KEYS = 8;

/**
 * GET na Data API **sem o header Authorization**: é o ponto de vista do atacante.
 * Qualquer 200 com resultados significa que a privacy rule do tipo permite leitura
 * por "everyone", independentemente de token — o leak é do app, não do token.
 */
export async function probeAnonymous(opts: ProbeOptions): Promise<ExposureResult> {
  const limit = Math.min(Math.max(opts.fieldScanLimit ?? 5, 1), 20);
  const url = `${opts.apiRoot}/obj/${encodeURIComponent(opts.type)}?limit=${limit}`;
  const base = { type: opts.type, apiRoot: opts.apiRoot, status: 0, exposed: false, count: 0, remaining: 0, fields: [], findings: [], level: "none" as ExposureLevel };
  try {
    const res = await requestJson<{ response?: { results?: unknown[]; count?: number; remaining?: number } }>(
      url,
      { method: "GET" },
      opts.http ?? {},
    );
    const response = res?.response;
    const results = Array.isArray(response?.results) ? response.results : [];
    const fields = fieldsOf(results);
    const findings = classify(fields);
    const exposed = results.length > 0;
    return {
      ...base,
      status: 200,
      exposed,
      count: response?.count ?? results.length,
      remaining: response?.remaining ?? 0,
      fields,
      findings,
      level: levelOf(exposed, findings),
      sample: opts.includeSample ? redactSample(results[0]) : undefined,
    };
  } catch (err) {
    const status = typeof (err as { status?: number }).status === "number" ? (err as { status: number }).status : 0;
    return { ...base, status, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface SweepOptions extends Omit<ProbeOptions, "type"> {
  types: string[];
  concurrency?: number;
  onProgress?: (done: number, total: number, type: string) => void;
}

export interface SweepResult {
  apiRoot: string;
  probed: number;
  exposed: number;
  critical: number;
  high: number;
  /** Tipos que responderam 200 sem nenhum registro: privacy rule fecha a leitura. */
  closed: number;
  /** Ordenado por gravidade; só o que respondeu com dados entra aqui. */
  leaks: ExposureResult[];
  errors: Array<{ type: string; status: number; message: string }>;
}

/** Varre tipos com limite de concorrência. GET anônimo em N tipos é tráfego de varredura. */
export async function sweepAnonymous(opts: SweepOptions): Promise<SweepResult> {
  const queue = [...opts.types];
  const leaks: ExposureResult[] = [];
  const errors: SweepResult["errors"] = [];
  const workers = Math.min(Math.max(opts.concurrency ?? 4, 1), 8);
  let done = 0;
  const runOne = async (type: string) => {
    const r = await probeAnonymous({ ...opts, type });
    if (r.exposed) leaks.push(r);
    else if (r.status !== 200) errors.push({ type, status: r.status, message: r.error ?? "" });
    done++; // fora do ?.() — com optional call os argumentos não são avaliados
    opts.onProgress?.(done, opts.types.length, type);
  };
  // Pool por índice: cada worker pega o próximo item atomicamente (next++ síncrono antes do await).
  let next = 0;
  const consume = async () => {
    for (;;) {
      const i = next++;
      if (i >= queue.length) return;
      await runOne(queue[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, consume));
  leaks.sort((a, b) => RANK[b.level] - RANK[a.level] || b.remaining - a.remaining);
  return {
    apiRoot: opts.apiRoot,
    probed: opts.types.length,
    exposed: leaks.length,
    critical: leaks.filter((l) => l.level === "critical").length,
    high: leaks.filter((l) => l.level === "high").length,
    closed: done - leaks.length - errors.length,
    leaks,
    errors,
  };
}

/** "critical" = credencial exposta; "high" = dado pessoal; "low" = dado de negócio; "none" = fechado. */
export function levelOf(exposed: boolean, findings: FieldFinding[]): ExposureLevel {
  if (!exposed) return "none";
  if (findings.some((f) => f.kind === "credential")) return "critical";
  if (findings.some((f) => f.kind === "pii")) return "high";
  if (findings.some((f) => f.kind === "sensitive")) return "high";
  return "low";
}

export interface WorkflowExposureResult {
  workflow: string;
  apiRoot: string;
  status: number;
  /** true = o workflow respondeu sem exigir autenticação (o 401 do Bubble não apareceu). */
  exposed: boolean;
  /** true = o /meta do app declara este workflow como `auth_unecessary`. */
  declaredPublic: boolean;
  /** Mensagem de erro/sucesso devolvida pelo app (corta o payload bruto). */
  message?: string;
  /** Amostra mascarada da resposta; só quando include_sample=true. */
  sample?: Record<string, string>;
  error?: string;
}

export interface WorkflowProbeOptions {
  apiRoot: string;
  workflow: string;
  http?: HttpOptions;
  includeSample?: boolean;
}

/**
 * POST em `/wf/{name}` **sem o header Authorization**, com corpo vazio.
 *
 * O Bubble responde 401 ("You must authenticate to call this method") quando o
 * workflow exige sessão. Qualquer outra resposta (200, 400 complaining de campo
 * faltando, 500) prova que o workflow foi alcançado por um atacante anônimo —
 * falta só o payload, que o atacante também tem.
 *
 * Efeito colateral: um workflow com nome destrutivo pode agir mesmo com corpo
 * vazio. Por isso o sweep ignora os nomes perigosos, salvo pedido explícito.
 */
export async function probeAnonymousWorkflow(opts: WorkflowProbeOptions): Promise<WorkflowExposureResult> {
  const url = `${opts.apiRoot}/wf/${encodeURIComponent(opts.workflow)}`;
  const base = { workflow: opts.workflow, apiRoot: opts.apiRoot, status: 0, exposed: false, declaredPublic: false };
  try {
    const res = await requestJson<Record<string, unknown>>(url, { method: "POST", body: {} }, opts.http ?? {});
    return {
      ...base,
      status: 200,
      exposed: true,
      message: typeof res?.status === "string" ? `status=${res.status}` : "respondeu 200 sem autenticação",
      ...(opts.includeSample ? { sample: redactSample(res) } : {}),
    };
  } catch (err) {
    const status = typeof (err as { status?: number }).status === "number" ? (err as { status: number }).status : 0;
    const message = err instanceof BubbleApiError ? err.bubbleMessage : err instanceof Error ? err.message : String(err);
    const exposed = status !== 401 && status !== 0;
    return {
      ...base,
      status,
      exposed,
      message: message.slice(0, 300),
    };
  }
}

/** Nomes que sugerem efeito colateral: não são sondados sem lista explícita. */
export const DESTRUCTIVE_WORKFLOW_RE =
  /(delete|remove|apagar|excluir|drop|truncate|purge|desativar|disable|send|enviar|email|cobrar|pagar|pagamento|payment|deploy|publish)/i;

export interface WorkflowSweepOptions {
  apiRoot: string;
  workflows: string[];
  concurrency?: number;
  includeSample?: boolean;
  http?: HttpOptions;
  /** Ignora o filtro de nomes destrutivos (exige lista explícita do operador). */
  allowDestructive?: boolean;
}

export interface WorkflowSweepResult {
  apiRoot: string;
  probed: number;
  exposed: number;
  /** Workflows que o app declara públicos no /meta (sem tráfego extra). */
  declaredPublic: string[];
  leaks: WorkflowExposureResult[];
  errors: Array<{ workflow: string; status: number; message: string }>;
}

/** Sonda vários workflows sem token, com limite de concorrência. */
export async function sweepAnonymousWorkflows(opts: WorkflowSweepOptions): Promise<WorkflowSweepResult> {
  const targets = opts.allowDestructive ? opts.workflows : opts.workflows.filter((w) => !DESTRUCTIVE_WORKFLOW_RE.test(w));
  const leaks: WorkflowExposureResult[] = [];
  const errors: WorkflowSweepResult["errors"] = [];
  let next = 0;
  const workers = Math.min(Math.max(opts.concurrency ?? 4, 1), 8);
  const consume = async () => {
    for (;;) {
      const i = next++;
      if (i >= targets.length) return;
      const name = targets[i]!;
      const r = await probeAnonymousWorkflow({
        apiRoot: opts.apiRoot,
        workflow: name,
        includeSample: opts.includeSample,
        http: opts.http,
      });
      if (r.exposed) leaks.push(r);
      else if (r.status !== 401) errors.push({ workflow: name, status: r.status, message: r.error ?? r.message ?? "" });
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, targets.length) }, consume));
  leaks.sort((a, b) => b.status - a.status || a.workflow.localeCompare(b.workflow));
  return {
    apiRoot: opts.apiRoot,
    probed: targets.length,
    exposed: leaks.length,
    declaredPublic: [],
    leaks,
    errors,
  };
}

const KIND_RANK: Record<FindingKind, number> = { credential: 0, pii: 1, sensitive: 2 };

/** Classifica campos e devolve ordenado por gravidade (credencial > pessoal > sensível). */
export function classify(fields: string[]): FieldFinding[] {
  const out: FieldFinding[] = [];
  for (const field of fields) {
    for (const p of FIELD_PATTERNS) {
      if (p.re.test(field)) {
        out.push({ field, kind: p.kind, label: p.label });
        break;
      }
    }
  }
  return out.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

function fieldsOf(results: unknown[]): string[] {
  const set = new Set<string>();
  for (const r of results) {
    if (r && typeof r === "object") for (const k of Object.keys(r as Record<string, unknown>)) set.add(k);
  }
  return [...set].sort();
}

/** Amostra mascarada: o suficiente para reconhecer o registro, sem despejar PII no contexto. */
export function redactSample(record: unknown): Record<string, string> | undefined {
  if (!record || typeof record !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record as Record<string, unknown>).slice(0, SAMPLE_KEYS)) {
    out[k] = mask(v);
  }
  return out;
}

function mask(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.length} itens]`;
  const s = String(v);
  return s.length <= 4 ? `${s} (${s.length} car.)` : `${s.slice(0, 2)}…${s.slice(-2)} (${s.length} car.)`;
}
