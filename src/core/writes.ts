import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BridgeConfig } from "../config.js";
import type { BubbleClient } from "./client.js";
import { safeSegment } from "./files.js";

/**
 * Guardas de escrita, em camadas:
 * 1. modo do servidor (read-write/admin) decide se a tool existe;
 * 2. live exige BUBBLE_ALLOW_LIVE_WRITES=true;
 * 3. toda escrita começa como dry-run e devolve um plan_id;
 * 4. executar exige o mesmo plan_id, emitido por dry-run, dentro do TTL e de uso único;
 * 5. a aprovação humana fica no cliente MCP (permissão "ask" no OpenCode).
 */

export class WriteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteRefused";
  }
}

export function assertWritable(config: BridgeConfig, client: BubbleClient): void {
  if (client.env === "live" && !config.allowLiveWrites) {
    throw new WriteRefused(
      "Escrita no live bloqueada. Use BUBBLE_ENV=test ou, se for intencional, defina BUBBLE_ALLOW_LIVE_WRITES=true.",
    );
  }
}

/** JSON com chaves ordenadas, para o hash não depender da ordem dos campos. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/**
 * Identificador do plano: hash de ferramenta + ambiente + app + argumentos.
 *
 * `scope` amarra o plano a quem o emitiu — no transporte HTTP, o nome do
 * client. Sem isso, um client autorizado poderia executar o plano emitido por
 * outro (o `plan_id` é determinístico: os mesmos argumentos dão o mesmo id).
 */
export function planId(tool: string, client: BubbleClient, args: unknown, scope = "local"): string {
  return createHash("sha256")
    .update(canonicalJson({ tool, api: client.apiRoot, scope, args }))
    .digest("hex")
    .slice(0, 16);
}

export interface WritePlan {
  plan_id: string;
  tool: string;
  env: string;
  method: string;
  endpoint: string;
  summary: string;
  payload_preview: unknown;
  next_step: string;
}

/** Prévia limitada do payload: o suficiente para revisar sem estourar o contexto. */
export function preview(payload: unknown, maxItems = 5): unknown {
  if (Array.isArray(payload)) {
    return payload.length > maxItems
      ? { first_items: payload.slice(0, maxItems), total_items: payload.length }
      : payload;
  }
  return payload;
}

const PLAN_TTL_MS = 15 * 60_000;
// ponytail: escopo de processo (HTTP stateless cria um McpServer por requisição); valor negativo = já consumido.
const plans = new Map<string, number>();

export function resetPlans(): void {
  plans.clear();
}

/** Registra o plan_id emitido por um dry-run (e purga expirados, mantendo o Map limitado). */
export function registerPlan(id: string): void {
  const now = Date.now();
  for (const [k, v] of plans) if (Math.abs(v) <= now) plans.delete(k);
  plans.set(id, now + PLAN_TTL_MS);
}

/** Valida e consome o plano (uso único) ANTES de executar. */
export function verifyPlan(expected: string, received: string | undefined): void {
  if (!received) {
    throw new WriteRefused("Execução sem plan_id. Rode antes com dry_run=true, revise o plano e reenvie com o plan_id devolvido.");
  }
  if (received !== expected) {
    throw new WriteRefused(
      "plan_id não corresponde aos argumentos atuais: o payload mudou desde a revisão, ou o plano foi emitido por outro " +
        "client. Gere um novo plano com dry_run=true.",
    );
  }
  const exp = plans.get(received);
  if (exp === undefined || Math.abs(exp) <= Date.now()) {
    throw new WriteRefused("plan_id sem dry-run prévio ou expirado (15 min). Gere um novo plano com dry_run=true.");
  }
  if (exp < 0) {
    throw new WriteRefused("plan_id já executado; planos são de uso único. Gere um novo plano com dry_run=true se quiser repetir.");
  }
  plans.set(received, -exp);
}

/** Salva o registro antes de apagar, para permitir recriação manual. */
export async function snapshotBeforeDelete(
  client: BubbleClient,
  type: string,
  id: string,
  exportDir: string,
): Promise<string> {
  const thing = await client.getThing(type, id);
  const dir = resolve(exportDir, "snapshots");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${safeSegment(type)}-${safeSegment(id)}-${client.env}-${stamp}.json`);
  await writeFile(file, JSON.stringify({ type, env: client.env, deleted_at: new Date().toISOString(), record: thing }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return file;
}
