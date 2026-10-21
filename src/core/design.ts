/**
 * Contrato de design do app: a mesma informação que o editor do Bubble
 * enxerga, lida do endpoint que o Bubble publica para o token da API
 * (`GET {apiRoot}/meta`).
 *
 * O /meta carrega mais que o swagger e mais que a Data API:
 * - tipos com o **id interno** de cada campo (é por ele que o runtime e o
 *   editor endereçam um campo — o nome de exibição serve só para o humano);
 * - a taxonomia real do Bubble (`custom.<tipo>`, `list.<tipo>`, `option.<option set>`),
 *   que permite resolver referências e option sets sem adivinhação;
 * - a assinatura de cada backend workflow (parâmetro, tipo do payload,
 *   obrigatoriedade, e se o workflow responde **sem autenticação**);
 * - `app_data` (appname, favicon, app_version, uso de captions).
 *
 * Formato verificado contra o app real em 2026-10-21 (291 tipos, 192 workflows).
 * O parser é tolerante: campo ausente vira warning, nunca exceção.
 */

export type FieldKind =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "user"
  | "file"
  | "image"
  | "geographic_address"
  | "reference"
  | "option"
  | "unknown";

export interface DesignField {
  /** Id interno do campo (ex.: `produto_f_brica_custom_cadastro_de_produtos_venda`). */
  id: string;
  /** Nome de exibição — o que aparece no editor. */
  display: string;
  /** Tipo cru declarado pelo Bubble (ex.: `list.custom.produtos`). */
  rawType: string;
  kind: FieldKind;
  /** Tipo referenciado: nome do tipo (custom./list.custom.) ou da option set (option.). */
  ref?: string;
  /** O campo guarda uma lista? */
  list: boolean;
}

export interface DesignType {
  /** Nome usado na URL da Data API (/obj/{name}). */
  name: string;
  /** Nome de exibição no editor. */
  display: string;
  fields: DesignField[];
  /** O tipo aparece na lista `get` do /meta (exposto na leitura da Data API). */
  readable: boolean;
}

export interface DesignWorkflowParam {
  /** Nome do parâmetro. */
  key: string;
  /** Tipo do payload declarado pelo Bubble (id interno, ex.: `api_wf_data.bUWEg0`). */
  payloadType: string;
  optional: boolean;
  /** Onde o parâmetro vai: corpo, query... */
  paramIn: string;
}

export interface DesignWorkflow {
  /** Nome do workflow (usado em POST /wf/{name}). */
  name: string;
  method: string;
  /**
   * `auth_unecessary` no /meta: o workflow responde **sem autenticação**.
   * O token admin também os executa; o ponto é que qualquer pessoa na internet
   * pode chamá-los.
   */
  public: boolean;
  params: DesignWorkflowParam[];
  /** Tipo de retorno declarado (mapa campo → tipo do Bubble). */
  returns: Record<string, string>;
}

export interface DesignApp {
  appname?: string;
  app_version?: string;
  favicon?: string;
  domain?: string;
  use_captions_for_get?: boolean;
}

export interface DesignDocument {
  app: DesignApp;
  types: DesignType[];
  workflows: DesignWorkflow[];
  counts: {
    types: number;
    fields: number;
    readable: number;
    workflows: number;
    publicWorkflows: number;
  };
  warnings: string[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asBool = (v: unknown): boolean => v === true;

/**
 * Normaliza o corpo de `/meta` num contrato de design.
 * Entradas tolerantes: o Bubble pode mudar o formato sem aviso.
 */
export function normalizeDesign(meta: unknown): DesignDocument {
  const warnings: string[] = [];
  if (!isObj(meta)) {
    return {
      app: {},
      types: [],
      workflows: [],
      counts: { types: 0, fields: 0, readable: 0, workflows: 0, publicWorkflows: 0 },
      warnings: ["/meta não devolveu um objeto JSON — design indisponível"],
    };
  }

  const app = normalizeApp(meta.app_data, warnings);
  const readable = new Set((Array.isArray(meta.get) ? meta.get : []).filter((x): x is string => typeof x === "string"));
  const types = normalizeTypes(meta.types, readable, warnings);
  const workflows = normalizeWorkflows(meta.post, warnings);

  const fields = types.reduce((n, t) => n + t.fields.length, 0);
  return {
    app,
    types,
    workflows,
    counts: {
      types: types.length,
      fields,
      readable: types.filter((t) => t.readable).length,
      workflows: workflows.length,
      publicWorkflows: workflows.filter((w) => w.public).length,
    },
    warnings,
  };
}

function normalizeApp(raw: unknown, warnings: string[]): DesignApp {
  if (!isObj(raw)) {
    warnings.push("/meta sem app_data");
    return {};
  }
  const out: DesignApp = {};
  const name = asString(raw.appname);
  const version = asString(raw.app_version);
  const favicon = asString(raw.favicon);
  const domain = asString(raw.domain);
  if (name) out.appname = name;
  if (version) out.app_version = version;
  if (favicon) out.favicon = favicon;
  if (domain) out.domain = domain;
  if (typeof raw.use_captions_for_get === "boolean") out.use_captions_for_get = raw.use_captions_for_get;
  return out;
}

function normalizeTypes(raw: unknown, readable: Set<string>, warnings: string[]): DesignType[] {
  if (!isObj(raw)) {
    warnings.push("/meta sem mapa de tipos");
    return [];
  }
  const out: DesignType[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!isObj(value)) {
      warnings.push(`tipo "${name}": entrada não é objeto — ignorado`);
      continue;
    }
    const display = asString(value.display) ?? name;
    const rawFields = Array.isArray(value.fields) ? value.fields : [];
    const fields: DesignField[] = [];
    for (const f of rawFields) {
      if (!isObj(f)) continue;
      const id = asString(f.id);
      if (!id) {
        warnings.push(`tipo "${name}": campo sem id — ignorado`);
        continue;
      }
      fields.push(normalizeField(id, f));
    }
    out.push({ name, display, fields, readable: readable.has(name) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));

  // Tipo legível que não veio no mapa de tipos (ou o inverso): sinal de drift.
  const known = new Set(out.map((t) => t.name));
  const missing = [...readable].filter((n) => !known.has(n));
  if (missing.length) {
    warnings.push(`${missing.length} tipo(s) em "get" sem definição em "types" (ex.: ${missing.slice(0, 3).join(", ")})`);
  }
  return out;
}

function normalizeField(id: string, raw: Json): DesignField {
  const rawType = asString(raw.type) ?? "unknown";
  const display = asString(raw.display) ?? id;
  const { kind, ref, list } = classify(rawType);
  return { id, display, rawType, kind, ...(ref ? { ref } : {}), list };
}

/**
 * Taxonomia do Bubble:
 *   text | number | boolean | date | user | file | image | geographic_address
 *   custom.<tipo>        → referência a outro tipo
 *   option.<option set>  → conjunto de opções
 *   list.<qualquer>      → lista do elemento indicado
 */
export function classify(rawType: string): { kind: FieldKind; ref?: string; list: boolean } {
  const t = rawType.trim();
  if (t.startsWith("list.")) {
    const inner = classify(t.slice("list.".length));
    return { kind: inner.kind, ...(inner.ref ? { ref: inner.ref } : {}), list: true };
  }
  if (t.startsWith("custom.")) return { kind: "reference", ref: t.slice("custom.".length), list: false };
  if (t.startsWith("option.")) return { kind: "option", ref: t.slice("option.".length), list: false };
  switch (t) {
    case "text":
    case "number":
    case "boolean":
    case "date":
    case "user":
    case "file":
    case "image":
    case "geographic_address":
      return { kind: t, list: false };
    default:
      return { kind: "unknown", list: false };
  }
}

function normalizeWorkflows(raw: unknown, warnings: string[]): DesignWorkflow[] {
  if (!Array.isArray(raw)) {
    warnings.push("/meta sem lista de workflows");
    return [];
  }
  const out: DesignWorkflow[] = [];
  for (const w of raw) {
    if (!isObj(w)) continue;
    const name = asString(w.endpoint);
    if (!name) {
      warnings.push("workflow sem endpoint — ignorado");
      continue;
    }
    const params: DesignWorkflowParam[] = [];
    for (const p of Array.isArray(w.parameters) ? w.parameters : []) {
      if (!isObj(p)) continue;
      const key = asString(p.key);
      if (!key) continue;
      params.push({
        key,
        payloadType: asString(p.value) ?? "unknown",
        optional: asBool(p.optional),
        paramIn: asString(p.param_in) ?? "body",
      });
    }
    const returns: Record<string, string> = {};
    if (isObj(w.return_btype)) {
      for (const [k, v] of Object.entries(w.return_btype)) {
        if (typeof v === "string") returns[k] = v;
      }
    }
    out.push({
      name,
      method: asString(w.method) ?? "post",
      public: asBool(w.auth_unecessary),
      params,
      returns,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Índice plano de campos: tipo → campo. Base para gerar mudança de design. */
export interface FieldIndexEntry {
  type: string;
  fieldId: string;
  display: string;
  kind: FieldKind;
  ref?: string;
  list: boolean;
}

export function fieldIndex(design: DesignDocument): FieldIndexEntry[] {
  const out: FieldIndexEntry[] = [];
  for (const t of design.types) {
    for (const f of t.fields) {
      out.push({
        type: t.name,
        fieldId: f.id,
        display: f.display,
        kind: f.kind,
        ...(f.ref ? { ref: f.ref } : {}),
        list: f.list,
      });
    }
  }
  return out;
}

/** Referências entre tipos: tipo → tipos referenciados. Detecta ciclos e órfãos. */
export function typeReferences(design: DesignDocument): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of design.types) {
    const refs = [...new Set(t.fields.filter((f) => f.kind === "reference" && f.ref).map((f) => f.ref as string))];
    if (refs.length) out[t.name] = refs.sort();
  }
  return out;
}
