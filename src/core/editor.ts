/**
 * Cliente do plano de design do Bubble (o "editor").
 *
 * ## O que é alcançável com quais credenciais
 
 */

import { requestJson, type HttpOptions } from "./http.js";
import { BubbleApiError } from "./errors.js";
import { normalizeDesign, type DesignDocument } from "./design.js";

/**
 * Tabela de encolhimento do editor: nome → código curto.
 *
 * Copiada do bundle do editor (`lib-browser-old/.../shrink`). É o que define
 * a forma como o design é lido e gravado — sem ela, toda leitura volta em
 * `%p3` e nenhuma escrita cai no lugar certo.
 */
export const SHRINK_MAP: Record<string, string> = {
  display_sender_name: "d7",
  list_id: "li",
  deleted: "del",
  email_address: "ea",
  action_id: "ai",
  description: "d3",
  label: "lab",
  user_name: "un",
  floating: "f7",
  formatting_type: "ft",
  poststripeauth: "p8",
  image_pressed: "ip",
  center_background: "cb",
  image_normal: "i9",
  image_hover: "ih",
  descending: "d2",
  password2: "p2",
  require_confirm: "rc",
  choices: "ch",
  default: "d1",
  terms: "tz",
  thing_type: "tt",
  initial_values: "i2",
  element_type: "et",
  email: "em",
  from: "fr",
  sort_field: "sf",
  separator_width: "sw",
  useiframe: "u2",
  columns: "c5",
  separator_color: "sc",
  html: "ht",
  name_has_been_changed: "n0",
  fields: "f3",
  rows: "rs",
  separator_style: "ss",
  body: "b3",
  subject: "su",
  constraint_type: "c2",
  constraints: "co",
  element_name: "e4",
  bind: "bi",
  meta_description: "md",
  type_to_find: "t5",
  group_type: "gt",
  action: "ak",
  to_change: "tc",
  stripes: "st",
  after: "af",
  changes: "cs",
  title: "t1",
  data_source: "ds",
  additional_values: "av",
  limit_number_of_characters: "0l",
  backdrop: "bd",
  workflows: "wf",
  margintop: "mt",
  password: "pw",
  event_name: "en",
  app_path: "ap",
  mandatory: "1m",
  linktype: "1l",
  open_in_new_tab: "o9",
  stripe_height: "sh",
  contents: "ct",
  floating_reference: "3f",
  stretch_or_rescale: "2f",
  tabs: "ts",
  custom_id: "ci",
  icon: "9i",
  page: "pa",
  content_format: "cf",
  display: "d",
  icon_color: "ic",
  args: "a",
  placeholder: "ps",
  background_gradient_direction: "b4",
  content: "c1",
  background_image: "bgi",
  bggcolor: "bg2",
  style: "s1",
  textshadow: "tes",
  key: "k",
  elements: "el",
  event: "e1",
  value: "v",
  repeat_background_vertical: "rbv",
  repeat_background_horizontal: "rbh",
  underline: "u",
  italic: "i",
  vertical_centering: "vc",
  textshadow_blur: "tsb",
  textshadow_color: "tsc",
  textshadow_horizontal: "tsh",
  textshadow_vertical: "tsv",
  page_item_type: "pet",
  readable_field: "rf",
  bold: "b",
  __initialized: "in",
  element_id: "ei",
  text: "3",
  line_height: "lh",
  condition: "c",
  letter_spacing: "ls",
  word_spacing: "ws",
  padding_vertical: "pv",
  background_gradient_from: "bgf",
  background_gradient_to: "bgt",
  padding_horizontal: "ph",
  current_parent: "cp",
  font_face: "f",
  font_alignment: "fa",
  font_size: "fs",
  border_width: "bw",
  states: "s",
  boxshadow_blur: "bsb",
  boxshadow_color: "bsc",
  boxshadow_vertical: "bv",
  boxshadow_horizontal: "bh",
  font_color: "fc",
  bgcolor: "bgc",
  default_name: "dn",
  entries: "e",
  border_color: "bc",
  is_visible: "iv",
  background_style: "bas",
  border_roundness: "br",
  border_style: "bos",
  zindex: "z",
  top: "t",
  left: "l",
  width: "w",
  height: "h",
  boxshadow_style: "bs",
  boxshadow_spread: "bsp",
  next: "n",
  name: "nm",
  properties: "p",
  type: "x",
  pages: "p3",
  element_definitions: "ed",
};

/** Nomes que o editor nunca encolhe (são identificadores, não campos). */
const NOT_SHRUNK = new Set(["provider", "actions", "val", "id", "_id", "value_id", "redirects"]);

/** Prefixo do escape do editor. */
const ESCAPE = "%";

const REVERSE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SHRINK_MAP).map(([name, code]) => [code, name]),
);

/** Encolhe um nome de nó: `pages` → `%p3`, `name` → `%nm`. */
export function shrink(name: string): string {
  if (typeof name !== "string") return name;
  if (NOT_SHRUNK.has(name)) return name;
  const code = SHRINK_MAP[name];
  if (code) return ESCAPE + code;
  // Já encolhido (ou com escape): escapa de novo, como o editor faz.
  if (name.startsWith(ESCAPE)) return ESCAPE + name;
  return name;
}

/** Desencolhe um nome de nó: `%p3` → `pages`. */
export function expand(name: string): string {
  if (typeof name !== "string" || !name.startsWith(ESCAPE)) return name;
  const code = name.slice(1);
  const original = REVERSE_MAP[code];
  // Código desconhecido: preserva o escape em vez de perder informação.
  return original ?? name;
}

/** Encolhe um caminho com pontos: `pages.AAW` → `%p3.AAW`. */
export function shrinkPath(path: string): string {
  return path
    .split(".")
    .filter((p) => p !== "")
    .map(shrink)
    .join(".");
}

/** Desencolhe um caminho com pontos: `%p3.AAW` → `pages.AAW`. */
export function expandPath(path: string): string {
  return path
    .split(".")
    .filter((p) => p !== "")
    .map(expand)
    .join(".");
}

/** Encolhe as chaves de um objeto (recursivo). É o que o editor grava. */
export function shrinkObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shrinkObject);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[shrink(k)] = shrinkObject(v);
  }
  return out;
}

/** Desencolhe as chaves de um objeto (recursivo). É o que o editor devolve. */
export function expandObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandObject);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[expand(k)] = expandObject(v);
  }
  return out;
}

/** Teto de caracteres por nó de design devolvido numa leitura. */
export const DEFAULT_MAX_NODE_CHARS = 20_000;

/**
 * Corta um nó de design grande.
 *
 * O design é interno e versionado pelo Bubble: alguns nós (o `settings` com
 * as credenciais de integração, o `api` com os 800+ workflows) passam de
 * centenas de KB. Devolver isso inteiro estoura o contexto de quem lê — o
 * corte devolve o começo e diz o tamanho real.
 */
export function capDesignNode(value: unknown, maxChars: number): unknown {
  const raw = JSON.stringify(value);
  if (raw === undefined) return value;
  if (raw.length <= maxChars) return value;
  return {
    _truncado: `nó maior que o teto (${raw.length} caracteres, teto ${maxChars}) — leia um caminho mais específico`,
    head: raw.slice(0, 2000),
  };
}

/** Nomes de parâmetro cujo valor é segredo.
 *
 * O design guarda as credenciais das integrações **em texto claro** — no
 * `settings.secure` e dentro das chamadas dos API Connectors. Ler o design e
 * despejar isso num contexto de LLM é vazar segredo da conta.
 */
const SECRET_NAME_RE =
  /(api[_-]?key|api[_-]?secret|access[_-]?key|chave|refresh[_-]?token|auth[_-]?token|bearer|token|secret|password|passwd|senha|credential|private[_-]?key|client[_-]?secret|authorization|signature|planilha|spreadsheet|drive|folder|file[_-]?id|doc[_-]?id)/i;

/** Chaves estruturais que não são segredo, mesmo combinando com "key"/"value". */
const NOT_SECRET_KEYS = new Set(["key", "value", "keys", "values", "id", "_id", "name", "type"]);

/**
 * JSON canônico: chaves ordenadas, recursivamente.
 *
 * O Bubble reorganiza as chaves do objeto ao gravar. Comparar a releitura
 * com o que foi enviado exige comparar conteúdo, não a ordem das chaves.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = walk(src[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value)) ?? "null";
}

/**
 * Valor opaco: string longa sem espaços, só letras, dígitos e símbolos de
 * base64/URL. É o formato de token, de id de planilha e de chave de API.
 */
function looksOpaque(v: string): boolean {
  if (v.length < 20 || v.length > 160) return false;
  if (/\s/.test(v)) return false;
  return /^[A-Za-z0-9_\-+/=.:]+$/.test(v) && /\d/.test(v);
}

/**
 * Mascara segredos no design lido.
 *
 * O editor guarda o par `{key: "chave_api", value: "<o segredo>"}` nos
 * parâmetros das chamadas: é o par que denota o segredo, não a chave
 * "value". Então a regra é: se o objeto tem `key` e `value` e o nome do
 * parâmetro parece um segredo, o valor é mascarado; e qualquer entrada cujo
 * **nome** seja de segredo também é mascarada.
 *
 * Dentro do par, um valor opaco também é mascarado mesmo quando o nome não
 * denuncia: o id de uma planilha ("1ZlUWyVRE…") é o mesmo tipo de
 * identificador privado que a chave que abre a planilha.
 */
export function redactDesignSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDesignSecrets);
  if (!value || typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const pairName = typeof src.key === "string" ? src.key : undefined;
  const pairIsSecret =
    pairName !== undefined &&
    !NOT_SECRET_KEYS.has(pairName) &&
    (SECRET_NAME_RE.test(pairName) || looksOpaque(src.value as string));
  for (const [k, v] of Object.entries(src)) {
    if (pairIsSecret && k === "value" && typeof v === "string") {
      out[k] = "[mascarado]";
      continue;
    }
    if (typeof v === "string" && !NOT_SECRET_KEYS.has(k) && SECRET_NAME_RE.test(k)) {
      out[k] = "[mascarado]";
      continue;
    }
    out[k] = redactDesignSecrets(v);
  }
  return out;
}

/** Uma operação do editor: método + caminho (com placeholders). */
export interface EditorOp {
  method: "GET" | "POST" | "PATCH" | "PUT";
  /**
   * Caminho relativo à base do editor. Placeholders aceitos:
   * `{app}` (appname), `{version}` (app_version), `{since}`, `{session}`,
   * `{path}` (caminho encolhido, com `/` no lugar do `.`).
   */
  path: string;
}

/** Mapa de operações aprovadas. A tool MCP só escolhe por nome. */
export type EditorOps = Record<string, EditorOp>;

/**
 * Operações medidas no editor. `BUBBLE_EDITOR_OPS` sobrescreve este mapa
 * (inclusive para reduzir o conjunto — omittingir uma operação a desliga).
 */
export const DEFAULT_EDITOR_OPS: EditorOps = {
  read_design: { method: "POST", path: "/appeditor/load_multiple_paths/{app}/{version}" },
  probe_design: { method: "GET", path: "/appeditor/load_single_path/{app}/{version}/no_version_hash/_index" },
  write_design: { method: "POST", path: "/appeditor/write" },
  export_design: { method: "GET", path: "/appeditor/export/{version}/{app}.bubble" },
  changes: { method: "GET", path: "/appeditor/changes/{app}/{version}/{since}/{session}" },
  publish_design: { method: "POST", path: "/appeditor/deploy_new_code" },
};

/** Uma alteração de design a aplicar: caminho (forma humana) + valor. */
export interface EditorChange {
  /** Caminho do nó, em forma humana (`pages.AAW.elements.bTRvd`). */
  path: string;
  /** Novo valor. `null` apaga o nó. */
  value: unknown;
  /** Metadados da transação (o editor usa para hints de undo). */
  metadata?: Record<string, unknown>;
  /**
   * O que a prévia mostra. Sem este campo, a prévia mostra o valor.
   *
   * Existe para o merge: o valor final carrega o que já estava no design
   * (inclusive credenciais de integração) e a prévia não pode despejar isso
   * no log nem no contexto de quem pediu.
   */
  previewValue?: unknown;
}

export interface BubbleEditorSessionOptions {
  /** Cookie de sessão da conta Bubble. Nunca é registrado em log. */
  session: string;
  /**
   * JWT do Firebase da conta (`meta-firebase_workflow`).
   *
   * O editor exige o cookie **e** este header. Sem o header, a resposta é 401
   * mesmo com a sessão válida — por isso a credencial é configurável à parte.
   */
  firebaseToken?: string;
  /** App alvo — o *appname* (slug) que o editor usa, ex.: `comprover`. */
  appId: string;
  /** Versão do design: `test` (desenvolvimento) ou `live` (publicado). */
  appVersion: string;
  /** Base HTTP do editor, ex.: `https://scheduled.bubble.io`. */
  base: string;
  ops?: EditorOps;
  http?: HttpOptions;
}

/** Um nó lido do design. */
export interface EditorNode {
  /** Caminho pedido, em forma humana. */
  path: string;
  /** Conteúdo do nó (null quando o caminho não existe). */
  data: unknown;
  /** Filhos, quando o servidor devolve o nó "chunked" (dados grandes). */
  chunkKeys?: string[];
  /** Verdadeiro quando o nó não existe no design. */
  missing?: boolean;
}

export interface EditorReadResult {
  /** Versão do design lida (o `last_change` do servidor). */
  lastChange?: string;
  nodes: EditorNode[];
}

/**
 * Padrões de nome que indicam operação de *publish* (deploy).
 *
 * Publicar um branch de desenvolvimento no Bubble já é um deploy do app
 * público: o `version-test` sobe para o live. Por isso publish é sempre
 * tratado como escrita no live, qualquer que seja o branch do request.
 */
const PUBLISH_OP_RE = /(publish|deploy|commit|release|go[_-]?live|golive)/i;

export class BubbleEditorSession {
  readonly base: string;
  readonly appId: string;
  readonly appVersion: string;
  private readonly session: string;
  private readonly firebaseToken?: string;
  private readonly ops: EditorOps;
  private readonly http: HttpOptions;

  constructor(opts: BubbleEditorSessionOptions) {
    this.session = opts.session;
    this.firebaseToken = opts.firebaseToken;
    this.appId = opts.appId;
    this.appVersion = opts.appVersion;
    this.base = opts.base.replace(/\/+$/, "");
    this.ops = opts.ops ?? DEFAULT_EDITOR_OPS;
    this.http = opts.http ?? {};
  }

  /**
   * Headers de credencial do editor.
   *
   * São dois: o cookie da sessão e o JWT do Firebase (`meta-firebase_workflow`).
   * O editor recusa a chamada com 401 se faltar qualquer um dos dois.
   */
  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Cookie: this.session };
    if (this.firebaseToken) headers["meta-firebase_workflow"] = this.firebaseToken;
    return headers;
  }

  /** O mapa tem a operação pedida? */
  has(op: string): boolean {
    return Object.hasOwn(this.ops, op);
  }

  /** Operações aprovadas (nomes). */
  opNames(): string[] {
    return Object.keys(this.ops).sort();
  }

  /** URL final de uma operação, com os placeholders resolvidos. */
  resolveUrl(op: EditorOp, vars: Record<string, string> = {}): string {
    const path = op.path
      .replace(/\{app\}/g, encodeURIComponent(this.appId))
      .replace(/\{version\}/g, encodeURIComponent(this.appVersion))
      .replace(/\{since\}/g, encodeURIComponent(vars.since ?? "0"))
      .replace(/\{session\}/g, encodeURIComponent(vars.session ?? "bridge"))
      .replace(/\{path\}/g, vars.path ?? "");
    if (!path.startsWith("/")) throw new Error(`Caminho de operação inválido: "${op.path}" (precisa começar com /)`);
    return `${this.base}${path}`;
  }

  /** URL final de uma operação pelo nome. Lança se a operação não for aprovada. */
  resolveUrlFor(op: string, vars: Record<string, string> = {}): string {
    const spec = this.ops[op];
    if (!spec) {
      throw new Error(
        `Operação de editor "${op}" não está no mapa aprovado (BUBBLE_EDITOR_OPS). Disponíveis: ${this.opNames().join(", ") || "nenhuma"}.`,
      );
    }
    return this.resolveUrl(spec, vars);
  }

  /** Método HTTP de uma operação aprovada. */
  methodFor(op: string): EditorOp["method"] {
    const spec = this.ops[op];
    if (!spec) throw new Error(`Operação de editor "${op}" não está no mapa aprovado (BUBBLE_EDITOR_OPS).`);
    return spec.method;
  }

  /**
   * Esta operação é um *publish* (deploy)?
   *
   * No Bubble, publicar um branch de desenvolvimento **é** um deploy do app
   * público — o branch `version-test` sobe para o live. O gate de escrita tem
   * de olhar isso, não só o branch alvo.
   */
  isPublishOp(op: string): boolean {
    const spec = this.ops[op];
    if (!spec) return false;
    return PUBLISH_OP_RE.test(op) || PUBLISH_OP_RE.test(spec.path);
  }

  /** A operação existe e é um publish? */
  isPublishOpNamed(op: string): boolean {
    return this.isPublishOp(op);
  }

  /** Nome da operação de leitura, se houver uma aprovada. */
  readOpName(): string | undefined {
    if (this.ops.read_design) return "read_design";
    return this.opNames().find((n) => /read|load|get|open/i.test(n));
  }

  /** Nome da operação de escrita, se houver uma aprovada. */
  writeOpName(): string | undefined {
    if (this.ops.write_design) return "write_design";
    return this.opNames().find((n) => /write|save|apply|set|update/i.test(n));
  }

  /**
   * Lê nós do design.
   *
   * `paths` são caminhos em forma humana (`pages.AAW`, `settings`, `api`).
   * A leitura volta desencolhida, em forma humana, para o agente não precisar
   * conhecer `%p3`/`%nm`.
   *
   * `noChunking: false` faz o editor devolver, no lugar dos dados de um nó
   * grande, apenas a **lista de filhos** (`{keys: [...]}`). É o que a
   * *descoberta* usa: mapear a raiz sem baixar o nó `api` inteiro (que tem
   * centenas de workflows no app real).
   */
  async readDesign(
    paths: string[],
    opts: {
      expand?: boolean;
      children?: number;
      maxChars?: number;
      secrets?: "mask" | "raw";
      noChunking?: boolean;
    } = {},
  ): Promise<EditorReadResult> {
    const op = this.readOpName();
    if (!op) throw new Error("Nenhuma operação de leitura de design aprovada (BUBBLE_EDITOR_OPS).");
    const expandWanted = opts.expand !== false;
    const mask = opts.secrets !== "raw";
    const maxChars = opts.maxChars ?? DEFAULT_MAX_NODE_CHARS;
    const pathArrays = paths.map((p) => shrinkPath(p).split(".").filter(Boolean));
    const body = { path_arrays: pathArrays, no_chunking: opts.noChunking !== false };
    const raw = (await this.run(op, body, { raw: true })) as {
      last_change?: string;
      data?: Array<{ data?: unknown; keys?: string[] }>;
    };
    const nodes: EditorNode[] = [];
    for (let i = 0; i < paths.length; i++) {
      const item = raw.data?.[i];
      const node: EditorNode = { path: paths[i]!, data: null };
      if (!item) {
        node.missing = true;
        nodes.push(node);
        continue;
      }
      if (Array.isArray(item.keys)) {
        node.chunkKeys = item.keys.map((k) => (expandWanted ? expand(k) : k));
        node.data = null;
      } else {
        const expanded = expandWanted ? expandObject(item.data) : item.data;
        node.data = capDesignNode(mask ? redactDesignSecrets(expanded) : expanded, maxChars);
      }
      nodes.push(node);
    }
    // Desce um nível: o nó "chunked" vira o mapa dos filhos.
    const children = opts.children ?? 0;
    if (children > 0) {
      for (const node of nodes) {
        if (!node.chunkKeys?.length) continue;
        const childPaths = node.chunkKeys.map((k) => `${node.path}.${k}`);
        const sub = await this.readDesign(childPaths, {
          expand: expandWanted,
          children: children - 1,
          maxChars,
          secrets: opts.secrets,
          noChunking: opts.noChunking,
        });
        const byPath = new Map(sub.nodes.map((n) => [n.path, n]));
        const merged: Record<string, unknown> = {};
        for (const key of node.chunkKeys) {
          const child = byPath.get(`${node.path}.${key}`);
          merged[key] = child ? (child.data ?? null) : null;
        }
        node.data = capDesignNode(merged, maxChars);
        delete node.chunkKeys;
      }
    }
    return { lastChange: raw.last_change, nodes };
  }

  /** Lê um nó do design. */
  async readNode(
    path: string,
    opts: {
      expand?: boolean;
      children?: number;
      maxChars?: number;
      secrets?: "mask" | "raw";
      noChunking?: boolean;
    } = {},
  ): Promise<EditorNode> {
    const res = await this.readDesign([path], opts);
    return res.nodes[0]!;
  }

  /**
   * Monta (sem enviar) a requisição de escrita — o que o dry-run mostra.
   * Serve para o plano expor método, URL e corpo antes de qualquer efeito.
   */
  previewWrite(changes: EditorChange[]): { method: string; endpoint: string; body: unknown } {
    const op = this.writeOpName();
    if (!op) throw new Error("Nenhuma operação de escrita de design aprovada (BUBBLE_EDITOR_OPS).");
    const spec = this.ops[op]!;
    return {
      method: spec.method,
      endpoint: this.resolveUrl(spec),
      body: this.previewBody(changes),
    };
  }

  /** Corpo do protocolo de escrita. */
  private writeBody(changes: EditorChange[]): Record<string, unknown> {
    return {
      v: 1,
      appname: this.appId,
      app_version: this.appVersion,
      changes: changes.map((c) => ({
        body: c.value === null ? null : shrinkObject(c.value),
        path_array: shrinkPath(c.path).split(".").filter(Boolean),
        metadata: c.metadata ?? {},
        session_id: this.sessionId(),
      })),
    };
  }

  /** Corpo da prévia: igual ao envio, mas com o que veio do design mascarado. */
  private previewBody(changes: EditorChange[]): Record<string, unknown> {
    return {
      v: 1,
      appname: this.appId,
      app_version: this.appVersion,
      changes: changes.map((c) => {
        const shown = c.previewValue !== undefined ? c.previewValue : c.value;
        return {
          body: shown === null ? null : shrinkObject(shown),
          path_array: shrinkPath(c.path).split(".").filter(Boolean),
          metadata: c.metadata ?? {},
          session_id: this.sessionId(),
        };
      }),
    };
  }

  /**
   * Aplica alterações de design.
   *
   * O caminho vai encolhido e o valor também: o servidor guarda o corpo
   * exatamente como ele chega, então `{"name": "x"}` viraria um campo
   * diferente do que o editor entende (`{"%nm": "x"}`).
   */
  async writeDesign(changes: EditorChange[]): Promise<{ lastChange?: string; lastChangeDate?: string; idCounter?: string }> {
    const op = this.writeOpName();
    if (!op) throw new Error("Nenhuma operação de escrita de design aprovada (BUBBLE_EDITOR_OPS).");
    const res = (await this.run(op, this.writeBody(changes))) as {
      last_change?: string;
      last_change_date?: string;
      id_counter?: string;
    };
    return { lastChange: res.last_change, lastChangeDate: res.last_change_date, idCounter: res.id_counter };
  }

  /** Apaga um nó do design (escreve `null` no caminho). */
  async deleteNode(path: string): Promise<{ lastChange?: string; lastChangeDate?: string }> {
    const res = await this.writeDesign([{ path, value: null }]);
    return { lastChange: res.lastChange, lastChangeDate: res.lastChangeDate };
  }

  /** Identificador de sessão da transação — o editor usa um id local por aba. */
  private sessionId(): string {
    return `${Date.now()}x${Math.floor(Math.random() * 1e9)}`;
  }

  /** Mudanças desde um `last_change`. */
  async changesSince(since: number | string, sessionId = "bridge"): Promise<unknown[]> {
    const op = this.ops.changes ? "changes" : this.opNames().find((n) => /change/i.test(n));
    if (!op) throw new Error("Nenhuma operação de leitura de mudanças aprovada (BUBBLE_EDITOR_OPS).");
    const res = (await this.run(op, undefined, { raw: true, vars: { since: String(since), session: sessionId } })) as unknown[];
    return Array.isArray(res) ? res : [];
  }

  /** Exporta o design inteiro (o mesmo arquivo `.bubble` do botão "Export"). */
  async exportDesign(): Promise<string> {
    const op = this.ops.export_design ? "export_design" : this.opNames().find((n) => /export/i.test(n));
    if (!op) throw new Error("Nenhuma operação de exportação de design aprovada (BUBBLE_EDITOR_OPS).");
    const res = await this.run(op, undefined, { text: true });
    return typeof res === "string" ? res : JSON.stringify(res);
  }

  /**
   * Publica o branch de desenvolvimento no app público.
   *
   * É um **deploy**: o gate de escrita exige `BUBBLE_ALLOW_LIVE_WRITES=true`.
   */
  async publish(): Promise<unknown> {
    const op = this.ops.publish_design ? "publish_design" : this.opNames().find((n) => /publish|deploy/i.test(n));
    if (!op) throw new Error("Nenhuma operação de publicação aprovada (BUBBLE_EDITOR_OPS).");
    return this.run(op, { appname: this.appId });
  }

  /**
   * Sonda leve: a sessão da conta responde?
   * Usado pelo `doctor` para dizer se a credencial de conta ainda vale.
   *
   * A URL vem do **mapa de operações aprovado** (`probe_design` no padrão);
   * quando o mapa não tiver uma operação de sondagem, a sonda usa a própria
   * operação de leitura com um caminho trivial. Nenhuma URL é adivinhada.
   */
  async probe(): Promise<{ reachable: boolean; status?: number; error?: string; lastChange?: string; pathVersionHash?: string }> {
    const op = this.probeOpName();
    if (!op) {
      return { reachable: false, error: "nenhuma operação de sondagem aprovada no mapa (BUBBLE_EDITOR_OPS)" };
    }
    try {
      const spec = this.ops[op]!;
      const raw = (await requestJson(
        this.resolveUrl(spec),
        {
          method: spec.method,
          // A sondagem só manda corpo quando a operação de leitura é um POST
          // (no mapa padrão). GET não leva corpo.
          body: op === this.readOpName() && spec.method !== "GET" ? { path_arrays: [["_index"]], no_chunking: true } : undefined,
          headers: this.authHeaders(),
        },
        this.http,
      )) as { last_change?: string; path_version_hash?: string };
      return { reachable: true, status: 200, lastChange: raw.last_change, pathVersionHash: raw.path_version_hash };
    } catch (err) {
      return {
        reachable: false,
        status: err instanceof BubbleApiError ? err.status : undefined,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Nome da operação de sondagem, se houver uma aprovada.
   *
   * `probe_design` no mapa padrão; senão, qualquer operação cujo nome ou
   * caminho case com sondagem. Sem nenhuma, a sonda cai na operação de leitura.
   */
  private probeOpName(): string | undefined {
    if (this.ops.probe_design) return "probe_design";
    const named = this.opNames().find((n) => /probe|ping|health|session|load_single/i.test(n));
    if (named) return named;
    return this.readOpName();
  }

  /**
   * Descoberta do design: o que existe na raiz e o que a sessão alcança.
   * Só lê — nenhuma escrita.
   */
  async discover(): Promise<{
    base: string;
    app: string;
    version: string;
    reachable: boolean;
    lastChange?: string;
    pathVersionHash?: string;
    /** Nós da raiz do design, com a contagem de filhos quando o nó é grande. */
    roots: Array<{ path: string; children?: number }>;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const out: {
      base: string;
      app: string;
      version: string;
      reachable: boolean;
      lastChange?: string;
      pathVersionHash?: string;
      roots: Array<{ path: string; children?: number }>;
      warnings: string[];
    } = {
      base: this.base,
      app: this.appId,
      version: this.appVersion,
      reachable: false,
      roots: [],
      warnings,
    };

    const probe = await this.probe();
    out.reachable = probe.reachable;
    out.lastChange = probe.lastChange;
    out.pathVersionHash = probe.pathVersionHash;
    if (!probe.reachable) {
      warnings.push(
        `a sessão não respondeu no editor: ${probe.error ?? "sem detalhe"} — ` +
          "confirme o cookie da conta e a permissão sobre o app.",
      );
      return out;
    }

    // Raiz do design, em forma encolhida: %p3=pages, %ed=element_definitions,
    // %wf=api(workflows), %p=properties, %x=type...
    //
    // `noChunking: false` é o ponto: o editor devolve a LISTA de filhos de um nó
    // grande em vez dos dados. Sem isso, mapear a raiz baixaria o nó `api`
    // inteiro (centenas de workflows) — vários MB por chamada.
    const roots = ["pages", "element_definitions", "api", "styles", "user_types", "option_sets", "mobile_views", "settings", "global_expressions"];
    const res = await this.readDesign(roots, { noChunking: false });
    for (const node of res.nodes) {
      out.roots.push({ path: node.path, children: node.chunkKeys?.length });
    }
    const missing = res.nodes.filter((n) => n.missing || (n.data === null && !n.chunkKeys)).map((n) => n.path);
    if (missing.length) warnings.push(`nós sem dados na raiz: ${missing.join(", ")}`);
    return out;
  }

  /** Executa uma operação aprovada, com o corpo do protocolo. */
  private async run(
    op: string,
    body?: unknown,
    opts: { raw?: boolean; text?: boolean; vars?: Record<string, string> } = {},
  ): Promise<unknown> {
    const spec = this.ops[op];
    if (!spec) {
      throw new Error(
        `Operação de editor "${op}" não está no mapa aprovado (BUBBLE_EDITOR_OPS). Disponíveis: ${this.opNames().join(", ") || "nenhuma"}.`,
      );
    }
    const url = this.resolveUrl(spec, opts.vars ?? {});
    try {
      const res = await requestJson(url, {
        method: spec.method,
        body: spec.method === "GET" || body === undefined ? undefined : body,
        responseType: opts.text ? "text" : "json",
        headers: this.authHeaders(),
      }, this.http);
      return res;
    } catch (err) {
      if (err instanceof BubbleApiError) {
        throw new BubbleApiError(
          err.status,
          err.endpoint,
          `operação de editor "${op}" falhou: ${err.bubbleMessage}`,
          err.hint ?? "confirme se a sessão da conta ainda é válida e se a operação existe no mapa",
        );
      }
      throw err;
    }
  }
}

/** Valida e normaliza o mapa de operações (JSON inline ou caminho de arquivo). */
export function parseEditorOps(raw: string | undefined, readFile?: (path: string) => string): EditorOps {
  if (!raw) return { ...DEFAULT_EDITOR_OPS };
  let text = raw.trim();
  // Começa com { ou [ → é JSON inline; qualquer outra coisa é caminho de arquivo.
  if (!text.startsWith("{") && !text.startsWith("[")) {
    if (!readFile) throw new Error("BUBBLE_EDITOR_OPS: informe o JSON inline ou um caminho de arquivo");
    text = readFile(text);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`BUBBLE_EDITOR_OPS não é JSON válido: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("BUBBLE_EDITOR_OPS deve ser um objeto { nomeDaOperacao: { method, path } }");
  }
  const out: EditorOps = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      throw new Error(`Operação "${name}" inválida: esperado { method, path }`);
    }
    const method = String((value as Record<string, unknown>).method ?? "POST").toUpperCase();
    const path = String((value as Record<string, unknown>).path ?? "");
    if (!["GET", "POST", "PATCH", "PUT"].includes(method)) {
      throw new Error(`Operação "${name}": method inválido "${method}" (use GET, POST, PATCH ou PUT)`);
    }
    if (!path.startsWith("/")) {
      throw new Error(`Operação "${name}": path deve começar com "/" (ex.: /appeditor/write)`);
    }
    out[name] = { method: method as EditorOp["method"], path };
  }
  return out;
}

/** Diferença entre dois contratos de design — o que a escrita de fato mudou. */
export interface DesignDiff {
  typesAdded: string[];
  typesRemoved: string[];
  fieldsAdded: Array<{ type: string; fieldId: string; display: string; kind: string }>;
  fieldsRemoved: Array<{ type: string; fieldId: string }>;
  workflowsAdded: string[];
  workflowsRemoved: string[];
  changed: boolean;
}

export function diffDesign(before: DesignDocument, after: DesignDocument): DesignDiff {
  const beforeTypes = new Map(before.types.map((t) => [t.name, t]));
  const afterTypes = new Map(after.types.map((t) => [t.name, t]));
  const beforeWorkflows = new Set(before.workflows.map((w) => w.name));
  const afterWorkflows = new Set(after.workflows.map((w) => w.name));

  const typesAdded = [...afterTypes.keys()].filter((n) => !beforeTypes.has(n));
  const typesRemoved = [...beforeTypes.keys()].filter((n) => !afterTypes.has(n));
  const fieldsAdded: DesignDiff["fieldsAdded"] = [];
  const fieldsRemoved: DesignDiff["fieldsRemoved"] = [];

  for (const [name, type] of afterTypes) {
    const old = beforeTypes.get(name);
    const oldFields = new Map((old?.fields ?? []).map((f) => [f.id, f]));
    for (const f of type.fields) {
      if (!oldFields.has(f.id)) {
        fieldsAdded.push({ type: name, fieldId: f.id, display: f.display, kind: f.kind });
      }
    }
  }
  for (const [name, type] of beforeTypes) {
    const now = afterTypes.get(name);
    const nowFields = new Set((now?.fields ?? []).map((f) => f.id));
    for (const f of type.fields) {
      if (!nowFields.has(f.id)) fieldsRemoved.push({ type: name, fieldId: f.id });
    }
  }

  const workflowsAdded = [...afterWorkflows].filter((n) => !beforeWorkflows.has(n));
  const workflowsRemoved = [...beforeWorkflows].filter((n) => !afterWorkflows.has(n));

  return {
    typesAdded: typesAdded.sort(),
    typesRemoved: typesRemoved.sort(),
    fieldsAdded,
    fieldsRemoved,
    workflowsAdded: workflowsAdded.sort(),
    workflowsRemoved: workflowsRemoved.sort(),
    changed:
      typesAdded.length > 0 ||
      typesRemoved.length > 0 ||
      fieldsAdded.length > 0 ||
      fieldsRemoved.length > 0 ||
      workflowsAdded.length > 0 ||
      workflowsRemoved.length > 0,
  };
}

export interface JsonDiff {
  changed: boolean;
  /** Caminhos adicionados (ex.: `pages.home.elements.titulo`). */
  added: string[];
  removed: string[];
  /** Caminhos cujo valor mudou. */
  modified: string[];
  truncated: boolean;
}

const DIFF_MAX_DEPTH = 8;
const DIFF_MAX_ENTRIES = 300;

/**
 * Diff estrutural do documento de design (JSON cru do editor).
 *
 * O documento é interno e versionado pelo Bubble: não há schema para comparar
 * campo a campo. O diff responde à pergunta útil — "a escrita mudou alguma
 * coisa?" — listando caminhos adicionados, removidos e alterados, com teto de
 * profundidade e de entradas para não despejar o design inteiro no contexto.
 */
export function diffDesignJson(before: unknown, after: unknown): JsonDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  let truncated = false;

  const walk = (a: unknown, b: unknown, path: string, depth: number): void => {
    if (added.length + removed.length + modified.length >= DIFF_MAX_ENTRIES) {
      truncated = true;
      return;
    }
    if (depth > DIFF_MAX_DEPTH) {
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        modified.push(path || "(raiz)");
        truncated = true;
      }
      return;
    }
    const aObj = isPlainObject(a);
    const bObj = isPlainObject(b);
    if (aObj && bObj) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        const p = path ? `${path}.${k}` : k;
        if (!(k in a)) added.push(p);
        else if (!(k in b)) removed.push(p);
        else walk(a[k], b[k], p, depth + 1);
        if (added.length + removed.length + modified.length >= DIFF_MAX_ENTRIES) {
          truncated = true;
          return;
        }
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) {
        const p = `${path}[${i}]`;
        if (i >= a.length) added.push(p);
        else if (i >= b.length) removed.push(p);
        else walk(a[i], b[i], p, depth + 1);
        if (added.length + removed.length + modified.length >= DIFF_MAX_ENTRIES) {
          truncated = true;
          return;
        }
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) modified.push(path || "(raiz)");
  };

  walk(before, after, "", 0);
  return {
    changed: added.length + removed.length + modified.length > 0,
    added: added.slice(0, DIFF_MAX_ENTRIES),
    removed: removed.slice(0, DIFF_MAX_ENTRIES),
    modified: modified.slice(0, DIFF_MAX_ENTRIES),
    truncated,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
