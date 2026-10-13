import { describe, expect, it, vi } from 'vitest';
import { fetchGraph, groupByService, MAX_USERS_PER_SERVICE, parseUsers } from './graph.ts';

const parse = (q: string) => parseUsers(new URLSearchParams(q));

describe('parseUsers', () => {
	it('順序を保って解釈する', () => {
		expect(parse('user=annict:tosuke,anilist:sno2wman,annict:rinsuki')).toEqual([
			{ service: 'annict', name: 'tosuke' },
			{ service: 'anilist', name: 'sno2wman' },
			{ service: 'annict', name: 'rinsuki' }
		]);
	});
	it('エンコードされた : と , も受け付ける', () => {
		expect(parse('user=annict%3Aa%2Canilist%3Ab')).toEqual([
			{ service: 'annict', name: 'a' },
			{ service: 'anilist', name: 'b' }
		]);
	});
	it('user が複数回指定されても連結する', () => {
		expect(parse('user=annict:a&user=anilist:b')).toEqual([
			{ service: 'annict', name: 'a' },
			{ service: 'anilist', name: 'b' }
		]);
	});
	it('不正なものは無視し，@・空白・大文字小文字を正規化する', () => {
		expect(parse('user=foo:bar,annict:,:x,nocolon, ANNICT: @a ,annict:A,AniList:b')).toEqual([
			{ service: 'annict', name: 'a' },
			{ service: 'anilist', name: 'b' }
		]);
	});
	it('旧形式と user 無しは空', () => {
		expect(parse('annict=tosuke&anilist=x')).toEqual([]);
		expect(parse('')).toEqual([]);
	});
	it('1 サービスあたり MAX_USERS_PER_SERVICE 人まで', () => {
		const q = Array.from({ length: 40 }, (_, i) => `annict:u${i}`).join(',');
		expect(parse(`user=${q},anilist:x`)).toHaveLength(MAX_USERS_PER_SERVICE + 1);
	});
});

describe('groupByService', () => {
	it('サービスごとに分ける', () => {
		expect(
			groupByService([
				{ service: 'annict', name: 'a' },
				{ service: 'anilist', name: 'b' },
				{ service: 'annict', name: 'c' }
			])
		).toEqual({ annict: ['a', 'c'], anilist: ['b'] });
	});
});

describe('fetchGraph', () => {
	const annictFetch = () =>
		vi.fn(async (_url: unknown, _init?: RequestInit) =>
			Response.json({
				data: {
					user: {
						username: 'tosuke',
						avatarUrl: null,
						works: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [{ annictId: 10, malAnimeId: '99', title: 'a' }]
						}
					}
				}
			})
		);

	it('Annict だけを取得し，AniList のユーザーは無視する（AniList には接続しない）', async () => {
		const f = annictFetch();
		const out = await fetchGraph(
			{ annict: ['tosuke'], anilist: ['sno2wman'] } as { annict: string[] },
			{ annictToken: 't', fetch: f as unknown as typeof fetch }
		);
		const urls = f.mock.calls.map((c) => String(c[0]));
		expect(urls.length).toBeGreaterThan(0);
		expect(urls.every((u) => u.startsWith('https://api.annict.com/'))).toBe(true);
		expect(out.users.map((u) => u.id)).toEqual(['user:annict:tosuke']);
		expect(out.errors).toEqual([]);
	});

	it('D1 のキャッシュと R2 のミラーで画像とリンクを補う（読み取りのみ）', async () => {
		const get = vi.fn(async () => new Map([[99, { url: 'https://img/99.jpg', anilistId: 7 }]]));
		const put = vi.fn();
		const putIfAbsent = vi.fn();
		const store = {
			listKeys: async () => new Set(['mal/99.jpg']),
			put: vi.fn()
		};
		const out = await fetchGraph(
			{ annict: ['tosuke'] },
			{
				annictToken: 't',
				fetch: annictFetch() as unknown as typeof fetch,
				cache: { get, put, putIfAbsent },
				mirror: { store }
			}
		);
		expect(out.animes[0].imageUrl).toBe('/img/mal/99.jpg');
		expect(out.animes[0].links.anilist).toBe('https://anilist.co/anime/7');
		expect(put).not.toHaveBeenCalled();
		expect(putIfAbsent).not.toHaveBeenCalled();
		expect(store.put).not.toHaveBeenCalled();
	});
});
