import { describe, expect, it } from 'vitest';
import { fetchFromAnnict } from './sources.ts';

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
