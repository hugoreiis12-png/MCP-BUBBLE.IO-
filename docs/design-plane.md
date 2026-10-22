# Plano de design do Bubble: leitura, escrita e o que a credencial alcança

Documento de referência do `bubble_design_read`, `bubble_editor_discover`,
`bubble_editor_read`, `bubble_editor_export` e `bubble_editor_write`. Tudo aqui
foi verificado contra o app real em 2026-10-21 (branch `version-test` do app
`comprover`).

---

## 1. A pergunta

"Consigo ler e escrever o design do app (o que se vê no editor do
bubble.io) usando só as credenciais do app?"

Resposta curta: **ler, sim. Escrever, não — e a diferença é de credencial, não
de código.**

| Caminho | Credencial | Estado |
| --- | --- | --- |
| Contrato de design (tipos, campos, workflows) | `BUBBLE_API_TOKEN` do app | ✅ funciona hoje |
| Design de verdade (páginas, elementos, workflow de design) | sessão da conta Bubble | ⚠️ implementado, precisa do cookie |
| Design publicado no live | sessão da conta Bubble + `BUBBLE_ALLOW_LIVE_WRITES=true` | ⚠️ idem |

---

## 2. O que o token do app alcança (e o que não alcança)

### 2.1 Alcança — o contrato de design

`GET {apiRoot}/meta` devolve, com o token do app:

- **`types`** — 291 tipos com o **id interno de cada campo** (o `display` é o
  nome de exibição; o `id` é o que o runtime e o editor endereçam).
- **taxonomia de tipos de campo** — `text`, `number`, `boolean`, `date`, `user`,
  `file`, `image`, `geographic_address`, `custom.<tipo>` (referência),
  `option.<option-set>` (conjunto de opções) e `list.<qualquer>`.
- **`post`** — 192 backend workflows com assinatura completa:
  `{endpoint, method, parameters:[{key, value, optional, param_in}], auth_unecessary, return_btype}`.
- **`app_data`** — `appname`, `app_version`, `favicon`, `use_captions_for_get`.

O `/meta` é **mais rico que o swagger** (`/meta/swagger.json`, 12,6 MB, 774
paths): traz os ids internos e o `auth_unecessary`, que o swagger não traz.
O swagger continua sendo a fonte para a forma dos *tipos* expostos na Data API.

> O `value` do parâmetro de um workflow é um id interno opaco
> (`api_wf_data.bUWEg0`). Não há definição correspondente no swagger — o
> mapeamento para o tipo real não é published pelo Bubble.

### 2.2 Não alcança — o plano da plataforma

| Chamada | Resposta |
| --- | --- |
| `POST https://bubble.io/api/1.1/wf/<qualquer>` com o token do app | `401 {"error_class":"Unauthorized","translation":"Invalid or expired token: 64b2…"}` |
| `GET https://editor.bubbleapps.io/api/1.1/...` | `401 "This application does not expose an API. Please upgrade your Bubble subscription…"` |
| `GET https://editor.bubbleapps.io/version-test/api/1.1/...` | idem |

O token é **escopado ao tenant**: ele lê e grava dados do app, mas a plataforma
recusa o mesmo token no plano dela. Não é um bug de configuração — é a
separação de escopos do Bubble.

> O host de `/appeditor/*` (o editor de verdade) é outro — por padrão
> `https://scheduled.bubble.io`, configurável em `BUBBLE_EDITOR_BASE`. A API do
> *app* (`/api/1.1`) e a do *editor* (`/appeditor`) moram em hosts diferentes.

### 2.3 O que alcança o design: a sessão da conta

O editor é um app interno da Bubble. O que o alcança é a **sessão da conta
Bubble**, não um token de app — e são **dois** credenciais, não um:

- cookie `meta_live_u2main` (conta de produção) ou `meta_test_u2main` (dev);
- header `meta-firebase_workflow` com o JWT do Firebase.

Falta qualquer um dos dois e a resposta é 401.

> **Raio de impacto:** essa sessão concede leitura e escrita de design sobre
> **todos os apps que a conta puder editar** — não só o app alvo. É uma
> credencial de conta, não de app. Por isso o Bridge só a usa se o operador
> configurar explicitamente, nunca a registra em log, e a escrita de design
> existe só no modo `admin`.

---

## 3. Por que as operações do editor são configuradas

A API do editor é interna, não documentada e muda sem aviso. O Bridge não
adivinha endpoint: ele executa um **mapa de operações** que o operador aprova.

O protocolo real foi **medido no editor** (não é documentação do Bubble) e o
Bridge o traz como mapa padrão — sobrescrevível por `BUBBLE_EDITOR_OPS`:

```json
{
  "read_design":    {"method":"POST","path":"/appeditor/load_multiple_paths/{app}/{version}"},
  "probe_design":   {"method":"GET", "path":"/appeditor/load_single_path/{app}/{version}/no_version_hash/_index"},
  "write_design":   {"method":"POST","path":"/appeditor/write"},
  "export_design":  {"method":"GET", "path":"/appeditor/export/{version}/{app}.bubble"},
  "changes":        {"method":"GET", "path":"/appeditor/changes/{app}/{version}/{since}/{session}"},
  "publish_design": {"method":"POST","path":"/appeditor/deploy_new_code"}
}
```

- o caminho aceita os placeholders `{app}` (appname), `{version}` (`test`/`live`),
  `{since}`, `{session}` e `{path}` (caminho encolhido);
- o corpo da escrita é `{v:1, appname, app_version, changes:[{body, path_array,
  metadata, session_id}]}` — o payload do agente entra inteiro, sem template
  escondido;
- **`BUBBLE_EDITOR_OPS` sobrescreve o mapa inteiro** (inclusive para reduzir o
  conjunto: omitir uma operação a desliga). O valor pode ser o JSON inline ou o
  caminho de um arquivo com o JSON;
- `bubble_editor_discover` (ou `bubble-bridge editor discover`) **mapeia a raiz do
  design** — os nós (`pages`, `element_definitions`, `api`, `styles`, `settings`…)
  com a contagem de filhos de cada um — e devolve as operações aprovadas. É o
  que responde "o que existe no app e o que dá para ler"; os *endpoints* do
  editor já são o mapa padrão acima.

**Falha fechada:** sem `BUBBLE_EDITOR_SESSION` + `BUBBLE_EDITOR_APP_ID` as
tools de editor nem são registradas; sem uma operação no mapa, a chamada é
recusada com a lista do que existe.

### 3.0 O editor exige duas credenciais

O cookie da conta **e** o header `meta-firebase_workflow` (JWT do Firebase):

```bash
BUBBLE_EDITOR_SESSION='meta_test_u2main=…'
BUBBLE_EDITOR_FIREBASE_TOKEN='eyJhbGciOi…'
```

Com o cookie válido e sem o header, a resposta é **401** — é o motivo mais
comum de a escrita de design falhar. Os dois credenciais ficam fora do log de
auditoria e fora do `bubble_config` (que só diz se estão definidos).

A base do editor (`BUBBLE_EDITOR_BASE`, padrão `https://scheduled.bubble.io`) é
o host de `/appeditor/*` — **não** o host da API do app (`/api/1.1`). São hosts
diferentes: a API do app e a do editor não se misturam.

### 3.1 Caminhos encolhidos ("shrunk")

O editor guarda nomes reservados em forma curta com prefixo `%`: `pages` → `%p3`,
`elements` → `%el`, `name` → `%nm`, `properties` → `%p`, `type` → `%x`. O
caminho vai encolhido **e o valor vai encolhido** — o servidor guarda o corpo
exatamente como ele chega, então mandar `{"name": "x"}` criaria um campo
diferente do que o editor entende. O Bridge encolhe na ida e desencolhe na
volta: o agente vê e escreve na forma humana (`pages.AAW.properties.<fieldId>`).

Apagar um nó é escrever `body: null` no mesmo caminho.

### 3.1 Deploy: publicar é escrever no live, mesmo no branch de dev

No Bubble, **publicar o branch `version-test` já é um deploy do app público** —
o dev sobe para o live. Por isso o gate de escrita tem duas travas, e não uma:

| Trava | Quando | Exigência |
| --- | --- | --- |
| branch alvo | `BUBBLE_EDITOR_BRANCH=version-live` | `BUBBLE_ALLOW_LIVE_WRITES=true` |
| operação de publish | nome ou caminho da op casa `publish\|deploy\|commit\|release\|go_live` | `BUBBLE_ALLOW_LIVE_WRITES=true` |

Sem a segunda trava, um `POST` de publish com `branch=version-test` passaria
batendo pelo gate do branch e subiria para produção. O dry-run também é
recusado nesse caso — o operador vê o bloqueio no plano, antes de executar.

O efeito colateral do publish é invisível no `verify=schema` enquanto o branch
não sobe: `/meta` só reflete o branch publicado.

---

## 4. Confirmação de efeito

O documento de design é interno e versionado pelo Bubble — não há schema para
comparar campo a campo. A verificação é estrutural:

| `verify` | Como confere | Quando a mudança aparece |
| --- | --- | --- |
| `design` (padrão) | relê o nó alterado e compara com o que foi escrito (JSON canônico) | imediatamente, se o editor persistiu |
| `schema` | relê o `/meta` e faz diff do contrato (tipos, campos e workflows) | **só depois de publicar o branch** |
| `none` | não confere | — |

O diff do documento cru (`diffDesignJson`) é limitado (8 níveis, 300 entradas)
e devolve caminhos adicionados, removidos e alterados — o suficiente para dizer
"a escrita mudou alguma coisa" sem despejar o design inteiro no contexto.

O `verify=schema` devolve `schema_diff` com `tipos_adicionados`,
`tipos_removidos`, `campos_adicionados`, `campos_removidos`,
`workflows_adicionados` e `workflows_removidos`. Quando o `/meta` não muda, a
resposta diz por quê: *"/meta reflete apenas o branch publicado — se a escrita
foi no branch de desenvolvimento, o diff só aparece depois de publicar"*.

---

## 4.1 O export do design (a entrada do Motor 2)

O `.bubble` que o editor exporta é a **única fonte** do formato de design que o
Bubble aceita:

```bash
node dist/cli.js editor export                  # → $BUBBLE_EXPORT_DIR/design/*.bubble
node dist/cli.js editor export --out app.bubble # → e também num caminho escolhido
```

Via MCP: `bubble_editor_export` — grava o arquivo e devolve só metadados
(`file`, `bytes`, `sha256`) mais um `head` opcional do começo. O design não é
despejado no contexto.

O arquivo é a entrada do compilador TS → `.bubble` (Motor 2): guarde-o
versionado, porque o formato evolui junto com o editor.

---

## 5. A brecha que apareceu no caminho: 163 workflows públicos

O `/meta` expõe, para cada workflow, o flag `auth_unecessary`. No app real:

```
192 workflows no total · 163 com auth_unecessary = true
```

Tradução: **163 backend workflows respondem sem nenhuma autenticação.** O token
do Bridge nem é preciso — qualquer pessoa na internet, com a URL do app, pode
chamá-los.

### 5.1 PoC (confirmado)

```bash
# sem Authorization, sem cookie — só o corpo vazio
curl -sS -X POST -H 'Content-Type: application/json' -d '{}' \
  https://comprover.bubbleapps.io/version-test/api/1.1/wf/admin
```

Resposta real (`200`):

```json
{ "status": "success", "response": { "executáveis": [
  { "_id": "1787094765075x211941341638447230",
    "Created By": "admin_user_comprover_test",
    "file": "//…cdn.bubble.io/…/coletar_cadastros.exe",
    "nome": "executável de importação de cadastro",
    "o que faz ou o que é": "esse executável importará o cadastro de clientes SAP e enviará para nosso banco postgres.exe" },
  { "nome": "backup", "file": "//…/backup_completo_sistema.zip" },
  { "nome": "relatorio_faturamento_2024.pdf", "file": "//…/relatorio_faturamento_2024.pdf" }
] } }
```

O workflow `admin` é a tela do painel administrativo: devolve a biblioteca de
documentos e executáveis da operação. Já `login` (que exige autenticação)
devolve `{empresa, logo, user_id, token, expires}` — ou seja, existe endpoint
público que **emite token de sessão** (`login_nativo`, `logar_cliente`).

### 5.2 Os que merecem atenção imediata

| Workflow | `auth_unecessary` | Devolve |
| --- | --- | --- |
| `admin`, `admin_backup`, `administrador`, `wp-admin` | **true** | biblioteca de executáveis/documentos do painel admin |
| `export_users` | **true** | dados de usuários |
| `login_nativo`, `logar_cliente` | **true** | `{user_id, token, expires}` — emite sessão |
| `trocar_senha` | **true** | `{senha}` — **troca de senha sem autenticação** |
| `desativar_robot` | **true** | — |
| `private`, `backend`, `permissao` | true / false | — |
| `login` | false | exige autenticação (401 anônimo confirmado) |

⚠️ `trocar_senha` público é o item mais grave da lista: se o workflow não
exigir a senha antiga, é tomada de conta sem credencial. **Não foi testado** —
testar seria atacar a conta do operador. Verificar no editor.

### 5.3 Como isso virou tool

- `bubble_workflow_exposure_audit` com `mode="declared"` — usa só o `/meta`
  (zero tráfego de escrita) e lista os workflows declarados públicos.
- `mode="active"` confirma com `POST` de corpo vazio **sem token**; por padrão
  só sonda os declarados públicos e **ignora nomes destrutivos**
  (`desativar_robot`, `apagar_*`, `enviar_*`…), que exigem lista explícita.

O mesmo `POST` anônimo no workflow `login` devolve `401 "You must authenticate
to call this method"` — é assim que a tool distingue "protegido" de
"alcançável": **400 também conta como exposto**, porque prova que o workflow
foi alcançado e só faltou payload — que o atacante também tem.

---

## 6. Como reproduzir cada achado

```bash
# 1. contrato de design (token do app)
node dist/cli.js design
node dist/cli.js design --type meusexecutáveisedocumentos

# 2. workflows declarados públicos, sem tráfego de escrita
node dist/cli.js doctor            # confere /meta e o swagger

# 3. PoC anônimo (o que o auditor usa)
curl -sS -X POST -H 'Content-Type: application/json' -d '{}' \
  https://comprover.bubbleapps.io/version-test/api/1.1/wf/admin

# 4. token do app recusado no plano da plataforma
curl -sS -X POST -H "Authorization: Bearer $BUBBLE_API_TOKEN" \
  https://bubble.io/api/1.1/wf/qualquer
```

---

## 7. O que continua em aberto

- [ ] **O transporte de escrita de design não foi validado end-to-end**: falta o
      cookie da conta e o JWT do Firebase para executar `bubble_editor_write`
      contra o app real. O protocolo foi medido no editor, mas o ciclo completo
      (escrever → reler → publicar → `verify=schema`) ainda não rodou.
- [ ] **O `editor export` ainda não rodou contra o app real** — é o `.bubble` que
      serve de referência para o Motor 2.
- [ ] **`/meta` só reflete o branch publicado.** Uma escrita de design só
      aparece no contrato depois de publicar — por isso `verify=design` (releitura
      do nó) é o padrão, e `verify=schema` vem com a ressalva.
- [ ] **O blast radius da sessão é a conta inteira.** Se o objetivo for abrir
      esse caminho para mais gente, a sessão precisa ser escopada por app —
      hoje não é.
- [ ] **O `api` do design é grande.** Centenas de workflows em poucos MB: a
      descoberta mapeia a raiz com `no_chunking: false` (lista de filhos, sem
      baixar o nó inteiro), mas a leitura completa de `api` ainda não foi feita.
