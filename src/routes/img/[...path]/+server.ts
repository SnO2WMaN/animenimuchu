import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { COVERS_PUBLIC_URL } from '$app/env/private';
import { isMirrorPath, redirectTarget } from '#lib/server/covers.ts';
import type { RequestHandler } from './$types';

/**
 * ミラーした画像の配信．COVERS_PUBLIC_URL があればそこへ 302（本番は通常，ビルド時の `_redirects` が先に処理する）．
 * 未設定なら R2 バインディングから直接返す（開発・フォールバック）．
 */
export const GET: RequestHandler = async ({ params }) => {
	if (!isMirrorPath(params.path)) error(404, 'Not found');

	if (COVERS_PUBLIC_URL) {
		const location = redirectTarget(COVERS_PUBLIC_URL, params.path);
		if (location) {
			return new Response(null, {
				status: 302,
				headers: {
					Location: location,
					'Cache-Control': 'public, max-age=86400',
					'Access-Control-Allow-Origin': '*'
				}
			});
		}
		console.error('COVERS_PUBLIC_URL is not a valid http(s) URL; serving from the R2 binding');
	}
	let bucket: R2Bucket | undefined;
	try {
		bucket = env.COVERS;
	} catch {
		bucket = undefined;
	}
	if (!bucket) error(404, 'Not found');

	const object = await bucket.get(params.path);
	if (!object) error(404, 'Not found');

	return new Response(object.body, {
		headers: {
			'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
			'Cache-Control': 'public, max-age=31536000, immutable',
			ETag: object.httpEtag
		}
	});
};
