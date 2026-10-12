import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnimeLinks, Dataset } from '#lib/types.ts';
import {
	applyMirror,
	buildRedirects,
	d1CoverCache,
	fillCovers,
	isMirrorPath,
	mirrorKey,
	mirrorUrl,
	normalizePublicUrl,
	r2CoverStore,
	redirectTarget,
	resetMirrorMemo,
	type Cover,
	type CoverCache,
	type CoverStore
} from './covers.ts';

// --- AniList からの逆引き ---

const ds = (
	animes: { id: string; imageUrl?: string | null; links?: Partial<AnimeLinks> }[]
): Dataset => ({
	users: [],
	animes: animes.map((a) => ({
		id: a.id,
		title: a.id,
		imageUrl: a.imageUrl ?? null,
		links: { annict: null, anilist: null, mal: null, ...a.links },
		size: 1
	})),
	statuses: [],
	errors: []
});

/** AniList を模す fake fetch．images に無い ID は返さない．AniList の ID は MAL ID + 1000．値が null なら画像なし． */
const fakeFetch = (images: Record<number, string | null>, status = 200) => {
	const calls: number[][] = [];
	const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const ids = JSON.parse(init!.body as string).variables.ids as number[];
		calls.push(ids);
		if (status !== 200) return new Response('{}', { status });
		const media = ids
			.filter((id) => id in images)
			.map((id) => ({
				id: id + 1000,
				idMal: id,
				coverImage: images[id] === null ? null : { medium: images[id] }
			}));
		return Response.json({ data: { Page: { pageInfo: { hasNextPage: false }, media } } });
	});
	return { f: f as unknown as typeof fetch, calls };
};

const fakeCache = (initial: [number, Cover | null][] = []) => {
	const store = new Map<number, Cover | null>(initial);
	const put = vi.fn(async (entries: { malId: number; cover: Cover | null }[]) => {
		for (const e of entries) store.set(e.malId, e.cover);
	});
	const get = vi.fn(async (ids: number[]) => {
		const m = new Map<number, Cover | null>();
		for (const id of ids) if (store.has(id)) m.set(id, store.get(id)!);
		return m;
	});
	return { cache: { get, put } satisfies CoverCache, put, get };
};

describe('fillCovers', () => {
	it('sets imageUrl from AniList', async () => {
		const { f } = fakeFetch({ 1: 'https://img/1.jpg' });
		const out = await fillCovers(ds([{ id: 'anime:mal:1' }]), { fetch: f });
		expect(out.animes[0].imageUrl).toBe('https://img/1.jpg');
	});

	it('does not mutate the input', async () => {
		const input = ds([{ id: 'anime:mal:1' }]);
		const { f } = fakeFetch({ 1: 'https://img/1.jpg' });
		await fillCovers(input, { fetch: f });
		expect(input.animes[0].imageUrl).toBeNull();
	});

	it('does not look up animes that already have imageUrl and an AniList link', async () => {
		const { f, calls } = fakeFetch({ 1: 'https://img/new.jpg' });
		const out = await fillCovers(
			ds([
				{
					id: 'anime:mal:1',
					imageUrl: 'https://img/old.jpg',
					links: { anilist: 'https://anilist.co/anime/5' }
				}
			]),
			{
				fetch: f
			}
		);
		expect(calls).toEqual([]);
		expect(out.animes[0].imageUrl).toBe('https://img/old.jpg');
	});

	it('does not fetch cache hits', async () => {
		const { f, calls } = fakeFetch({ 2: 'https://img/2.jpg' });
		const { cache } = fakeCache([[1, { url: 'https://cached/1.jpg', anilistId: 1001 }]]);
		const out = await fillCovers(ds([{ id: 'anime:mal:1' }, { id: 'anime:mal:2' }]), {
			fetch: f,
			cache
		});
		expect(calls).toEqual([[2]]);
		expect(out.animes.map((a) => a.imageUrl)).toEqual([
			'https://cached/1.jpg',
			'https://img/2.jpg'
		]);
	});

	it('treats a negative cache entry as a hit', async () => {
		const { f, calls } = fakeFetch({ 1: 'https://img/1.jpg' });
		const { cache, put } = fakeCache([[1, null]]);
		const out = await fillCovers(ds([{ id: 'anime:mal:1' }]), { fetch: f, cache });
		expect(calls).toEqual([]);
		expect(put).not.toHaveBeenCalled();
		expect(out.animes[0].imageUrl).toBeNull();
	});

	it('splits more than 50 ids into multiple requests', async () => {
		const { f, calls } = fakeFetch({});
		const animes = Array.from({ length: 120 }, (_, i) => ({ id: `anime:mal:${i + 1}` }));
		await fillCovers(ds(animes), { fetch: f });
		expect(calls.map((c) => c.length).sort((a, b) => b - a)).toEqual([50, 50, 20]);
	});

	it('does not cache failed batches and returns the graph intact', async () => {
		const { f } = fakeFetch({}, 429);
		const { cache, put } = fakeCache();
		const input = ds([{ id: 'anime:mal:1' }, { id: 'anime:annict:5' }]);
		const out = await fillCovers(input, { fetch: f, cache });
		expect(put).not.toHaveBeenCalled();
		expect(out.animes).toEqual(input.animes);
	});

	it('does not throw when fetch rejects', async () => {
		const f = (async () => {
			throw new Error('network');
		}) as unknown as typeof fetch;
		const input = ds([{ id: 'anime:mal:1' }]);
		expect((await fillCovers(input, { fetch: f })).animes).toEqual(input.animes);
	});

	it('puts found urls and null for missing ids', async () => {
		const { f } = fakeFetch({ 1: 'https://img/1.jpg' });
		const { cache, put } = fakeCache();
		await fillCovers(ds([{ id: 'anime:mal:1' }, { id: 'anime:mal:2' }]), { fetch: f, cache });
		expect(put).toHaveBeenCalledTimes(1);
		expect(put.mock.calls[0][0]).toEqual(
			expect.arrayContaining([
				{ malId: 1, cover: { url: 'https://img/1.jpg', anilistId: 1001 } },
				{ malId: 2, cover: null }
			])
		);
		expect(put.mock.calls[0][0]).toHaveLength(2);
	});

	it('ignores animes without a MAL id', async () => {
		const { f, calls } = fakeFetch({});
		const out = await fillCovers(ds([{ id: 'anime:annict:7' }]), { fetch: f });
		expect(calls).toEqual([]);
		expect(out.animes[0].imageUrl).toBeNull();
	});

	it('hands put to waitUntil without awaiting it', async () => {
		const { f } = fakeFetch({ 1: 'https://img/1.jpg' });
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const put = vi.fn(() => gate);
		const cache: CoverCache = { get: async () => new Map(), put };
		const waitUntil = vi.fn();
		const out = await fillCovers(ds([{ id: 'anime:mal:1' }]), { fetch: f, cache, waitUntil });
		expect(out.animes[0].imageUrl).toBe('https://img/1.jpg');
		expect(put).toHaveBeenCalledTimes(1);
		expect(waitUntil).toHaveBeenCalledTimes(1);
		release();
	});

	it('swallows put errors', async () => {
		const { f } = fakeFetch({ 1: 'https://img/1.jpg' });
		const cache: CoverCache = {
			get: async () => new Map(),
			put: async () => {
				throw new Error('d1 down');
			}
		};
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const out = await fillCovers(ds([{ id: 'anime:mal:1' }]), { fetch: f, cache });
		expect(out.animes[0].imageUrl).toBe('https://img/1.jpg');
		spy.mockRestore();
	});

	it('sets links.anilist, and also when imageUrl already exists', async () => {
		const { f } = fakeFetch({ 1: 'https://img/1.jpg', 2: 'https://img/2.jpg' });
		const out = await fillCovers(
			ds([{ id: 'anime:mal:1' }, { id: 'anime:mal:2', imageUrl: 'https://img/own.jpg' }]),
			{ fetch: f }
		);
		expect(out.animes[0].links.anilist).toBe('https://anilist.co/anime/1001');
		expect(out.animes[1].imageUrl).toBe('https://img/own.jpg');
		expect(out.animes[1].links.anilist).toBe('https://anilist.co/anime/1002');
	});

	it('keeps other links untouched', async () => {
		const { f } = fakeFetch({ 1: 'https://img/1.jpg' });
		const out = await fillCovers(ds([{ id: 'anime:mal:1', links: { annict: 'a', mal: 'm' } }]), {
			fetch: f
		});
		expect(out.animes[0].links).toEqual({
			annict: 'a',
			mal: 'm',
			anilist: 'https://anilist.co/anime/1001'
		});
	});

	it('sets links.anilist even when AniList has no image', async () => {
		const { f } = fakeFetch({ 1: null });
		const { cache, put } = fakeCache();
		const out = await fillCovers(ds([{ id: 'anime:mal:1' }]), { fetch: f, cache });
		expect(out.animes[0].imageUrl).toBeNull();
		expect(out.animes[0].links.anilist).toBe('https://anilist.co/anime/1001');
		expect(put.mock.calls[0][0]).toEqual([{ malId: 1, cover: { url: null, anilistId: 1001 } }]);
	});

	it('uses a cached imageless entry for the link without fetching', async () => {
		const { f, calls } = fakeFetch({});
		const { cache } = fakeCache([[1, { url: null, anilistId: 77 }]]);
		const out = await fillCovers(ds([{ id: 'anime:mal:1' }]), { fetch: f, cache });
		expect(calls).toEqual([]);
		expect(out.animes[0].links.anilist).toBe('https://anilist.co/anime/77');
	});
});

// --- D1 キャッシュ ---

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

type Row = { mal_id: number; url: string | null; anilist_id: number | null; fetched_at: number };

const fakeDb = (rows: Row[] = []) => {
	const selects: { sql: string; params: unknown[] }[] = [];
	const batches: { sql: string; params: unknown[] }[][] = [];
	const prepare = (sql: string) => ({
		bind: (...params: unknown[]) => ({
			sql,
			params,
			all: async () => {
				selects.push({ sql, params });
				return { results: rows.filter((r) => params.includes(r.mal_id)) };
			}
		})
	});
	const batch = async (stmts: { sql: string; params: unknown[] }[]) => {
		batches.push(stmts.map((s) => ({ sql: s.sql, params: s.params })));
		return [];
	};
	return { db: { prepare, batch } as unknown as D1Database, selects, batches };
};

describe('d1CoverCache', () => {
	it('splits get into chunks of 90', async () => {
		const { db, selects } = fakeDb();
		const ids = Array.from({ length: 200 }, (_, i) => i + 1);
		await d1CoverCache(db, () => NOW).get(ids);
		expect(selects.map((s) => s.params.length)).toEqual([90, 90, 20]);
		expect(selects[0].sql).toContain('WHERE mal_id IN (');
	});

	it('expires found after 30 days and missing after 3 days', async () => {
		const { db } = fakeDb([
			{ mal_id: 1, url: 'u1', anilist_id: 101, fetched_at: NOW - 29 * DAY },
			{ mal_id: 2, url: 'u2', anilist_id: 102, fetched_at: NOW - 31 * DAY },
			{ mal_id: 3, url: null, anilist_id: null, fetched_at: NOW - 2 * DAY },
			{ mal_id: 4, url: null, anilist_id: null, fetched_at: NOW - 4 * DAY }
		]);
		const got = await d1CoverCache(db, () => NOW).get([1, 2, 3, 4, 5]);
		expect([...got.entries()]).toEqual([
			[1, { url: 'u1', anilistId: 101 }],
			[3, null]
		]);
	});

	it('treats legacy rows (url set, anilist_id NULL) as cache misses', async () => {
		const { db } = fakeDb([{ mal_id: 1, url: 'u1', anilist_id: null, fetched_at: NOW - DAY }]);
		const got = await d1CoverCache(db, () => NOW).get([1]);
		expect(got.size).toBe(0);
	});

	it('distinguishes an imageless AniList entry from a negative cache entry', async () => {
		const { db } = fakeDb([
			{ mal_id: 1, url: null, anilist_id: 101, fetched_at: NOW - DAY },
			{ mal_id: 2, url: null, anilist_id: null, fetched_at: NOW - DAY }
		]);
		const got = await d1CoverCache(db, () => NOW).get([1, 2]);
		expect(got.get(1)).toEqual({ url: null, anilistId: 101 });
		expect(got.get(2)).toBeNull();
	});

	it('puts in batches of 90 with upsert', async () => {
		const { db, batches } = fakeDb();
		const entries = Array.from({ length: 100 }, (_, i) => ({ malId: i + 1, cover: null }));
		await d1CoverCache(db, () => NOW).put(entries);
		expect(batches.map((b) => b.length)).toEqual([90, 10]);
		expect(batches[0][0].sql).toContain('ON CONFLICT(mal_id) DO UPDATE');
		expect(batches[0][0].sql).toContain('anilist_id=excluded.anilist_id');
		expect(batches[0][0].params).toEqual([1, null, null, NOW]);
	});

	it('puts url and anilist_id', async () => {
		const { db, batches } = fakeDb();
		await d1CoverCache(db, () => NOW).put([
			{ malId: 1, cover: { url: 'u', anilistId: 9 } },
			{ malId: 2, cover: { url: null, anilistId: 8 } }
		]);
		expect(batches[0].map((b) => b.params)).toEqual([
			[1, 'u', 9, NOW],
			[2, null, 8, NOW]
		]);
	});
});

// --- R2 ミラー ---

const AL = (n: number) => `https://s4.anilist.co/file/${n}.jpg`;

const anime = (id: string, imageUrl: string | null) => ({
	id,
	title: id,
	imageUrl,
	links: { annict: null, anilist: null, mal: null },
	size: 1
});

const dataset = (animes: ReturnType<typeof anime>[]): Dataset => ({
	users: [],
	animes,
	statuses: [],
	errors: []
});

const fakeStore = (
	initial: string[] = [],
	opts: { listFails?: boolean; putFails?: number[] } = {}
) => {
	const keys = new Set(initial);
	const puts: { key: string; contentType: string }[] = [];
	const store: CoverStore = {
		listKeys: async () => {
			if (opts.listFails) throw new Error('list failed');
			return new Set(keys);
		},
		put: async (key, _body, contentType) => {
			if (opts.putFails?.some((n) => key === mirrorKey(n))) throw new Error('put failed');
			keys.add(key);
			puts.push({ key, contentType });
		}
	};
	return { store, puts };
};

const okFetch = (init: { type?: string; length?: string; size?: number; ok?: boolean } = {}) =>
	vi.fn(async (_url: unknown) => {
		const headers: Record<string, string> = { 'content-type': init.type ?? 'image/jpeg' };
		if (init.length) headers['content-length'] = init.length;
		return new Response(new Uint8Array(init.size ?? 10), {
			status: init.ok === false ? 429 : 200,
			headers
		});
	}) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

beforeEach(() => {
	resetMirrorMemo();
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('helpers', () => {
	it('builds key and url, trimming trailing slashes', () => {
		expect(mirrorKey(5)).toBe('mal/5.jpg');
		expect(mirrorUrl(5)).toBe('/img/mal/5.jpg');
	});

	it('isMirrorPath accepts only mal/<digits>.jpg', () => {
		expect(isMirrorPath('mal/123.jpg')).toBe(true);
		for (const p of [
			'mal/abc.jpg',
			'x',
			'mal/1.png',
			'mal/1.jpg/x',
			'../mal/1.jpg',
			'mal/.jpg',
			''
		])
			expect(isMirrorPath(p)).toBe(false);
	});
});

describe('applyMirror', () => {
	it('replaces imageUrl of mirrored works, even when null', async () => {
		const { store } = fakeStore(['mal/1.jpg', 'mal/2.jpg']);
		const input = dataset([anime('anime:mal:1', null), anime('anime:mal:2', AL(2))]);
		const out = await applyMirror(input, { store, fetch: okFetch() });
		expect(out.animes.map((a) => a.imageUrl)).toEqual(['/img/mal/1.jpg', '/img/mal/2.jpg']);
		expect(input.animes[0].imageUrl).toBeNull();
	});

	it('copies only unmirrored works with an AniList url, up to limit', async () => {
		const { store, puts } = fakeStore(['mal/1.jpg']);
		const f = okFetch();
		const input = dataset([
			anime('anime:mal:1', AL(1)),
			anime('anime:mal:2', AL(2)),
			anime('anime:mal:3', null),
			anime('anime:mal:4', AL(4)),
			anime('anime:mal:5', AL(5))
		]);
		const out = await applyMirror(input, { store, fetch: f, limit: 2 });
		expect(puts.map((p) => p.key).sort()).toEqual(['mal/2.jpg', 'mal/4.jpg']);
		expect(f).toHaveBeenCalledTimes(2);
		expect(puts[0].contentType).toBe('image/jpeg');
		// 今回コピーしたものも，この応答では元の URL のまま（次回からミラー）．
		expect(out.animes[1].imageUrl).toBe(AL(2));
		expect(out.animes[0].imageUrl).toBe('/img/mal/1.jpg');
	});

	it('skips disallowed hosts, non-images and oversized bodies', async () => {
		const bad = [
			{ url: 'https://evil.example/a.jpg', f: okFetch() },
			{ url: 'http://s4.anilist.co/a.jpg', f: okFetch() },
			{ url: 'not a url', f: okFetch() },
			{ url: AL(1), f: okFetch({ type: 'text/html' }) },
			{ url: AL(1), f: okFetch({ length: String(600 * 1024) }) },
			{ url: AL(1), f: okFetch({ size: 600 * 1024 }) },
			{ url: AL(1), f: okFetch({ ok: false }) }
		];
		for (const { url, f } of bad) {
			const { store, puts } = fakeStore();
			await applyMirror(dataset([anime('anime:mal:1', url)]), { store, fetch: f });
			expect(puts).toEqual([]);
		}
	});

	it('does not let one failure affect others', async () => {
		const { store, puts } = fakeStore([], { putFails: [2] });
		const f = vi.fn(async (u: unknown) => {
			if (String(u).includes('/3.')) throw new Error('network');
			return new Response(new Uint8Array(5), { headers: { 'content-type': 'image/png' } });
		}) as unknown as typeof fetch;
		await applyMirror(
			dataset([
				anime('anime:mal:1', AL(1)),
				anime('anime:mal:2', AL(2)),
				anime('anime:mal:3', AL(3)),
				anime('anime:mal:4', AL(4))
			]),
			{ store, fetch: f }
		);
		expect(puts.map((p) => p.key).sort()).toEqual(['mal/1.jpg', 'mal/4.jpg']);
	});

	it('hands the copy to waitUntil without awaiting it', async () => {
		const { store, puts } = fakeStore();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const f = vi.fn(async () => {
			await gate;
			return new Response(new Uint8Array(5), { headers: { 'content-type': 'image/jpeg' } });
		}) as unknown as typeof fetch;
		const waited: Promise<unknown>[] = [];
		await applyMirror(dataset([anime('anime:mal:1', AL(1))]), {
			store,
			fetch: f,
			waitUntil: (p) => void waited.push(p)
		});
		expect(waited).toHaveLength(1);
		expect(puts).toEqual([]);
		release();
		await waited[0];
		expect(puts).toHaveLength(1);
	});

	it('keeps original imageUrl when listKeys fails', async () => {
		const { store, puts } = fakeStore(['mal/1.jpg'], { listFails: true });
		const out = await applyMirror(dataset([anime('anime:mal:1', AL(1))]), {
			store,
			fetch: okFetch()
		});
		expect(out.animes[0].imageUrl).toBe(AL(1));
		expect(console.error).toHaveBeenCalled();
		// ミラーは無かったものとして続行する．
		expect(puts).toHaveLength(1);
	});

	it('ignores works without MAL id', async () => {
		const { store, puts } = fakeStore(['mal/1.jpg']);
		const f = okFetch();
		const input = dataset([anime('anime:annict:1', AL(1)), anime('anime:anilist:1', null)]);
		const out = await applyMirror(input, { store, fetch: f });
		expect(out.animes.map((a) => a.imageUrl)).toEqual([AL(1), null]);
		expect(f).not.toHaveBeenCalled();
		expect(puts).toEqual([]);
	});

	it('does nothing without a store', async () => {
		const input = dataset([anime('anime:mal:1', AL(1))]);
		const out = await applyMirror(input, {});
		expect(out.animes[0].imageUrl).toBe(AL(1));
	});
});

describe('r2CoverStore', () => {
	const fakeBucket = (pages: string[][]) => {
		const calls: { prefix?: string; cursor?: string }[] = [];
		const puts: { key: string; options: unknown }[] = [];
		const bucket = {
			list: async (o: { prefix?: string; cursor?: string }) => {
				calls.push(o);
				const i = o.cursor ? Number(o.cursor) : 0;
				return {
					objects: pages[i].map((key) => ({ key })),
					truncated: i < pages.length - 1,
					cursor: String(i + 1)
				};
			},
			put: async (key: string, _b: unknown, options: unknown) => void puts.push({ key, options })
		} as unknown as R2Bucket;
		return { bucket, calls, puts };
	};

	it('follows pages until not truncated', async () => {
		const { bucket, calls } = fakeBucket([['mal/1.jpg'], ['mal/2.jpg'], ['mal/3.jpg']]);
		const keys = await r2CoverStore(bucket).listKeys();
		expect([...keys]).toEqual(['mal/1.jpg', 'mal/2.jpg', 'mal/3.jpg']);
		expect(calls.map((c) => c.cursor)).toEqual([undefined, '1', '2']);
		expect(calls.every((c) => c.prefix === 'mal/')).toBe(true);
	});

	it('memoizes for 60 seconds and records puts', async () => {
		const { bucket, calls, puts } = fakeBucket([['mal/1.jpg']]);
		let t = 1000;
		const store = r2CoverStore(bucket, () => t);
		await store.listKeys();
		t += 59_000;
		await store.put('mal/9.jpg', new ArrayBuffer(1), 'image/webp');
		expect(calls).toHaveLength(1);
		expect(puts[0].options).toEqual({
			httpMetadata: {
				contentType: 'image/webp',
				cacheControl: 'public, max-age=31536000, immutable'
			}
		});
		expect([...(await store.listKeys())].sort()).toEqual(['mal/1.jpg', 'mal/9.jpg']);
		expect(calls).toHaveLength(1);
		t += 2000;
		await store.listKeys();
		expect(calls).toHaveLength(2);
	});
});

// --- リダイレクト ---

describe('normalizePublicUrl', () => {
	it('末尾のスラッシュを除く', () => {
		expect(normalizePublicUrl('https://pub-x.r2.dev/')).toBe('https://pub-x.r2.dev');
		expect(normalizePublicUrl('https://x.example/a//')).toBe('https://x.example/a');
	});
	it('不正な値は null', () => {
		expect(normalizePublicUrl(undefined)).toBeNull();
		expect(normalizePublicUrl('')).toBeNull();
		expect(normalizePublicUrl('not a url')).toBeNull();
		expect(normalizePublicUrl('/img')).toBeNull();
		expect(normalizePublicUrl('ftp://x.example')).toBeNull();
		expect(normalizePublicUrl('javascript:alert(1)')).toBeNull();
		expect(normalizePublicUrl('https://x.example/?a=1')).toBeNull();
	});
});

describe('redirectTarget', () => {
	it('base と path をつなぐ', () => {
		expect(redirectTarget('https://x.example', 'mal/1.jpg')).toBe('https://x.example/mal/1.jpg');
		expect(redirectTarget('https://x.example/', 'mal/1.jpg')).toBe('https://x.example/mal/1.jpg');
		expect(redirectTarget('http://localhost:9999/ok', 'mal/1.jpg')).toBe(
			'http://localhost:9999/ok/mal/1.jpg'
		);
	});
	it('未設定・不正は null', () => {
		expect(redirectTarget(undefined, 'mal/1.jpg')).toBeNull();
		expect(redirectTarget('nope', 'mal/1.jpg')).toBeNull();
	});
});

describe('buildRedirects', () => {
	it('有効な URL', () => {
		expect(buildRedirects('https://pub-x.r2.dev')).toBe('/img/* https://pub-x.r2.dev/:splat 302\n');
	});
	it('末尾のスラッシュ', () => {
		expect(buildRedirects('https://x.example/')).toBe('/img/* https://x.example/:splat 302\n');
	});
	it('不正・未設定は null', () => {
		expect(buildRedirects('nope')).toBeNull();
		expect(buildRedirects(undefined)).toBeNull();
	});
});
