# Plano de design do Bubble: leitura, escrita e o que a credencial alcança

Documento de referência do `bubble_design_read`, `bubble_editor_discover`,
`bubble_editor_read` e `bubble_editor_write`. Tudo aqui foi verificado contra o
app real em 2026-10-21 (branch `version-test` do app `comprover`).

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

### 2.3 O que alcança o design: a sessão da conta

O editor é um app interno da Bubble (`editor.bubbleapps.io`). O que o alcança é a
**sessão da conta Bubble**, não um token de app:

- cookie `meta_live_u2main` (conta de produção) ou `meta_test_u2main` (dev);
- header `meta-firebase_workflow` com o JWT do Firebase.

> **Raio de impacto:** essa sessão concede leitura e escrita de design sobre
> **todos os apps que a conta puder editar** — não só o app alvo. É uma
> credencial de conta, não de app. Por isso o Bridge só a usa se o operador
> configurar explicitamente, nunca a registra em log, e a escrita de design
> existe só no modo `admin`.

---

## 3. Por que as operações do editor são configuradas

A API do editor é interna, não documentada e muda sem aviso. O Bridge não
adivinha endpoint: ele executa um **mapa de operações** que o operador aprova.

```bash
BUBBLE_EDITOR_OPS='{
  "read_design":  {"method":"GET",  "path":"/wf/load_app_design"},
  "write_design": {"method":"POST", "path":"/wf/save_app_design"}
}'
```

- o caminho aceita os placeholders `{app_id}` e `{branch}`;
- o corpo enviado é `{app_id, branch, ...payload}` — o payload do agente entra
  inteiro, sem template escondido;
- `bubble_editor_discover` (ou `bubble-bridge editor discover`) sonda o schema
  do app interno do editor e devolve os workflows candidatos a leitura e a
  escrita de design, para montar esse mapa.

**Falha fechada:** sem `BUBBLE_EDITOR_SESSION` + `BUBBLE_EDITOR_APP_ID` as
tools de editor nem são registradas; sem uma operação no mapa, a chamada é
recusada com a lista do que existe.

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
| `design` (padrão) | relê o documento de design e faz diff de caminhos | imediatamente, se o editor persistiu |
| `schema` | relê o `/meta` e faz diff do contrato | **só depois de publicar o branch** |
| `none` | não confere | — |

O diff do documento cru (`diffDesignJson`) é limitado (8 níveis, 300 entradas)
e devolve caminhos adicionados, removidos e alterados — o suficiente para dizer
"a escrita mudou alguma coisa" sem despejar o design inteiro no contexto.

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
      cookie da conta para executar `bubble_editor_write` contra o app real. A
      hipótese de trabalho é que a API do app interno do editor abre para conta
      autenticada; `bubble_editor_discover` é quem responde isso.
- [ ] **Os endpoints do editor não são públicos.** O mapa `BUBBLE_EDITOR_OPS` é
      preenchido pelo `discover`; até lá, `bubble_editor_read/write` falham
      fechado com a lista do que está aprovado.
- [ ] **`/meta` só reflete o branch publicado.** Uma escrita de design só
      aparece no contrato depois de publicar — por isso `verify=design` (releitura
      do documento) é o padrão, e `verify=schema` vem com a ressalva.
- [ ] **O blast radius da sessão é a conta inteira.** Se o objetivo for abrir
      esse caminho para mais gente, a sessão precisa ser escopada por app —
      hoje não é.
