import { parseUsers } from '#lib/server/graph.ts';
import type { Dataset } from '#lib/types.ts';
import type { PageServerLoad } from './$types';

/** `user` パラメータ（複数回の指定も含む）だけを引き継いだクエリ文字列． */
const userQuery = (searchParams: URLSearchParams): string => {
	const q = new URLSearchParams();
	for (const u of searchParams.getAll('user')) q.append('user', u);
	return q.toString();
};

export const load: PageServerLoad = ({ url, fetch, setHeaders }) => {
	const users = parseUsers(url.searchParams);
	const empty = users.length === 0;

	if (!empty) setHeaders({ 'Cache-Control': 'public, max-age=300' });

	return {
		users,
		// await せずに返して，ページの外枠を先に描画しつつデータはストリーミングする．
		// 取得の入口は /api/graph に一本化し，SvelteKit の内部 fetch（同一プロセス内で解決される）で呼ぶ．
		dataset: empty
			? null
			: fetch(`/api/graph?${userQuery(url.searchParams)}`).then(async (res): Promise<Dataset> => {
					if (!res.ok) throw new Error(`/api/graph failed: HTTP ${res.status}`);
					return res.json();
				})
	};
};
