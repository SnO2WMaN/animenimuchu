import type { Service } from '#lib/query.ts';
import type { Anime, Dataset, FetchResult, Status, User } from '#lib/types.ts';
import {
	applyMirrored,
	fillCovers,
	listMirrored,
	scheduleMirror,
	type CoverCache,
	type CoverStore
} from './covers.ts';
import { fetchFromAnilist, fetchFromAnnict } from './sources.ts';

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
 * 複数サービスの取得結果を 1 つのグラフにまとめる．
 * 同じ作品は ID（主に MAL の ID）で同一視し，先に出てきた方のタイトルを使う．
 * 画像とリンクは，先に出てきたものが null なら後から来たもので補う（リンクはキーごと）．
 * 同じユーザー・作品の組に複数の状態があれば WATCHING を優先する．
 */
export const mergeResults = (results: FetchResult[]): Dataset => {
	const users = new Map<string, User>();
	const animes = new Map<string, Anime>();
	const statuses = new Map<string, Status>();

	for (const r of results) {
		for (const u of r.users) if (!users.has(u.id)) users.set(u.id, u);
		for (const a of r.animes) {
			const prev = animes.get(a.id);
			if (!prev) animes.set(a.id, a);
			else
				animes.set(a.id, {
					...prev,
					imageUrl: prev.imageUrl ?? a.imageUrl,
					links: {
						annict: prev.links.annict ?? a.links.annict,
						anilist: prev.links.anilist ?? a.links.anilist,
						mal: prev.links.mal ?? a.links.mal
					}
				});
		}
		for (const s of r.statuses) {
			const key = `${s.userId}\u0000${s.animeId}`;
			const prev = statuses.get(key);
			if (!prev || (prev.status === 'WATCHED' && s.status === 'WATCHING')) statuses.set(key, s);
		}
	}

	const userSize = new Map<string, number>();
	const animeSize = new Map<string, number>();
	for (const { userId, animeId } of statuses.values()) {
		userSize.set(userId, (userSize.get(userId) ?? 0) + 1);
		animeSize.set(animeId, (animeSize.get(animeId) ?? 0) + 1);
	}

	return {
		users: [...users.values()].map((u) => ({ ...u, size: userSize.get(u.id) ?? 0 })),
		animes: [...animes.values()].map((a) => ({ ...a, size: animeSize.get(a.id) ?? 0 })),
		statuses: [...statuses.values()],
		errors: results.flatMap((r) => r.errors)
	};
};

export const fetchGraph = async (
	params: { annict: string[]; anilist: string[] },
	options: {
		annictToken: string | undefined;
		fetch?: typeof fetch;
		cache?: CoverCache;
		mirror?: { store: CoverStore };
		waitUntil?: (p: Promise<unknown>) => void;
	}
): Promise<Dataset> => {
	// Annict の方がタイトルが日本語で揃っているので先に並べる．
	const results = await Promise.all([
		fetchFromAnnict(params.annict, options.annictToken, options.fetch),
		fetchFromAnilist(params.anilist, options.fetch)
	]);
	const merged = mergeResults(results);
	const { mirror } = options;
	// ミラー済みの作品は先に R2 の URL に置き換える（AniList の逆引き対象が減り，API が失敗しても表示できる）．
	const keys = mirror ? await listMirrored(mirror.store) : new Set<string>();
	const mirrored = mirror ? applyMirrored(merged, keys) : merged;
	// 画像の無い MAL ID 付きの作品は AniList から逆引きする（失敗してもグラフ本体は返す）．
	const filled = await fillCovers(mirrored, {
		cache: options.cache,
		fetch: options.fetch,
		waitUntil: options.waitUntil
	});
	// 未ミラーのものを背景で R2 にコピーする．
	if (mirror)
		await scheduleMirror(filled, keys, {
			store: mirror.store,
			fetch: options.fetch,
			waitUntil: options.waitUntil
		});
	return filled;
};
