import { json } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { ANNICT_ACCESS_TOKEN } from '$app/env/private';
import {
	d1CoverCache,
	r2CoverStore,
	type CoverCache,
	type CoverStore
} from '#lib/server/covers.ts';
import { fetchGraph, groupByService, parseUsers } from '#lib/server/graph.ts';
import type { RequestHandler } from './$types';

/**
 * Cloudflare のバインディング（D1）から，サムネイルのキャッシュ設定を作る．
 * バインディングが無い環境（素の Vite など）では cache なしになる．
 */
const coverOptions = (): {
	cache?: CoverCache;
} => {
	try {
		const db = env.DB;
		if (!db) return {};
		return { cache: d1CoverCache(db) };
	} catch {
		// プリレンダリング中など，env にアクセスできない場合．
		return {};
	}
};

/**
 * R2 バインディング（COVERS）から，画像のミラー設定を作る．
 * バインディングが無い環境では mirror なしになる．
 */
const mirrorOptions = (): { mirror?: { store: CoverStore } } => {
	try {
		const bucket = env.COVERS;
		if (!bucket) return {};
		return { mirror: { store: r2CoverStore(bucket) } };
	} catch {
		return {};
	}
};

export const GET: RequestHandler = async ({ url, fetch }) => {
	const dataset = await fetchGraph(groupByService(parseUsers(url.searchParams)), {
		annictToken: ANNICT_ACCESS_TOKEN,
		fetch,
		...coverOptions(),
		...mirrorOptions()
	});
	return json(dataset, {
		headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' }
	});
};
