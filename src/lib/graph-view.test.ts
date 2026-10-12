import Graph from 'graphology';
import { describe, expect, it } from 'vitest';
import {
	highlightedAnimeIds,
	layoutGraph,
	selectLabels,
	truncateLabel,
	type LabelCandidate
} from './graph-view.ts';

// --- ラベル ---

const viewport = { width: 800, height: 600 };
const cand = (id: string, o: Partial<LabelCandidate> = {}): LabelCandidate => ({
	id,
	x: 100,
	y: 100,
	r: 5,
	text: id,
	priority: 1,
	width: 60,
	...o
});

describe('selectLabels', () => {
	it('重なるものは優先度の高い方だけ残る', () => {
		const result = selectLabels(
			[cand('low', { priority: 1 }), cand('high', { priority: 5, y: 105 })],
			viewport
		);
		expect(result.map((l) => l.id)).toEqual(['high']);
	});

	it('重ならないものは両方残り，優先度順に並ぶ', () => {
		const result = selectLabels(
			[cand('a', { priority: 1 }), cand('b', { priority: 2, y: 300 })],
			viewport
		);
		expect(result.map((l) => l.id)).toEqual(['b', 'a']);
	});

	it('画面外は除外する', () => {
		const result = selectLabels(
			[cand('out', { x: -500 }), cand('out2', { y: 700 }), cand('in', { y: 300 })],
			viewport
		);
		expect(result.map((l) => l.id)).toEqual(['in']);
	});

	it('max で件数を制限する', () => {
		const list = [0, 1, 2, 3].map((i) => cand(`n${i}`, { y: 50 + i * 100, priority: i }));
		expect(selectLabels(list, viewport, 2).map((l) => l.id)).toEqual(['n3', 'n2']);
	});

	it('ラベルはノードの右側に置く', () => {
		const [l] = selectLabels([cand('a')], viewport);
		expect(l).toEqual({ id: 'a', x: 109, y: 100, text: 'a' });
	});
});

describe('truncateLabel', () => {
	it('長い文字列を … で切り詰める', () => {
		expect(truncateLabel('あ'.repeat(30), 24)).toBe(`${'あ'.repeat(23)}…`);
		expect(truncateLabel('短い')).toBe('短い');
	});
});

// --- レイアウト ---

const build = () => {
	const g = new Graph();
	const users = ['u0', 'u1', 'u2'];
	users.forEach((u) => g.addNode(u, { kind: 'user', x: 0, y: 0, size: 10 }));
	const add = (id: string, owners: string[]) => {
		g.addNode(id, { kind: 'anime', x: 0, y: 0, size: 4 });
		owners.forEach((u) => g.addEdge(u, id));
	};
	users.forEach((u) => {
		for (let i = 0; i < 30; i++) add(`own:${u}:${i}`, [u]);
	});
	for (let i = 0; i < 10; i++) add(`all:${i}`, users);
	for (let a = 0; a < 3; a++)
		for (let b = a + 1; b < 3; b++)
			for (let i = 0; i < 5; i++) add(`pair:${a}${b}:${i}`, [users[a], users[b]]);
	return { g, users };
};

const pos = (g: Graph, n: string) => ({
	x: g.getNodeAttribute(n, 'x') as number,
	y: g.getNodeAttribute(n, 'y') as number
});

describe('layoutGraph', () => {
	const { g, users } = build();
	layoutGraph(g);
	const up = users.map((u) => pos(g, u));
	const centroid = {
		x: up.reduce((s, p) => s + p.x, 0) / 3,
		y: up.reduce((s, p) => s + p.y, 0) / 3
	};
	const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
		Math.hypot(a.x - b.x, a.y - b.y);
	const own = g.filterNodes((n) => n.startsWith('own:'));
	const all = g.filterNodes((n) => n.startsWith('all:'));

	it('すべての座標が有限値', () => {
		g.forEachNode((_, a) => {
			expect(Number.isFinite(a.x)).toBe(true);
			expect(Number.isFinite(a.y)).toBe(true);
		});
	});

	it('全員が観ている作品は専用作品より重心に近い', () => {
		const mean = (ns: string[]) =>
			ns.reduce((s, n) => s + dist(pos(g, n), centroid), 0) / ns.length;
		expect(mean(all)).toBeLessThan(mean(own));
	});

	it('専用作品は所有ユーザーが最も近い', () => {
		const ok = own.filter((n) => {
			const p = pos(g, n);
			const owner = n.split(':')[1];
			const nearest = users.reduce((best, u) =>
				dist(p, pos(g, u)) < dist(p, pos(g, best)) ? u : best
			);
			return nearest === owner;
		});
		expect(ok.length / own.length).toBeGreaterThanOrEqual(0.9);
	});

	it('専用作品は所有ユーザーの近くに集まる（所有者からの平均距離 / ユーザー間の平均距離）', () => {
		const userMean = (dist(up[0], up[1]) + dist(up[0], up[2]) + dist(up[1], up[2])) / 3;
		const ownerMean =
			own.reduce((s, n) => s + dist(pos(g, n), pos(g, n.split(':')[1])), 0) / own.length;
		expect(ownerMean / userMean).toBeLessThan(0.45);
	});

	it('専用作品どうしが同一座標に重ならない', () => {
		users.forEach((u) => {
			const ns = own.filter((n) => n.split(':')[1] === u);
			let min = Infinity;
			for (let i = 0; i < ns.length; i++)
				for (let j = i + 1; j < ns.length; j++)
					min = Math.min(min, dist(pos(g, ns[i]), pos(g, ns[j])));
			expect(min).toBeGreaterThan(0);
		});
	});
});

// --- 強調 ---

describe('highlightedAnimeIds', () => {
	const user = (id: string) => ({ id }) as never;
	const dataset = {
		users: [user('u1'), user('u2'), user('u3')],
		animes: [
			{ id: 'a', size: 3 },
			{ id: 'b', size: 2 },
			{ id: 'c', size: 1 },
			{ id: 'd', size: 1 }
		] as never[],
		statuses: [
			...['u1', 'u2', 'u3'].map((userId) => ({ userId, animeId: 'a', status: 'WATCHED' as const })),
			...['u1', 'u2'].map((userId) => ({ userId, animeId: 'b', status: 'WATCHED' as const })),
			{ userId: 'u1', animeId: 'c', status: 'WATCHED' as const },
			{ userId: 'u2', animeId: 'd', status: 'WATCHING' as const }
		]
	};
	const ids = (s: Set<string> | null) => (s ? [...s].sort() : s);

	it('強調なしは null', () => {
		expect(highlightedAnimeIds(dataset, { minWatchers: 1, userIds: [] })).toBeNull();
		expect(highlightedAnimeIds(dataset, { minWatchers: 0, userIds: ['unknown'] })).toBe(null);
	});

	it('n のみ（ちょうど size は含む）', () => {
		expect(ids(highlightedAnimeIds(dataset, { minWatchers: 2, userIds: [] }))).toEqual(['a', 'b']);
		expect(ids(highlightedAnimeIds(dataset, { minWatchers: 3, userIds: [] }))).toEqual(['a']);
		expect(ids(highlightedAnimeIds(dataset, { minWatchers: 4, userIds: [] }))).toEqual([]);
	});

	it('ユーザーのみ（複数は AND）', () => {
		expect(ids(highlightedAnimeIds(dataset, { minWatchers: 1, userIds: ['u1'] }))).toEqual([
			'a',
			'b',
			'c'
		]);
		expect(ids(highlightedAnimeIds(dataset, { minWatchers: 1, userIds: ['u1', 'u2'] }))).toEqual([
			'a',
			'b'
		]);
		expect(ids(highlightedAnimeIds(dataset, { minWatchers: 1, userIds: ['u1', 'u3'] }))).toEqual([
			'a'
		]);
	});

	it('n とユーザーの併用は両方を満たすもの', () => {
		expect(ids(highlightedAnimeIds(dataset, { minWatchers: 3, userIds: ['u1'] }))).toEqual(['a']);
		expect(ids(highlightedAnimeIds(dataset, { minWatchers: 2, userIds: ['u2'] }))).toEqual([
			'a',
			'b'
		]);
	});

	it('未知の ID は無視する', () => {
		expect(ids(highlightedAnimeIds(dataset, { minWatchers: 1, userIds: ['u3', 'x'] }))).toEqual([
			'a'
		]);
		expect(highlightedAnimeIds(dataset, { minWatchers: 1, userIds: ['x'] })).toBeNull();
	});

	it('1 作品も観ていないユーザーを選ぶと空', () => {
		const d = { ...dataset, users: [...dataset.users, user('u4')] };
		expect(ids(highlightedAnimeIds(d, { minWatchers: 1, userIds: ['u4'] }))).toEqual([]);
		expect(ids(highlightedAnimeIds(d, { minWatchers: 1, userIds: ['u1', 'u4'] }))).toEqual([]);
	});
});
