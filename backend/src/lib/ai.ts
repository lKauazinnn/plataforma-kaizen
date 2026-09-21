import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import { normalizeEmail } from './roles';

function getGeminiClient(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  return new GoogleGenAI({ apiKey: key });
}

function getGroqClient(): Groq | null {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  return new Groq({ apiKey: key });
}

export const hasAiConfigured = () => Boolean(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY);

export interface CatalogNode {
  id: string;
  level: number;
  name: string;
  parentId: string | null;
}

export interface ClassificationSuggestion {
  catalogItemId: string | null;
  source: 'ai' | 'professor' | null;
  suggestedName?: string;
}

// Sem chave de IA o sistema não inventa classificação: retorna null e a
// revisão fica por conta do professor (princípio: "a IA prepara; o professor
// confere e aprova" — sem IA, não há sugestão, apenas revisão manual).
export async function classifyQuestion(
  statement: string,
  catalog: CatalogNode[]
): Promise<ClassificationSuggestion> {
  if (!hasAiConfigured()) {
    return { catalogItemId: null, source: null };
  }

  const tree = buildCatalogNames(catalog);
  const names = JSON.stringify(tree);

  const aiClient = getGeminiClient();
  const groq = getGroqClient();

  // 1. Tenta classificar usando Google Gemini (GenAI) se a chave estiver configurada
  if (aiClient) {
    try {
      const response = await aiClient.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Catálogo disponível (JSON): ${names}\n\nQuestão:\n${statement.slice(0, 2000)}`,
        config: {
          temperature: 0.1,
          systemInstruction:
             'Você classifica questões de provas em um catálogo educativo com níveis: disciplina (1), conteúdo (2), tópico (3) e subtópico (4). ' +
             'Responda APENAS com JSON no formato {"level": 1|2|3|4, "match": "nome exato do item do catálogo"} ' +
            'escolhendo o nível mais específico que fizer sentido. Se nada casar, retorne {"level": null, "match": null}.',
          responseMimeType: 'application/json',
        },
      });

      const raw = response.text ?? '';
      const json = extractJson(raw);
      if (json && json.level && json.match) {
        const matchNorm = normalizeEmail(String(json.match));
        const found =
          catalog.find((c) => c.level === json.level && normalizeEmail(c.name) === matchNorm) ?? null;

        if (found) {
          return {
            catalogItemId: found.id,
            source: 'ai',
            suggestedName: found.name,
          };
        }
      }
    } catch (error) {
      console.error('[ai:gemini] falha ao classificar questão com Gemini:', error);
    }
  }

  // 2. Fallback para Groq se Gemini não estiver configurado ou falhar
  if (groq) {
    try {
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content:
               'Você classifica questões de provas em um catálogo educativo com níveis: disciplina (1), conteúdo (2), tópico (3) e subtópico (4). ' +
               'Responda APENAS com JSON no formato {"level": 1|2|3|4, "match": "nome exato do item do catálogo"} ' +
              'escolhendo o nível mais específico que fizer sentido. Se nada casar, retorne {"level": null, "match": null}.',
          },
          {
            role: 'user',
            content: `Catálogo disponível (JSON): ${names}\n\nQuestão:\n${statement.slice(0, 2000)}`,
          },
        ],
      });

      const raw = completion.choices[0]?.message?.content ?? '';
      const json = extractJson(raw);
      if (json && json.level && json.match) {
        const matchNorm = normalizeEmail(String(json.match));
        const found =
          catalog.find((c) => c.level === json.level && normalizeEmail(c.name) === matchNorm) ?? null;

        return {
          catalogItemId: found?.id ?? null,
          source: 'ai',
          suggestedName: found?.name,
        };
      }
    } catch (error) {
      console.error('[ai:groq] falha ao classificar questão com Groq:', error);
    }
  }

  return { catalogItemId: null, source: 'ai' };
}

/** Elemento visual de verdade dentro da imagem — o que vira recorte. */
export interface ExtractedFigure {
  /** Caixa normalizada [yMin, xMin, yMax, xMax] em 0–1000 (padrão do Gemini). */
  box: number[];
  /** Legenda/fonte impressa junto da figura, transcrita como texto. */
  caption?: string | null;
}

export interface ExtractedImageQuestion {
  number?: number | null;
  statement: string;
  type: 'multiple_choice' | 'free_response';
  alternatives: { letter: string; text: string }[];
  /** A transcrição viu uma figura nesta questão (mesmo que a caixa não tenha saído). */
  hasFigure: boolean;
  /** Vazio quando a questão é só texto — a imagem inteira NÃO é anexada. */
  figures: ExtractedFigure[];
  gabarito?: string | null;
  gabaritoOrigin?: 'document' | 'ai' | 'professor' | 'heuristic' | null;
  catalogItemId?: string | null;
  classificationSource?: 'ai' | null;
}

/**
 * Digitaliza as questões de uma captura de tela ou foto.
 *
 * A questão sai como num banco de questões: enunciado e alternativas em TEXTO,
 * e só o que é figura de verdade (mapa, gráfico, tabela desenhada, diagrama)
 * continua imagem — o modelo devolve a caixa de cada uma e quem recorta é o
 * `image-crop`. Antes a imagem inteira era anexada a cada questão, então o
 * print do site aparecia embaixo do enunciado já transcrito, com botões,
 * cabeçalho e as outras questões da tela junto.
 *
 * São DUAS chamadas de propósito. Pedir a transcrição e as coordenadas na
 * mesma resposta degrada a geometria: no print de teste a caixa do mapa saiu
 * 400px acima do mapa, em cima dos botões da questão anterior. Isolada, a
 * detecção acerta a moldura. A segunda chamada só acontece quando a
 * transcrição diz que existe figura — print só de texto continua custando uma.
 */
export async function extractQuestionFromImage(
  buffer: Buffer,
  mimeType: string,
  catalog: CatalogNode[]
): Promise<ExtractedImageQuestion[]> {
  const aiClient = getGeminiClient();
  if (!aiClient) {
    throw new Error('Chave GEMINI_API_KEY necessária para extração de questões a partir de imagens.');
  }

  const base64Data = buffer.toString('base64');
  const mime = mimeType || 'image/png';
  const tree = buildCatalogNames(catalog);
  const catalogNames = JSON.stringify(tree);

  const prompt =
    'Você digitaliza provas e cadernos de questões a partir de capturas de tela e fotos.\n' +
    'O resultado tem que ficar igual ao de um banco de questões: enunciado e alternativas em TEXTO, ' +
    'e só o que é figura de verdade continua sendo imagem (ela é recortada depois, em outra etapa).\n\n' +
    'TRANSCRIÇÃO DO TEXTO\n' +
    '- Copie o texto exatamente como está, com acentuação, pontuação, quebras de parágrafo, fórmulas e notação matemática.\n' +
    '- NÃO transcreva a interface do site ou do aplicativo: botões (Responder, Gabarito Comentado, Aulas, Comentários, ' +
    'Estatísticas, Cadernos, Criar), cabeçalho com Ano/Banca/Órgão/Prova, código da questão, trilha de assuntos, ' +
    'barra de status do celular, menus e rodapés.\n' +
    '- NÃO descreva a figura dentro do enunciado e não escreva "(imagem)" nem "[mapa]": a figura vai à parte. ' +
    'Mantenha a frase original que a apresenta (ex.: "Observe o mapa a seguir.").\n' +
    '- A legenda ou fonte impressa embaixo da figura (ex.: "Fonte: CPCON, 2026.") também fica fora do enunciado.\n' +
    '- Havendo várias questões na imagem, devolva uma entrada por questão, na ordem em que aparecem.\n' +
    '- Ignore questão cortada pela borda da captura (enunciado incompleto ou alternativas faltando) em vez de completar ' +
    'o que está faltando.\n\n' +
    'CAMPOS DE CADA QUESTÃO\n' +
    '- "number": número da questão como aparece na imagem, ou null;\n' +
    '- "type": "multiple_choice" (tem alternativas) ou "free_response" (dissertativa);\n' +
    '- "statement": enunciado completo em texto;\n' +
    '- "alternatives": [{"letter": "A", "text": "..."}] — sem repetir a letra dentro do texto. Em free_response, [];\n' +
    '- "hasFigure": true se a questão tiver elemento visual (mapa, gráfico, charge, foto, diagrama, esquema, tabela ou ' +
    'fórmula desenhada como imagem). Texto, alternativas, botões e ícones do site NÃO contam: nesses casos, false;\n' +
    '- "figureCaption": legenda ou fonte impressa junto da figura, transcrita como texto, ou null;\n' +
    '- "gabarito": letra (ex.: "A") ou resposta final curta se a imagem indicar a correta ou se for calculável com alta ' +
    'certeza; caso contrário null;\n' +
    '- "catalogMatch": nome exato de um item do catálogo correspondente ao tema, ou null;\n' +
    '- "catalogLevel": nível desse item (1, 2 ou 3), ou null.\n\n' +
    'Catálogo disponível (JSON): ' + catalogNames + '\n\n' +
    'Responda ESTRITAMENTE em JSON no schema: {"questions": [...]}.';

  const response = await aiClient.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { data: base64Data, mimeType: mime } },
          { text: prompt },
        ],
      },
    ],
    config: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  });

  const parsedJson = parseJsonLoose(response.text ?? '');
  const rawList: any[] = Array.isArray(parsedJson?.questions)
    ? parsedJson.questions
    : Array.isArray(parsedJson)
    ? parsedJson
    : [];

  const results: ExtractedImageQuestion[] = [];
  const captions: (string | null)[] = [];

  for (const [idx, q] of rawList.entries()) {
    let catalogItemId: string | null = null;
    if (q.catalogMatch && q.catalogLevel) {
      const matchNorm = normalizeEmail(String(q.catalogMatch));
      const found =
        catalog.find((c) => c.level === q.catalogLevel && normalizeEmail(c.name) === matchNorm) ?? null;
      if (found) catalogItemId = found.id;
    }

    const alts = Array.isArray(q.alternatives) ? q.alternatives : [];
    const isMultiple = q.type === 'multiple_choice' || alts.length >= 2;
    const statement = String(q.statement || '').trim() || 'Questão extraída da imagem';

    if (!isMultiple && looksTruncated(statement)) {
      console.warn('[ai:gemini] questão cortada pela borda da captura, ignorada:', statement.slice(0, 60));
      continue;
    }

    captions.push(cleanCaption(q?.figureCaption));
    results.push({
      number: typeof q.number === 'number' ? q.number : idx + 1,
      statement,
      type: isMultiple ? 'multiple_choice' : 'free_response',
      alternatives: isMultiple ? alts : [],
      hasFigure: q.hasFigure === true,
      figures: [],
      gabarito: q.gabarito ? String(q.gabarito).trim() : null,
      gabaritoOrigin: q.gabarito ? 'ai' : null,
      catalogItemId,
      classificationSource: catalogItemId ? 'ai' : null,
    });
  }

  if (results.some((q) => q.hasFigure)) {
    try {
      await attachFigures(aiClient, base64Data, mime, results, captions);
    } catch (figureError) {
      // Sem as caixas a questão ainda vale: o controller anexa a imagem
      // original inteira nas questões que declararam figura.
      console.error('[ai:gemini] falha ao localizar figuras na imagem:', figureError);
    }
  }

  return results;
}

/**
 * Segunda chamada: só geometria.
 *
 * A associação vem do próprio modelo — os enunciados já transcritos entram no
 * prompt numerados, e cada caixa diz a qual deles pertence. Casar por ordem de
 * cima para baixo quebraria justamente no caso comum: questão cortada na borda
 * é descartada na transcrição, mas a figura dela continua na imagem.
 */
async function attachFigures(
  aiClient: GoogleGenAI,
  base64Data: string,
  mimeType: string,
  questions: ExtractedImageQuestion[],
  captions: (string | null)[]
): Promise<void> {
  const resumo = questions
    .map((q, i) => `${i}: ${q.statement.replace(/\s+/g, ' ').slice(0, 180)}`)
    .join('\n');

  const prompt =
    'Localize as figuras desta captura de um caderno de questões: mapas, gráficos, charges, fotos, diagramas, ' +
    'esquemas, tabelas desenhadas e fórmulas em imagem.\n' +
    'NÃO localize parágrafos de texto, alternativas, legendas, botões, ícones, cabeçalho ou rodapé do site.\n\n' +
    'Questões já transcritas desta imagem:\n' +
    resumo +
    '\n\nResponda em JSON: [{"box_2d": [ymin, xmin, ymax, xmax], "question": <índice da lista acima>}].\n' +
    'A caixa vai em coordenadas normalizadas de 0 a 1000 sobre a imagem inteira, nesta ordem exata ' +
    '(ymin, xmin, ymax, xmax), envolvendo só a figura e a moldura dela — sem o enunciado acima nem a legenda abaixo.\n' +
    'Figura de questão que não está na lista (cortada pela borda, por exemplo) recebe "question": null.\n' +
    'Se não houver nenhuma figura, responda [].';

  const response = await aiClient.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { data: base64Data, mimeType } },
          { text: prompt },
        ],
      },
    ],
    config: { temperature: 0, responseMimeType: 'application/json' },
  });

  const parsed = parseJsonLoose(response.text ?? '');
  const detections: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.figures) ? parsed.figures : [];

  // Fila das questões que declararam figura: recebe as caixas sem índice
  // válido, na ordem em que aparecem.
  const semCaixa = questions.map((q, i) => (q.hasFigure ? i : -1)).filter((i) => i >= 0);

  for (const item of detections) {
    const box = normalizeBox(item?.box_2d ?? item?.box ?? item?.bbox ?? item?.boundingBox);
    if (!box) continue;

    const declarado = Number(item?.question ?? item?.questionIndex ?? item?.question_index);
    let alvo = Number.isInteger(declarado) && declarado >= 0 && declarado < questions.length ? declarado : -1;
    if (alvo === -1) {
      const proxima = semCaixa.find((i) => questions[i].figures.length === 0);
      if (proxima === undefined) continue; // caixa de questão descartada na transcrição
      alvo = proxima;
    }

    questions[alvo].figures.push({
      box,
      caption: cleanCaption(item?.caption) ?? captions[alvo] ?? null,
    });
  }
}

function normalizeBox(box: unknown): number[] | null {
  if (!Array.isArray(box) || box.length < 4) return null;
  const nums = box.slice(0, 4).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

/**
 * Questão cortada pela borda da captura vira lixo na revisão: meio enunciado,
 * sem alternativa nenhuma. O prompt manda ignorar, mas o modelo transcreve
 * assim mesmo de vez em quando. Só é descartada quando não tem alternativa E o
 * texto para no meio de uma palavra — dissertativa de verdade termina em
 * pontuação ("Justifique.", "Calcule o valor de x:").
 */
function looksTruncated(statement: string): boolean {
  const text = statement.trim();
  return text.length > 40 && /[a-zà-ÿ]$/.test(text);
}

function cleanCaption(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.toLowerCase() === 'null') return null;
  return text.slice(0, 300);
}

/** JSON do modelo, aceitando o caso em que ele embrulha a resposta em texto. */
function parseJsonLoose(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/[\[{][\s\S]*[\]}]/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}
export interface GabaritoSuggestion {
  gabarito: string;
  confidence: number;
  rationale?: string;
}

/**
 * Sugere o gabarito de uma questão que veio do PDF sem tabela de respostas.
 *
 * Uma prova sem gabarito não pode simplesmente ser rejeitada — é o caso mais
 * comum de caderno de questões avulso. A sugestão entra SEMPRE como
 * `gabaritoOrigin: 'ai'`, nunca como 'document': é um palpite que o professor
 * confere e assume, e a tela mostra isso explicitamente.
 */
export async function suggestGabarito(
  statement: string,
  alternatives: { letter: string; text: string }[]
): Promise<GabaritoSuggestion | null> {
  const aiClient = getGeminiClient();
  const groq = getGroqClient();
  if (!aiClient && !groq) return null;

  const isMultiple = alternatives.length >= 2;
  const letters = alternatives.map((a) => a.letter.toUpperCase());

  const instruction = isMultiple
    ? 'Você resolve questões de prova. Responda APENAS com JSON ' +
      '{"gabarito": "LETRA", "confidence": 0.0-1.0, "rationale": "justificativa em uma frase"}. ' +
      `A letra DEVE ser uma destas: ${letters.join(', ')}. ` +
      'Se não for possível determinar a resposta com segurança, retorne {"gabarito": null, "confidence": 0}.'
    : 'Você resolve questões de prova dissertativas. Responda APENAS com JSON ' +
      '{"gabarito": "resposta final curta", "confidence": 0.0-1.0, "rationale": "justificativa em uma frase"}. ' +
      'Dê o resultado final (número, expressão ou termo), não a resolução completa. ' +
      'Se não for possível determinar a resposta com segurança, retorne {"gabarito": null, "confidence": 0}.';

  const content =
    statement.slice(0, 4000) +
    (isMultiple ? '\n\n' + alternatives.map((a) => `${a.letter}) ${a.text}`).join('\n') : '');

  const parse = (raw: string): GabaritoSuggestion | null => {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      if (!parsed.gabarito) return null;
      const value = String(parsed.gabarito).trim();
      if (!value) return null;
      // Numa múltipla escolha, uma letra fora das alternativas é ruído, não resposta.
      if (isMultiple && !letters.includes(value.toUpperCase())) return null;
      const confidence = Number(parsed.confidence);
      return {
        gabarito: isMultiple ? value.toUpperCase() : value,
        confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
        rationale: parsed.rationale ? String(parsed.rationale).slice(0, 300) : undefined,
      };
    } catch {
      return null;
    }
  };

  if (aiClient) {
    try {
      const response = await aiClient.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: content,
        config: { temperature: 0.1, systemInstruction: instruction, responseMimeType: 'application/json' },
      });
      const suggestion = parse(response.text ?? '');
      if (suggestion) return suggestion;
    } catch (error) {
      console.error('[ai:gemini] falha ao sugerir gabarito:', error);
    }
  }

  if (groq) {
    try {
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content },
        ],
      });
      const suggestion = parse(completion.choices[0]?.message?.content ?? '');
      if (suggestion) return suggestion;
    } catch (error) {
      console.error('[ai:groq] falha ao sugerir gabarito:', error);
    }
  }

  return null;
}

function extractJson(raw: string): { level: number | null; match: string | null } | null {
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return {
      level: parsed.level ?? null,
      match: parsed.match ?? null,
    };
  } catch {
    return null;
  }
}

function buildCatalogNames(catalog: CatalogNode[]): { id: string; level: number; name: string; parent: string | null }[] {
  return catalog.map((c) => ({
    id: c.id,
    level: c.level,
    name: c.name,
    parent: c.parentId,
  }));
}
