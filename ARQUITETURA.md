# Arquitetura

## Visão geral

```
React (Vite) ── axios ──> Express API (:3333) ──> Supabase (PostgREST + Postgres)
     │                        │
     │                        ├─ pdf-parse (extração do PDF - B10)
     │                        ├─ Groq (classificação - B13, opcional)
     │                        └─ bcrypt/jwt (autenticação)
```

Toda a lógica de negócio fica no Express. O Supabase é o banco de dados e provedor de
auth (redefinição de senha). A segurança é feita em duas camadas:

1. **Backend**: middleware `authMiddleware` valida o JWT da aplicação (com fallback para
   token do Supabase) e sempre filtra por `organizationId` (isolamento por organização - B04).
2. **Banco**: cada tabela pertence a uma `organizationId` e as queries são feitas com
   `service_role`/usuário scoped (quando `SUPABASE_ANON_KEY` está configurada).

## Modelo de dados

| Tabela | Responsabilidade |
| --- | --- |
| `organizations` | Instituição (slug identifica quem entra na mesma org) |
| `users` | Papéis: `admin`, `professor`, `aluno` (campo `role`) |
| `turmas` | Turma criada pelo professor |
| `turma_members` | Vínculo aluno↔turma com `status` (`ativo`/`pendente`) |
| `catalog_items` | Catálogo `level 1 (disciplina) → 2 (tópico) → 3 (subtópico)` |
| `import_jobs` | Job de upload de PDF (status `processing`/`completed`/`failed`) |
| `questions` | Questão com `status` (`pending`/`approved`/`rejected`), alternativas, gabarito, incl. imagens |
| `exams` | Simulado (`draft`/`published`/`archived`) |
| `exam_questions` | Questões do simulado em ordem |
| `attempts` | Tentativa do aluno (`in_progress`/`submitted`) |
| `answers` | Resposta escolhida + resultado da correção (`isCorrect`) |
| `notices` | Avisos do professor para a turma |
| `audit_logs` | Registro de auditoria de cada ação relevante (B28) |

## Autenticação (B02-B04)

- `POST /auth/register` cria usuário + organização (por slug). O primeiro e-mail igual a
  `OWNER_EMAIL` vira `admin`.
- `POST /auth/login` valida senha (bcrypt) e devolve JWT de 7 dias.
- `GET /auth/me` devolve o usuário atual.
- O cadastro aceita somente os perfis `professor` e `aluno`; o redirecionamento usa o
  perfil retornado pelo backend.
- `forgot-password`/`reset-password` usam o Supabase Auth (fluxo de e-mail) com fallback
  dev (`debugResetUrl` em dev).

## Turmas (B05-B08)

- `POST /classes` cria a turma do professor.
- `GET /classes/:id/students/search?q=` pesquisa alunos já cadastrados na organização.
- `POST /classes/:id/students/link` cria o vínculo ativo diretamente; `DELETE` remove o vínculo.

## Importação de PDF (B09-B13)

1. `POST /imports/upload` (multipart, máx. 4 MB) grava um `import_jobs`.
2. `pdf-parse` extrai o texto; o parser (`src/lib/pdf.ts`) separa as questões, identifica o
   gabarito (`respostas: ...`), preserva referências visuais (imagens/gráficos/mapas) e
   registra de onde veio o gabarito (`gabaritoOrigin`) e a confiança (`gabaritoConfidence`).
3. Para cada questão, `src/lib/ai.ts` tenta classificar no catálogo via Gemini/Groq (opcional),
   mantendo a cadeia disciplina → conteúdo → tópico → subtópico.
4. As questões entram como `pending` e o professor revisa.

### Importação por imagem (print ou foto)

Quando o arquivo é PNG/JPG/WebP quem extrai é o Gemini, em **duas chamadas**:

1. **Transcrição** — enunciado e alternativas viram TEXTO, sem a interface do site (botões,
   cabeçalho com banca/órgão, código da questão, menus). Cada questão informa se tem figura
   (`hasFigure`) e qual é a legenda impressa junto dela.
2. **Detecção** — só acontece se a transcrição apontar figura. O modelo devolve a caixa
   (`box_2d`, normalizada em 0–1000) de cada mapa/gráfico/diagrama e a qual questão ela
   pertence. Pedir transcrição e coordenadas na mesma resposta degrada a geometria: na captura
   de teste a caixa do mapa saiu ~400 px acima dele, em cima dos botões da questão anterior.

`src/lib/image-crop.ts` recorta cada caixa da imagem original (`@napi-rs/canvas`), apara a linha
de texto que tenha vazado para a borda do recorte e só esse PNG é anexado à questão — o
enunciado já está em texto. A captura inteira só sobe quando a questão tem figura e nenhum
recorte sai, com aviso na tela de importação.

## Revisão de questões (B14-B18)

- Lista por status (`GET /questions?status=pending|approved|rejected|all`).
- Edição (`PATCH`), exclusão (`DELETE`) e classificação manual (`POST /:id/classificate`).
- **Aprovação em lote**: `POST /questions/approve-all` valida tecnicamente cada pendente
  (enunciado ≥ 5 chars e ≥ 2 alternativas); válidas vão para `approved`, demais para
  `rejected` com `rejectionReason`.

## Simulados (B19-B21)

- `POST /exams` valida turma + questões aprovadas da organização e grava `exam_questions`.
- `GET /exams/:id` devolve o simulado **com as questões exatamente como o professor verá**
  (pré-visualização = o que o aluno vê). Aluno só acessa publicado.
- `POST /exams/:id/publish` exige ao menos 1 questão; após publicado não pode ser editado.
- `POST /exams/:id/archive`.

## Tentativas e correção (B22-B24)

- `POST /exams/:id/start` cria ou retoma a tentativa (uma por aluno/simulado).
- `GET /exams/:id/take` devolve as questões com as respostas já salvas.
- `PUT /attempts/:id/answers` faz upsert das respostas (salvamento automático).
- `POST /attempts/:id/submit` compara cada resposta com o gabarito, grava `isCorrect`,
  marca a tentativa como `submitted` e devolve `{ correct, total, percent }`.

## Resultados (B25-B26)

- `GET /exams/:id/results` — desempenho de todos os alunos da turma.
- `GET /exams/:id/results/by-question` — taxa de acerto por questão.
- `GET /exams/:id/my-result` — resultado do próprio aluno com gabarito.

## Endpoints

| Recurso | Rotas |
| --- | --- |
| Auth | `auth/routes.ts` |
| Turmas | `class/routes.ts` |
| Catálogo | `catalog/routes.ts` |
| Importação | `import/routes.ts` |
| Questões | `question/routes.ts` |
| Simulados | `exam/routes.ts` |
| Tentativas | `attempt/routes.ts` |
| Resultados | `result/routes.ts` |
| Avisos | `notice/routes.ts` |
| Auditoria | `audit/routes.ts` |
| Painéis | `dashboard/routes.ts` |
| Admin (usuários) | `admin/routes.ts` |

## Frontend

- Rotas protegidas por papel (`Protected`/`ProfessorOnly`/`AlunoOnly` no `App.tsx`).
- `AuthContext` guarda usuário/token em `@kaizen:*` (localStorage).
- `services/api.ts`: axios com token automático, limpeza em 401 e `apiError()`.
- Páginas: professor (Início, Turmas, Questões + revisão, Importar PDF, Simulados + criação + prévia, Resultados) e aluno (Início, Simulados, Responder, Resultado, histórico).
