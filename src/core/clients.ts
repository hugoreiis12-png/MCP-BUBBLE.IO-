import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { MODES, modeRank, type Mode } from "../config.js";

/**
 * Registro de clients do transporte remoto: cada client tem nome, teto de modo e
 * o sha256 do próprio token. O token em claro só existe na saída de `clients add`.
 */

export interface ClientIdentity {
  name: string;
  mode: Mode;
}

/** Recebe o bearer apresentado e devolve quem é, ou null (401). */
export type Authenticator = (bearer: string) => ClientIdentity | null;

const ClientSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, "nome: letras, números, . _ - (até 63)"),
  token_sha256: z.string().regex(/^[0-9a-f]{64}$/, "token_sha256 precisa ser hex de 64 caracteres"),
  mode: z.enum(MODES),
  enabled: z.boolean().default(true),
  created_at: z.string().optional(),
});
const ClientsFileSchema = z.object({ clients: z.array(ClientSchema) });

export type ClientRecord = z.infer<typeof ClientSchema>;

const TOKEN_BYTES = 32;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** O servidor é o teto: um client nunca recebe mais que o BUBBLE_MODE. */
export function effectiveMode(clientMode: Mode, serverMode: Mode): Mode {
  return modeRank(clientMode) <= modeRank(serverMode) ? clientMode : serverMode;
}

/** Compara hashes de tamanho fixo em tempo constante, sempre percorrendo a lista inteira. */
function findByToken(clients: ClientRecord[], bearer: string): ClientRecord | undefined {
  const presented = Buffer.from(hashToken(bearer), "hex");
  let match: ClientRecord | undefined;
  for (const c of clients) {
    if (timingSafeEqual(presented, Buffer.from(c.token_sha256, "hex")) && !match) match = c;
  }
  return match;
}

/** Autenticador de token único (BUBBLE_BRIDGE_HTTP_TOKEN): vira o client "default". */
export function staticTokenAuth(token: string, mode: Mode): Authenticator {
  const record: ClientRecord = { name: "default", token_sha256: hashToken(token), mode, enabled: true };
  return (bearer) => (findByToken([record], bearer) ? { name: record.name, mode: record.mode } : null);
}

export function readClients(path: string): ClientRecord[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // Arquivo corrompido nunca libera acesso: a requisição vira 500 com a causa.
    throw new Error(
      `Arquivo de clients ilegível (${path}): ${err instanceof Error ? err.message : String(err)}. ` +
        "Rode `clients list` para conferir o formato { \"clients\": [ ... ] }.",
    );
  }
  const parsed = ClientsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Arquivo de clients inválido (${path}):\n${issues}`);
  }
  return parsed.data.clients;
}

/** Grava atômico (tmp + rename) e com permissão 600. */
export function writeClients(path: string, clients: ClientRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ clients }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

/** Lê o arquivo de clients e o relê quando o mtime muda (revogar sem reiniciar). */
export class ClientRegistry {
  private clients: ClientRecord[] = [];
  private version = "";

  constructor(private readonly path: string) {
    this.reload();
  }

  readonly authenticate: Authenticator = (bearer) => {
    this.reload();
    const match = findByToken(this.clients, bearer);
    return match?.enabled ? { name: match.name, mode: match.mode } : null;
  };

  activeCount(): number {
    this.reload();
    return this.clients.filter((c) => c.enabled).length;
  }

  /** Falha fechada: arquivo corrompido lança e a requisição vira 500, nunca acesso liberado. */
  private reload(): void {
    const stat = existsSync(this.path) ? statSync(this.path) : undefined;
    const version = stat ? `${stat.mtimeMs}:${stat.size}:${stat.ino}` : "ausente";
    if (version === this.version) return;
    this.clients = readClients(this.path);
    this.version = version;
  }
}

export function addClient(path: string, name: string, mode: Mode): string {
  const clients = readClients(path);
  if (clients.some((c) => c.name === name)) throw new Error(`client "${name}" já existe — revogue ou use outro nome`);
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const record = ClientSchema.parse({ name, token_sha256: hashToken(token), mode, enabled: true, created_at: new Date().toISOString() });
  writeClients(path, [...clients, record]);
  return token;
}

export function revokeClient(path: string, name: string): void {
  const clients = readClients(path);
  if (!clients.some((c) => c.name === name)) throw new Error(`client "${name}" não encontrado`);
  writeClients(path, clients.map((c) => (c.name === name ? { ...c, enabled: false } : c)));
}

/** Visão segura: nunca expõe o hash. */
export function listClients(path: string): Array<Omit<ClientRecord, "token_sha256">> {
  return readClients(path).map(({ token_sha256: _hash, ...rest }) => rest);
}