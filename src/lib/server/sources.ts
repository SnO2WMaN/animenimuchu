import type { Anime, FetchError, FetchResult, Status, User, WatchStatus } from '#lib/types.ts';

// --- AniList ---

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';

type MediaListCollection = {
	user: { name: string; avatar: { medium: string | null } | null; siteUrl: string };
	lists: {
		entries: {
			status: 'CURRENT' | 'REPEATING' | 'COMPLETED';
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
		MediaListCollection(userName: $userName, type: ANIME, status_in: [CURRENT, REPEATING, COMPLETED]) {
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

class AnilistError extends Error {}

const fetchCollection = async (
	username: string,
	fetcher: typeof fetch
): Promise<MediaListCollection> => {
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
	if (!collection) throw new AnilistError(body?.errors?.[0]?.message ?? `HTTP ${res.status}`);
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
					status: status === 'COMPLETED' ? 'WATCHED' : 'WATCHING'
				};
				result.animes.push(anime);
				result.statuses.push(s);
			}
		}
	});

	return result;
};

// --- Annict ---

const ANNICT_ENDPOINT = 'https://api.annict.com/graphql';

// graphql-ruby は max_page_size を超える first を黙って切り詰めるので，大きめに指定してページングで取り切る．
const PAGE_SIZE = 1000;

const ANNICT_QUERY = `
	query($username: String!, $state: StatusState!, $after: String) {
		user(username: $username) {
			username
			avatarUrl
			works(state: $state, first: ${PAGE_SIZE}, after: $after) {
				pageInfo { hasNextPage endCursor }
				nodes { annictId malAnimeId title }
			}
		}
	}
`;

type Work = { annictId: number; malAnimeId: string | null; title: string };

type UserResponse = {
	username: string;
	avatarUrl: string | null;
	works: {
		pageInfo: { hasNextPage: boolean; endCursor: string | null };
		nodes: Work[];
	};
};

class AnnictError extends Error {}

const fetchWorks = async (
	username: string,
	state: WatchStatus,
	token: string,
	fetcher: typeof fetch
): Promise<{ user: Omit<UserResponse, 'works'>; works: Work[] }> => {
	const works: Work[] = [];
	let after: string | null = null;
	for (;;) {
		const res = await fetcher(ANNICT_ENDPOINT, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				Accept: 'application/json'
			},
			body: JSON.stringify({ query: ANNICT_QUERY, variables: { username, state, after } })
		});
		if (!res.ok) throw new AnnictError(`HTTP ${res.status}`);

		const body = (await res.json()) as {
			data?: { user: UserResponse | null } | null;
			errors?: { message: string }[];
		};
		if (body.errors?.length) throw new AnnictError(body.errors[0].message);

		const user = body.data?.user;
		if (!user) throw new AnnictError('User not found');

		works.push(...user.works.nodes);
		if (!user.works.pageInfo.hasNextPage || !user.works.pageInfo.endCursor) {
			return { user: { username: user.username, avatarUrl: user.avatarUrl }, works };
		}
		after = user.works.pageInfo.endCursor;
	}
};

export const fetchFromAnnict = async (
	usernames: string[],
	token: string | undefined,
	fetcher: typeof fetch = fetch
): Promise<FetchResult> => {
	const result: FetchResult = { users: [], animes: [], statuses: [], errors: [] };
	if (usernames.length === 0) return result;

	if (!token) {
		result.errors.push(
			...usernames.map((username): FetchError => ({
				service: 'annict',
				username,
				message: 'ANNICT_ACCESS_TOKEN is not configured'
			}))
		);
		return result;
	}

	const settled = await Promise.allSettled(
		usernames.map(async (username) => {
			const [watching, watched] = await Promise.all([
				fetchWorks(username, 'WATCHING', token, fetcher),
				fetchWorks(username, 'WATCHED', token, fetcher)
			]);
			return { username, watching, watched };
		})
	);

	settled.forEach((s, i) => {
		if (s.status === 'rejected') {
			result.errors.push({
				service: 'annict',
				username: usernames[i],
				message: s.reason instanceof Error ? s.reason.message : String(s.reason)
			});
			return;
		}

		const { watching, watched } = s.value;
		const user: User = {
			id: `user:annict:${watching.user.username.toLowerCase()}`,
			service: 'annict',
			name: watching.user.username,
			avatarUrl: watching.user.avatarUrl,
			url: `https://annict.com/@${watching.user.username}`
		};
		result.users.push(user);

		for (const [status, works] of [
			['WATCHING', watching.works],
			['WATCHED', watched.works]
		] as const) {
			for (const work of works) {
				const animeId = work.malAnimeId
					? `anime:mal:${work.malAnimeId}`
					: `anime:annict:${work.annictId}`;
				result.animes.push({
					id: animeId,
					title: work.title,
					imageUrl: null,
					links: {
						annict: `https://annict.com/works/${work.annictId}`,
						anilist: null,
						mal: work.malAnimeId ? `https://myanimelist.net/anime/${work.malAnimeId}` : null
					}
				});
				result.statuses.push({ userId: user.id, animeId, status });
			}
		}
	});

	return result;
};
