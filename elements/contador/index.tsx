// Elemento de exemplo: mostra o contrato completo — fields de entrada,
// um estado exposto ao Bubble, um evento e reset.
import { useEffect, useRef, useState } from "react";
import { defineElement } from "../../src/element/react.js";

type Props = { titulo: string; inicial: number; passo: number };

export default defineElement<Props, "valor", "mudou">({
  name: "contador",
  display: "Contador BB",
  properties: { titulo: "text", inicial: "number", passo: "number" },
  states: ["valor"],
  events: ["mudou"],
  initialStates: { valor: 0 },
  render: (props, api) => <Contador {...props} api={api} />,
});

function Contador({
  titulo = "Contador",
  inicial = 0,
  passo = 1,
  api,
}: Partial<Props> & { api: { publishState(n: "valor", v: unknown): void; triggerEvent(n: "mudou"): void } }) {
  const [valor, setValor] = useState(inicial);
  // Fonte da verdade entre renders: cliques rápidos não podem ler um `valor` antigo.
  const atual = useRef(inicial);

  // Quando o Bubble muda o valor inicial (ex.: outro registro), recomeça dele.
  useEffect(() => {
    atual.current = inicial;
    setValor(inicial);
    api.publishState("valor", inicial);
  }, [inicial]); // eslint-disable-line react-hooks/exhaustive-deps

  const somar = (delta: number) => {
    atual.current += delta;
    setValor(atual.current);
    api.publishState("valor", atual.current);
    api.triggerEvent("mudou");
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, font: "14px system-ui, sans-serif" }}>
      <strong>{titulo}</strong>
      <button type="button" aria-label="diminuir" onClick={() => somar(-passo)}>
        −
      </button>
      <output data-testid="valor">{valor}</output>
      <button type="button" aria-label="aumentar" onClick={() => somar(passo)}>
        +
      </button>
    </div>
  );
}
