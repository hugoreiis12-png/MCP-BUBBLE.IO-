import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditEntry {
  tool: string;
  env: string;
  /** Nome do client remoto que chamou (transporte HTTP). */
  client?: string;
  /** Tipo, workflow ou recurso alvo — nunca o token. */
  target?: string;
  ok: boolean;
  ms: number;
  items?: number;
  error?: string;
  /** Escritas: id do plano executado (hash do payload, não o payload). */
  planId?: string;
  dryRun?: boolean;
}

/** Log de auditoria em JSON Lines. Sem caminho configurado, não grava nada. */
export class AuditLog {
  constructor(private readonly path?: string) {}

  async write(entry: AuditEntry): Promise<void> {
    if (!this.path) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      // Falha de auditoria não derruba a operação, mas fica visível em stderr.
      process.stderr.write(`[bubble-bridge] falha ao gravar auditoria em ${this.path}: ${String(err)}\n`);
    }
  }
}
