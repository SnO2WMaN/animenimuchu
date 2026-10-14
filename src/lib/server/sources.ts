import type { FetchError, FetchResult, User, WatchStatus } from '#lib/types.ts';

// --- Annict ---

const ANNICT_ENDPOINT = 'https://api.annict.com/graphql';

// graphql-ruby は max_page_size を超える first を黙って切り詰めるので，大きめに指定してページングで取り切る．
const PAGE_SIZE = 1000;

// Annict の StatusState での名前．
const ANNICT_STATE: Record<WatchStatus, string> = {
	WATCHING: 'WATCHING',
	WATCHED: 'WATCHED',
	PLANNING: 'WANNA_WATCH'
};

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
			body: JSON.stringify({
				query: ANNICT_QUERY,
				variables: { username, state: ANNICT_STATE[state], after }
			})
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
			const [watching, watched, planning] = await Promise.all([
				fetchWorks(username, 'WATCHING', token, fetcher),
				fetchWorks(username, 'WATCHED', token, fetcher),
				fetchWorks(username, 'PLANNING', token, fetcher)
			]);
			return { username, watching, watched, planning };
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

		const { watching, watched, planning } = s.value;
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
			['WATCHED', watched.works],
			['PLANNING', planning.works]
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
