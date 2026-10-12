-- MAL ID から AniList に逆引きしたサムネイルのキャッシュ．url が NULL のものは否定キャッシュ．
CREATE TABLE IF NOT EXISTS covers (
	mal_id INTEGER PRIMARY KEY,
	url TEXT,
	fetched_at INTEGER NOT NULL
);
