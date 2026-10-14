export type Service = 'annict' | 'anilist';

export type WatchStatus = 'WATCHING' | 'WATCHED' | 'PLANNING';

export type User = {
	/** `user:<service>:<username>` */
	id: string;
	service: Service;
	name: string;
	avatarUrl: string | null;
	url: string;
};

export type AnimeLinks = {
	/** `https://annict.com/works/<annictId>` */
	annict: string | null;
	/** `https://anilist.co/anime/<id>` */
	anilist: string | null;
	/** `https://myanimelist.net/anime/<malId>` */
	mal: string | null;
};

export type Anime = {
	/** `anime:mal:<id>`，MAL の ID が無ければ `anime:<service>:<id>` */
	id: string;
	title: string;
	/** サムネイル（AniList の coverImage）．無ければ null */
	imageUrl: string | null;
	/** 各サービスの作品ページ．同じ作品の複数の取得結果は，非 null を優先して統合する */
	links: AnimeLinks;
};

export type Status = {
	userId: string;
	animeId: string;
	status: WatchStatus;
};

export type FetchError = {
	service: Service;
	username: string;
	message: string;
};

export type FetchResult = {
	users: User[];
	animes: Anime[];
	statuses: Status[];
	errors: FetchError[];
};

export type Dataset = {
	users: (User & { size: number })[];
	animes: (Anime & { size: number })[];
	statuses: Status[];
	errors: FetchError[];
};
