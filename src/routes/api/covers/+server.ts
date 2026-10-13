import { error, json } from '@sveltejs/kit';
import { env, waitUntil } from 'cloudflare:workers';
import { MAX_COVER_REPORTS } from '#lib/graph-data.ts';
import {
	acceptCoverReports,
	d1CoverCache,
	r2CoverStore,
	validateCoverReports
} from '#lib/server/covers.ts';
import type { RequestHandler } from './$types';

const MAX_BODY_BYTES = 32 * 1024;

/** 本文を最大 max バイトまで読む．超えたら null． */
const readLimited = async (request: Request, max: number): Promise<string | null> => {
	const length = request.headers.get('content-length');
	if (length !== null && Number(length) > max) return null;
	if (!request.body) return '';
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const c of chunks) {
		bytes.set(c, offset);
		offset += c.byteLength;
	}
	return new TextDecoder().decode(bytes);
};

/** ブラウザが AniList から得たカバー画像を共有キャッシュ（D1）に先勝ちで保存し，R2 へのミラーを背景で始める．同一オリジンのみ． */
export const POST: RequestHandler = async ({ request, fetch }) => {
	if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
		error(415, 'Content-Type must be application/json');

	const text = await readLimited(request, MAX_BODY_BYTES);
	if (text === null) error(413, 'Request body too large');

	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		error(400, 'Invalid JSON');
	}
	const covers = (body as { covers?: unknown } | null)?.covers;
	if (Array.isArray(covers) && covers.length > MAX_COVER_REPORTS) error(400, 'Too many covers');

	let db: D1Database | undefined;
	let bucket: R2Bucket | undefined;
	try {
		db = env.DB;
		bucket = env.COVERS;
	} catch {
		// env にアクセスできない環境．
	}
	// バインディングが無い環境（素の Vite など）では保存しない．
	if (!db) return json({ accepted: 0 });

	const accepted = await acceptCoverReports(validateCoverReports(body), {
		cache: d1CoverCache(db),
		store: bucket ? r2CoverStore(bucket) : undefined,
		fetch,
		waitUntil
	});
	return json({ accepted });
};
