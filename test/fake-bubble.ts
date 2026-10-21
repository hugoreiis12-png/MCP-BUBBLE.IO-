import { readFileSync } from "node:fs";
import type { FetchLike } from "../src/core/http.js";

type Thing = { _id: string; "Created Date": string } & Record<string, unknown>;

export interface FakeOptions {
  /** Teto de itens por cursor, como o Bubble (50.000). */
  cap?: number;
  /** Quantas respostas 429 devolver antes de responder normalmente. */
  throttle?: number;
  token?: string;
  /**
   * Como `remaining` se comporta perto do teto — o manual não diz:
   * "capped" conta só até o teto; "total" conta todos os registros da busca.
   */
  remaining?: "capped" | "total";
  /** Workflows que o app declara públicos: respondem 200 mesmo sem token. */
  publicWorkflows?: string[];
}

/**
 * Simulação mínima da Data API para testes: busca com constraints
 * equals / greater than, ordenação por Created Date, cursor, limit e teto.
 */
export function fakeBubble(data: Record<string, Thing[]>, opts: FakeOptions = {}) {
  const calls: string[] = [];
  const writes: Array<{ method: string; path: string; body?: string }> = [];
  let seq = 0;
  let throttle = opts.throttle ?? 0;
  const swagger = JSON.parse(readFileSync(new URL("./fixtures/swagger.json", import.meta.url), "utf8"));

  const fetch: FetchLike = async (input, init) => {
    calls.push(input);
    const url = new URL(input);
    if (throttle > 0) {
      throttle--;
      return new Response("", { status: 429, headers: { "retry-after": "0" } });
    }
    const path = url.pathname.replace(/^\/version-test/, "");
    const wfMatch = /^\/api\/1\.1\/wf\/([^/]+)$/.exec(path);
    if (opts.token && (init?.headers as Record<string, string>)?.Authorization !== `Bearer ${opts.token}`) {
      // Workflow declarado público no app responde sem token: o leak é do app, não do token.
      if (wfMatch && opts.publicWorkflows?.includes(decodeURIComponent(wfMatch[1]!))) {
        return json(200, { status: "success", response: { executaveis: [{ _id: "doc1", nome: "backup" }] } });
      }
      return json(401, { error_class: "Unauthorized", translation: "You do not have permission" });
    }
    if (path === "/api/1.1/meta/swagger.json") return json(200, swagger);
    if (path === "/api/1.1/meta") {
      const types: Record<string, unknown> = {};
      for (const name of Object.keys(data)) {
        types[name] = {
          display: name,
          fields: [
            { id: `${name}_f_nome_custom`, display: "nome", type: "text" },
            { id: `${name}_f_total_number`, display: "total", type: "number" },
            { id: `${name}_f_itens_list_${name}`, display: "itens", type: `list.custom.${name}` },
          ],
        };
      }
      return json(200, {
        get: Object.keys(data),
        post: [
          {
            endpoint: "admin",
            method: "post",
            auth_unecessary: true,
            parameters: [{ key: "_wf_request_data", value: "api_wf_data.bXOXT", optional: false, param_in: "body" }],
            return_btype: { executaveis: "list.custom.meusexecutaveisdocumentos" },
          },
          {
            endpoint: "login",
            method: "post",
            auth_unecessary: false,
            parameters: [{ key: "_wf_request_data", value: "api_wf_data.bUWEg0", optional: false, param_in: "body" }],
            return_btype: { token: "text" },
          },
        ],
        types,
        app_data: { appname: "meuapp", app_version: "test" },
      });
    }

    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({ method, path, body: typeof init?.body === "string" ? init.body : undefined });
      const wf = /^\/api\/1\.1\/wf\/([^/]+)$/.exec(path);
      if (wf && method === "POST") {
        return json(200, { status: "success", response: { echo: JSON.parse(String(init?.body ?? "{}")) } });
      }
      const w = /^\/api\/1\.1\/obj\/([^/]+)(?:\/([^/]+))?$/.exec(path);
      if (!w) return json(404, { statusCode: 404, body: { status: "NOT_FOUND", message: "no route" } });
      const wtype = decodeURIComponent(w[1]!);
      const list = (data[wtype] ??= []);
      const sub = w[2] ? decodeURIComponent(w[2]) : undefined;
      if (method === "POST" && sub === "bulk") {
        if ((init?.headers as Record<string, string>)["Content-Type"] !== "text/plain") {
          return json(400, { statusCode: 400, body: { status: "ERROR", message: "Make sure the Content-Type header is text/plain" } });
        }
        const lines = String(init?.body)
          .split("\n")
          .map((l) => {
            const item = JSON.parse(l) as Record<string, unknown>;
            if (item.invalid) return JSON.stringify({ status: "error", message: "Permission denied" });
            const id = `new${++seq}`;
            list.push({ _id: id, "Created Date": new Date().toISOString(), ...item });
            return JSON.stringify({ status: "success", id });
          });
        return new Response(lines.join("\n"), { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (method === "POST" && !sub) {
        const id = `new${++seq}`;
        list.push({ _id: id, "Created Date": new Date().toISOString(), ...JSON.parse(String(init?.body)) });
        return json(201, { status: "success", id });
      }
      const idx = list.findIndex((r) => r._id === sub);
      if (idx < 0) return json(404, { statusCode: 404, body: { status: "MISSING_DATA", message: "missing" } });
      if (method === "PATCH") {
        Object.assign(list[idx]!, JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        list.splice(idx, 1);
        return new Response(null, { status: 204 });
      }
      return json(405, { statusCode: 405, body: { status: "ERROR", message: "method" } });
    }

    const m = /^\/api\/1\.1\/obj\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (!m) return json(404, { statusCode: 404, body: { status: "NOT_FOUND", message: "no route" } });
    const type = decodeURIComponent(m[1]!);
    const rows = data[type];
    if (!rows) return json(404, { statusCode: 404, body: { status: "NOT_FOUND", message: `type ${type}` } });

    if (m[2]) {
      const thing = rows.find((r) => r._id === decodeURIComponent(m[2]!));
      return thing
        ? json(200, { response: thing })
        : json(404, { statusCode: 404, body: { status: "MISSING_DATA", message: "missing" } });
    }

    const constraints = JSON.parse(url.searchParams.get("constraints") ?? "[]") as Array<{
      key: string;
      constraint_type: string;
      value: unknown;
    }>;
    let filtered = rows.filter((r) =>
      constraints.every((c) => {
        const v = r[c.key];
        if (c.constraint_type === "equals") return v === c.value;
        if (c.constraint_type === "greater than") return String(v) > String(c.value);
        throw new Error(`fake não suporta ${c.constraint_type}`);
      }),
    );
    if (url.searchParams.get("sort_field") === "Created Date") {
      filtered = [...filtered].sort((a, b) => (a["Created Date"] < b["Created Date"] ? -1 : a["Created Date"] > b["Created Date"] ? 1 : a._id.localeCompare(b._id)));
    }
    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const cap = opts.cap ?? 50_000;
    const visible = filtered.slice(0, cap);
    const page = cursor >= cap ? [] : visible.slice(cursor, cursor + limit);
    const universe = opts.remaining === "total" ? filtered.length : visible.length;
    const remaining = Math.max(0, universe - cursor - page.length);
    return json(200, { response: { cursor, results: page, count: page.length, remaining } });
  };

  return { fetch, calls, writes, data };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Gera n registros; `sameDateEvery` agrupa registros com o mesmo Created Date. */
export function makeRows(n: number, sameDateEvery = 1): Thing[] {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  return Array.from({ length: n }, (_, i) => ({
    _id: `id${String(i).padStart(6, "0")}`,
    "Created Date": new Date(start + Math.floor(i / sameDateEvery) * 1000).toISOString(),
    n: i,
  }));
}
