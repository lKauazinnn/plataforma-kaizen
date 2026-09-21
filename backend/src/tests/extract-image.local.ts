// Verificação manual da extração multimodal: roda o Gemini numa imagem real e
// grava os recortes em disco. Uso:
//   npx tsx src/tests/extract-image.local.ts <caminho-da-imagem> <pasta-saida>
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { extractQuestionFromImage } from '../lib/ai';
import { createCropper } from '../lib/image-crop';

async function main() {
  const imagePath = process.argv[2];
  const outDir = process.argv[3] ?? '.';
  if (!imagePath) throw new Error('informe o caminho da imagem');

  const buffer = readFileSync(imagePath);
  const mime = /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg';

  const questions = await extractQuestionFromImage(buffer, mime, []);
  const cropper = await createCropper(buffer);
  mkdirSync(outDir, { recursive: true });
  console.log(`imagem ${cropper.width}x${cropper.height} — ${questions.length} questão(ões)\n`);

  for (const [index, q] of questions.entries()) {
    const numero = q.number ?? index + 1;
    console.log(`── Questão ${numero} [${q.type}] gabarito=${q.gabarito ?? '-'}`);
    console.log(q.statement);
    for (const alt of q.alternatives) console.log(`  ${alt.letter}) ${alt.text}`);
    console.log(`  figuras: ${q.figures.length}`);

    for (const [i, figure] of q.figures.entries()) {
      const crop = cropper.crop(figure.box);
      if (!crop) {
        console.log(`  ! caixa descartada: ${JSON.stringify(figure.box)}`);
        continue;
      }
      const file = join(outDir, `q${numero}-fig${i + 1}.png`);
      writeFileSync(file, crop.buffer);
      console.log(`  → ${file} (${crop.width}x${crop.height}) caixa=${JSON.stringify(figure.box)} legenda=${figure.caption ?? '-'}`);
    }
    console.log('');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
