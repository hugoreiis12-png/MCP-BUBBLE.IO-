/**
 * Runtime de elementos Bubble escritos em React.
 *
 * O autor escreve `export default defineElement({...})`; o build gera um bundle
 * que chama `registerElement`, e os arquivos initialize/update/reset.js do plugin
 * apenas delegam para `window.__bubbleBridge[name]`.
 *
 * Contrato do Bubble usado aqui (verificado em plugins públicos sincronizados com GitHub):
 *   initialize(instance, context) · update(instance, properties, context) · reset(instance, context)
 *   `properties` vem indexado pelo `name` de cada field do params.json.
 *   `instance.publishState(nome, valor)` e `instance.triggerEvent(nome)` expõem estados e eventos.
 */
import { Component, createElement, type ErrorInfo, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

export type PropKind = "text" | "number" | "boolean" | "date" | "list" | "any";

export interface ElementApi<S extends string = string, E extends string = string> {
  publishState(name: S, value: unknown): void;
  triggerEvent(name: E): void;
  /** Contexto do Bubble (usuário atual, upload etc.), como o Bubble o entrega. */
  context: unknown;
}

export interface ElementDefinition<P extends Record<string, unknown> = Record<string, unknown>, S extends string = string, E extends string = string> {
  /** Chave técnica do bundle: letras, números, _ e -. */
  name: string;
  /** Nome do elemento no Plugin Editor (campo `display` do params.json). */
  display: string;
  /** Fields do elemento: chave = `name` do field no Plugin Editor. */
  properties: { [K in keyof P]: PropKind };
  states?: readonly S[];
  events?: readonly E[];
  /** Publicados no initialize — evita o erro de dependência circular citado no manual. */
  initialStates?: Partial<Record<S, unknown>>;
  render(props: Partial<P>, api: ElementApi<S, E>): ReactNode;
  onReset?(api: ElementApi<S, E>): void;
}

export function defineElement<P extends Record<string, unknown>, S extends string = never, E extends string = never>(
  def: ElementDefinition<P, S, E>,
): ElementDefinition<P, S, E> {
  if (!/^[A-Za-z0-9_-]+$/.test(def.name)) throw new Error(`Nome de elemento inválido: "${def.name}"`);
  return def;
}

/** Forma mínima do `instance` do Bubble que o runtime usa. */
export interface BubbleInstance {
  canvas: HTMLElement | { 0?: HTMLElement; get?(i: number): HTMLElement };
  data: Record<string, unknown>;
  publishState(name: string, value: unknown): void;
  triggerEvent(name: string): void;
}

export interface Registered {
  initialize(instance: BubbleInstance, context: unknown): void;
  update(instance: BubbleInstance, properties: Record<string, unknown>, context: unknown): void;
  reset(instance: BubbleInstance, context: unknown): void;
}

interface Slot {
  root: Root;
  props: Record<string, unknown>;
  api: ElementApi;
  generation: number;
}

const SLOT = "__bubbleBridge";

/** `instance.canvas` é um objeto jQuery nos plugins com jQuery; aceita os dois formatos. */
export function canvasElement(canvas: BubbleInstance["canvas"]): HTMLElement {
  if (typeof (canvas as HTMLElement).appendChild === "function") return canvas as HTMLElement;
  const jq = canvas as { 0?: HTMLElement; get?(i: number): HTMLElement };
  const el = jq[0] ?? jq.get?.(0);
  if (!el) throw new Error("instance.canvas sem elemento DOM");
  return el;
}

class Boundary extends Component<{ name: string; children?: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[bubble-bridge] elemento "${this.props.name}" falhou ao renderizar`, error, info.componentStack);
  }
  override render() {
    if (this.state.error) {
      return createElement(
        "div",
        { role: "alert", style: { font: "12px sans-serif", color: "#b42318", padding: 8 } },
        `Erro no elemento ${this.props.name}: ${this.state.error.message}`,
      );
    }
    return this.props.children;
  }
}

function pickProps(def: ElementDefinition, properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(def.properties)) {
    const v = properties[key];
    out[key] = v === null ? undefined : v;
  }
  return out;
}

export function adapter(def: ElementDefinition): Registered {
  const states = new Set<string>(def.states ?? []);
  const events = new Set<string>(def.events ?? []);

  // `render` roda dentro de um componente: hooks (useState, useEffect…) funcionam nele.
  const Host = (p: { props: Record<string, unknown>; api: ElementApi }) => def.render(p.props, p.api) ?? null;
  const draw = (slot: Slot) => {
    flushSync(() => {
      // `key` muda no reset: o React remonta o componente e o estado interno volta ao inicial.
      slot.root.render(
        createElement(Boundary, { name: def.name, key: slot.generation }, createElement(Host, { props: slot.props, api: slot.api })),
      );
    });
  };

  return {
    initialize(instance, context) {
      const host = document.createElement("div");
      host.style.width = "100%";
      host.style.height = "100%";
      host.setAttribute("data-bubble-bridge", def.name);
      canvasElement(instance.canvas).appendChild(host);
      const api: ElementApi = {
        context,
        publishState(name, value) {
          if (!states.has(name)) {
            console.warn(`[bubble-bridge] estado "${name}" não declarado em ${def.name}`);
            return;
          }
          instance.publishState(name, value);
        },
        triggerEvent(name) {
          if (!events.has(name)) {
            console.warn(`[bubble-bridge] evento "${name}" não declarado em ${def.name}`);
            return;
          }
          instance.triggerEvent(name);
        },
      };
      const slot: Slot = { root: createRoot(host), props: {}, api, generation: 0 };
      instance.data[SLOT] = slot;
      for (const [name, value] of Object.entries(def.initialStates ?? {})) api.publishState(name, value);
    },
    update(instance, properties, context) {
      const slot = instance.data[SLOT] as Slot | undefined;
      if (!slot) return;
      slot.api.context = context;
      slot.props = pickProps(def, properties ?? {});
      draw(slot);
    },
    reset(instance) {
      const slot = instance.data[SLOT] as Slot | undefined;
      if (!slot) return;
      def.onReset?.(slot.api);
      slot.generation++;
      draw(slot);
    },
  };
}

/** Chamado pelo bundle gerado. Idempotente: recarregar o header não duplica o registro. */
export function registerElement(def: ElementDefinition): void {
  const g = globalThis as unknown as { __bubbleBridge?: Record<string, Registered> };
  g.__bubbleBridge ??= {};
  g.__bubbleBridge[def.name] = adapter(def);
}
