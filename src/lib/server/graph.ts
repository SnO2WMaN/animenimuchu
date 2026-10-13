import type { Service } from '#lib/query.ts';
import { mergeResults } from '#lib/graph-data.ts';
import type { Dataset } from '#lib/types.ts';
import {
	applyMirrored,
	fillCoversFromCache,
	listMirrored,
	type CoverCache,
	type CoverStore
} from './covers.ts';
import { fetchFromAnnict } from './sources.ts';

/** 1 サービスあたりに受け付けるユーザー数の上限 */
export const MAX_USERS_PER_SERVICE = 30;

/**
 * `user` パラメータ（`annict:a,anilist:b`，複数回の指定も可）をユーザーの配列にする．
 * 不明なサービス・`:` の無いもの・名前が空のものは無視する．先頭の `@` と前後の空白は除く．
 * 同一サービス・同一名（大文字小文字は区別しない）の重複はまとめ，1 サービスあたり MAX_USERS_PER_SERVICE 人まで．
 */
export const parseUsers = (searchParams: URLSearchParams): { service: Service; name: string }[] => {
	const users: { service: Service; name: string }[] = [];
	const seen = new Set<string>();
	const counts: Record<Service, number> = { annict: 0, anilist: 0 };
	for (const raw of searchParams.getAll('user')) {
		for (const item of raw.split(',')) {
			const i = item.indexOf(':');
			if (i < 0) continue;
			const service = item.slice(0, i).trim().toLowerCase();
			if (service !== 'annict' && service !== 'anilist') continue;
			const name = item
				.slice(i + 1)
				.trim()
				.replace(/^@/, '')
				.trim();
			if (name.length === 0) continue;
			const key = `${service}:${name.toLowerCase()}`;
			if (seen.has(key) || counts[service] >= MAX_USERS_PER_SERVICE) continue;
			seen.add(key);
			counts[service]++;
			users.push({ service, name });
		}
	}
	return users;
};

/** ユーザーの配列を `fetchGraph` に渡すサービスごとの名前の配列にする． */
export const groupByService = (
	users: { service: Service; name: string }[]
): { annict: string[]; anilist: string[] } => ({
	annict: users.filter((u) => u.service === 'annict').map((u) => u.name),
	anilist: users.filter((u) => u.service === 'anilist').map((u) => u.name)
});

/**
 * Annict のユーザーの視聴状況を取得し，キャッシュ（D1・R2）の内容で画像とリンクを補う．
 * AniList には接続しない（AniList の API はブラウザから呼ぶ）．AniList のユーザーは無視する．
 */
export const fetchGraph = async (
	params: { annict: string[] },
	options: {
		annictToken: string | undefined;
		fetch?: typeof fetch;
		cache?: CoverCache;
		mirror?: { store: CoverStore };
	}
): Promise<Dataset> => {
	const merged = mergeResults([
		await fetchFromAnnict(params.annict, options.annictToken, options.fetch)
	]);
	// ミラー済みの作品は R2 の URL に置き換える．
	const keys = options.mirror ? await listMirrored(options.mirror.store) : new Set<string>();
	const mirrored = options.mirror ? applyMirrored(merged, keys) : merged;
	// D1 のキャッシュにある画像とリンクを補う（読み取りのみ）．
	return fillCoversFromCache(mirrored, options.cache);
};
