import { describe, expect, it, vi } from 'vitest';
import type { AnimeLinks, Dataset, FetchResult } from '#lib/types.ts';
import {
	anilistUsersOf,
	coverReportsOf,
	enrichWithCovers,
	fetchCoversByMalId,
	fetchFromAnilist,
	loadFullDataset,
	mergeResults,
	postCoverReports,
	type CoverStorage
} from './graph-data.ts';

const noLinks: AnimeLinks = { annict: null, anilist: null, mal: null };

// --- fetchFromAnilist ---

const media = (id: number, idMal: number | null) => ({
	status: 'COMPLETED',
	media: {
		id,
		idMal,
		siteUrl: `https://anilist.co/anime/${id}`,
		title: { native: `n${id}`, romaji: null, english: null },
		coverImage: { medium: `https://img/${id}.jpg` }
	}
});

const fake = (async () =>
	Response.json({
		data: {
			MediaListCollection: {
				user: { name: 'U', siteUrl: 'https://anilist.co/user/U', avatar: null },
				lists: [{ entries: [media(1, 100), media(2, null)] }]
			}
		}
	})) as unknown as typeof fetch;

describe('fetchFromAnilist', () => {
	it('builds anilist and mal links', async () => {
		const r = await fetchFromAnilist(['u'], fake);
		const byId = new Map(r.animes.map((a) => [a.id, a]));
		expect(byId.get('anime:mal:100')?.links).toEqual({
			annict: null,
			anilist: 'https://anilist.co/anime/1',
			mal: 'https://myanimelist.net/anime/100'
		});
		expect(byId.get('anime:anilist:2')?.links).toEqual({
			annict: null,
			anilist: 'https://anilist.co/anime/2',
			mal: null
		});
	});

	it('sends only browser-safe headers to the AniList endpoint, one request per user', async () => {
		const f = vi.fn(fake as (...a: unknown[]) => Promise<Response>);
		await fetchFromAnilist(['a', 'b'], f as unknown as typeof fetch);
		expect(f).toHaveBeenCalledTimes(2);
		expect(f.mock.calls[0][0]).toBe('https://graphql.anilist.co');
		expect((f.mock.calls[0][1] as RequestInit).headers).toEqual({
			'Content-Type': 'application/json',
			Accept: 'application/json'
		});
	});

	it('collects errors per user, including HTTP 429 as Too Many Requests', async () => {
		const f = (async (_u: unknown, init?: RequestInit) => {
			const name = JSON.parse(init!.body as string).variables.userName;
			if (name === 'limited') return new Response('{}', { status: 429 });
			if (name === 'missing')
				return Response.json(
					{ data: null, errors: [{ message: 'User not found' }] },
					{ status: 404 }
				);
			return fake('' as never);
		}) as unknown as typeof fetch;
		const r = await fetchFromAnilist(['ok', 'limited', 'missing'], f);
		expect(r.users).toHaveLength(1);
		expect(r.errors).toHaveLength(2);
		expect(r.errors[0].message).toContain('Too Many Requests');
		expect(r.errors[1]).toMatchObject({ username: 'missing', message: 'User not found' });
	});

	it('returns an empty result without requests for no users', async () => {
		const f = vi.fn();
		const r = await fetchFromAnilist([], f as unknown as typeof fetch);
		expect(r).toEqual({ users: [], animes: [], statuses: [], errors: [] });
		expect(f).not.toHaveBeenCalled();
	});
});

// --- fetchCoversByMalId ---

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

describe('fetchCoversByMalId', () => {
	it('returns found, missing and imageless entries', async () => {
		const { f } = fakeFetch({ 1: 'https://img/1.jpg', 2: null });
		const r = await fetchCoversByMalId([1, 2, 3], f);
		expect(r.found.get(1)).toEqual({ url: 'https://img/1.jpg', anilistId: 1001 });
		expect(r.found.get(2)).toEqual({ url: null, anilistId: 1002 });
		expect(r.missing).toEqual([3]);
		expect(r.failed).toBe(false);
	});

	it('splits ids into batches of 50 and dedups', async () => {
		const { f, calls } = fakeFetch({});
		const ids = Array.from({ length: 120 }, (_, i) => (i % 100) + 1);
		await fetchCoversByMalId(ids, f);
		expect(calls.map((c) => c.length).sort((a, b) => b - a)).toEqual([50, 50]);
	});

	it('looks up at most 20 batches (1000 ids) and runs 4 at a time', async () => {
		let running = 0;
		let peak = 0;
		const f = vi.fn(async () => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, 1));
			running--;
			return Response.json({ data: { Page: { media: [] } } });
		});
		const ids = Array.from({ length: 1500 }, (_, i) => i + 1);
		const r = await fetchCoversByMalId(ids, f as unknown as typeof fetch);
		expect(f).toHaveBeenCalledTimes(20);
		expect(peak).toBe(4);
		expect(r.missing).toHaveLength(1000);
	});

	it('marks 429, errors and invalid JSON as failed without found/missing', async () => {
		for (const res of [
			() => new Response('{}', { status: 429 }),
			() => Response.json({ errors: [{ message: 'x' }] }),
			() => new Response('not json'),
			() => Response.json({ data: { Page: {} } })
		]) {
			const r = await fetchCoversByMalId([1], (async () => res()) as unknown as typeof fetch);
			expect(r).toEqual({ found: new Map(), missing: [], failed: true });
		}
		const rejecting = (async () => {
			throw new Error('network');
		}) as unknown as typeof fetch;
		expect((await fetchCoversByMalId([1], rejecting)).failed).toBe(true);
	});
});

describe('mergeResults', () => {
	it('merges animes across services by id and counts sizes', () => {
		const merged = mergeResults([
			{
				users: [{ id: 'user:annict:a', service: 'annict', name: 'a', avatarUrl: null, url: '' }],
				animes: [
					{
						id: 'anime:mal:1',
						title: 'アニメ',
						imageUrl: null,
						links: { ...noLinks, annict: 'annict' }
					}
				],
				statuses: [{ userId: 'user:annict:a', animeId: 'anime:mal:1', status: 'WATCHED' }],
				errors: []
			},
			{
				users: [{ id: 'user:anilist:b', service: 'anilist', name: 'b', avatarUrl: null, url: '' }],
				animes: [
					{
						id: 'anime:mal:1',
						title: 'Anime',
						imageUrl: 'https://img/1.jpg',
						links: { ...noLinks, anilist: 'anilist' }
					},
					{ id: 'anime:anilist:2', title: 'Other', imageUrl: null, links: noLinks }
				],
				statuses: [
					{ userId: 'user:anilist:b', animeId: 'anime:mal:1', status: 'WATCHING' },
					{ userId: 'user:anilist:b', animeId: 'anime:anilist:2', status: 'WATCHED' },
					{ userId: 'user:anilist:b', animeId: 'anime:anilist:2', status: 'WATCHING' }
				],
				errors: [{ service: 'anilist', username: 'c', message: 'Not Found.' }]
			}
		]);

		expect(merged.animes).toEqual([
			{
				id: 'anime:mal:1',
				title: 'アニメ',
				imageUrl: 'https://img/1.jpg',
				links: { annict: 'annict', anilist: 'anilist', mal: null },
				size: 2
			},
			{ id: 'anime:anilist:2', title: 'Other', imageUrl: null, links: noLinks, size: 1 }
		]);
		expect(merged.users.map((u) => [u.id, u.size])).toEqual([
			['user:annict:a', 1],
			['user:anilist:b', 2]
		]);
		expect(merged.statuses).toHaveLength(3);
		expect(merged.statuses.find((s) => s.animeId === 'anime:anilist:2')?.status).toBe('WATCHING');
		expect(merged.errors).toHaveLength(1);
	});
});

describe('mergeResults imageUrl', () => {
	const anime = (imageUrl: string | null, title: string) => ({
		id: 'anime:mal:1',
		title,
		imageUrl,
		links: noLinks
	});
	const result = (a: ReturnType<typeof anime>) => ({
		users: [],
		animes: [a],
		statuses: [],
		errors: []
	});

	it('fills a null imageUrl from a later result but keeps the first title', () => {
		const merged = mergeResults([
			result(anime(null, 'first')),
			result(anime('https://img/x.jpg', 'second'))
		]);
		expect(merged.animes).toEqual([
			{ id: 'anime:mal:1', title: 'first', imageUrl: 'https://img/x.jpg', links: noLinks, size: 0 }
		]);
	});
	it('keeps the first imageUrl when both have one', () => {
		const merged = mergeResults([
			result(anime('https://img/a.jpg', 'a')),
			result(anime('https://img/b.jpg', 'b'))
		]);
		expect(merged.animes[0].imageUrl).toBe('https://img/a.jpg');
	});
});

describe('mergeResults links', () => {
	const withLinks = (links: AnimeLinks) => ({
		users: [],
		animes: [{ id: 'anime:mal:1', title: 't', imageUrl: null, links }],
		statuses: [],
		errors: []
	});

	it('merges links per key, preferring the first non-null value', () => {
		const merged = mergeResults([
			withLinks({ annict: 'annict1', anilist: null, mal: 'mal1' }),
			withLinks({ annict: 'annict2', anilist: 'anilist2', mal: null })
		]);
		expect(merged.animes[0].links).toEqual({
			annict: 'annict1',
			anilist: 'anilist2',
			mal: 'mal1'
		});
	});
});

// --- coverReportsOf ---

const CDN = (n: number) =>
	`https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx${n}-abc.jpg`;

const a = (id: string, imageUrl: string | null, anilist: string | null = null) => ({
	id,
	title: id,
	imageUrl,
	links: { ...noLinks, anilist },
	size: 1
});

describe('coverReportsOf', () => {
	it('extracts MAL animes with an AniList CDN image and an AniList page', () => {
		const out = coverReportsOf({
			animes: [
				a('anime:mal:10', CDN(110), 'https://anilist.co/anime/110'),
				a('anime:anilist:5', CDN(5), 'https://anilist.co/anime/5'),
				a('anime:mal:11', '/img/mal/11.jpg', 'https://anilist.co/anime/111'),
				a('anime:mal:12', 'https://evil.example/x.jpg', 'https://anilist.co/anime/112'),
				a('anime:mal:13', CDN(113), null),
				a('anime:mal:14', CDN(114), 'https://anilist.co/anime/114/extra'),
				a('anime:mal:15', null, 'https://anilist.co/anime/115')
			]
		});
		expect(out).toEqual([{ malId: 10, anilistId: 110, url: CDN(110) }]);
	});
});

// --- enrichWithCovers ---

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const key = (n: number) => `animenimuchu:cover:${n}`;

const memStorage = (initial: Record<string, string> = {}) => {
	const m = new Map(Object.entries(initial));
	const storage: CoverStorage = {
		getItem: (k) => m.get(k) ?? null,
		setItem: (k, v) => void m.set(k, v)
	};
	return { storage, m };
};

const ds = (
	animes: { id: string; imageUrl?: string | null; links?: Partial<AnimeLinks> }[]
): Dataset => ({
	users: [],
	animes: animes.map((x) => ({
		id: x.id,
		title: x.id,
		imageUrl: x.imageUrl ?? null,
		links: { ...noLinks, ...x.links },
		size: 1
	})),
	statuses: [],
	errors: []
});

describe('enrichWithCovers', () => {
	const opts = (f: typeof fetch, storage: CoverStorage | null) => ({
		fetch: f,
		storage,
		now: () => NOW
	});

	it('sets imageUrl and the AniList link, reports them, and saves to storage', async () => {
		const { f } = fakeFetch({ 1: CDN(1001), 2: null });
		const { storage, m } = memStorage();
		const input = ds([{ id: 'anime:mal:1' }, { id: 'anime:mal:2' }, { id: 'anime:mal:3' }]);
		const out = await enrichWithCovers(input, opts(f, storage));
		expect(out.dataset.animes.map((x) => x.imageUrl)).toEqual([CDN(1001), null, null]);
		expect(out.dataset.animes.map((x) => x.links.anilist)).toEqual([
			'https://anilist.co/anime/1001',
			'https://anilist.co/anime/1002',
			null
		]);
		expect(out.reports).toEqual([{ malId: 1, anilistId: 1001, url: CDN(1001) }]);
		expect(input.animes[0].imageUrl).toBeNull();
		expect(JSON.parse(m.get(key(1))!)).toEqual({ url: CDN(1001), anilistId: 1001, t: NOW });
		expect(JSON.parse(m.get(key(2))!)).toEqual({ url: null, anilistId: 1002, t: NOW });
		expect(JSON.parse(m.get(key(3))!)).toEqual({ url: null, anilistId: null, t: NOW });
	});

	it('only fills what is null', async () => {
		const { f } = fakeFetch({ 1: CDN(1001) });
		const out = await enrichWithCovers(
			ds([{ id: 'anime:mal:1', imageUrl: '/img/mal/1.jpg', links: { mal: 'm' } }]),
			opts(f, null)
		);
		expect(out.dataset.animes[0].imageUrl).toBe('/img/mal/1.jpg');
		expect(out.dataset.animes[0].links).toEqual({
			annict: null,
			mal: 'm',
			anilist: 'https://anilist.co/anime/1001'
		});
	});

	it('does not look up complete animes or animes without a MAL id', async () => {
		const { f, calls } = fakeFetch({});
		const input = ds([
			{ id: 'anime:mal:1', imageUrl: 'x', links: { anilist: 'https://anilist.co/anime/1' } },
			{ id: 'anime:annict:7' }
		]);
		const out = await enrichWithCovers(input, opts(f, null));
		expect(calls).toEqual([]);
		expect(out.dataset).toBe(input);
		expect(out.reports).toEqual([]);
	});

	it('uses valid storage entries without fetching and without reporting them', async () => {
		const { f, calls } = fakeFetch({ 3: CDN(1003) });
		const { storage } = memStorage({
			[key(1)]: JSON.stringify({ url: CDN(1001), anilistId: 1001, t: NOW - 29 * DAY }),
			[key(2)]: JSON.stringify({ url: null, anilistId: null, t: NOW - 2 * DAY })
		});
		const out = await enrichWithCovers(
			ds([{ id: 'anime:mal:1' }, { id: 'anime:mal:2' }, { id: 'anime:mal:3' }]),
			opts(f, storage)
		);
		expect(calls).toEqual([[3]]);
		expect(out.dataset.animes[0].imageUrl).toBe(CDN(1001));
		expect(out.reports.map((r) => r.malId)).toEqual([3]);
	});

	it('does not fetch at all when everything is cached', async () => {
		const { f, calls } = fakeFetch({});
		const { storage } = memStorage({
			[key(1)]: JSON.stringify({ url: CDN(1001), anilistId: 1001, t: NOW })
		});
		const out = await enrichWithCovers(ds([{ id: 'anime:mal:1' }]), opts(f, storage));
		expect(calls).toEqual([]);
		expect(out.reports).toEqual([]);
		expect(out.dataset.animes[0].imageUrl).toBe(CDN(1001));
	});

	it('treats expired, broken and legacy entries as misses', async () => {
		const { f, calls } = fakeFetch({});
		const { storage } = memStorage({
			[key(1)]: JSON.stringify({ url: 'u', anilistId: 1, t: NOW - 31 * DAY }),
			[key(2)]: JSON.stringify({ url: null, anilistId: null, t: NOW - 4 * DAY }),
			[key(3)]: '{broken',
			[key(4)]: JSON.stringify({ url: 'u', anilistId: null, t: NOW }),
			[key(5)]: JSON.stringify({ url: 'u', anilistId: 5 })
		});
		await enrichWithCovers(
			ds([1, 2, 3, 4, 5].map((n) => ({ id: `anime:mal:${n}` }))),
			opts(f, storage)
		);
		expect(calls.flat().sort()).toEqual([1, 2, 3, 4, 5]);
	});

	it('does not save failed batches', async () => {
		const { f } = fakeFetch({}, 429);
		const { storage, m } = memStorage();
		const input = ds([{ id: 'anime:mal:1' }]);
		const out = await enrichWithCovers(input, opts(f, storage));
		expect(m.size).toBe(0);
		expect(out.dataset.animes).toEqual(input.animes);
		expect(out.reports).toEqual([]);
	});

	it('does not throw when fetch rejects, storage is null or setItem throws', async () => {
		const rejecting = (async () => {
			throw new Error('network');
		}) as unknown as typeof fetch;
		const input = ds([{ id: 'anime:mal:1' }]);
		expect((await enrichWithCovers(input, opts(rejecting, null))).dataset.animes).toEqual(
			input.animes
		);

		const { f } = fakeFetch({ 1: CDN(1001) });
		const broken: CoverStorage = {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('quota');
			}
		};
		const out = await enrichWithCovers(input, opts(f, broken));
		expect(out.dataset.animes[0].imageUrl).toBe(CDN(1001));
		const out2 = await enrichWithCovers(input, opts(f, null));
		expect(out2.dataset.animes[0].imageUrl).toBe(CDN(1001));
	});
});

// --- loadFullDataset ---

describe('loadFullDataset', () => {
	const server: Dataset = {
		users: [
			{ id: 'user:annict:a', service: 'annict', name: 'a', avatarUrl: null, url: '', size: 1 }
		],
		animes: [{ id: 'anime:mal:1', title: 'one', imageUrl: null, links: noLinks, size: 1 }],
		statuses: [{ userId: 'user:annict:a', animeId: 'anime:mal:1', status: 'WATCHED' }],
		errors: []
	};

	const router = (calls: string[]) =>
		(async (_u: unknown, init?: RequestInit) => {
			const body = JSON.parse(init!.body as string);
			if (body.variables.userName !== undefined) {
				calls.push(`user:${body.variables.userName}`);
				if (body.variables.userName === 'bad')
					return Response.json(
						{ data: null, errors: [{ message: 'User not found' }] },
						{ status: 404 }
					);
				return Response.json({
					data: {
						MediaListCollection: {
							user: { name: 'u', siteUrl: 'https://anilist.co/user/u', avatar: null },
							lists: [
								{
									entries: [
										{
											status: 'CURRENT',
											media: {
												id: 502,
												idMal: 2,
												siteUrl: 'https://anilist.co/anime/502',
												title: { native: 'two', romaji: null, english: null },
												coverImage: { medium: CDN(502) }
											}
										}
									]
								}
							]
						}
					}
				});
			}
			calls.push(`covers:${body.variables.ids.join(',')}`);
			const media = body.variables.ids.map((id: number) => ({
				id: id + 1000,
				idMal: id,
				coverImage: { medium: CDN(id + 1000) }
			}));
			return Response.json({ data: { Page: { media } } });
		}) as unknown as typeof fetch;

	it('merges server data and AniList users, fills covers and dedups reports', async () => {
		const calls: string[] = [];
		const out = await loadFullDataset(
			{ server, anilistUsers: ['u'] },
			{ fetch: router(calls), storage: null, now: () => NOW }
		);
		expect(out.dataset.users.map((u) => u.id)).toEqual(['user:annict:a', 'user:anilist:u']);
		expect(out.dataset.animes.map((x) => [x.id, x.imageUrl])).toEqual([
			['anime:mal:1', CDN(1001)],
			['anime:mal:2', CDN(502)]
		]);
		expect(calls).toEqual(['user:u', 'covers:1']);
		expect(out.reports.map((r) => [r.malId, r.anilistId]).sort()).toEqual([
			[1, 1001],
			[2, 502]
		]);
	});

	it('keeps server data and records AniList failures in errors', async () => {
		const out = await loadFullDataset(
			{ server, anilistUsers: ['bad'] },
			{ fetch: router([]), storage: null, now: () => NOW }
		);
		expect(out.dataset.users.map((u) => u.id)).toEqual(['user:annict:a']);
		expect(out.dataset.errors).toEqual([
			{ service: 'anilist', username: 'bad', message: 'User not found' }
		]);
		expect(out.dataset.animes.map((x) => x.id)).toEqual(['anime:mal:1']);
	});

	it('works with no server data and no AniList users', async () => {
		const f = vi.fn();
		const out = await loadFullDataset(
			{ server: null, anilistUsers: [] },
			{ fetch: f as unknown as typeof fetch, storage: null }
		);
		expect(f).not.toHaveBeenCalled();
		expect(out.dataset).toEqual({
			users: [],
			animes: [],
			statuses: [],
			errors: []
		} satisfies FetchResult);
		expect(out.reports).toEqual([]);
	});
});

// --- postCoverReports ---

describe('postCoverReports', () => {
	it('posts in chunks of 100 and swallows errors', async () => {
		const f = vi.fn(async (_u: unknown, _i?: RequestInit) => {
			throw new Error('offline');
		});
		const reports = Array.from({ length: 250 }, (_, i) => ({
			malId: i + 1,
			anilistId: i + 1,
			url: CDN(i + 1)
		}));
		await postCoverReports(reports, f as unknown as typeof fetch);
		expect(f).toHaveBeenCalledTimes(3);
		expect(f.mock.calls[0][0]).toBe('/api/covers');
		expect(JSON.parse(f.mock.calls[2][1]!.body as string).covers).toHaveLength(50);
	});
});

describe('anilistUsersOf', () => {
	it('AniList のユーザー名だけを順序を保って取り出す', () => {
		expect(
			anilistUsersOf([
				{ service: 'annict', name: 'a' },
				{ service: 'anilist', name: 'x' },
				{ service: 'anilist', name: 'y' }
			])
		).toEqual(['x', 'y']);
		expect(anilistUsersOf([])).toEqual([]);
	});
});
