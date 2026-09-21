// Extração de elementos visuais do PDF (B11).
//
// Renderiza cada página com pdf.js + @napi-rs/canvas e recorta APENAS as
// figuras — gráficos, mapas, tabelas desenhadas, charges. O enunciado e as
// alternativas já saem como texto no `pdf.ts`, então antes, quando o recorte
// era o bloco inteiro da questão, o mesmo texto aparecia duas vezes na tela do
// aluno: escrito e de novo dentro da imagem.
//
// A figura é achada por exclusão: as coordenadas do texto dizem quais linhas
// da página são escrita; o que sobra com tinta no render é desenho.
import { createCanvas, Path2D as NapiPath2D, DOMMatrix as NapiDOMMatrix } from '@napi-rs/canvas';
import { blockAnchor } from './pdf';
import { pathToFileURL } from 'url';

export interface VisualRegion {
  questionNumber: number;
  pageIndex: number; // 1-based
  buffer: Buffer; // PNG
  width: number;
  height: number;
  /** Assinatura do texto que abre o bloco — casa o recorte com a questão extraída. */
  anchor: string;
  /** Posição do bloco no documento (0-based), último critério de casamento. */
  order: number;
}

const SCALE = 2;

/** Folga em volta da figura recortada, em pixels do render. */
const PAD = 6;
/** Pixel escuro o bastante para contar como traço (fundo do render é branco). */
const INK_LUMA = 235;
/** Linha com menos tinta que isso é ruído de antialiasing, não desenho. */
const INK_ROW_RATIO = 0.003;
/**
 * Vão em branco que ainda mantém a figura inteira.
 *
 * Rótulo de eixo e legenda dentro do gráfico são TEXTO: a linha deles entra na
 * máscara de escrita e rasga a figura em duas faixas. Costurar vãos curtos
 * devolve o gráfico inteiro; um parágrafo de verdade é mais alto que isso e
 * continua de fora.
 */
const MERGE_GAP_PX = 22;
/** Abaixo disso é filete, número de página ou traço de separação. */
const MIN_FIGURE_HEIGHT = 40;
const MIN_FIGURE_WIDTH = 60;
/** Distância máxima entre a figura e o fim do último bloco da página. */
const TRAILING_TOLERANCE = 120;
/** Faixa do topo da página onde a figura ainda é da questão da página anterior. */
const TOP_CARRY_RATIO = 0.18;
/** Retorno de `pickBlock` para "é da última questão da página anterior". */
const CARRY_OVER = -2;

const GABARITO_TERMINATOR_RE = /^(gabarito|respostas|answer key|respostas das quest[õo]es|gabarito comentado)/i;

let pdfjsPromise: Promise<any> | null = null;
let pdfCanvasFactory: any = null;

type PdfCanvasFactory = {
  create: (w: number, h: number) => { canvas: any; context: any };
  reset: (c: any, w: number, h: number) => void;
  destroy: (c: any) => void;
};

function makeCanvasFactory(): PdfCanvasFactory {
  return {
    create(w: number, h: number) {
      const canvas = createCanvas(w, h);
      return { canvas, context: canvas.getContext('2d') as any };
    },
    reset(c: any, w: number, h: number) {
      c.canvas.width = w;
      c.canvas.height = h;
    },
    destroy(c: any) {
      c.canvas.width = 0;
      c.canvas.height = 0;
      c.canvas = null as any;
      c.context = null as any;
    },
  };
}

const PDFJS_ENTRY = 'pdfjs-dist/legacy/build/pdf.mjs';
const PDFJS_WORKER = 'pdfjs-dist/legacy/build/pdf.worker.mjs';

/**
 * `import()` que sobrevive à compilação para CommonJS.
 *
 * O tsconfig usa `"module": "commonjs"`, e nesse modo o tsc reescreve TODO
 * `await import()` como `require()`. O pdfjs-dist 4.x publica apenas ESM
 * (`.mjs`), e `require()` de um `.mjs` lança ERR_REQUIRE_ESM — em produção isso
 * derrubava a extração inteira e todo PDF entrava sem imagem. Em dev nunca
 * aparecia porque o tsx preserva o `import()` original.
 *
 * Montar a expressão com `new Function` a esconde do compilador, então ela
 * chega ao Node como um `import()` dinâmico de verdade.
 */
const importESM: (specifier: string) => Promise<any> = new Function(
  'specifier',
  'return import(specifier)'
) as any;

// Carrega o pdf.js (legacy ESM) uma única vez e prepara o polyfill de canvas.
async function loadPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // `require.resolve` é uma referência ESTÁTICA ao pacote: é o que mantém o
      // pdfjs-dist visível para o file tracing da Vercel. Escondido apenas
      // atrás do `new Function`, o `.mjs` ficaria fora do bundle e o erro
      // viraria "module not found". Resolver não carrega o módulo — só devolve
      // o caminho absoluto, que vira uma file:// URL que o import() aceita.
      let specifier = PDFJS_ENTRY;
      try {
        specifier = pathToFileURL(require.resolve(PDFJS_ENTRY)).href;
      } catch {
        // Sem `require` disponível (execução como ESM puro): o specifier nu
        // resolve normalmente pelo próprio Node.
      }

      const mod = await importESM(specifier);

      // Sem worker configurado, o pdf.js monta um "fake worker" importando o
      // pdf.worker.mjs por um caminho que ele calcula em runtime — invisível
      // para o file tracing da Vercel, então o arquivo ficava fora do bundle e
      // a extração morria em "Setting up fake worker failed". O require.resolve
      // estático resolve as duas pontas: obriga o empacotador a incluir o
      // worker e devolve o caminho real para apontar o workerSrc.
      try {
        mod.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve(PDFJS_WORKER)).href;
      } catch (workerError) {
        console.error('[pdf-visuals] worker do pdfjs não resolvido:', workerError);
      }

      if (typeof (globalThis as any).Path2D === 'undefined') (globalThis as any).Path2D = NapiPath2D;
      if (typeof (globalThis as any).DOMMatrix === 'undefined') (globalThis as any).DOMMatrix = NapiDOMMatrix;
      pdfCanvasFactory = makeCanvasFactory();
      return mod;
    })();
  }
  return pdfjsPromise;
}

// Extrai as figuras de cada página e entrega cada uma à questão em que ela cai.
export async function extractVisualRegions(pdfBuffer: Buffer): Promise<VisualRegion[]> {
  const regions: VisualRegion[] = [];
  /** Última questão da página anterior: dona das figuras que viram a página. */
  let carryOver: Block | null = null;
  const pdfjs = await loadPdfjs();
  const input = new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength);

  const doc = await pdfjs.getDocument({
    data: input,
    useSystemFonts: true,
    useWorkerFetch: false,
    isEvalSupported: false,
    canvasFactory: pdfCanvasFactory,
  }).promise;

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const text = await page.getTextContent();
      const items = text.items ?? [];
      const blocks = buildBlocks(items);
      if (blocks.length === 0) continue;

      const viewport = page.getViewport({ scale: SCALE });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d') as any;

      // Silencia warnings de fontes padrão não embutidas (ex: Helvetica puro)
      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        await page.render({
          canvasContext: ctx,
          viewport,
          canvasFactory: pdfCanvasFactory,
        }).promise;
      } catch (pageError) {
        console.error('[pdf-visuals] falha ao renderizar página', pageNumber, pageError);
        continue;
      } finally {
        console.warn = originalWarn;
      }

      const pixels = ctx.getImageData(0, 0, width, height).data as Uint8ClampedArray;
      const textRows = markTextRows(items, viewport, height);
      const bands = findFigureBands(pixels, width, height, textRows);
      if (bands.length === 0) continue;

      const spans = blocks.map((block) => blockSpan(block, viewport));

      for (const band of bands) {
        const target = pickBlock(spans, band, height);
        if (target === -1) continue;

        // Sem página anterior (a figura abre o documento) só resta a primeira
        // questão desta página.
        const block = target === CARRY_OVER ? carryOver ?? blocks[0] : blocks[target];

        const crop = cropBand(canvas, pixels, width, height, band);
        if (!crop) continue;

        regions.push({
          questionNumber: block.number,
          pageIndex: pageNumber,
          buffer: crop.buffer,
          width: crop.width,
          height: crop.height,
          anchor: blockAnchor(block.text),
          order: regions.length,
        });
      }

      carryOver = blocks[blocks.length - 1];
    }
  } finally {
    await doc.destroy().catch(() => {});
  }

  return regions;
}

interface Block {
  number: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Texto corrido do início do bloco, de onde sai a âncora. */
  text: string;
}

/** Faixa horizontal da página, em pixels do render. */
interface Band {
  top: number;
  bottom: number;
}

function buildBlocks(items: any[]): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;

  for (const item of items) {
    if (!item || typeof item.str !== 'string') continue;
    const str = item.str.trim();
    if (!str) continue;
    if (GABARITO_TERMINATOR_RE.test(str)) break;

    const start = questionNumberFromItem(str);
    const tx = item.transform?.[4] ?? 0;
    const ty = item.transform?.[5] ?? 0;
    const th = item.height ?? 0;
    const tw = item.width ?? 0;

    if (start !== null) {
      if (current) blocks.push(current);
      current = { number: start, minX: tx, maxX: tx + tw, minY: ty - th, maxY: ty, text: str };
      continue;
    }

    if (!current) continue;
    current.minX = Math.min(current.minX, tx);
    current.maxX = Math.max(current.maxX, tx + tw);
    current.minY = Math.min(current.minY, ty - th);
    current.maxY = Math.max(current.maxY, ty);
    // A âncora só precisa do começo do bloco; parar cedo evita carregar a
    // questão inteira em memória só para comparar 48 caracteres.
    if (current.text.length < 160) current.text += ' ' + str;
  }

  if (current) blocks.push(current);
  return blocks;
}

function questionNumberFromItem(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  if (/^\(?[A-Ea-e]\)?$/.test(s)) return null; // alternativa isolada
  const numeric = s.match(/^(\d{1,3})\s*[\.\)\]\:]\s*/);
  if (numeric) return parseInt(numeric[1], 10);
  const named = s.match(/^\b(?:quest[ãa]o|questao)\s*\.?\s*(\d{1,3})\b/i);
  if (named) return parseInt(named[1], 10);
  const short = s.match(/^\bq\.?\s*(\d{1,3})\b/i);
  if (short) return parseInt(short[1], 10);
  return null;
}

/**
 * Máscara das linhas ocupadas por texto, em pixels do render.
 *
 * É o que separa escrita de desenho: o pdf.js entrega a posição de cada trecho
 * de texto, então toda linha que um deles cruza está fora do jogo.
 */
function markTextRows(items: any[], viewport: any, height: number): Uint8Array {
  const rows = new Uint8Array(height);

  for (const item of items) {
    if (!item || typeof item.str !== 'string' || !item.str.trim()) continue;
    const tx = item.transform?.[4] ?? 0;
    const ty = item.transform?.[5] ?? 0;
    const th = item.height ?? 0;

    // O item é ancorado na base da linha: a caixa vai de um pouco abaixo dela
    // (descida do "g", do "p") até a altura da fonte acima.
    const [, yBase] = viewport.convertToViewportPoint(tx, ty - th * 0.3);
    const [, yTop] = viewport.convertToViewportPoint(tx, ty + th);

    const from = Math.max(0, Math.floor(Math.min(yBase, yTop)) - 1);
    const to = Math.min(height - 1, Math.ceil(Math.max(yBase, yTop)) + 1);
    for (let y = from; y <= to; y++) rows[y] = 1;
  }

  return rows;
}

/** Faixas com traço e sem texto — as figuras da página. */
function findFigureBands(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  textRows: Uint8Array
): Band[] {
  const minInk = Math.max(3, Math.round(width * INK_ROW_RATIO));
  const drawn = new Uint8Array(height);

  for (let y = 0; y < height; y++) {
    if (textRows[y]) continue;
    let ink = 0;
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * 4;
      if (pixels[i + 3] > 16 && (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 < INK_LUMA) {
        if (++ink >= minInk) {
          drawn[y] = 1;
          break;
        }
      }
    }
  }

  const bands: Band[] = [];
  let current: Band | null = null;
  let gap = 0;

  for (let y = 0; y < height; y++) {
    if (drawn[y]) {
      if (current) {
        current.bottom = y;
        gap = 0;
      } else {
        current = { top: y, bottom: y };
        gap = 0;
      }
      continue;
    }

    if (!current) continue;
    if (++gap > MERGE_GAP_PX) {
      bands.push(current);
      current = null;
    }
  }
  if (current) bands.push(current);

  return bands.filter((band) => band.bottom - band.top + 1 >= MIN_FIGURE_HEIGHT);
}

/** Faixa vertical do bloco de texto da questão, em pixels do render. */
function blockSpan(block: Block, viewport: any): Band {
  const [, yBottom] = viewport.convertToViewportPoint(block.minX, block.minY);
  const [, yTop] = viewport.convertToViewportPoint(block.minX, block.maxY);
  return { top: Math.min(yTop, yBottom), bottom: Math.max(yTop, yBottom) };
}

/**
 * De quem é a figura.
 *
 * Dentro do bloco, é da questão do bloco. No vão entre dois blocos, é da
 * questão de BAIXO: é o formato "Observe o gráfico para responder à questão",
 * em que a figura abre a questão, antes do número dela. Colada no topo da
 * página, antes de qualquer número, é o contrário: a questão começou na página
 * anterior e a figura veio junto na virada.
 */
function pickBlock(spans: Band[], band: Band, pageHeight: number): number {
  const center = (band.top + band.bottom) / 2;

  for (let i = 0; i < spans.length; i++) {
    if (center >= spans[i].top && center <= spans[i].bottom) return i;
  }

  if (spans.length > 0 && center < spans[0].top && band.top < pageHeight * TOP_CARRY_RATIO) {
    return CARRY_OVER;
  }

  for (let i = 0; i < spans.length; i++) {
    if (spans[i].top > center) return i;
  }

  // Depois do último bloco só sobra rodapé — a não ser que a figura encoste
  // nele, caso em que ainda é da última questão da página.
  const last = spans.length - 1;
  if (last >= 0 && band.top - spans[last].bottom <= TRAILING_TOLERANCE) return last;
  return -1;
}

/** Recorta a faixa, apertando as laterais até onde existe traço. */
function cropBand(
  canvas: any,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  band: Band
): { buffer: Buffer; width: number; height: number } | null {
  let left = width;
  let right = -1;

  for (let y = band.top; y <= band.bottom; y++) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * 4;
      if (pixels[i + 3] > 16 && (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 < INK_LUMA) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (right < 0) return null;

  const sx = Math.max(0, left - PAD);
  const sy = Math.max(0, band.top - PAD);
  const sw = Math.min(width, right + PAD) - sx;
  const sh = Math.min(height, band.bottom + PAD) - sy;
  if (sw < MIN_FIGURE_WIDTH || sh < MIN_FIGURE_HEIGHT) return null;

  const out = createCanvas(sw, sh);
  const ctx = out.getContext('2d') as any;
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return { buffer: out.toBuffer('image/png'), width: sw, height: sh };
}

/** Só para conferência manual: render cru de cada página (ver src/tests/render-pages.local.ts). */
export async function renderPages(pdfBuffer: Buffer): Promise<{ pageIndex: number; buffer: Buffer; width: number; height: number }[]> {
  const pdfjs = await loadPdfjs();
  const input = new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength);
  const doc = await pdfjs.getDocument({ data: input, useSystemFonts: true, useWorkerFetch: false, isEvalSupported: false, canvasFactory: pdfCanvasFactory }).promise;
  const out: { pageIndex: number; buffer: Buffer; width: number; height: number }[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d') as any, viewport, canvasFactory: pdfCanvasFactory }).promise;
    out.push({ pageIndex: pageNumber, buffer: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height });
  }
  await doc.destroy().catch(() => {});
  return out;
}
