// ビルド前に実行する（bun scripts/gen-redirects.ts）．
// ビルド時の環境変数 COVERS_PUBLIC_URL があれば，プロジェクトルートに Pages の `_redirects` を生成する．
// （adapter-cloudflare は static/ ではなくプロジェクトルートの `_redirects` を読む）
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { buildRedirects, normalizePublicUrl } from '../src/lib/server/covers.ts';

const file = new URL('../_redirects', import.meta.url);
const raw = process.env.COVERS_PUBLIC_URL;
const content = buildRedirects(raw);

if (content === null) {
	if (raw) console.error(`COVERS_PUBLIC_URL is not a valid http(s) URL: ${raw}`);
	if (existsSync(file)) rmSync(file);
	console.log('_redirects: not generated');
} else {
	writeFileSync(file, content);
	console.log(`_redirects: generated (${normalizePublicUrl(raw)})`);
}
