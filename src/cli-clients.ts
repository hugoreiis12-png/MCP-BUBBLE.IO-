import { MODES, type Mode } from "./config.js";
import { addClient, listClients, revokeClient } from "./core/clients.js";

const USAGE = "uso: bubble-bridge clients add <nome> --mode read-only|read-write|admin | list | revoke <nome> [--file clients.json]";

function parseMode(raw: string | undefined): Mode {
  if (raw && (MODES as readonly string[]).includes(raw)) return raw as Mode;
  throw new Error(`--mode obrigatório: ${MODES.join(" | ")}`);
}

/** Gestão de clients do transporte remoto. Não fala com o Bubble: não exige BUBBLE_APP_URL. */
export function runClients(positionals: string[], mode: string | undefined, file: string | undefined): number {
  const path = file ?? process.env.BUBBLE_BRIDGE_CLIENTS_FILE;
  if (!path) throw new Error("defina --file ou BUBBLE_BRIDGE_CLIENTS_FILE");
  const [action, name] = positionals;
  if (action === "list") {
    process.stdout.write(JSON.stringify(listClients(path), null, 2) + "\n");
    return 0;
  }
  if (!name) throw new Error(USAGE);
  if (action === "add") {
    const token = addClient(path, name, parseMode(mode));
    process.stderr.write(`[bubble-bridge] client "${name}" criado. Guarde o token agora: ele não é exibido de novo.\n`);
    process.stdout.write(token + "\n");
    return 0;
  }
  if (action === "revoke") {
    revokeClient(path, name);
    process.stderr.write(`[bubble-bridge] client "${name}" revogado (vale na próxima requisição).\n`);
    return 0;
  }
  throw new Error(USAGE);
}
