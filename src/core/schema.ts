/**
 * Normaliza a especificação Swagger/OpenAPI que o Bubble publica em
 * /api/1.1/meta/swagger.json num modelo simples de tipos e workflows.
 *
 * O formato exato do Bubble não é documentado: o parser aceita Swagger 2.0
 * (definitions) e OpenAPI 3 (components.schemas) e é tolerante a ausências.
 * Validar contra o swagger real do app é item da PoC-1.
 */

export type FieldKind = "string" | "number" | "boolean" | "date" | "object" | "unknown";

export interface FieldInfo {
  name: string;
  kind: FieldKind;
  list: boolean;
  /** Referência a outro tipo, quando o swagger a declara. */
  ref?: string;
}

export interface TypeInfo {
  /** Nome usado na URL da Data API (/obj/{name}). */
  name: string;
  operations: string[];
  fields: FieldInfo[];
}

export interface WorkflowInfo {
  name: string;
  methods: string[];
  params: FieldInfo[];
}

export interface NormalizedSchema {
  format: "swagger2" | "openapi3" | "unknown";
  types: TypeInfo[];
  workflows: WorkflowInfo[];
  warnings: string[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

export function normalizeSwagger(doc: unknown): NormalizedSchema {
  const warnings: string[] = [];
  if (!isObj(doc)) {
    return { format: "unknown", types: [], workflows: [], warnings: ["swagger não é um objeto JSON"] };
  }
  const format = typeof doc.swagger === "string" ? "swagger2" : typeof doc.openapi === "string" ? "openapi3" : "unknown";
  const defs: Json =
    (isObj(doc.definitions) && doc.definitions) ||
    (isObj(doc.components) && isObj(doc.components.schemas) && doc.components.schemas) ||
    {};
  const paths: Json = isObj(doc.paths) ? doc.paths : {};
  if (!Object.keys(paths).length) warnings.push("swagger sem paths — Data API ou Workflow API podem estar desligadas");

  const types = new Map<string, TypeInfo>();
  const workflows = new Map<string, WorkflowInfo>();

  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    const obj = /\/obj\/([^/{]+)/.exec(path);
    const wf = /\/wf\/([^/{]+)/.exec(path);
    if (obj?.[1]) {
      const name = decode(obj[1], warnings);
      const t = types.get(name) ?? { name, operations: [], fields: [] };
      for (const m of HTTP_METHODS) {
        if (!isObj(item[m])) continue;
        const op = `${m.toUpperCase()} ${path.includes("{") ? "by-id" : "collection"}`;
        if (!t.operations.includes(op)) t.operations.push(op);
        if (!t.fields.length) {
          const schema = responseSchema(item[m] as Json);
          const resolved = resolveSchema(schema, defs);
          if (resolved) t.fields = fieldsOf(resolved, defs);
        }
      }
      types.set(name, t);
    } else if (wf?.[1]) {
      const name = decode(wf[1], warnings);
      const w = workflows.get(name) ?? { name, methods: [], params: [] };
      for (const m of HTTP_METHODS) {
        if (!isObj(item[m])) continue;
        if (!w.methods.includes(m.toUpperCase())) w.methods.push(m.toUpperCase());
        if (!w.params.length) w.params = paramsOf(item[m] as Json, defs);
      }
      workflows.set(name, w);
    }
  }

  // Fallback: tipo sem schema de resposta → procura definição com nome equivalente.
  for (const t of types.values()) {
    if (t.fields.length) continue;
    const key = Object.keys(defs).find((k) => squash(k) === squash(t.name));
    const def = key ? resolveSchema(defs[key], defs) : undefined;
    if (def) t.fields = fieldsOf(def, defs);
    else warnings.push(`tipo "${t.name}": campos não encontrados no swagger`);
  }

  return {
    format,
    types: [...types.values()].sort((a, b) => a.name.localeCompare(b.name)),
    workflows: [...workflows.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}

function decode(raw: string, warnings: string[]): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    warnings.push(`nome "${raw}" com escape de URL inválido — usado cru`);
    return raw;
  }
}

function squash(s: string): string {
  return s.toLowerCase().replace(/[\s_-]/g, "");
}

function responseSchema(op: Json): unknown {
  const responses = isObj(op.responses) ? op.responses : {};
  const ok = (responses["200"] ?? responses["201"]) as Json | undefined;
  if (!isObj(ok)) return undefined;
  if (ok.schema) return ok.schema; // swagger 2
  const content = isObj(ok.content) ? ok.content : {};
  const json = content["application/json"];
  return isObj(json) ? json.schema : undefined; // openapi 3
}

function refName(ref: unknown): string | undefined {
  return typeof ref === "string" ? ref.split("/").pop() : undefined;
}

/** Segue $ref e desembrulha envelopes do Bubble ({response: {...}} e {results: [...]}). */
function resolveSchema(schema: unknown, defs: Json, depth = 0): Json | undefined {
  if (!isObj(schema) || depth > 6) return undefined;
  if (schema.$ref) return resolveSchema(defs[refName(schema.$ref) ?? ""], defs, depth + 1);
  const props = isObj(schema.properties) ? schema.properties : undefined;
  if (props && Object.keys(props).length === 1 && isObj(props.response)) {
    return resolveSchema(props.response, defs, depth + 1);
  }
  if (props && isObj(props.results) && isObj(props.results.items)) {
    return resolveSchema(props.results.items, defs, depth + 1);
  }
  return props ? schema : undefined;
}

function fieldsOf(schema: Json, defs: Json): FieldInfo[] {
  const props = isObj(schema.properties) ? schema.properties : {};
  return Object.entries(props).map(([name, p]) => fieldFrom(name, p, defs));
}

function fieldFrom(name: string, p: unknown, defs: Json): FieldInfo {
  if (!isObj(p)) return { name, kind: "unknown", list: false };
  if (p.type === "array") {
    const inner = fieldFrom(name, p.items, defs);
    return { ...inner, list: true };
  }
  if (p.$ref) return { name, kind: "string", list: false, ref: refName(p.$ref) };
  const kind: FieldKind =
    p.type === "string"
      ? p.format === "date-time" || p.format === "date"
        ? "date"
        : "string"
      : p.type === "number" || p.type === "integer"
        ? "number"
        : p.type === "boolean"
          ? "boolean"
          : p.type === "object"
            ? "object"
            : "unknown";
  return { name, kind, list: false };
}

function paramsOf(op: Json, defs: Json): FieldInfo[] {
  const out: FieldInfo[] = [];
  const params = Array.isArray(op.parameters) ? op.parameters : [];
  for (const p of params) {
    if (!isObj(p)) continue;
    if (p.in === "body") {
      const body = resolveSchema(p.schema, defs) ?? (isObj(p.schema) ? p.schema : undefined);
      if (body) out.push(...fieldsOf(body, defs));
    } else if (typeof p.name === "string" && p.in !== "header" && p.in !== "path") {
      out.push(fieldFrom(p.name, p.schema ?? p, defs));
    }
  }
  const rb = isObj(op.requestBody) && isObj(op.requestBody.content) ? op.requestBody.content : undefined;
  const json = rb && isObj(rb["application/json"]) ? rb["application/json"] : undefined;
  if (json) {
    const body = resolveSchema(json.schema, defs) ?? (isObj(json.schema) ? json.schema : undefined);
    if (body) out.push(...fieldsOf(body, defs));
  }
  return out.filter((f, i) => out.findIndex((g) => g.name === f.name) === i);
}
