// PDF.js のCJK用 cMap と標準フォントを public/pdfjs/ にコピーする（日本語の非埋め込みフォント対策）
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const dst = join(root, 'public', 'pdfjs');
if (!existsSync(src)) process.exit(0);
mkdirSync(dst, { recursive: true });
for (const d of ['cmaps', 'standard_fonts']) cpSync(join(src, d), join(dst, d), { recursive: true });
