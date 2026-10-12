import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const ALLOWED_HOST = 'image.annict.com';
const MAX_BYTES = 1_000_000;

/** CORS ヘッダの無い Annict のアイコンを，WebGL テクスチャに使えるよう中継する． */
export const GET: RequestHandler = async ({ url, fetch }) => {
	let target: URL;
	try {
		target = new URL(url.searchParams.get('url') ?? '');
	} catch {
		error(400, 'Invalid url');
	}
	if (target.protocol !== 'https:' || target.hostname !== ALLOWED_HOST) {
		error(400, 'Host not allowed');
	}

	const res = await fetch(target);
	if (!res.ok) error(502, `Upstream HTTP ${res.status}`);

	const contentType = res.headers.get('content-type');
	if (!contentType?.startsWith('image/')) error(502, 'Upstream is not an image');
	if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) error(502, 'Image too large');

	return new Response(res.body, {
		headers: {
			'Content-Type': contentType,
			'Cache-Control': 'public, max-age=86400',
			'Access-Control-Allow-Origin': '*'
		}
	});
};
