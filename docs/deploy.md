# Deploy no Portainer (rede interna)

O Bubble Bridge roda como uma stack do Portainer, só na rede interna, e os clients MCP
(OpenCode, Claude Code, Claude Desktop) conectam por HTTP com **um token por client**.

```
client MCP ──HTTP + Bearer──▶ VM :8787 ──▶ container bridge ──HTTPS──▶ App Bubble
                                             └─ volume bridge-data: clients.json, logs/, exports/
```

## 1. Subir a stack

**Opção A: Repository (recomendada).** Em Portainer, vá em Stacks → Add stack → Repository:

- **Repository URL:** o repositório deste projeto.
- **Compose path:** `deploy/docker-compose.yml`. O build da imagem é feito na própria VM.
- **Environment variables:** use Advanced mode, cole `deploy/stack.env.example` e preencha.
  `BUBBLE_API_TOKEN` fica só aqui, nunca no git.

**Opção B: Web editor.** Construa a imagem na VM com `docker build -t bubble-bridge:0.4.0 .`, cole
`deploy/docker-compose.yml` sem o bloco `build:` e preencha as mesmas variáveis.

**Porta: 8787** (fixa no compose). `BRIDGE_BIND_IP` é **obrigatório**: a porta só é publicada no
IP da VM na rede interna, e a stack não sobe sem ele. Para descobrir o IP, rode `ip -4 addr` na VM.
No firewall da VM, libere a 8787 só para a sub-rede interna, por exemplo
`ufw allow from 192.168.0.0/24 to any port 8787 proto tcp`.

## 2. Cadastrar clients

Em Portainer, vá em Containers → `bridge` → Console (`/bin/sh`) e rode:

```sh
node dist/cli.js clients add hugo-opencode --mode read-write   # imprime o token UMA vez
node dist/cli.js clients list                                  # nome, modo, ativo (sem hashes)
node dist/cli.js clients revoke hugo-opencode                  # vale na próxima requisição
```

- O arquivo é `/data/clients.json`, guardado no volume `bridge-data`, e contém só o **sha256** de cada token.
- **Modo efetivo** = o menor entre o modo do client e o `BUBBLE_MODE` da stack, que é o teto do servidor.
- Uma mudança no arquivo vale sem reiniciar o container. Se o arquivo estiver corrompido, o servidor
  responde 500 e nunca libera acesso.
- `bubble_data_export` e `bubble_editor_export` não aparecem para client remoto, porque o arquivo seria gravado no disco da VM.

## 3. Conectar os clients

Troque `vm-interna` pelo IP ou hostname da VM e `TOKEN` pelo valor que o `clients add` imprimiu.

**Claude Code**
```sh
claude mcp add --transport http bubble http://vm-interna:8787/mcp --header "Authorization: Bearer TOKEN"
```

**OpenCode** (`opencode.json`)
```json
{
  "mcp": {
    "bubble": {
      "type": "remote",
      "url": "http://vm-interna:8787/mcp",
      "headers": { "Authorization": "Bearer {env:BUBBLE_BRIDGE_TOKEN}" },
      "enabled": true
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`, via ponte stdio → HTTP)
```json
{
  "mcpServers": {
    "bubble": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://vm-interna:8787/mcp", "--allow-http", "--header", "Authorization: Bearer TOKEN"]
    }
  }
}
```

## 4. Verificar

```sh
curl http://vm-interna:8787/healthz                                   # {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://vm-interna:8787/mcp -d '{}'   # 401
curl -s -X POST http://vm-interna:8787/mcp \
  -H "Authorization: Bearer TOKEN" -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'          # tools do modo do client
```

A auditoria fica em `/data/logs/audit.jsonl`, uma linha por chamada com o nome do client.
Ela nunca registra token nem payload. Os logs do processo saem pelo Portainer, em Containers → `bridge` → Logs.

## Segurança na rede interna

- O tráfego é HTTP puro, então o bearer trafega em claro dentro da rede. Se a rede não for confiável,
  coloque um proxy TLS interno na frente e defina `BUBBLE_BRIDGE_TRUST_PROXY=true` para o rate
  limit usar o IP real que vem do `X-Forwarded-For`.
- O container roda sem root, com sistema de arquivos read-only, sem capabilities e com limite de 512 MB.
- Os limites por padrão são 120 req/min por IP antes da autenticação, 120 req/min por client depois dela,
  32 requisições em voo e 6 chamadas simultâneas à API do Bubble, compartilhadas entre todos os clients.
- Requisições com `Origin` de navegador são recusadas, a menos que o Origin esteja em `BUBBLE_BRIDGE_ALLOWED_ORIGINS`.