import type Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import type { Dataset } from './types.ts';

// --- 色 ---

/** HSL（h: 度，s/l: 0〜1）を `#rrggbb` に変換する．sigma が解釈できる形式にするため． */
export const hsl = (h: number, s: number, l: number): string => {
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		const a = s * Math.min(l, 1 - l);
		const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
		return Math.round(c * 255)
			.toString(16)
			.padStart(2, '0');
	};
	return `#${f(0)}${f(8)}${f(4)}`;
};

/** 2 つの HSL 色の間を t（0〜1）で補間する． */
export const lerpHsl = (
	[h1, s1, l1]: [number, number, number],
	[h2, s2, l2]: [number, number, number],
	t: number
): string => hsl(h1 + (h2 - h1) * t, s1 + (s2 - s1) * t, l1 + (l2 - l1) * t);

// --- ラベル ---

export type LabelCandidate = {
	id: string;
	/** ノード中心の画面座標 */
	x: number;
	y: number;
	/** ノードの画面上の半径 */
	r: number;
	text: string;
	/** 大きいほど優先 */
	priority: number;
	/** 描画したときのテキスト幅（px） */
	width: number;
};

export type PlacedLabel = { id: string; x: number; y: number; text: string };

/** ノード端からラベルまでの間隔 */
export const LABEL_GAP = 4;
/** ラベル同士の余白 */
export const LABEL_MARGIN = 2;
/** 衝突判定に使うラベルの高さ */
export const LABEL_HEIGHT = 16;

/**
 * ラベルを優先度順に並べ，画面外のものと既に置いたラベルと重なるものを除いて最大 `max` 件を返す．
 * 返す `x` はテキストの左端，`y` は縦方向の中央．
 */
export const selectLabels = (
	candidates: LabelCandidate[],
	viewport: { width: number; height: number },
	max = Infinity
): PlacedLabel[] => {
	const sorted = candidates
		.map((c, i) => ({ c, i }))
		.sort((a, b) => b.c.priority - a.c.priority || a.i - b.i);
	const placed: { x1: number; y1: number; x2: number; y2: number }[] = [];
	const result: PlacedLabel[] = [];
	for (const { c } of sorted) {
		if (result.length >= max) break;
		const left = c.x + c.r + LABEL_GAP;
		const rect = {
			x1: left - LABEL_MARGIN,
			y1: c.y - LABEL_HEIGHT / 2 - LABEL_MARGIN,
			x2: left + c.width + LABEL_MARGIN,
			y2: c.y + LABEL_HEIGHT / 2 + LABEL_MARGIN
		};
		if (rect.x2 < 0 || rect.y2 < 0 || rect.x1 > viewport.width || rect.y1 > viewport.height) {
			continue;
		}
		if (placed.some((p) => rect.x1 < p.x2 && p.x1 < rect.x2 && rect.y1 < p.y2 && p.y1 < rect.y2)) {
			continue;
		}
		placed.push(rect);
		result.push({ id: c.id, x: left, y: c.y, text: c.text });
	}
	return result;
};

/** 長いタイトルを `maxLength` 文字（コードポイント単位）で `…` に切り詰める． */
export const truncateLabel = (text: string, maxLength = 24) => {
	const chars = [...text];
	return chars.length <= maxLength ? text : `${chars.slice(0, maxLength - 1).join('')}…`;
};

// --- レイアウト（ForceAtlas2） ---

/** 文字列から 32bit のシードを作る簡単なハッシュ（FNV-1a）． */
const hashString = (s: string) => {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
};

const mulberry32 = (seed: number) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const USER_RADIUS = 10;
const JITTER = 2;
/** 専用作品（1 人のユーザーにしかつながらない作品）を所有ユーザーへ寄せる係数． */
const PULL = 0.6;
/** 寄せた後の専用作品どうしの最小距離（専用作品の最近傍距離の中央値に対する比）． */
const MIN_GAP_RATIO = 1.2;
const RELAX_ITERATIONS = 30;

/** 専用作品を所有ユーザーの方向へ縮め，重なりを簡単な緩和で解く．決定的． */
const pullPrivateNodes = (graph: Graph): void => {
	const groups = new Map<string, string[]>();
	graph.forEachNode((node, attrs) => {
		if (attrs.kind === 'user') return;
		const owners = new Set<string>();
		graph.forEachNeighbor(node, (nb, nbAttrs) => {
			if (nbAttrs.kind === 'user') owners.add(nb);
		});
		if (owners.size !== 1) return;
		const [owner] = owners;
		const list = groups.get(owner);
		if (list) list.push(node);
		else groups.set(owner, [node]);
	});

	for (const [owner, nodes] of groups) {
		const ox = graph.getNodeAttribute(owner, 'x') as number;
		const oy = graph.getNodeAttribute(owner, 'y') as number;
		const xs = nodes.map((n) => graph.getNodeAttribute(n, 'x') as number);
		const ys = nodes.map((n) => graph.getNodeAttribute(n, 'y') as number);
		const m = nodes.length;
		// FA2 直後の最近傍距離の中央値から最小距離を決める（縮める前）．
		const nearest: number[] = [];
		for (let i = 0; i < m; i++) {
			let best = Infinity;
			for (let j = 0; j < m; j++) {
				if (i !== j) best = Math.min(best, Math.hypot(xs[i] - xs[j], ys[i] - ys[j]));
			}
			if (Number.isFinite(best)) nearest.push(best);
		}
		nearest.sort((a, b) => a - b);
		const gap = (nearest[nearest.length >> 1] ?? 0) * MIN_GAP_RATIO;

		for (let i = 0; i < m; i++) {
			xs[i] = ox + (xs[i] - ox) * PULL;
			ys[i] = oy + (ys[i] - oy) * PULL;
		}
		for (let it = 0; it < RELAX_ITERATIONS && gap > 0; it++) {
			let moved = false;
			for (let i = 0; i < m; i++) {
				for (let j = i + 1; j < m; j++) {
					let dx = xs[j] - xs[i];
					let dy = ys[j] - ys[i];
					let d = Math.hypot(dx, dy);
					if (d >= gap) continue;
					if (d < 1e-9) {
						const a = (i * 2.399963) % (2 * Math.PI);
						dx = Math.cos(a);
						dy = Math.sin(a);
						d = 1;
					}
					const push = (gap - d) / 2 / d;
					xs[i] -= dx * push;
					ys[i] -= dy * push;
					xs[j] += dx * push;
					ys[j] += dy * push;
					moved = true;
				}
			}
			if (!moved) break;
		}
		nodes.forEach((n, i) => graph.mergeNodeAttributes(n, { x: xs[i], y: ys[i] }));
	}
};

/**
 * ノードの x,y を書き換える．ユーザーを円周上に置き，作品はつながるユーザーの重心付近から始めて，
 * ForceAtlas2（同期版）で収束させる．ブラウザ依存なし．
 */
export const layoutGraph = (graph: Graph): void => {
	const users = graph.filterNodes((n) => graph.getNodeAttribute(n, 'kind') === 'user');
	users.forEach((u, i) => {
		const angle = (2 * Math.PI * i) / Math.max(1, users.length);
		graph.mergeNodeAttributes(u, {
			x: Math.cos(angle) * USER_RADIUS,
			y: Math.sin(angle) * USER_RADIUS
		});
	});

	graph.forEachNode((node, attrs) => {
		if (attrs.kind === 'user') return;
		const rand = mulberry32(hashString(node));
		let sx = 0;
		let sy = 0;
		let count = 0;
		graph.forEachNeighbor(node, (nb, nbAttrs) => {
			if (nbAttrs.kind !== 'user') return;
			sx += nbAttrs.x;
			sy += nbAttrs.y;
			count++;
		});
		const cx = count > 0 ? sx / count : 0;
		const cy = count > 0 ? sy / count : 0;
		graph.mergeNodeAttributes(node, {
			x: cx + (rand() * 2 - 1) * JITTER,
			y: cy + (rand() * 2 - 1) * JITTER
		});
	});

	if (graph.order < 2) return;
	const iterations = Math.round(Math.min(1000, Math.max(300, 1500000 / Math.max(1, graph.order))));
	forceAtlas2.assign(graph, {
		iterations,
		settings: {
			...forceAtlas2.inferSettings(graph),
			barnesHutOptimize: true,
			linLogMode: true,
			gravity: 1,
			scalingRatio: 10
		}
	});
	pullPrivateNodes(graph);
};

// --- 強調 ---

/**
 * 強調する作品の ID の集合．`minWatchers` 人以上が観ていて，`userIds`（データセットに存在するもののみ）の
 * 全員が観ている作品．どちらの条件も無ければ（強調なし）`null`．
 */
export const highlightedAnimeIds = (
	dataset: Pick<Dataset, 'users' | 'animes' | 'statuses'>,
	opts: { minWatchers: number; userIds: string[] }
): Set<string> | null => {
	const known = new Set(dataset.users.map((u) => u.id));
	const selected = [...new Set(opts.userIds.filter((id) => known.has(id)))];
	if (opts.minWatchers <= 1 && selected.length === 0) return null;

	const watchedBy = new Map<string, Set<string>>();
	for (const s of dataset.statuses) {
		const set = watchedBy.get(s.animeId);
		if (set) set.add(s.userId);
		else watchedBy.set(s.animeId, new Set([s.userId]));
	}
	const result = new Set<string>();
	for (const a of dataset.animes) {
		if (a.size < opts.minWatchers) continue;
		const watchers = watchedBy.get(a.id);
		if (selected.every((u) => watchers?.has(u))) result.add(a.id);
	}
	return result;
};
