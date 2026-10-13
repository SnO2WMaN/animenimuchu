import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cover, CoverReport } from '#lib/graph-data.ts';
import type { AnimeLinks, Dataset } from '#lib/types.ts';
import {
	acceptCoverReports,
	applyMirror,
	buildRedirects,
	d1CoverCache,
	fillCoversFromCache,
	isMirrorPath,
	mirrorKey,
	mirrorUrl,
	normalizePublicUrl,
	r2CoverStore,
	redirectTarget,
	resetMirrorMemo,
	validateCoverReports,
	type CoverCache,
	type CoverStore
} from './covers.ts';

// --- D1 キャッシュからの補完 ---

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

const fakeCache = (initial: [number, Cover | null][] = []) => {
	const store = new Map<number, Cover | null>(initial);
	const put = vi.fn(async (entries: { malId: number; cover: Cover | null }[]) => {
		for (const e of entries) store.set(e.malId, e.cover);
	});
	const putIfAbsent = vi.fn(async (entries: { malId: number; cover: Cover }[]) => {
		let n = 0;
		for (const e of entries) {
			if (store.get(e.malId)?.url) continue;
			store.set(e.malId, e.cover);
			n++;
		}
		return n;
	});
	const get = vi.fn(async (ids: number[]) => {
		const m = new Map<number, Cover | null>();
		for (const id of ids) if (store.has(id)) m.set(id, store.get(id)!);
		return m;
	});
	return { cache: { get, put, putIfAbsent } satisfies CoverCache, put, putIfAbsent, get };
};

describe('fillCoversFromCache', () => {
	it('sets imageUrl and the AniList link from the cache', async () => {
		const { cache } = fakeCache([[1, { url: 'https://cached/1.jpg', anilistId: 1001 }]]);
		const out = await fillCoversFromCache(ds([{ id: 'anime:mal:1' }]), cache);
		expect(out.animes[0].imageUrl).toBe('https://cached/1.jpg');
		expect(out.animes[0].links.anilist).toBe('https://anilist.co/anime/1001');
	});

	it('does not mutate the input', async () => {
		const input = ds([{ id: 'anime:mal:1' }]);
		const { cache } = fakeCache([[1, { url: 'https://cached/1.jpg', anilistId: 1001 }]]);
		await fillCoversFromCache(input, cache);
		expect(input.animes[0].imageUrl).toBeNull();
		expect(input.animes[0].links.anilist).toBeNull();
	});

	it('does not touch animes that already have imageUrl and an AniList link', async () => {
		const { cache, get } = fakeCache([[1, { url: 'https://cached/1.jpg', anilistId: 1 }]]);
		const input = ds([
			{
				id: 'anime:mal:1',
				imageUrl: 'https://img/old.jpg',
				links: { anilist: 'https://anilist.co/anime/5' }
			}
		]);
		const out = await fillCoversFromCache(input, cache);
		expect(get).not.toHaveBeenCalled();
		expect(out).toBe(input);
	});

	it('keeps an existing imageUrl and fills only the link', async () => {
		const { cache } = fakeCache([[1, { url: 'https://cached/1.jpg', anilistId: 1001 }]]);
		const out = await fillCoversFromCache(
			ds([{ id: 'anime:mal:1', imageUrl: 'https://img/own.jpg', links: { annict: 'a' } }]),
			cache
		);
		expect(out.animes[0].imageUrl).toBe('https://img/own.jpg');
		expect(out.animes[0].links).toEqual({
			annict: 'a',
			mal: null,
			anilist: 'https://anilist.co/anime/1001'
		});
	});

	it('uses a cached imageless entry for the link only', async () => {
		const { cache } = fakeCache([[1, { url: null, anilistId: 77 }]]);
		const out = await fillCoversFromCache(ds([{ id: 'anime:mal:1' }]), cache);
		expect(out.animes[0].imageUrl).toBeNull();
		expect(out.animes[0].links.anilist).toBe('https://anilist.co/anime/77');
	});

	it('leaves negative cache entries, misses and non-MAL animes as they are', async () => {
		const { cache, get } = fakeCache([[1, null]]);
		const input = ds([{ id: 'anime:mal:1' }, { id: 'anime:mal:2' }, { id: 'anime:annict:7' }]);
		const out = await fillCoversFromCache(input, cache);
		expect(get.mock.calls[0][0]).toEqual([1, 2]);
		expect(out.animes).toEqual(input.animes);
	});

	it('returns the input without a cache and swallows cache errors', async () => {
		const input = ds([{ id: 'anime:mal:1' }]);
		expect(await fillCoversFromCache(input, undefined)).toBe(input);
		const cache: CoverCache = {
			get: async () => {
				throw new Error('d1 down');
			},
			put: async () => {},
			putIfAbsent: async () => 0
		};
		expect(await fillCoversFromCache(input, cache)).toBe(input);
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

describe('d1CoverCache putIfAbsent', () => {
	it('uses a conditional upsert that only overwrites imageless, legacy or expired rows', async () => {
		const { db, batches } = fakeDb();
		await d1CoverCache(db, () => NOW).putIfAbsent([
			{ malId: 1, cover: { url: 'u', anilistId: 9 } }
		]);
		const stmt = batches[0][0];
		expect(stmt.sql).toContain('ON CONFLICT(mal_id) DO UPDATE');
		expect(stmt.sql).toContain(
			'WHERE covers.url IS NULL OR covers.anilist_id IS NULL OR covers.fetched_at <= ?'
		);
		expect(stmt.params).toEqual([1, 'u', 9, NOW, NOW - 30 * DAY]);
	});

	it('returns the number of rows actually written', async () => {
		const prepare = (sql: string) => ({ bind: (...params: unknown[]) => ({ sql, params }) });
		const batch = async (stmts: { params: unknown[] }[]) =>
			stmts.map((s) => ({ meta: { changes: s.params[0] === 2 ? 0 : 1 } }));
		const db = { prepare, batch } as unknown as D1Database;
		const n = await d1CoverCache(db, () => NOW).putIfAbsent([
			{ malId: 1, cover: { url: 'a', anilistId: 1 } },
			{ malId: 2, cover: { url: 'b', anilistId: 2 } },
			{ malId: 3, cover: { url: 'c', anilistId: 3 } }
		]);
		expect(n).toBe(2);
	});

	// SQLite の ON CONFLICT ... WHERE と同じ規則を，メモリ上で再現して確認する．
	it('first write wins within the TTL, and expired/legacy/imageless rows are replaced', async () => {
		const rows = new Map<number, Row>([
			[1, { mal_id: 1, url: 'old', anilist_id: 1, fetched_at: NOW - DAY }],
			[2, { mal_id: 2, url: 'old', anilist_id: 2, fetched_at: NOW - 31 * DAY }],
			[3, { mal_id: 3, url: 'old', anilist_id: null, fetched_at: NOW - DAY }],
			[4, { mal_id: 4, url: null, anilist_id: 4, fetched_at: NOW - DAY }]
		]);
		const prepare = (_sql: string) => ({
			bind: (...p: unknown[]) => ({ params: p })
		});
		const batch = async (stmts: { params: unknown[] }[]) =>
			stmts.map(({ params: [id, url, aid, t, limit] }) => {
				const r = rows.get(id as number);
				if (r && !(r.url === null || r.anilist_id === null || r.fetched_at <= (limit as number)))
					return { meta: { changes: 0 } };
				rows.set(id as number, {
					mal_id: id as number,
					url: url as string,
					anilist_id: aid as number,
					fetched_at: t as number
				});
				return { meta: { changes: 1 } };
			});
		const db = { prepare, batch } as unknown as D1Database;
		const n = await d1CoverCache(db, () => NOW).putIfAbsent(
			[1, 2, 3, 4, 5].map((malId) => ({ malId, cover: { url: 'new', anilistId: malId } }))
		);
		expect(n).toBe(4);
		expect(rows.get(1)?.url).toBe('old');
		for (const id of [2, 3, 4, 5]) expect(rows.get(id)?.url).toBe('new');
	});
});

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

// --- ブラウザからの報告 ---

const cdn = (id: number, name = 'AbCd-_1', size = 'small', ext = 'jpg') =>
	`https://s4.anilist.co/file/anilistcdn/media/anime/cover/${size}/bx${id}-${name}.${ext}`;

const report = (malId: number, anilistId = malId + 1000): CoverReport => ({
	malId,
	anilistId,
	url: cdn(anilistId)
});

describe('validateCoverReports', () => {
	it('accepts valid reports of every size and extension', () => {
		const covers = [
			report(1),
			{ malId: 2, anilistId: 2, url: cdn(2, 'x', 'medium', 'png') },
			{ malId: 3, anilistId: 3, url: cdn(3, 'x', 'large', 'webp') },
			{ malId: 4, anilistId: 4, url: cdn(4, 'x', 'extraLarge', 'jpeg') }
		];
		expect(validateCoverReports({ covers })).toEqual(covers);
	});

	it('silently drops invalid urls, hosts and extensions', () => {
		const ok = report(1);
		const bad = [
			{ malId: 2, anilistId: 2, url: 'https://evil.example/x.jpg' },
			{
				malId: 3,
				anilistId: 3,
				url: cdn(3).replace('s4.anilist.co', 's4.anilist.co.evil.example')
			},
			{ malId: 4, anilistId: 4, url: cdn(4).replace('https', 'http') },
			{ malId: 5, anilistId: 5, url: cdn(5, 'x', 'small', 'gif') },
			{ malId: 6, anilistId: 6, url: cdn(6, 'x', 'huge') },
			{ malId: 7, anilistId: 7, url: `${cdn(7)}?x=1` },
			{ malId: 8, anilistId: 8, url: `${cdn(8)}/../x` },
			{ malId: 9, anilistId: 9, url: cdn(9, 'a.b') },
			{ malId: 10, anilistId: 10, url: 5 },
			{ malId: 11, anilistId: 11 },
			null,
			'x'
		];
		expect(validateCoverReports({ covers: [...bad, ok] })).toEqual([ok]);
	});

	it('rejects a bx id that differs from anilistId', () => {
		expect(validateCoverReports({ covers: [{ malId: 1, anilistId: 2, url: cdn(3) }] })).toEqual([]);
	});

	it('rejects out-of-range or non-integer ids', () => {
		const mk = (malId: unknown, anilistId: unknown) => ({
			malId,
			anilistId,
			url: cdn(Number(anilistId) || 1)
		});
		const covers = [
			mk(0, 1),
			mk(-1, 1),
			mk(100_000_000, 1),
			mk(1.5, 1),
			mk('1', 1),
			mk(1, 0),
			mk(1, 100_000_000),
			mk(2, 99_999_999),
			mk(99_999_999, 1)
		];
		expect(validateCoverReports({ covers }).map((r) => r.malId)).toEqual([2, 99_999_999]);
	});

	it('keeps the first of duplicate malIds', () => {
		const out = validateCoverReports({ covers: [report(1, 10), report(1, 20), report(2)] });
		expect(out.map((r) => [r.malId, r.anilistId])).toEqual([
			[1, 10],
			[2, 1002]
		]);
	});

	it('returns an empty array for malformed structures', () => {
		for (const input of [null, undefined, 1, 'x', [], {}, { covers: 'x' }, { covers: {} }])
			expect(validateCoverReports(input)).toEqual([]);
	});
});

describe('acceptCoverReports', () => {
	it('saves first-write-wins and mirrors from the stored url, not the reported one', async () => {
		const { cache, putIfAbsent } = fakeCache([[1, { url: cdn(1001, 'first'), anilistId: 1001 }]]);
		const { store, puts } = fakeStore();
		const f = okFetch();
		const accepted = await acceptCoverReports(
			[{ malId: 1, anilistId: 1001, url: cdn(1001, 'second') }, report(2)],
			{ cache, store, fetch: f }
		);
		expect(putIfAbsent).toHaveBeenCalledTimes(1);
		expect(accepted).toBe(1);
		const urls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(urls.sort()).toEqual([cdn(1001, 'first'), cdn(1002)].sort());
		expect(puts.map((p) => p.key).sort()).toEqual(['mal/1.jpg', 'mal/2.jpg']);
	});

	it('mirrors up to 30 and skips already mirrored keys', async () => {
		const { cache } = fakeCache();
		const { store, puts } = fakeStore(['mal/1.jpg']);
		const reports = Array.from({ length: 50 }, (_, i) => report(i + 1));
		await acceptCoverReports(reports, { cache, store, fetch: okFetch() });
		expect(puts).toHaveLength(30);
		expect(puts.some((p) => p.key === 'mal/1.jpg')).toBe(false);
	});

	it('hands the copy to waitUntil and works without a store', async () => {
		const { cache } = fakeCache();
		const { store } = fakeStore();
		const waitUntil = vi.fn();
		await acceptCoverReports([report(1)], { cache, store, fetch: okFetch(), waitUntil });
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await expect(acceptCoverReports([report(2)], { cache })).resolves.toBe(1);
		await expect(acceptCoverReports([], { cache })).resolves.toBe(0);
	});
});
