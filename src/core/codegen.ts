import type { FieldInfo, NormalizedSchema } from "./schema.js";

/**
 * Gera interfaces TypeScript a partir do schema normalizado — base do SDK
 * tipado da Data API (Fase A do Motor 2 começa aqui).
 */
const RESERVED = ["BubbleTypes", "BubbleWorkflows", "BubbleTypeName", "Record", "Array", "Date", "Object", "String", "Number", "Boolean", "Promise", "Map", "Set"];

export function generateTypes(schema: NormalizedSchema, header = defaultHeader()): string {
  const used = new Set<string>(RESERVED);
  const names = new Map(schema.types.map((t) => [t.name, uniqueName(pascal(t.name), used)]));
  const lines: string[] = [header, ""];

  for (const t of schema.types) {
    const iface = names.get(t.name)!;
    lines.push(`/** Data API: /obj/${t.name.replace(/\*\/|[\r\n\u2028\u2029]/g, " ")} */`);
    lines.push(`export interface ${iface} {`);
    const fields = t.fields.some((f) => f.name === "_id") ? t.fields : [{ name: "_id", kind: "string", list: false } as FieldInfo, ...t.fields];
    for (const f of fields) {
      lines.push(`  ${propKey(f.name)}${f.name === "_id" ? "" : "?"}: ${tsType(f, names)};`);
    }
    lines.push("}", "");
  }

  if (schema.types.length) {
    lines.push("/** Mapa nome-na-API → interface. */");
    lines.push("export interface BubbleTypes {");
    for (const t of schema.types) lines.push(`  ${propKey(t.name)}: ${names.get(t.name)};`);
    lines.push("}", "");
    lines.push("export type BubbleTypeName = keyof BubbleTypes;", "");
  }

  if (schema.workflows.length) {
    lines.push("/** Backend workflows expostos: /wf/{nome} → parâmetros. */");
    lines.push("export interface BubbleWorkflows {");
    for (const w of schema.workflows) {
      const params = w.params.map((p) => `${propKey(p.name)}?: ${tsType(p, names)}`).join("; ");
      lines.push(`  ${propKey(w.name)}: { ${params}${params ? " " : ""}};`);
    }
    lines.push("}", "");
  }
  return lines.join("\n");
}

function defaultHeader(): string {
  return "// Gerado por bubble-bridge a partir do swagger do app. Não edite à mão.";
}

function tsType(f: FieldInfo, names: Map<string, string>): string {
  let base: string;
  switch (f.kind) {
    case "number":
      base = "number";
      break;
    case "boolean":
      base = "boolean";
      break;
    case "object":
      base = "Record<string, unknown>";
      break;
    case "unknown":
      base = "unknown";
      break;
    default:
      base = "string"; // texto, data ISO e referências (id do registro relacionado)
  }
  const comment = f.ref ? ` /* id de ${names.get(f.ref) ?? f.ref} */` : f.kind === "date" ? " /* ISO 8601 */" : "";
  return f.list ? `Array<${base}>${comment}` : `${base}${comment}`;
}

function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function pascal(name: string): string {
  const out = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join("");
  return /^[A-Za-z_]/.test(out) ? out : `T${out || "Type"}`;
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}${i}`;
  used.add(name);
  return name;
}
