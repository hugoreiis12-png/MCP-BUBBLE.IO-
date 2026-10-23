import { readFile } from "node:fs/promises";
import type { BridgeConfig } from "../config.js";
import type { BubbleClient, BubbleThing } from "./client.js";
import type { NormalizedSchema } from "./schema.js";
import { assertWritable } from "./writes.js";

/**
 *
 * O app Bubble guarda o HTML de cada página num data type (padrão do guia:
 * tipo `paginas`, campos `pagina` e `html`) e o app renderiza com expressão
 * dinâmica — "Do a search for paginas where pagina = X → first item's html".
 * Este módulo empacota o deploy do HTML local: valida o contrato no swagger,
 * procura o registro pela chave e cria ou atualiza. Assim como no `editor
 * write` do CLI, o dry-run é o padrão; executar exige `--execute`.
 */

export interface PageDeployOptions {
  /** Arquivo local com o HTML completo da página (CSS e JS inline). */
  file: string;
  /** Tipo de dado no app — `paginas` no padrão do guia. */
  type: string;
  /** Campo chave do registro (comporta o slug) — `pagina` no padrão do guia. */
  keyField: string;
  /** Campo que recebe o HTML — `html` no padrão do guia. */
  htmlField: string;
  /** Valor da chave que identifica a página no app. */
  slug: string;
}

export interface PageDeployResult {
  action: "create" | "update";
  type: string;
  slug: string;
  method: string;
  endpoint: string;
  html_bytes: number;
  dry_run: boolean;
  /** Presente quando o deploy já rodou ou quando o registro já existia. */
  id?: string;
  warnings: string[];
  aviso?: string;
}

export const PAGE_DEFAULT_TYPE = "paginas";
export const PAGE_DEFAULT_KEY_FIELD = "pagina";
export const PAGE_DEFAULT_HTML_FIELD = "html";

/** Slug derivado do nome do arquivo: `minha-página.html` → `minha-pagina`. */
export function slugFromFile(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  const slug = base
    .replace(/\.[^.]+$/, "")
    // diacríticos saem do slug: chave de busca e endereço da página ficam ASCII puro
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "pagina";
}

/** Erros bloqueiam o deploy; avisos apenas viajam junto no resultado. */
export function checkPageContract(
  schema: NormalizedSchema | undefined,
  type: string,
  keyField: string,
  htmlField: string,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!schema) {
    warnings.push("swagger indisponível — tipo e campos não puderam ser validados contra o app");
    return { errors, warnings };
  }
  const t = schema.types.find((x) => x.name === type);
  if (!t) {
    errors.push(`tipo "${type}" não está exposto na Data API — habilite-o em Settings > API`);
    return { errors, warnings };
  }
  const missing = [keyField, htmlField].filter((f) => !t.fields.some((x) => x.name === f));
  if (missing.length) {
    errors.push(
      `campos ausentes do swagger: ${missing.join(", ")} — exponha-os em Settings > API para o tipo ${type}`,
    );
  }
  if (!t.operations.includes("POST collection")) {
    errors.push(`POST /obj/${type} não está exposto — o app recusaria a criação`);
  }
  if (!t.operations.includes("PATCH by-id")) {
    warnings.push(`PATCH por id não está exposto — um deploy futuro sobre a página registrada falhará`);
  }
  return { errors, warnings };
}

/**
 * Registros do tipo com o campo chave = slug. Lista vazia não é erro: o
 * deploy cria o registro. Mais de um é data corrompida do app — o deploy
 * atualiza só o primeiro e avisa.
 */
export async function findPagesByKey(
  client: BubbleClient,
  type: string,
  keyField: string,
  slug: string,
): Promise<BubbleThing[]> {
  const page = await client.list(type, {
    constraints: [{ key: keyField, constraint_type: "equals", value: slug }],
    limit: 100,
  });
  return page.results;
}

/** Destino resolvido de um deploy: o que seria feito, sem escrever nada. */
export interface PageDeployTarget {
  action: "create" | "update";
  method: "POST" | "PATCH";
  endpoint: string;
  /** Id do registro existente (update). */
  id?: string;
  warnings: string[];
}

export type PageTargetOptions = Omit<PageDeployOptions, "file"> & { schema?: NormalizedSchema };

/** Valida o contrato e busca o registro pela chave. Compartilhado pela CLI e pela tool MCP. */
export async function resolvePageDeploy(client: BubbleClient, opts: PageTargetOptions): Promise<PageDeployTarget> {
  const contract = checkPageContract(opts.schema, opts.type, opts.keyField, opts.htmlField);
  if (contract.errors.length) {
    throw new Error(
      `Contrato do tipo "${opts.type}" não aceita deploy de página:\n- ${contract.errors.join("\n- ")}`,
    );
  }
  const existing = await findPagesByKey(client, opts.type, opts.keyField, opts.slug);
  const target = existing[0];
  const warnings = [...contract.warnings];
  if (existing.length > 1) {
    warnings.push(
      `${existing.length} registros com ${opts.keyField}="${opts.slug}" — atualizando só ${target!._id}; dedupe no app`,
    );
  }
  if (!target) return { action: "create", method: "POST", endpoint: `${client.apiRoot}/obj/${opts.type}`, warnings };
  return {
    action: "update",
    method: "PATCH",
    endpoint: `${client.apiRoot}/obj/${opts.type}/${encodeURIComponent(target._id)}`,
    id: target._id,
    warnings,
  };
}

/** Cria ou atualiza o registro da página no destino resolvido; devolve o id. */
export async function applyPageDeploy(
  client: BubbleClient,
  opts: Omit<PageTargetOptions, "schema">,
  target: PageDeployTarget,
  html: string,
): Promise<string> {
  const fields: Record<string, unknown> = { [opts.keyField]: opts.slug, [opts.htmlField]: html };
  if (target.action === "create") return client.create(opts.type, fields);
  await client.update(opts.type, target.id!, fields);
  return target.id!;
}

/**
 * Resolve o deploy de uma página local: valida o contrato, busca o registro
 * pela chave e devolve um plano (dry-run) ou executa a escrita.
 */
export async function deployPage(
  config: BridgeConfig,
  client: BubbleClient,
  opts: PageDeployOptions & { schema?: NormalizedSchema; execute: boolean },
): Promise<PageDeployResult> {
  const target = await resolvePageDeploy(client, opts);
  if (opts.execute) assertWritable(config, client);
  const html = await readFile(opts.file, "utf8");
  const base = {
    action: target.action,
    type: opts.type,
    slug: opts.slug,
    method: target.method,
    endpoint: target.endpoint,
    html_bytes: Buffer.byteLength(html, "utf8"),
    warnings: target.warnings,
  };
  if (!opts.execute) {
    return { ...base, id: target.id, dry_run: true, aviso: "nada foi alterado — rode de novo com --execute para aplicar" };
  }
  const id = await applyPageDeploy(client, opts, target, html);
  return { ...base, id, dry_run: false };
}
