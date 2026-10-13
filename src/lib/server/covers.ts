import type { Cover, CoverReport } from '#lib/graph-data.ts';
import type { Dataset } from '#lib/types.ts';

export type CoverCache = {
	/** 有効期限内のものだけを返す．Map に無ければ未キャッシュ，値が null なら否定キャッシュ（AniList に作品が無い）． */
	get(malIds: number[]): Promise<Map<number, Cover | null>>;
	/** 無条件に上書きする． */
	put(entries: { malId: number; cover: Cover | null }[]): Promise<void>;
	/**
	 * 先勝ち．画像つきの有効期限内の行が既にある malId は上書きしない．保存した件数を返す．
	 * 行が無い・期限切れ・旧形式（anilist_id が NULL）・画像なしの行は上書きする．
	 */
	putIfAbsent(entries: { malId: number; cover: Cover }[]): Promise<number>;
};

const MAL_ID = /^anime:mal:(\d+)$/;

/** D1 キャッシュだけを使い，MAL ID 付きで画像または AniList のリンクが無い作品を補う（AniList には接続しない）．入力は変更しない． */
export const fillCoversFromCache = async (
	dataset: Dataset,
	cache: CoverCache | undefined
): Promise<Dataset> => {
	if (!cache) return dataset;
	const targets = new Set<number>();
	for (const a of dataset.animes) {
		if (a.imageUrl !== null && a.links.anilist !== null) continue;
		const m = MAL_ID.exec(a.id);
		if (m) targets.add(Number(m[1]));
	}
	if (targets.size === 0) return dataset;

	let covers: Map<number, Cover | null>;
	try {
		covers = await cache.get([...targets]);
	} catch (e) {
		console.error('cover cache get failed', e);
		return dataset;
	}

	return {
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
	};
};

// --- D1 キャッシュ ---

const CHUNK = 90;
const DAY = 24 * 60 * 60 * 1000;
/** 画像があるものの有効期限 */
export const TTL_FOUND = 30 * DAY;
/** 画像が無いもの・否定キャッシュ（url が null）の有効期限 */
export const TTL_MISSING = 3 * DAY;

const chunks = <T>(xs: T[]): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
	return out;
};

export const d1CoverCache = (db: D1Database, now: () => number = () => Date.now()): CoverCache => ({
	async get(malIds) {
		const result = new Map<number, Cover | null>();
		const t = now();
		for (const ids of chunks([...new Set(malIds)])) {
			const { results } = await db
				.prepare(
					`SELECT mal_id, url, anilist_id, fetched_at FROM covers WHERE mal_id IN (${ids.map(() => '?').join(',')})`
				)
				.bind(...ids)
				.all<{
					mal_id: number;
					url: string | null;
					anilist_id: number | null;
					fetched_at: number;
				}>();
			for (const r of results) {
				// anilist_id が NULL で url がある行は旧形式．リンクが作れないのでミス扱いにして再取得させる．
				if (r.anilist_id === null && r.url !== null) continue;
				const ttl = r.url === null ? TTL_MISSING : TTL_FOUND;
				if (t - r.fetched_at >= ttl) continue;
				// anilist_id が NULL で url も NULL なら否定キャッシュ（AniList に作品が無い）．
				result.set(
					r.mal_id,
					r.anilist_id === null ? null : { url: r.url, anilistId: r.anilist_id }
				);
			}
		}
		return result;
	},
	async put(entries) {
		const t = now();
		const sql =
			'INSERT INTO covers (mal_id, url, anilist_id, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(mal_id) DO UPDATE SET url=excluded.url, anilist_id=excluded.anilist_id, fetched_at=excluded.fetched_at';
		for (const part of chunks(entries)) {
			await db.batch(
				part.map((e) =>
					db.prepare(sql).bind(e.malId, e.cover?.url ?? null, e.cover?.anilistId ?? null, t)
				)
			);
		}
	},
	async putIfAbsent(entries) {
		const t = now();
		// 既存の行が，画像なし・旧形式・期限切れのときだけ上書きする．
		const sql =
			'INSERT INTO covers (mal_id, url, anilist_id, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(mal_id) DO UPDATE SET url=excluded.url, anilist_id=excluded.anilist_id, fetched_at=excluded.fetched_at WHERE covers.url IS NULL OR covers.anilist_id IS NULL OR covers.fetched_at <= ?';
		let saved = 0;
		for (const part of chunks(entries)) {
			const results = await db.batch(
				part.map((e) =>
					db.prepare(sql).bind(e.malId, e.cover.url, e.cover.anilistId, t, t - TTL_FOUND)
				)
			);
			for (const r of results) saved += r.meta?.changes ?? 0;
		}
		return saved;
	}
});

// --- R2 ミラー ---

/** ミラーした画像の保存先と配信元の設定 */
export type CoverStore = {
	/** ミラー済みの key（`mal/<id>.jpg`）の集合 */
	listKeys(): Promise<Set<string>>;
	put(key: string, body: ArrayBuffer | ReadableStream, contentType: string): Promise<void>;
};

const ALLOWED_HOST = 's4.anilist.co';
const MAX_BYTES = 500 * 1024;
const COPY_PARALLEL = 6;
const DEFAULT_LIMIT = 30;
const LIST_TTL_MS = 60_000;

export const mirrorKey = (malId: number): string => `mal/${malId}.jpg`;

/** 画像の URL は常にこのアプリの同一オリジンの `/img/…`（保存先は外から見えない）． */
export const MIRROR_BASE = '/img';

export const mirrorUrl = (malId: number): string => `${MIRROR_BASE}/${mirrorKey(malId)}`;

/** `/img/*` ルートで配信を許可するパス（`mal/<数字>.jpg`）か． */
export const isMirrorPath = (path: string): boolean => /^mal\/\d+\.jpg$/.test(path);

// list は Class A 操作なので，同じ isolate 内で 60 秒メモ化する．
let listMemo: { keys: Set<string>; at: number } | null = null;

/** テスト用にメモを捨てる． */
export const resetMirrorMemo = (): void => {
	listMemo = null;
};

/** R2 バケットから CoverStore を作る． */
export const r2CoverStore = (bucket: R2Bucket, now: () => number = Date.now): CoverStore => ({
	async listKeys() {
		if (listMemo && now() - listMemo.at < LIST_TTL_MS) return new Set(listMemo.keys);
		const keys = new Set<string>();
		let cursor: string | undefined;
		for (;;) {
			const res = await bucket.list({ prefix: 'mal/', cursor });
			for (const o of res.objects) keys.add(o.key);
			if (!res.truncated) break;
			cursor = res.cursor;
		}
		listMemo = { keys, at: now() };
		return new Set(keys);
	},
	async put(key, body, contentType) {
		await bucket.put(key, body, {
			httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' }
		});
		listMemo?.keys.add(key);
	}
});

const malIdOf = (id: string): number | null => {
	const m = MAL_ID.exec(id);
	return m ? Number(m[1]) : null;
};

/** ミラー済みの作品の imageUrl をミラーの URL に置き換える（元が null でも設定する）．入力は変更しない． */
export const applyMirrored = (dataset: Dataset, keys: Set<string>): Dataset => {
	let changed = false;
	const animes = dataset.animes.map((a) => {
		const id = malIdOf(a.id);
		if (id === null || !keys.has(mirrorKey(id))) return a;
		const imageUrl = mirrorUrl(id);
		if (imageUrl === a.imageUrl) return a;
		changed = true;
		return { ...a, imageUrl };
	});
	return changed ? { ...dataset, animes } : dataset;
};

/** 失敗しても例外にせず，ミラー済みの key の集合を返す（失敗は空）． */
export const listMirrored = async (store: CoverStore | undefined): Promise<Set<string>> => {
	if (!store) return new Set();
	try {
		return await store.listKeys();
	} catch (e) {
		console.error('mirror listKeys failed', e);
		return new Set();
	}
};

const isAllowedSource = (raw: string): boolean => {
	try {
		const u = new URL(raw);
		return u.protocol === 'https:' && u.hostname === ALLOWED_HOST;
	} catch {
		return false;
	}
};

const copyOne = async (
	store: CoverStore,
	fetcher: typeof fetch,
	malId: number,
	url: string
): Promise<void> => {
	try {
		const res = await fetcher(url);
		if (!res.ok) return;
		const contentType = res.headers.get('content-type');
		if (!contentType?.startsWith('image/')) return;
		const length = res.headers.get('content-length');
		if (length !== null && Number(length) > MAX_BYTES) return;
		const body = await res.arrayBuffer();
		if (body.byteLength > MAX_BYTES) return;
		await store.put(mirrorKey(malId), body, contentType);
	} catch (e) {
		console.error('mirror copy failed', malId, e);
	}
};

/**
 * 未ミラーで AniList の画像 URL がある作品を，最大 limit 件まで R2 にコピーする．
 * waitUntil があれば背景で行い，待たない．
 */
export const scheduleMirror = async (
	dataset: Dataset,
	keys: Set<string>,
	options: {
		store?: CoverStore;
		fetch?: typeof fetch;
		waitUntil?: (p: Promise<unknown>) => void;
		limit?: number;
	}
): Promise<void> => {
	const store = options.store;
	if (!store) return;
	const limit = options.limit ?? DEFAULT_LIMIT;
	const targets: { malId: number; url: string }[] = [];
	const seen = new Set<number>();
	for (const a of dataset.animes) {
		if (targets.length >= limit) break;
		const malId = malIdOf(a.id);
		if (malId === null || seen.has(malId) || keys.has(mirrorKey(malId))) continue;
		if (a.imageUrl === null || !isAllowedSource(a.imageUrl)) continue;
		seen.add(malId);
		targets.push({ malId, url: a.imageUrl });
	}
	if (targets.length === 0) return;

	const fetcher = options.fetch ?? fetch;
	const run = async () => {
		let next = 0;
		const worker = async () => {
			while (next < targets.length) {
				const t = targets[next++];
				await copyOne(store, fetcher, t.malId, t.url);
			}
		};
		await Promise.all(Array.from({ length: Math.min(COPY_PARALLEL, targets.length) }, worker));
	};
	const p = run();
	if (options.waitUntil) options.waitUntil(p);
	else await p;
};

/** applyMirrored と scheduleMirror をまとめたもの． */
export const applyMirror = async (
	dataset: Dataset,
	options: {
		store?: CoverStore;
		fetch?: typeof fetch;
		waitUntil?: (p: Promise<unknown>) => void;
		limit?: number;
	}
): Promise<Dataset> => {
	const keys = await listMirrored(options.store);
	await scheduleMirror(dataset, keys, options);
	return applyMirrored(dataset, keys);
};

// --- `/img` のリダイレクト（bun のスクリプトからも使うので cloudflare:workers を import しない） ---

/** `COVERS_PUBLIC_URL` を検証して正規化する（http/https の URL のみ．末尾のスラッシュは除く）．不正なら null． */
export const normalizePublicUrl = (raw: string | undefined): string | null => {
	if (!raw) return null;
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		return null;
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
	if (u.search || u.hash) return null;
	return u.href.replace(/\/+$/, '');
};

/** `/img/<path>` のリダイレクト先（`<base>/<path>`）．base が未設定・不正なら null． */
export const redirectTarget = (base: string | undefined, path: string): string | null => {
	const normalized = normalizePublicUrl(base);
	if (normalized === null) return null;
	return `${normalized}/${path.replace(/^\/+/, '')}`;
};

/** Cloudflare Pages の `_redirects` の内容．base が未設定・不正なら null（ファイルを作らない）． */
export const buildRedirects = (base: string | undefined): string | null => {
	const normalized = normalizePublicUrl(base);
	if (normalized === null) return null;
	return `/img/* ${normalized}/:splat 302\n`;
};

// --- ブラウザからのカバー画像の報告 ---

const MAX_ID = 99_999_999;
const REPORT_URL =
	/^https:\/\/s4\.anilist\.co\/file\/anilistcdn\/media\/anime\/cover\/(?:small|medium|large|extraLarge)\/bx(\d+)-[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/;

const isId = (v: unknown): v is number =>
	typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_ID;

/**
 * `{ covers: [...] }` の本文を検証する．不正な要素は黙って捨て，構造が不正なら空配列．
 * 同じ malId の重複は先勝ち．
 */
export const validateCoverReports = (input: unknown): CoverReport[] => {
	if (typeof input !== 'object' || input === null) return [];
	const covers = (input as { covers?: unknown }).covers;
	if (!Array.isArray(covers)) return [];
	const out: CoverReport[] = [];
	const seen = new Set<number>();
	for (const c of covers) {
		if (typeof c !== 'object' || c === null) continue;
		const { malId, anilistId, url } = c as Record<string, unknown>;
		if (!isId(malId) || !isId(anilistId) || typeof url !== 'string') continue;
		const m = REPORT_URL.exec(url);
		if (!m || Number(m[1]) !== anilistId || seen.has(malId)) continue;
		seen.add(malId);
		out.push({ malId, anilistId, url });
	}
	return out;
};

/**
 * 検証済みの報告を D1 に先勝ちで保存し，R2 に無いものを背景でミラーする．保存した件数を返す．
 * ミラーのコピー元は，報告の URL ではなく，先勝ちで D1 に残っている URL を使う．
 */
export const acceptCoverReports = async (
	reports: CoverReport[],
	options: {
		cache: CoverCache;
		store?: CoverStore;
		fetch?: typeof fetch;
		waitUntil?: (p: Promise<unknown>) => void;
		limit?: number;
	}
): Promise<number> => {
	if (reports.length === 0) return 0;
	const accepted = await options.cache.putIfAbsent(
		reports.map((r) => ({ malId: r.malId, cover: { url: r.url, anilistId: r.anilistId } }))
	);
	if (options.store) {
		const stored = await options.cache.get(reports.map((r) => r.malId));
		const animes = [...stored].flatMap(([malId, cover]) =>
			cover?.url
				? [
						{
							id: `anime:mal:${malId}`,
							title: '',
							imageUrl: cover.url,
							links: { annict: null, anilist: null, mal: null },
							size: 0
						}
					]
				: []
		);
		const keys = await listMirrored(options.store);
		await scheduleMirror({ users: [], animes, statuses: [], errors: [] }, keys, options);
	}
	return accepted;
};
