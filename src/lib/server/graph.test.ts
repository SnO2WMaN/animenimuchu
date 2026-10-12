import { describe, expect, it } from 'vitest';
import type { AnimeLinks } from '#lib/types.ts';
import { groupByService, MAX_USERS_PER_SERVICE, mergeResults, parseUsers } from './graph.ts';

const noLinks: AnimeLinks = { annict: null, anilist: null, mal: null };

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
