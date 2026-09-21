import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { renderPages } from '../lib/pdf-visuals';
async function main() {
  const pages = await renderPages(readFileSync(process.argv[2]));
  const outDir = process.argv[3] ?? '.';
  mkdirSync(outDir, { recursive: true });
  for (const p of pages) {
    const file = join(outDir, `page${p.pageIndex}.png`);
    writeFileSync(file, p.buffer);
    console.log(file, p.width + 'x' + p.height);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
