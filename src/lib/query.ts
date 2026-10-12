export type Service = 'annict' | 'anilist';

/** URL の見た目を読みやすくするため，エンコードされた `:` と `,` を元に戻す． */
export const prettifyQuery = (url: string): string =>
	url.replaceAll(/%3A/gi, ':').replaceAll(/%2C/gi, ',');

/**
 * ユーザー行の配列から `?user=annict:a,anilist:b` を組み立てる．
 * 行の順序を保つ．先頭の `@` と前後の空白は除き，同一サービス・同一名（大文字小文字は区別しない）の重複はまとめる
 * （サーバ側の parseUsers と同じ規則）．空なら空文字列を返す．
 */
export const buildQuery = (rows: { service: Service; name: string }[]): string => {
	const seen = new Set<string>();
	const items: string[] = [];
	for (const row of rows) {
		for (const part of row.name.split(',')) {
			const name = part.trim().replace(/^@/, '');
			if (name.length === 0) continue;
			const key = `${row.service}:${name.toLowerCase()}`;
			if (seen.has(key)) continue;
			seen.add(key);
			items.push(`${row.service}:${name}`);
		}
	}
	if (items.length === 0) return '';
	const params = new URLSearchParams();
	params.set('user', items.join(','));
	return `?${prettifyQuery(params.toString())}`;
};

/** クリップボードにテキストを書き込む．権限が無い・非セキュアコンテキストなどで失敗したら false． */
export const copyText = async (text: string): Promise<boolean> => {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
};
