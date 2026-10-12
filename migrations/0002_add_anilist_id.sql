-- AniList の作品 ID．url が NULL かつ anilist_id が NULL なら否定キャッシュ，url が NULL で anilist_id があれば「作品はあるが画像が無い」．
ALTER TABLE covers ADD COLUMN anilist_id INTEGER;
