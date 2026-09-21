// Recorte de figuras da imagem enviada na importação multimodal.
//
// O print de um caderno de questões é quase todo texto: enunciado,
// alternativas, cabeçalho do site e botões. Anexar a imagem inteira à questão
// duplicava tudo isso embaixo do enunciado já transcrito. A IA devolve a caixa
// de cada elemento visual de verdade (mapa, gráfico, tabela desenhada) e aqui
// essa caixa vira um PNG só com a figura — igual ao que o aluno vê num banco
// de questões: texto como texto, figura como figura.
import { createCanvas, loadImage } from '@napi-rs/canvas';

/** Caixa normalizada [yMin, xMin, yMax, xMax] — ordem do bounding box do Gemini. */
export type RawBox = number[];

export interface Crop {
  buffer: Buffer;
  width: number;
  height: number;
}

export interface Cropper {
  width: number;
  height: number;
  /** PNG só com a região da caixa, ou null se a caixa não for aproveitável. */
  crop(box: RawBox): Crop | null;
}

/** Folga mínima: a caixa do modelo costuma encostar na moldura da figura. */
const PAD_RATIO = 0.004;
/** Abaixo disso o recorte é ruído (um ícone, uma letra solta), não uma figura. */
const MIN_SIDE_PX = 40;
/** Caixa que cobre quase a página inteira é "a imagem toda" travestida de figura. */
const FULL_IMAGE_RATIO = 0.92;

/**
 * Decodifica a imagem UMA vez e devolve um recortador.
 *
 * Uma mesma captura costuma render várias questões; carregar o bitmap por
 * figura desperdiçaria a decodificação inteira a cada recorte.
 */
export async function createCropper(source: Buffer): Promise<Cropper> {
  const image = await loadImage(source);
  const width = image.width;
  const height = image.height;

  return {
    width,
    height,
    crop(box: RawBox): Crop | null {
      const rect = toPixelRect(box, width, height);
      if (!rect) return null;

      const canvas = createCanvas(rect.width, rect.height);
      const ctx = canvas.getContext('2d') as any;
      ctx.drawImage(image, rect.left, rect.top, rect.width, rect.height, 0, 0, rect.width, rect.height);

      const trimmed = trimStrayEdgeLines(ctx, rect.width, rect.height);
      if (!trimmed) return { buffer: canvas.toBuffer('image/png'), width: rect.width, height: rect.height };

      const out = createCanvas(rect.width, trimmed.height);
      const outCtx = out.getContext('2d') as any;
      outCtx.drawImage(canvas, 0, trimmed.top, rect.width, trimmed.height, 0, 0, rect.width, trimmed.height);
      return { buffer: out.toBuffer('image/png'), width: rect.width, height: trimmed.height };
    },
  };
}

interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function toPixelRect(box: RawBox, imageWidth: number, imageHeight: number): PixelRect | null {
  if (!Array.isArray(box) || box.length < 4) return null;
  const nums = box.slice(0, 4).map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;

  // O Gemini normaliza em 0–1000, mas às vezes devolve 0–1 por conta própria;
  // deduzir a escala custa uma linha e evita perder a figura inteira.
  const scale = nums.every((n) => n <= 1.001) ? 1 : 1000;
  const [yMin, xMin, yMax, xMax] = nums;

  const padX = Math.max(2, imageWidth * PAD_RATIO);
  const padY = Math.max(2, imageHeight * PAD_RATIO);

  const left = Math.max(0, Math.floor((Math.min(xMin, xMax) / scale) * imageWidth - padX));
  const top = Math.max(0, Math.floor((Math.min(yMin, yMax) / scale) * imageHeight - padY));
  const right = Math.min(imageWidth, Math.ceil((Math.max(xMin, xMax) / scale) * imageWidth + padX));
  const bottom = Math.min(imageHeight, Math.ceil((Math.max(yMin, yMax) / scale) * imageHeight + padY));

  const width = right - left;
  const height = bottom - top;
  if (width < MIN_SIDE_PX || height < MIN_SIDE_PX) return null;
  if (width >= imageWidth * FULL_IMAGE_RATIO && height >= imageHeight * FULL_IMAGE_RATIO) return null;

  return { left, top, width, height };
}

/** Ink mínimo para a linha contar como conteúdo (evita chiado do JPEG). */
const ROW_INK_RATIO = 0.005;
/** Altura máxima de uma banda para ela ser "uma linha de texto", não a figura. */
const STRAY_LINE_RATIO = 0.06;
const STRAY_LINE_MAX_PX = 16;
/** Espaço em branco que separa a linha solta da figura. */
const MIN_GAP_PX = 2;

/**
 * Apara linha de texto que vazou para dentro do recorte.
 *
 * A caixa do modelo erra por alguns pixels e costuma abrir um pouco acima da
 * figura, trazendo o rabo da frase "Observe o mapa a seguir" — ou, embaixo, a
 * linha "Fonte: ...", que já vai como legenda em texto. Só cai fora uma banda
 * FINA e separada do resto por um vão em branco: dentro de uma figura com
 * moldura não existe linha em branco (a borda pinta todas), então isto não
 * tem como comer a figura.
 */
function trimStrayEdgeLines(ctx: any, width: number, height: number): { top: number; height: number } | null {
  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, width, height).data;
  } catch {
    return null;
  }

  const background = estimateBackground(pixels, width, height);
  const inkThreshold = Math.max(1, Math.round(width * ROW_INK_RATIO));
  const blank: boolean[] = new Array(height);

  for (let y = 0; y < height; y++) {
    let ink = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const diff =
        Math.abs(pixels[i] - background[0]) +
        Math.abs(pixels[i + 1] - background[1]) +
        Math.abs(pixels[i + 2] - background[2]);
      if (diff > 90 && ++ink > inkThreshold) break;
    }
    blank[y] = ink <= inkThreshold;
  }

  const maxLine = Math.min(STRAY_LINE_MAX_PX, Math.floor(height * STRAY_LINE_RATIO));
  let top = 0;
  let bottom = height - 1;

  // Topo: pula o branco, mede a primeira banda, corta se ela for uma linha
  // isolada. Uma única passada por borda — duas linhas soltas seguidas são
  // texto de verdade e devem aparecer no aviso da revisão, não sumir aqui.
  let cursor = top;
  while (cursor <= bottom && blank[cursor]) cursor++;
  let bandEnd = cursor;
  while (bandEnd <= bottom && !blank[bandEnd]) bandEnd++;
  let gapEnd = bandEnd;
  while (gapEnd <= bottom && blank[gapEnd]) gapEnd++;
  if (bandEnd - cursor <= maxLine && gapEnd - bandEnd >= MIN_GAP_PX && gapEnd <= bottom) {
    top = Math.max(0, gapEnd - MIN_GAP_PX);
  }

  cursor = bottom;
  while (cursor >= top && blank[cursor]) cursor--;
  let bandStart = cursor;
  while (bandStart >= top && !blank[bandStart]) bandStart--;
  let gapStart = bandStart;
  while (gapStart >= top && blank[gapStart]) gapStart--;
  if (cursor - bandStart <= maxLine && bandStart - gapStart >= MIN_GAP_PX && gapStart >= top) {
    bottom = Math.min(height - 1, gapStart + MIN_GAP_PX);
  }

  const newHeight = bottom - top + 1;
  if (newHeight === height) return null;
  if (newHeight < MIN_SIDE_PX || newHeight < height * 0.5) return null;
  return { top, height: newHeight };
}

/** Cor de fundo do recorte pela mediana das bordas — serve para print claro e escuro. */
function estimateBackground(pixels: Uint8ClampedArray, width: number, height: number): [number, number, number] {
  const samples: number[][] = [[], [], []];
  const step = Math.max(1, Math.floor(width / 32));
  for (let x = 0; x < width; x += step) {
    for (const y of [0, height - 1]) {
      const i = (y * width + x) * 4;
      samples[0].push(pixels[i]);
      samples[1].push(pixels[i + 1]);
      samples[2].push(pixels[i + 2]);
    }
  }
  const median = (values: number[]) => {
    if (values.length === 0) return 255;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return [median(samples[0]), median(samples[1]), median(samples[2])];
}
