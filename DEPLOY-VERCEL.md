# Deploy na Vercel

## Estado atual (já no ar)

| | URL | Projeto na Vercel | Deploy automático no `git push`? |
| --- | --- | --- | --- |
| Frontend | https://plataforma-kaizen.vercel.app | `plataforma-kaizen` | **Sim** (conectado ao GitHub) |
| API | https://kaizen-api-eight.vercel.app | `kaizen-api` | **Não** — veja abaixo |

> **A API não está conectada ao Git.** Ela foi criada e publicada pela CLI, então
> `git push` **atualiza só o frontend**. Para atualizar a API depois de mexer no
> `backend/`, rode:
>
> ```bash
> cd backend && npx vercel deploy --prod
> ```
>
> Para ligar o deploy automático: no dashboard do projeto `kaizen-api` →
> **Settings → Git** conecte o repositório e, em **Settings → Build and Deployment**,
> defina **Root Directory** = `backend`. Sem o Root Directory a build tenta rodar
> na raiz do repositório e falha.

### Pendências conhecidas

- **`GROQ_API_KEY` vazia.** A `GEMINI_API_KEY` já está em produção, então a
  classificação automática e a importação a partir de imagem funcionam — o Groq é
  só o fallback de classificação/gabarito quando a Gemini falha. Para adicionar:
  `cd backend && npx vercel env add GROQ_API_KEY production` e redeploy.
- **`OWNER_EMAIL` vazia**, então nenhum e-mail é tratado como admin/root.
- **Supabase → Authentication → URL Configuration** ainda precisa apontar para o
  domínio de produção (passo 5), senão a recuperação de senha manda link para
  `localhost`.

---

## Arquitetura

São **dois projetos** na Vercel, ambos apontando para o mesmo repositório do
GitHub, cada um com um **Root Directory** diferente:

| Projeto | Root Directory | O que é |
| --- | --- | --- |
| `kaizen-api` | `backend` | O Express roda como uma Serverless Function (`api/index.ts`). Todas as rotas são reescritas para ela pelo `backend/vercel.json`. |
| `plataforma-kaizen` | `frontend` | SPA Vite servida como estático, com rewrite de SPA para o `index.html`. |

O frontend fala com a API por **CORS**, usando a variável `VITE_API_URL`
(embutida no build). O token vai no header `Authorization: Bearer`, não em
cookie — por isso não há dependência de `SameSite`/domínio compartilhado.

```
navegador ──► plataforma-kaizen.vercel.app        (estático)
          └─► kaizen-api-eight.vercel.app/api/*  (function, CORS liberado p/ o domínio do web)
                    └─► Supabase (PostgREST + Storage)
```

---

## 1. Subir o código para o GitHub

O deploy da Vercel parte do repositório. Com o remote já configurado
(`origin` → `lKauazinnn/plataforma-kaizen`):

```bash
git add -A
git commit -m "chore: configura deploy na Vercel"
git push origin main
```

---

## 2. Criar o projeto da API (`kaizen-api`)

1. Vercel → **Add New… → Project** → importe o repositório `plataforma-kaizen`.
2. Em **Root Directory**, escolha `backend`.
3. **Framework Preset**: `Other`. Deixe Build/Install Command no padrão — o
   `npm run build` (`prisma generate && tsc`) roda como gate de tipos.
4. Em **Environment Variables**, cadastre (marcando *Production* e *Preview*):

| Variável | Obrigatória | Valor |
| --- | --- | --- |
| `SUPABASE_URL` | **sim** | Project URL do Supabase |
| `SUPABASE_SERVICE_KEY` | **sim** | `service_role` key — nunca no frontend |
| `SUPABASE_ANON_KEY` | recomendada | `anon` key (sem ela, cai no service key e o RLS por usuário fica desativado) |
| `JWT_SECRET` | **sim** | segredo longo e aleatório |
| `JWT_EXPIRES_IN` | não | padrão `7d` |
| `FRONTEND_URL` | **sim** | URL do projeto web, **sem barra no fim** — só é conhecida depois do passo 3, veja o passo 4 |
| `DATABASE_URL` | não | só para comandos do Prisma; o runtime usa Supabase |
| `GEMINI_API_KEY` | não | habilita classificação por IA **e** a importação de questões por imagem |
| `GROQ_API_KEY` | não | alternativa de IA, só para classificação de texto |
| `OWNER_EMAIL` | não | e-mail tratado como admin/root |
| `UPLOAD_MAX_MB` | não | padrão `4`. **Não aumente na Vercel** (veja Limitações) |
| `ALLOW_VERCEL_PREVIEW_ORIGINS` | não | `true` libera CORS para qualquer `*.vercel.app`; use só para testar previews |

> `NODE_ENV=production` **não** precisa ser definida: a Vercel já a define, e é
> ela que desliga o endpoint `/debug`.

5. **Deploy**. Anote a URL gerada (ex.: `https://kaizen-api-eight.vercel.app`).

Teste imediatamente:

```bash
curl https://kaizen-api-eight.vercel.app/health
# {"status":"ok","message":"Server is running"}
```

---

## 3. Criar o projeto do frontend (`plataforma-kaizen`)

1. **Add New… → Project** → mesmo repositório.
2. Em **Root Directory**, escolha `frontend`.
3. **Framework Preset**: `Vite` (o `frontend/vercel.json` já fixa build e rewrite).
4. **Environment Variables**:

| Variável | Obrigatória | Valor |
| --- | --- | --- |
| `VITE_API_URL` | **sim** | `https://kaizen-api-eight.vercel.app/api` — **com o sufixo `/api`** |
| `VITE_SUPABASE_URL` | não | Project URL do Supabase (só para recuperação de senha) |
| `VITE_SUPABASE_ANON_KEY` | não | `anon` key |

> Variáveis `VITE_*` são embutidas no bundle **em build time**. Mudar o valor
> exige um **Redeploy** — não basta salvar.

5. **Deploy**. Anote a URL (ex.: `https://plataforma-kaizen.vercel.app`).

---

## 4. Fechar o laço do CORS

Volte no projeto **`kaizen-api`** → Settings → Environment Variables e defina:

```
FRONTEND_URL = https://plataforma-kaizen.vercel.app
```

Sem barra no final. Aceita lista separada por vírgula, se houver domínio próprio:

```
FRONTEND_URL = https://plataforma-kaizen.vercel.app,https://kaizen.cajupar.com
```

Depois **Redeploy** o projeto da API (variável de runtime só entra em vigor no
próximo deploy).

> Se `FRONTEND_URL` ficar vazia, a API libera **qualquer** origem. Funciona, mas
> não é o que se quer em produção.

---

## 5. Supabase — recuperação de senha

Supabase → **Authentication → URL Configuration**:

- **Site URL**: `https://plataforma-kaizen.vercel.app`
- **Redirect URLs**: `https://plataforma-kaizen.vercel.app/reset-password`

Sem isso o e-mail de redefinição não é enviado, ou aponta para `localhost`.

---

## 6. Verificação ponta a ponta

```bash
API=https://kaizen-api-eight.vercel.app
WEB=https://plataforma-kaizen.vercel.app

# 1. A function está viva
curl -s $API/health

# 2. /debug DEVE dar 404 em produção (é o esperado)
curl -s -o /dev/null -w "%{http_code}\n" $API/debug

# 3. Rota protegida sem token → 401 (prova que o roteamento chega no middleware)
curl -s $API/api/imports

# 4. CORS liberado para o frontend → deve responder o header
curl -s -I -H "Origin: $WEB" $API/api/imports | grep -i access-control-allow-origin

# 5. CORS bloqueado para origem estranha → 403
curl -s -H "Origin: https://origem-estranha.example" $API/api/imports
```

No navegador: abra o `$WEB`, faça login e recarregue a página em uma rota interna
(ex.: `/professor/resultados`) — o rewrite de SPA deve devolver a aplicação, não 404.

---

## Por que a API tem um `public/robots.txt`

Como o `backend/package.json` tem script `build`, a Vercel roda o build e depois
exige um diretório de saída estático — que um projeto só-de-API não produz. O
deploy falha com *"No Output Directory named public found"*.

Apontar `outputDirectory` para `dist` resolveria o erro, mas serviria o código
compilado como arquivo estático público. E um `public/` vazio também é recusado
(*"The Output Directory public is empty"*). Por isso o `buildCommand` gera um
`public/` contendo apenas um `robots.txt`: diretório não-vazio, nenhum código
servido, e sem `index.html` para não sombrear a rota `/` da API — que continua
caindo no rewrite para a function.

---

## Limitações conhecidas na Vercel

Estas são restrições **da plataforma**, não bugs do sistema. Servem para o piloto;
se apertarem, o caminho é mover a API para um host de processo longo (Railway,
Render, Fly) — o `src/server.ts` continua funcionando como servidor normal, porque
o `listen()` só é suprimido quando a variável `VERCEL` está presente.

1. **Upload limitado a ~4 MB.** A Vercel corta o corpo da requisição em ~4,5 MB
   *antes* de ela chegar na function. Por isso `UPLOAD_MAX_MB` vale `4` e a UI
   anuncia "máx. 4 MB". Um PDF de prova maior que isso precisa ser dividido.
   A correção definitiva é enviar o arquivo direto do navegador para o Supabase
   Storage e passar só a chave para a API — mudança de fluxo, não feita aqui.

2. **Timeout de 60 s.** A importação de PDF é **síncrona**: extrai o texto,
   renderiza as páginas com `pdfjs-dist` + `@napi-rs/canvas`, recorta a região
   de cada questão e chama a IA questão a questão, tudo dentro do request.
   `maxDuration` está em `60` (o teto do plano Hobby; no Pro dá para ir a 300).
   Provas grandes vão estourar. O desenho correto é uma fila/job em background.

3. **Cold start.** A function carrega `pdfjs-dist` e o binário nativo do
   `@napi-rs/canvas`; a primeira chamada após um período ocioso demora mais.

4. **Previews.** Cada deploy de preview do frontend ganha um subdomínio novo, que
   não bate com `FRONTEND_URL` e é bloqueado pelo CORS. Para testar previews no
   navegador, ligue `ALLOW_VERCEL_PREVIEW_ORIGINS=true` na API.

---

## Troubleshooting

| Sintoma | Causa provável | Correção |
| --- | --- | --- |
| Erro de CORS no console do navegador | `FRONTEND_URL` na API diferente do domínio real do frontend (barra no fim conta) | Ajuste `FRONTEND_URL` e **redeploy da API**. O log da function mostra `[cors] origem bloqueada: …` com a origem recebida |
| Toda chamada dá 404 e o console mostra `[api] VITE_API_URL não foi definida` | `VITE_API_URL` ausente no build | Defina no projeto web e **redeploy** (é build time) |
| Chamadas vão para `…/auth/login` sem `/api` | `VITE_API_URL` sem o sufixo `/api` | Use `https://kaizen-api-eight.vercel.app/api` |
| 500 em toda rota, log com `variáveis de ambiente obrigatórias ausentes` | `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` não cadastradas | Cadastre e redeploy |
| 413 ao importar | arquivo acima de ~4,5 MB | Divida o PDF (veja Limitações #1) |
| `FUNCTION_INVOCATION_TIMEOUT` na importação | PDF grande estourando 60 s | Divida o PDF ou mova a API para host de processo longo (Limitações #2) |
| Recarregar rota interna dá 404 | rewrite de SPA ausente | Confirme que o `frontend/vercel.json` foi para o deploy |
| Importação funciona mas sem imagens por questão | falha do `@napi-rs/canvas` na function | O log traz `[import] falha ao extrair visuais:` — a importação degrada de propósito e segue sem os recortes |
