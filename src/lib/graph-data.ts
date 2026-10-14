// ブラウザ・サーバ・vitest のどれでも動く（サーバ専用の import を含めない）．
// AniList の API は，サーバの通信元がブロックされるため，ブラウザから直接呼ぶ．
import type { Anime, Dataset, FetchResult, Status, User, WatchStatus } from '#lib/types.ts';

// --- マージ ---

const STATUS_RANK: Record<WatchStatus, number> = { PLANNING: 0, WATCHED: 1, WATCHING: 2 };

/**
 * 複数サービスの取得結果を 1 つのグラフにまとめる．
 * 同じ作品は ID（主に MAL の ID）で同一視し，先に出てきた方のタイトルを使う．
 * 画像とリンクは，先に出てきたものが null なら後から来たもので補う（リンクはキーごと）．
 * 同じユーザー・作品の組に複数の状態があれば WATCHING，WATCHED，PLANNING の順に優先する．
 * サイズ（観ている人の数）には PLANNING を数えない．
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
			if (!prev || STATUS_RANK[s.status] > STATUS_RANK[prev.status]) statuses.set(key, s);
		}
	}

	const userSize = new Map<string, number>();
	const animeSize = new Map<string, number>();
	for (const { userId, animeId, status } of statuses.values()) {
		if (status === 'PLANNING') continue;
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

// --- AniList のユーザーの視聴状況 ---

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';

type MediaListCollection = {
	user: { name: string; avatar: { medium: string | null } | null; siteUrl: string };
	lists: {
		entries: {
			status: 'CURRENT' | 'REPEATING' | 'COMPLETED' | 'PLANNING';
			media: {
				id: number;
				idMal: number | null;
				siteUrl: string;
				title: { native: string | null; romaji: string | null; english: string | null };
				coverImage: { medium: string | null } | null;
			};
		}[];
	}[];
};

// 1 人でも存在しないユーザーが混ざると全エイリアスが null になるので，ユーザーごとにリクエストを分ける．
const ANILIST_QUERY = `
	query($userName: String) {
		MediaListCollection(userName: $userName, type: ANIME, status_in: [CURRENT, REPEATING, COMPLETED, PLANNING]) {
			user { name siteUrl avatar { medium } }
			lists {
				entries {
					status
					media { id idMal siteUrl title { native romaji english } coverImage { medium } }
				}
			}
		}
	}
`;

const ANILIST_STATUS = {
	CURRENT: 'WATCHING',
	REPEATING: 'WATCHING',
	COMPLETED: 'WATCHED',
	PLANNING: 'PLANNING'
} as const satisfies Record<
	MediaListCollection['lists'][number]['entries'][number]['status'],
	WatchStatus
>;

class AnilistError extends Error {}

const fetchCollection = async (
	username: string,
	fetcher: typeof fetch
): Promise<MediaListCollection> => {
	// ブラウザから呼ぶので，禁止ヘッダ（User-Agent など）は付けない．
	const res = await fetcher(ANILIST_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({ query: ANILIST_QUERY, variables: { userName: username } })
	});
	// 存在しないユーザーは 404 と共に errors が返るので，ステータスコードより先に本文を見る．
	const body = (await res.json().catch(() => null)) as {
		data?: { MediaListCollection: MediaListCollection | null } | null;
		errors?: { message: string }[];
	} | null;

	const collection = body?.data?.MediaListCollection;
	if (!collection) {
		const message = body?.errors?.[0]?.message;
		if (res.status === 429)
			throw new AnilistError(
				message?.includes('Too Many Requests') ? message : 'Too Many Requests'
			);
		throw new AnilistError(message ?? `HTTP ${res.status}`);
	}
	return collection;
};

export const fetchFromAnilist = async (
	usernames: string[],
	fetcher: typeof fetch = fetch
): Promise<FetchResult> => {
	const result: FetchResult = { users: [], animes: [], statuses: [], errors: [] };
	if (usernames.length === 0) return result;

	const settled = await Promise.allSettled(
		usernames.map((username) => fetchCollection(username, fetcher))
	);

	settled.forEach((s, i) => {
		if (s.status === 'rejected') {
			result.errors.push({
				service: 'anilist',
				username: usernames[i],
				message: s.reason instanceof Error ? s.reason.message : String(s.reason)
			});
			return;
		}

		const collection = s.value;
		const user: User = {
			id: `user:anilist:${collection.user.name.toLowerCase()}`,
			service: 'anilist',
			name: collection.user.name,
			avatarUrl: collection.user.avatar?.medium ?? null,
			url: collection.user.siteUrl
		};
		result.users.push(user);

		for (const { entries } of collection.lists) {
			for (const { status, media } of entries) {
				const anime: Anime = {
					id: media.idMal ? `anime:mal:${media.idMal}` : `anime:anilist:${media.id}`,
					title: media.title.native ?? media.title.romaji ?? media.title.english ?? `${media.id}`,
					imageUrl: media.coverImage?.medium ?? null,
					links: {
						annict: null,
						anilist: media.siteUrl,
						mal: media.idMal ? `https://myanimelist.net/anime/${media.idMal}` : null
					}
				};
				const s: Status = {
					userId: user.id,
					animeId: anime.id,
					status: ANILIST_STATUS[status]
				};
				result.animes.push(anime);
				result.statuses.push(s);
			}
		}
	});

	return result;
};

// --- AniList からの逆引き（MAL ID → カバー画像） ---

const BATCH_SIZE = 50;
// 訪問者の IP から叩くので，AniList のレート制限（30〜90 回/分）に収まるよう控えめにする．
const BATCH_PARALLEL = 4;
const MAX_BATCHES = 20;

const COVER_QUERY = `query ($ids: [Int], $p: Int) {
  Page(page: $p, perPage: ${BATCH_SIZE}) {
    pageInfo { hasNextPage }
    media(idMal_in: $ids, type: ANIME) { id idMal coverImage { medium } }
  }
}`;

/** AniList 上の作品．画像が無くても AniList の ID は分かる（その場合 url は null）． */
export type Cover = { url: string | null; anilistId: number };

type BatchResult = { ok: true; found: Map<number, Cover> } | { ok: false };

const fetchBatch = async (ids: number[], fetcher: typeof fetch): Promise<BatchResult> => {
	try {
		const res = await fetcher(ANILIST_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({ query: COVER_QUERY, variables: { ids, p: 1 } })
		});
		// 429 でも Retry-After は待たない．
		if (!res.ok) return { ok: false };
		const json = (await res.json()) as {
			data?: {
				Page?: {
					media?: {
						id: number;
						idMal: number | null;
						coverImage?: { medium?: string | null } | null;
					}[];
				};
			};
			errors?: unknown;
		};
		if (json.errors || !json.data?.Page || !Array.isArray(json.data.Page.media))
			return { ok: false };
		const found = new Map<number, Cover>();
		for (const m of json.data.Page.media) {
			if (typeof m.idMal === 'number' && typeof m.id === 'number')
				found.set(m.idMal, { url: m.coverImage?.medium || null, anilistId: m.id });
		}
		return { ok: true, found };
	} catch {
		return { ok: false };
	}
};

/**
 * MAL ID から AniList の作品（ID とカバー画像）を一括で引く．
 * 作品はあるが画像が無いものは found に url: null で入る．
 * 失敗したバッチの ID は found にも missing にも入らない．
 * 1 回の呼び出しで引くのは最大 MAX_BATCHES バッチ（1000 件）まで．超えた分は found にも missing にも入らない．
 */
export const fetchCoversByMalId = async (
	malIds: number[],
	fetcher: typeof fetch = fetch
): Promise<{ found: Map<number, Cover>; missing: number[]; failed: boolean }> => {
	const unique = [...new Set(malIds)];
	const batches: number[][] = [];
	for (let i = 0; i < unique.length && batches.length < MAX_BATCHES; i += BATCH_SIZE)
		batches.push(unique.slice(i, i + BATCH_SIZE));

	const found = new Map<number, Cover>();
	const missing: number[] = [];
	let failed = false;

	for (let i = 0; i < batches.length; i += BATCH_PARALLEL) {
		const results = await Promise.all(
			batches.slice(i, i + BATCH_PARALLEL).map((b) => fetchBatch(b, fetcher))
		);
		for (const [j, r] of results.entries()) {
			if (!r.ok) {
				failed = true;
				continue;
			}
			// 成功したバッチで返ってこなかった ID は，AniList に作品が無い．
			for (const id of batches[i + j]) {
				const cover = r.found.get(id);
				if (cover) found.set(id, cover);
				else missing.push(id);
			}
		}
	}
	return { found, missing, failed };
};

// --- カバー画像の報告 ---

/** クライアントが AniList から得た，作品のカバー画像の報告（サーバの共有キャッシュへ送る）． */
export type CoverReport = { malId: number; anilistId: number; url: string };

export const MAX_COVER_REPORTS = 100;

const MAL_ID = /^anime:mal:(\d+)$/;
const ANILIST_ANIME_URL = /^https:\/\/anilist\.co\/anime\/(\d+)$/;
const ANILIST_CDN = 'https://s4.anilist.co/';

/** ID が `anime:mal:<N>`，画像が AniList の CDN，リンクが AniList の作品ページである作品から報告を作る． */
export const coverReportsOf = (dataset: { animes: Anime[] }): CoverReport[] => {
	const reports: CoverReport[] = [];
	for (const a of dataset.animes) {
		const m = MAL_ID.exec(a.id);
		if (!m || a.imageUrl === null || !a.imageUrl.startsWith(ANILIST_CDN)) continue;
		const l = a.links.anilist === null ? null : ANILIST_ANIME_URL.exec(a.links.anilist);
		if (!l) continue;
		reports.push({ malId: Number(m[1]), anilistId: Number(l[1]), url: a.imageUrl });
	}
	return reports;
};

/** 報告を `/api/covers` に送る．100 件ずつに分け，失敗しても例外にしない． */
export const postCoverReports = async (
	reports: CoverReport[],
	fetcher: typeof fetch = fetch
): Promise<void> => {
	for (let i = 0; i < reports.length; i += MAX_COVER_REPORTS) {
		try {
			await fetcher('/api/covers', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ covers: reports.slice(i, i + MAX_COVER_REPORTS) })
			});
		} catch {
			// 共有キャッシュへの報告は失敗しても表示に影響しない．
		}
	}
};

// --- クライアントのキャッシュ（localStorage） ---

/** `Storage` の部分集合（テストで注入できる）． */
export type CoverStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

const DAY = 24 * 60 * 60 * 1000;
const TTL_FOUND = 30 * DAY;
const TTL_MISSING = 3 * DAY;

const storageKey = (malId: number): string => `animenimuchu:cover:${malId}`;

/** 有効なキャッシュなら Cover（作品なしの否定キャッシュは null），ミスなら undefined． */
const readStored = (
	storage: CoverStorage,
	malId: number,
	now: number
): Cover | null | undefined => {
	try {
		const raw = storage.getItem(storageKey(malId));
		if (raw === null) return undefined;
		const v = JSON.parse(raw) as { url?: unknown; anilistId?: unknown; t?: unknown } | null;
		if (typeof v !== 'object' || v === null || typeof v.t !== 'number') return undefined;
		const url = v.url;
		const anilistId = v.anilistId;
		if (url !== null && typeof url !== 'string') return undefined;
		if (anilistId !== null && typeof anilistId !== 'number') return undefined;
		if (now - v.t >= (url === null ? TTL_MISSING : TTL_FOUND)) return undefined;
		if (anilistId === null) return url === null ? null : undefined;
		return { url, anilistId };
	} catch {
		return undefined;
	}
};

const writeStored = (
	storage: CoverStorage,
	malId: number,
	cover: Cover | null,
	now: number
): void => {
	try {
		storage.setItem(
			storageKey(malId),
			JSON.stringify({ url: cover?.url ?? null, anilistId: cover?.anilistId ?? null, t: now })
		);
	} catch {
		// 容量超過やプライベートモードなど．キャッシュ無しで続行する．
	}
};

const defaultStorage = (): CoverStorage | null => {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
};

type EnrichOptions = {
	fetch?: typeof fetch;
	/** 省略すると localStorage．null ならキャッシュを使わない． */
	storage?: CoverStorage | null;
	now?: () => number;
};

/**
 * MAL ID 付きで画像または AniList のリンクが無い作品に，AniList から逆引きしたサムネイルと作品ページを付ける．
 * 入力は変更しない．失敗しても例外にせず，入力をそのまま返す．
 * reports は今回 AniList の API から新しく得た画像（localStorage から復元したものは含めない）．
 */
export const enrichWithCovers = async (
	dataset: Dataset,
	options: EnrichOptions = {}
): Promise<{ dataset: Dataset; reports: CoverReport[] }> => {
	const targets = new Set<number>();
	for (const a of dataset.animes) {
		if (a.imageUrl !== null && a.links.anilist !== null) continue;
		const m = MAL_ID.exec(a.id);
		if (m) targets.add(Number(m[1]));
	}
	if (targets.size === 0) return { dataset, reports: [] };

	const storage = options.storage === undefined ? defaultStorage() : options.storage;
	const now = (options.now ?? Date.now)();

	const covers = new Map<number, Cover | null>();
	if (storage) {
		for (const id of targets) {
			const c = readStored(storage, id, now);
			if (c !== undefined) covers.set(id, c);
		}
	}

	const reports: CoverReport[] = [];
	const uncached = [...targets].filter((id) => !covers.has(id));
	if (uncached.length > 0) {
		try {
			const { found, missing } = await fetchCoversByMalId(uncached, options.fetch);
			for (const [malId, cover] of found) {
				covers.set(malId, cover);
				if (storage) writeStored(storage, malId, cover, now);
				if (cover.url !== null) reports.push({ malId, anilistId: cover.anilistId, url: cover.url });
			}
			for (const malId of missing) {
				covers.set(malId, null);
				if (storage) writeStored(storage, malId, null, now);
			}
		} catch {
			// 失敗してもグラフ本体は返す．
		}
	}

	return {
		dataset: {
			...dataset,
			animes: dataset.animes.map((a) => {
				const m = MAL_ID.exec(a.id);
				const cover = m ? covers.get(Number(m[1])) : null;
				if (!cover) return a;
				const imageUrl = a.imageUrl ?? cover.url;
				const anilist = a.links.anilist ?? `https://anilist.co/anime/${cover.anilistId}`;
				if (imageUrl === a.imageUrl && anilist === a.links.anilist) return a;
				return { ...a, imageUrl, links: { ...a.links, anilist } };
			})
		},
		reports
	};
};

/**
 * サーバのデータ（無ければ null）と AniList のユーザーの視聴状況をマージし，カバー画像を補う．
 * AniList のユーザーの取得エラーは dataset.errors に入る．
 * reports は，サーバの共有キャッシュへ送る価値のある（今回 AniList から得た）画像．
 */
export const loadFullDataset = async (
	input: { server: Dataset | null; anilistUsers: string[] },
	options: EnrichOptions = {}
): Promise<{ dataset: Dataset; reports: CoverReport[] }> => {
	const anilist = await fetchFromAnilist(input.anilistUsers, options.fetch);
	const server: FetchResult = input.server ?? { users: [], animes: [], statuses: [], errors: [] };
	const merged = mergeResults([server, anilist]);
	const enriched = await enrichWithCovers(merged, options);

	const reports = new Map<number, CoverReport>();
	for (const r of [...coverReportsOf(anilist), ...enriched.reports])
		if (!reports.has(r.malId)) reports.set(r.malId, r);
	return { dataset: enriched.dataset, reports: [...reports.values()] };
};

/** ユーザー指定の配列から，AniList のユーザー名だけを順序を保って取り出す． */
export const anilistUsersOf = (users: { service: string; name: string }[]): string[] =>
	users.filter((u) => u.service === 'anilist').map((u) => u.name);
