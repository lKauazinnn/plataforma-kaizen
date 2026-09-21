// Verificação manual do recorte de figuras do PDF. Uso:
//   npx tsx src/tests/extract-pdf.local.ts <arquivo.pdf> <pasta-saida>
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { extractVisualRegions } from '../lib/pdf-visuals';

async function main() {
  const pdfPath = process.argv[2];
  const outDir = process.argv[3] ?? '.';
  if (!pdfPath) throw new Error('informe o caminho do PDF');

  const regions = await extractVisualRegions(readFileSync(pdfPath));
  mkdirSync(outDir, { recursive: true });
  console.log(`${regions.length} figura(s)\n`);

  for (const region of regions) {
    const file = join(outDir, `pag${region.pageIndex}-q${region.questionNumber}-${region.order}.png`);
    writeFileSync(file, region.buffer);
    console.log(
      `pág ${region.pageIndex} · questão ${region.questionNumber} · ${region.width}x${region.height} · ${region.anchor.slice(0, 40)}`
    );
    console.log(`  ${file}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
