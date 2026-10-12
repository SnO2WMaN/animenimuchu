import { describe, expect, it } from 'vitest';
import { fetchFromAnilist, fetchFromAnnict } from './sources.ts';

// --- AniList ---

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
});

// --- Annict ---

const fakeFetch = (nodes: { annictId: number; malAnimeId: string | null; title: string }[]) =>
	(async () =>
		Response.json({
			data: {
				user: {
					username: 'u',
					avatarUrl: null,
					works: { pageInfo: { hasNextPage: false, endCursor: null }, nodes }
				}
			}
		})) as unknown as typeof fetch;

describe('fetchFromAnnict', () => {
	it('builds annict and mal links', async () => {
		const r = await fetchFromAnnict(
			['u'],
			'token',
			fakeFetch([
				{ annictId: 10, malAnimeId: '99', title: 'a' },
				{ annictId: 11, malAnimeId: null, title: 'b' }
			])
		);
		const byId = new Map(r.animes.map((a) => [a.id, a]));
		expect(byId.get('anime:mal:99')?.links).toEqual({
			annict: 'https://annict.com/works/10',
			anilist: null,
			mal: 'https://myanimelist.net/anime/99'
		});
		expect(byId.get('anime:annict:11')?.links).toEqual({
			annict: 'https://annict.com/works/11',
			anilist: null,
			mal: null
		});
	});
});
