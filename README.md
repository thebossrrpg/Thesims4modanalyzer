# 🧠 TS4 Mod Analyzer

> Um detetive automatizado para identificar mods do The Sims 4 dentro do seu banco do Notion a partir de uma URL.

---

## ✨ O que é isso?

O **TS4 Mod Analyzer** recebe a URL de um mod e descobre automaticamente se esse mod já existe no banco de dados do Notion.

Ele não apenas compara links — ele analisa sinais como **título, slug, domínio, criador** e aplica um pipeline em fases para tomar uma decisão consistente.

---

## 🎯 Objetivo

Gerenciar muitos mods manualmente é caótico.

Esse projeto foi criado para:

- 🔎 Verificar se um mod já está cadastrado
- 🚫 Evitar duplicatas
- 📚 Organizar sua base no Notion
- 🤖 Tomar decisões consistentes automaticamente
- 🧩 Resolver ambiguidades com uma camada semântica (embeddings) quando necessário

---

## ✅ Saídas do analisador

O CLI (e futuramente a interface web) retorna um destes status:

- `FOUND`
- `AMBIGUOUS`
- `NOTFOUND`
- `REJECTED_404`

---

## 🧠 Como ele pensa?

O sistema funciona em etapas, como um funil de decisão.

---

### 🟢 Phase 0 / 0.5 — Match determinístico (rápido)

Primeiro ele verifica:

- **Phase 0:** a URL já existe (match exato)?
- **Phase 0.5:** há match seguro por slug?

Se sim → ✅ Encontrado imediatamente, sem análise extra.

---

### 🟡 Phase 1 — Análise da página (identidade)

Se não houver match direto, ele:

- abre a página
- lê título e metadados públicos
- analisa o slug da URL
- detecta erro real (ex.: 404)
- detecta páginas bloqueadas/challenge (Cloudflare / Vercel etc.)
- tenta unfurl/fallbacks de metadata quando necessário

Se a página for inválida → `REJECTED_404`.

> Importante: títulos de challenge (ex.: `Vercel Security Checkpoint`) **não são tratados como identidade real do mod**.

---

### 🟠 Phase 2 — Busca inteligente no snapshot

Aqui começa a busca por similaridade no snapshot local do Notion.

O sistema compara sinais como:

- Nome/título do mod
- Criador (quando disponível)
- Tokens do título
- Tokens do slug
- Domínio da URL

Ele calcula uma pontuação e decide:

- confiança alta → 🎯 `FOUND`
- dúvida/ambiguidade → segue no funil
- sem confiança → `NOTFOUND` (com candidatos para possível rescue)

#### 🛡️ Modo especial para páginas bloqueadas
Se a página estiver marcada como bloqueada (`isBlocked=true`):
- o **peso do título vai para zero**
- o sistema passa a confiar em sinais estruturais (slug + domínio)

Isso evita que títulos de challenge contaminem o match.

---

### 🟣 Phase 2.5 — Planejamento (rescue planner)

Antes da etapa final, o sistema decide se vale chamar a Phase 3:

- seleciona os melhores candidatos (top-K)
- escolhe o modo:
  - `DISAMBIGUATE`
  - `CONFIRM_SINGLE_WEAK`
  - ou pula a Phase 3

---

### 🔵 Phase 3 — Desempate semântico (embeddings)

Quando há poucos candidatos parecidos, entra a camada semântica.

Atualmente a Phase 3 usa **embeddings** (Xenova/all-MiniLM-L6-v2) para comparar:

- identidade da URL (canonicalizada)
- candidatos do snapshot / Notion live

A Phase 3 só roda quando:

- a fase anterior não resolveu com confiança
- existem poucos candidatos (1–5)
- a identidade é válida
- o gate anti-challenge aprova a identidade

Além disso, a Phase 3 usa:

- **evidence cache** (para evitar repetir decisões)
- **Notion live enrichment** (quando disponível)
- fallback seguro quando a IA/embeddings não deve rodar

---

## 🚨 Quando uma URL é rejeitada?

O sistema considera inválida quando encontra erro real de página, por exemplo:

- 404
- "Page not found"
- "Not found"
- conteúdo inválido que indica falha real

Nesses casos, o processo é interrompido com `REJECTED_404`.

> Diferente de páginas de challenge/bloqueio: elas não são necessariamente 404 — elas são tratadas como identidade parcial e entram em um fluxo defensivo.

---

## 🏗 Estrutura do Projeto (visão geral)

- `phase1/` → Análise da URL (identidade, bloqueio, unfurl)
- `phase2/` → Busca no snapshot do Notion
- `phase3/` → Desempate semântico (embeddings)
- `embedding/` → Engine de embeddings + canonicalização de texto
- `domain/` → Tipos e contratos
- `cache/` + `utils/` → Caches, helpers e infraestrutura
- `src/main.ts` → Orquestração completa das fases

Arquitetura modular, separando responsabilidades por fase.

---

## 📌 Estado atual (CLI congelado)

### Pré-release de congelamento (antes da interface web)
**Tag:** `v1.3.4-rc.1`

Esse freeze consolida o CLI com:

- ✅ Pipeline em fases (0/0.5/1/2/2.5/3)
- ✅ Hardening para páginas bloqueadas/challenge
- ✅ Phase 2 com modo estrutural para `isBlocked=true`
- ✅ Phase 3 com embeddings (Xenova/all-MiniLM-L6-v2)
- ✅ Evidence cache + Notion live cache
- ✅ Saídas estáveis (`FOUND`, `AMBIGUOUS`, `NOTFOUND`, `REJECTED_404`)

> A tag antiga `v1.0.6-hard404-stable` foi um marco importante, mas o baseline atual de freeze pré-web é `v1.3.4-rc.1`.

---

## 🔮 Próximo passo (em andamento)

### Interface web local (MVP)
O próximo passo é criar uma interface web simples para usar o analisador sem terminal.

### Stack decidida (MVP)
- **Backend:** Express
- **Frontend:** HTML + CSS + JS puro
- **Integração:** backend chama o CLI com `--json`

### Estratégia
A interface web **não reimplementa** a lógica do analisador.  
Ela apenas atua como uma “casca” que envia URL → chama CLI → renderiza resultado.

---

## 🗓️ Cronograma da interface web (MVP)

### Dia 1 — Backend adapter + contrato
- Criar `POST /api/analyze`
- Executar o CLI com `--json`
- Tratar timeout/erros
- Validar via curl/Postman

### Dia 2 — UI mínima (HTML/CSS/JS puro)
- Tela única com input + botão
- Loading
- Renderização por status (`FOUND`, `AMBIGUOUS`, `NOTFOUND`, `REJECTED_404`)
- Debug colapsável (opcional, recomendado)

### Pós-MVP
- Melhorias de UX
- Histórico local
- Logs canônicos (`decisionlog` / `ialog`)
- Hardening do embedding engine (runtime/cache offline)

> 📄 Existe um cronograma detalhado em arquivo separado: `CRONOGRAMA_INTERFACE_WEB_MVP.txt`.

---

## 🧩 Em resumo

O TS4 Mod Analyzer:

> Recebe uma URL  
> Descobre qual mod ela representa  
> Procura no seu Notion (via snapshot + confirmação quando necessário)  
> E decide com confiança se encontrou ou não

Sem duplicação.  
Sem suposições soltas.  
Sem caos.

---

✨ Projeto pessoal focado em organização, precisão e automação, criado por Akin (@UnpaidSimmer).
v1.3.4
