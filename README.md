# 🧠 TS4 Mod Analyzer

> Um detetive automatizado para identificar mods do The Sims 4 dentro do seu banco do Notion a partir de uma URL.

---

## ✨ O que é isso?

O **TS4 Mod Analyzer** recebe a URL de um mod e descobre automaticamente se esse mod já existe no banco de dados do Notion.

Ele não apenas compara links — ele analisa nomes, títulos, criadores e padrões para tomar uma decisão inteligente.

---

## 🎯 Objetivo

Gerenciar muitos mods manualmente é caótico.

Esse projeto foi criado para:

- 🔎 Verificar se um mod já está cadastrado
- 🚫 Evitar duplicatas
- 📚 Organizar sua base no Notion
- 🤖 Tomar decisões consistentes automaticamente
- 🧩 Resolver ambiguidades com IA quando necessário

---

## 🧠 Como ele pensa?

O sistema funciona em etapas, como um funil de decisão.

---

### 🟢 Phase 0 — Match direto

Primeiro ele verifica:

> Essa URL já existe exatamente igual no snapshot do Notion?

Se sim → ✅ Encontrado imediatamente.

Sem análise extra.

---

### 🟡 Phase 1 — Análise da página

Se não houver match direto, ele:

- Abre a página
- Lê o título
- Extrai metadados públicos
- Analisa o slug da URL
- Detecta se a página é inválida (ex: 404)

Se a página for inválida, o processo é interrompido.

---

### 🟠 Phase 2 — Busca inteligente

Aqui começa a parte interessante.

O sistema compara:

- Nome do mod
- Criador
- Tokens do título
- Palavras do slug
- Domínio da URL

Ele calcula uma pontuação de similaridade.

Se a confiança for alta → 🎯 Match encontrado.  
Se houver dúvida → passa para a próxima etapa.

---

### 🔵 Phase 3 — Desempate com IA

Quando há poucos candidatos muito parecidos, a IA entra em ação.

Mas apenas se:

- A fase anterior falhou
- Existem poucos candidatos
- A identidade da página é válida

A IA então decide qual candidato faz mais sentido.

---

## 🚨 Quando uma URL é rejeitada?

O sistema considera inválida quando:

- A página retorna erro 404
- O título contém "Page not found"
- O conteúdo indica erro real
- O site não retorna uma página válida

Nesses casos, o processo é interrompido com uma mensagem clara.

---

## 🏗 Estrutura do Projeto

phase1/ → Análise da URL
phase2/ → Busca no snapshot do Notion
phase3/ → Desempate com IA
domain/ → Tipos e estruturas
utils/ → Funções auxiliares

Arquitetura modular, separando responsabilidade por fase.

---

## 📌 Versão Estável

Tag congelada: v1.0.6-hard404-stable


Essa versão:

- ✅ Detecta 404 corretamente
- ✅ Não deixa IA rodar quando não deve
- ✅ Resolve match exato corretamente
- ✅ Build estável

---


## 🌐 Interface web (mostly offline)

Agora o projeto inclui uma interface web local para uso sem linha de comando:

1. `npm run build`
2. `npm run web:start`
3. Abra `http://localhost:4173`

Características:
- Reaproveita o pipeline atual (Phase 0 → 3) sem duplicar lógica
- Executa análise local via CLI (`--json`)
- Mostra status inequívoco (`FOUND`, `NOTFOUND`, `AMBIGUOUS`, `REJECTED_404`)
- Indica quando a decisão veio de IA (`PHASE_3`)
- Oferece downloads de cache/logs para auditoria

---

## 🧩 Em resumo

O TS4 Mod Analyzer:

> Recebe uma URL  
> Descobre qual mod ela representa  
> Procura no seu Notion  
> E decide com confiança se encontrou ou não  

Sem duplicação.  
Sem suposições soltas.  
Sem caos.

---

✨ Projeto pessoal focado em organização, precisão e automação, criado por Akin (@UnpaidSimmer).
# v1.1.1
