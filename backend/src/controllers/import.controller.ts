import { Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import multer from 'multer';
import supabase from '../lib/supabase';
import { AuthRequest } from '../middlewares/auth.middleware';
import { extractQuestionsFromPdf } from '../lib/pdf';
import { extractVisualRegions, VisualRegion } from '../lib/pdf-visuals';
import { classifyQuestion, extractQuestionFromImage, suggestGabarito } from '../lib/ai';
import { createCropper } from '../lib/image-crop';
import { logAudit } from '../lib/audit';

const VISUAL_BUCKET = 'question-visuals';

// A Vercel corta o corpo da requisição em ~4,5 MB antes de ela chegar na
// function, então um teto maior só geraria um 413 opaco da plataforma em vez de
// um erro nosso. Fora da Vercel (Railway/Render/processo local) é seguro elevar
// via UPLOAD_MAX_MB.
export const MAX_UPLOAD_MB = Number(process.env.UPLOAD_MAX_MB) || 4;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdf = /pdf/i.test(file.mimetype) || /\.pdf$/i.test(file.originalname);
    const isImage = /image\/(png|jpe?g|webp)/i.test(file.mimetype) || /\.(png|jpe?g|webp)$/i.test(file.originalname);
    if (!isPdf && !isImage) {
      return cb(new Error('Apenas arquivos PDF ou Imagens (PNG, JPG, WebP) são aceitos'));
    }
    cb(null, true);
  },
});

// A function da Vercel morre em 60s (`maxDuration` no vercel.json). Classificar
// e resolver cada questão em série estourava esse teto numa prova de 11
// questões sem gabarito — 22 chamadas de IA enfileiradas. O trabalho de IA roda
// em paralelo limitado e com prazo: passou do orçamento, as questões restantes
// entram sem sugestão (o professor usa o botão "Sugerir gabarito" na revisão)
// em vez de a importação inteira falhar por timeout.
const AI_BUDGET_MS = Number(process.env.IMPORT_AI_BUDGET_MS) || 30_000;
const AI_CONCURRENCY = Number(process.env.IMPORT_AI_CONCURRENCY) || 4;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Casa os recortes visuais de um PDF com as questões extraídas do texto.
 *
 * Os dois lados vêm de bibliotecas diferentes (pdf-parse para o texto, pdf.js
 * para o render), então a numeração de um NÃO acompanha a do outro: uma prova
 * no formato "QUESTÃO 01" é numerada 1..N pelo render e 2..N+1 pelo texto (a
 * capa consome o índice 1). Casar por número fazia cada questão receber a
 * imagem da questão seguinte — ou nenhuma, na última.
 *
 * A ordem de tentativa é da evidência mais forte para a mais fraca:
 *   1. âncora — o próprio texto que abre o bloco, igual nos dois lados;
 *   2. número da questão;
 *   3. posição no documento.
 * Cada recorte é entregue uma única vez.
 */
class VisualMatcher {
  private readonly byAnchor = new Map<string, VisualRegion[]>();
  private readonly byNumber = new Map<number, VisualRegion[]>();
  private readonly byOrder = new Map<number, VisualRegion>();
  private readonly used = new Set<VisualRegion>();

  constructor(private readonly regions: VisualRegion[]) {
    for (const region of regions) {
      if (region.anchor) {
        const list = this.byAnchor.get(region.anchor) ?? [];
        list.push(region);
        this.byAnchor.set(region.anchor, list);
      }
      const numbered = this.byNumber.get(region.questionNumber) ?? [];
      numbered.push(region);
      this.byNumber.set(region.questionNumber, numbered);
      this.byOrder.set(region.order, region);
    }
  }

  /** Recortes ainda não entregues a nenhuma questão. */
  get unmatchedCount(): number {
    return this.regions.filter((r) => !this.used.has(r)).length;
  }

  take(question: { number?: number; anchor?: string }, index: number): VisualRegion[] {
    const candidates =
      this.pick(question.anchor ? this.byAnchor.get(question.anchor) : undefined) ??
      this.pick(question.number !== undefined ? this.byNumber.get(question.number) : undefined) ??
      this.pick(this.byOrder.has(index) ? [this.byOrder.get(index)!] : undefined) ??
      [];

    for (const region of candidates) this.used.add(region);
    return candidates;
  }

  private pick(list: VisualRegion[] | undefined): VisualRegion[] | null {
    if (!list) return null;
    const free = list.filter((r) => !this.used.has(r));
    return free.length > 0 ? free : null;
  }
}

export class ImportController {
  // Formato do Supabase: multer middleware na rota
  async upload(req: AuthRequest, res: Response) {
    try {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ error: 'Envie um arquivo PDF ou Imagem' });

      const isImage = /image\/(png|jpe?g|webp)/i.test(file.mimetype) || /\.(png|jpe?g|webp)$/i.test(file.originalname);

      const now = new Date().toISOString();
      const { data: job, error: jobError } = await supabase
        .from('import_jobs')
        .insert({
          id: randomUUID(),
          organizationId: req.organizationId!,
          userId: req.userId!,
          fileName: file.originalname,
          status: 'processing',
          updatedAt: now,
        })
        .select()
        .single();

      if (jobError || !job) {
        console.error('Erro ao criar job:', JSON.stringify(jobError));
        return res.status(500).json({ error: 'Erro ao iniciar importação' });
      }

      // ── Processamento de IMAGEM (Gemini Multimodal) ──
      if (isImage) {
        try {
          const catalog = await this.fetchCatalogForOrg(req.organizationId!);
          const extractedList = await extractQuestionFromImage(file.buffer, file.mimetype, catalog);

          // Só as figuras viram imagem. Anexar a captura inteira à questão
          // repetia embaixo do enunciado tudo o que já tinha virado texto — e
          // ainda trazia junto as outras questões da tela, o cabeçalho do site
          // e os botões. O aluno precisa ver o mapa, não o print.
          const cropper = await createCropper(file.buffer).catch((cropError) => {
            console.error('[import:image] falha ao abrir a imagem para recorte:', cropError);
            return null;
          });

          // A captura original só sobe se algum recorte falhar: nesse caso é
          // melhor o professor ver a figura dentro do print do que perdê-la.
          let originalUrl: string | null | undefined;
          const uploadOriginal = async () => {
            if (originalUrl === undefined) {
              const ext = file.originalname.split('.').pop() || 'png';
              originalUrl = await this.uploadVisual(
                req.organizationId!,
                job.id,
                `original-${Date.now()}.${ext}`,
                file.buffer,
                file.mimetype
              );
            }
            return originalUrl;
          };

          let recortesFalhos = 0;
          const inserted: any[] = [];
          for (const [index, q] of extractedList.entries()) {
            const numero = q.number ?? index + 1;
            const images: Array<Record<string, unknown>> = [];
            let recorteFalhou = false;

            for (const [figIndex, figure] of q.figures.entries()) {
              const crop = cropper?.crop(figure.box) ?? null;
              const url = crop
                ? await this.uploadVisual(
                    req.organizationId!,
                    job.id,
                    // O índice, e não o número da questão: numeração repetida
                    // na mesma captura faria um recorte sobrescrever o outro.
                    `q${index + 1}-fig${figIndex + 1}.png`,
                    crop.buffer
                  )
                : null;

              if (!url) {
                recorteFalhou = true;
                continue;
              }
              images.push({ url, caption: figure.caption ?? undefined, source: 'image-figure' });
            }

            // A transcrição viu figura e nenhum recorte saiu: o professor
            // recebe a captura inteira em vez de uma questão que perdeu o
            // mapa sem ninguém avisar.
            if (recorteFalhou || (q.hasFigure && images.length === 0)) {
              recortesFalhos++;
              const url = await uploadOriginal();
              if (url) {
                images.push({
                  url,
                  caption: 'Não foi possível recortar a figura — imagem enviada por inteiro.',
                  source: 'image-upload',
                });
              }
            }

            const { data: created, error: qErr } = await supabase
              .from('questions')
              .insert({
                id: randomUUID(),
                organizationId: req.organizationId!,
                importJobId: job.id,
                createdBy: req.userId!,
                number: numero,
                statement: q.statement,
                alternatives: q.alternatives || [],
                images,
                gabarito: q.gabarito ?? null,
                gabaritoOrigin: q.gabarito ? 'ai' : null,
                gabaritoConfidence: q.gabarito ? 0.85 : null,
                catalogItemId: q.catalogItemId ?? null,
                classificationSource: q.classificationSource ?? null,
                status: 'pending',
                updatedAt: now,
              })
              .select('id, number, statement, alternatives, images, gabarito, gabaritoOrigin, catalogItemId, classificationSource, status')
              .single();

            if (qErr) {
              console.error('[import:image] erro ao inserir questão:', JSON.stringify(qErr));
            } else if (created) {
              inserted.push({ ...created, taxonomy: this.taxonomyFor(catalog, created.catalogItemId) });
            }
          }

          await supabase
            .from('import_jobs')
            .update({
              status: 'completed',
              totalQuestions: inserted.length,
              updatedAt: new Date().toISOString(),
            })
            .eq('id', job.id);

          await logAudit({
            organizationId: req.organizationId!,
            userId: req.userId!,
            action: 'create',
            entityType: 'import_job',
            entityId: job.id,
            details: { fileName: file.originalname, totalQuestions: inserted.length, format: 'image' },
          });

          return res.status(201).json({
            job,
            questions: inserted,
            warnImages:
              recortesFalhos > 0
                ? `${recortesFalhos} questão(ões) tiveram figura que não pôde ser recortada — a imagem original foi anexada inteira. Confira antes de aprovar.`
                : undefined,
          });
        } catch (imgError: any) {
          console.error('[import:image] falha ao processar imagem:', imgError);
          await supabase
            .from('import_jobs')
            .update({
              status: 'failed',
              errorMessage: imgError?.message || 'Falha ao processar imagem com Gemini',
              updatedAt: new Date().toISOString(),
            })
            .eq('id', job.id);
          return res.status(500).json({ error: 'Falha ao extrair questões da imagem: ' + (imgError?.message || 'erro interno') });
        }
      }

      // ── Processamento de PDF (B10, B11, B12, B13) ──
      try {
        const result = await extractQuestionsFromPdf(file.buffer);
        const catalog = await this.fetchCatalogForOrg(req.organizationId!);

        // B11: renderiza cada página e recorta a região visual de cada questão
        // O motivo da falha precisa chegar ao professor: antes o erro era
        // engolido e todo PDF sem imagem recebia o mesmo aviso genérico, o que
        // tornava impossível distinguir "PDF sem figuras" de "extrator quebrou".
        let visualFailure: string | null = null;
        const regions = await extractVisualRegions(file.buffer).catch((visualError) => {
          console.error('[import] falha ao extrair visuais:', visualError);
          visualFailure = visualError instanceof Error ? visualError.message : String(visualError);
          return [];
        });
        // O recorte é casado com a questão por ÂNCORA (o texto que abre o
        // bloco), não pelo número: texto e imagem são extraídos por
        // bibliotecas diferentes e as duas numerações divergem sempre que a
        // prova não usa "1." — foi assim que todas as imagens sumiram no PDF
        // da VUNESP ("QUESTÃO 01"). Número e ordem ficam como fallback.
        const matcher = new VisualMatcher(regions);

        // Classificação assistida por IA (B13) + sugestão de gabarito.
        // Caderno de questões sem tabela de respostas é o caso mais comum: em
        // vez de importar sem gabarito (e a questão ser rejeitada na aprovação),
        // a IA resolve a questão e propõe a resposta. Entra marcada como 'ai' —
        // é palpite para o professor confirmar, nunca é gravada como se tivesse
        // vindo do documento.
        const aiDeadline = Date.now() + AI_BUDGET_MS;
        const catalogNodes = catalog.map((c) => ({ id: c.id, level: c.level, name: c.name, parentId: c.parentId }));

        const aiByIndex = await mapWithConcurrency(result.questions, AI_CONCURRENCY, async (q) => {
          if (Date.now() >= aiDeadline) return { suggestion: null, gabaritoSugerido: null };

          const precisaClassificar = q.statement.replace(/\([A-Ea-e]\)\s*$/, '').trim().length > 0;
          const precisaGabarito = !q.gabarito && q.statement.trim().length >= 10;

          // As duas chamadas são independentes: em paralelo custam o tempo da
          // mais lenta, não a soma das duas.
          const [suggestion, gabaritoSugerido] = await Promise.all([
            precisaClassificar
              ? classifyQuestion(
                  q.statement + '\n' + q.alternatives.map((a) => `${a.letter}) ${a.text}`).join('\n'),
                  catalogNodes
                ).catch((aiError) => {
                  console.error('[import] falha ao classificar:', aiError);
                  return null;
                })
              : Promise.resolve(null),
            precisaGabarito
              ? suggestGabarito(q.statement, q.alternatives).catch((aiError) => {
                  console.error('[import] falha ao sugerir gabarito:', aiError);
                  return null;
                })
              : Promise.resolve(null),
          ]);

          return { suggestion, gabaritoSugerido };
        });

        const inserted: any[] = [];
        for (const [index, q] of result.questions.entries()) {
          const { suggestion, gabaritoSugerido } = aiByIndex[index];

          let gabarito = q.gabarito ? q.gabarito.toUpperCase() : null;
          let gabaritoOrigin: string | null = q.gabarito ? q.gabaritoOrigin ?? 'heuristic' : null;
          let gabaritoConfidence: number | null = q.gabarito ? q.gabaritoConfidence ?? 0.4 : null;

          if (!gabarito && gabaritoSugerido) {
            gabarito = gabaritoSugerido.gabarito;
            gabaritoOrigin = 'ai';
            gabaritoConfidence = gabaritoSugerido.confidence;
          }

          const questionRegions = matcher.take(q, index);
          let images = [...q.images];
          for (const [regionIndex, region] of questionRegions.entries()) {
            const key = `pag${region.pageIndex}-q${q.number ?? index + 1}-${regionIndex}.png`;
            const url = await this.uploadVisual(req.organizationId!, job.id, key, region.buffer);
            if (url) images.push({ url, caption: `Elemento visual da página ${region.pageIndex}`, source: 'pdf-page', page: region.pageIndex });
          }

          const { data: created, error: qErr } = await supabase
            .from('questions')
            .insert({
              id: randomUUID(),
              organizationId: req.organizationId!,
              importJobId: job.id,
              createdBy: req.userId!,
              number: q.number ?? index + 1,
              statement: q.statement,
              alternatives: q.alternatives.filter((a) => a.text.trim().length > 0),
              images,
              gabarito,
              gabaritoOrigin,
              gabaritoConfidence,
              catalogItemId: suggestion?.catalogItemId ?? null,
              classificationSource: suggestion?.source ?? null,
              status: 'pending',
              updatedAt: now,
            })
            .select('id, number, statement, alternatives, images, gabarito, gabaritoOrigin, catalogItemId, classificationSource, status')
            .single();

          if (qErr) {
            console.error('Erro ao inserir questão:', JSON.stringify(qErr));
          } else if (created) {
            inserted.push({ ...created, taxonomy: this.taxonomyFor(catalog, created.catalogItemId) });
          }
        }

        const { error: updateError } = await supabase
          .from('import_jobs')
          .update({
            status: 'completed',
            totalQuestions: inserted.length,
            updatedAt: new Date().toISOString(),
          })
          .eq('id', job.id);

        if (updateError) console.error('Erro ao finalizar job:', JSON.stringify(updateError));

        await logAudit({
          organizationId: req.organizationId!,
          userId: req.userId!,
          action: 'create',
          entityType: 'import_job',
          entityId: job.id,
          details: { fileName: file.originalname, totalQuestions: inserted.length },
        });

        return res.status(201).json({
          job: { ...job, status: 'completed', totalQuestions: inserted.length },
          questions: inserted,
          warnImages: visualFailure
            ? `Falha ao recortar os visuais deste PDF (${visualFailure}). As questões foram importadas só com o texto — revise antes de aprovar.`
            : matcher.unmatchedCount > 0
            ? `${matcher.unmatchedCount} recorte(s) visual(is) deste PDF não puderam ser associados a uma questão. Confira as questões com figura antes de aprovar.`
            : regions.length === 0
            ? 'Não foi possível extrair automaticamente o visual de cada questão deste PDF. Revise cada questão visualmente antes de aprovar.'
            : undefined,
        });
      } catch (extractError) {
        console.error('Erro na extração:', extractError);
        const { error } = await supabase
          .from('import_jobs')
          .update({
            status: 'failed',
            errorMessage: extractError instanceof Error ? extractError.message : 'Falha ao processar o PDF',
            updatedAt: new Date().toISOString(),
          })
          .eq('id', job.id);
        if (error) console.error(error);
        return res.status(500).json({ error: 'Não foi possível interpretar o PDF', jobId: job.id });
      }
    } catch (error: any) {
      console.error(error);
      return res.status(500).json({ error: error?.message ?? 'Erro ao processar o arquivo' });
    }
  }

  async list(req: AuthRequest, res: Response) {
    try {
      const { data, error } = await supabase
        .from('import_jobs')
        .select('*')
        .eq('organizationId', req.organizationId!)
        .eq('userId', req.userId!)
        .order('createdAt', { ascending: false });
      if (error) return res.status(500).json({ error: 'Erro ao listar importações' });
      return res.json(data ?? []);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Erro ao listar importações' });
    }
  }

  async getById(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const { data: job, error } = await supabase
        .from('import_jobs')
        .select('*')
        .eq('id', id)
        .eq('organizationId', req.organizationId!)
        .single();
      if (error || !job) return res.status(404).json({ error: 'Importação não encontrada' });

      const { data: questions, error: qErr } = await supabase
        .from('questions')
        .select('*')
        .eq('importJobId', id)
        .eq('organizationId', req.organizationId!)
        .order('number', { ascending: true });
      if (qErr) return res.status(500).json({ error: 'Erro ao listar questões' });

      return res.json({ ...job, questions: questions ?? [] });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Erro ao buscar importação' });
    }
  }

  private async fetchCatalogForOrg(orgId: string) {
    const { data } = await supabase
      .from('catalog_items')
      .select('id, level, name, parentId')
      .eq('organizationId', orgId);
    return data ?? [];
  }

  private taxonomyFor(catalog: Array<{ id: string; name: string; level: number; parentId: string | null }>, itemId?: string | null) {
    if (!itemId) return [];
    const byId = new Map(catalog.map((item) => [item.id, item]));
    const path: Array<{ level: number; name: string }> = [];
    let current = byId.get(itemId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.unshift({ level: current.level, name: current.name });
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return path;
  }

  // ─── Supabase Storage (B11: gráficos/imagens reais por questão) ──────────
  private async ensureVisualBucket() {
    const { error } = await supabase.storage.getBucket(VISUAL_BUCKET);
    if (!error) return;
    const { error: createError } = await supabase.storage.createBucket(VISUAL_BUCKET, {
      public: true,
      fileSizeLimit: 15 * 1024 * 1024,
    });
    if (createError) {
      console.error('[storage] erro ao criar bucket:', createError.message);
    }
  }

  private async uploadVisual(orgId: string, jobId: string, key: string, buffer: Buffer, contentType = 'image/png'): Promise<string | null> {
    await this.ensureVisualBucket();
    const path = `${orgId}/${jobId}/${key}`;
    const { error: uploadError } = await supabase.storage
      .from(VISUAL_BUCKET)
      .upload(path, buffer, { contentType, upsert: true });
    if (uploadError) {
      console.error('[storage] erro ao enviar visual:', uploadError.message);
      return null;
    }
    const { data } = await supabase.storage.from(VISUAL_BUCKET).getPublicUrl(path);
    return data?.publicUrl ?? null;
  }
}

export { upload as importUploadMiddleware };
