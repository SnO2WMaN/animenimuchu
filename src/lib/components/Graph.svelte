<script lang="ts">
	import { onMount } from 'svelte';
	import Graph from 'graphology';
	import {
		highlightedAnimeIds,
		layoutGraph,
		lerpHsl,
		selectLabels,
		truncateLabel,
		type LabelCandidate
	} from '#lib/graph-view.ts';
	import type { Dataset } from '#lib/types.ts';

	let {
		dataset,
		minWatchers = 1,
		highlightUsers = [],
		highlightedCount = $bindable(null),
		focused = $bindable(null)
	}: {
		dataset: Dataset;
		/** この人数以上が観ている作品を強調する（1 以下なら人数の条件なし） */
		minWatchers?: number;
		/** この全員が観ている作品を強調する（ユーザー ID） */
		highlightUsers?: string[];
		/** 強調された作品の数．強調が無効なら null */
		highlightedCount?: number | null;
		/** ホバー中，またはクリックで固定したノードの ID */
		focused?: string | null;
	} = $props();

	let container: HTMLDivElement;
	let overlay: HTMLCanvasElement;
	// onMount 内で作る sigma に，強調の変更を伝える．描画の準備ができるまでは null．
	let applyHighlight: ((h: Set<string> | null) => void) | null = null;
	let highlight: Set<string> | null = null;

	$effect(() => {
		const h = highlightedAnimeIds(dataset, { minWatchers, userIds: highlightUsers });
		highlight = h;
		highlightedCount = h ? h.size : null;
		applyHighlight?.(h);
	});

	const FONT_FAMILY =
		'"Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif';
	/** focus が無いときに出す作品ラベルの最大数と，対象にする画面上の最小半径 */
	const MAX_ANIME_LABELS = 40;
	const MIN_ANIME_RADIUS = 5;
	/** 強調の対象外の作品の見え方 */
	const DIMMED = { opacity: 0.12, color: '#a1a1aa' };

	/** Annict の画像は CORS が通らないので，同一オリジンのプロキシ経由にする． */
	const proxiedImageUrl = (url: string) => {
		try {
			return new URL(url).hostname === 'image.annict.com'
				? `/api/image?url=${encodeURIComponent(url)}`
				: url;
		} catch {
			return url;
		}
	};
	const imageAttr = (url: string | null) => (url ? { image: proxiedImageUrl(url) } : {});

	const buildGraph = (dataset: Dataset) => {
		const graph = new Graph();
		const maxAnimeSize = Math.max(1, dataset.users.length);
		const maxUserSize = Math.max(1, ...dataset.users.map((u) => u.size));

		dataset.users.forEach((u, i) => {
			graph.addNode(u.id, {
				kind: 'user',
				...imageAttr(u.avatarUrl),
				label: u.name,
				size: 26 + 10 * Math.sqrt(u.size / maxUserSize),
				color: lerpHsl(
					[326, 0.55, 0.6],
					[426, 0.55, 0.6],
					i / Math.max(1, dataset.users.length - 1)
				)
			});
		});
		dataset.animes.forEach((a) => {
			// 「見たい」だけの作品（size 0）は，グラフには出さない．
			if (a.size === 0) return;
			const t = maxAnimeSize <= 1 ? 1 : (a.size - 1) / (maxAnimeSize - 1);
			graph.addNode(a.id, {
				kind: 'anime',
				...imageAttr(a.imageUrl),
				label: a.title,
				// 共通して観ている人が多い作品ほど大きく表示する．
				size: 9 + 18 * t,
				color: lerpHsl([206, 0.35, 0.72], [226, 0.7, 0.42], t)
			});
		});
		for (const s of dataset.statuses) {
			if (s.status === 'PLANNING') continue;
			if (!graph.hasNode(s.userId) || !graph.hasNode(s.animeId)) continue;
			graph.addEdge(s.userId, s.animeId, {
				status: s.status,
				size: s.status === 'WATCHING' ? 1.5 : 0.5,
				color: s.status === 'WATCHING' ? 'rgba(244, 114, 182, 0.5)' : 'rgba(148, 163, 184, 0.2)'
			});
		}
		return graph;
	};

	onMount(() => {
		let disposed = false;
		let cleanup = () => {};

		// sigma などはブラウザ専用なので，SSR を避けて動的に読み込む．
		void (async () => {
			const [{ default: Sigma, DEFAULT_STYLES }, { layerFill }, { layerImage }] = await Promise.all(
				[import('sigma'), import('sigma/rendering'), import('@sigma/node-image')]
			);
			if (disposed) return;

			const graph = buildGraph(dataset);
			layoutGraph(graph);
			let hovered: string | null = null;
			let pinned: string | null = null;
			let neighbors = new Set<string>();
			const dimmedAnime = (node: string) =>
				highlight !== null &&
				graph.getNodeAttribute(node, 'kind') !== 'user' &&
				!highlight.has(node);

			const updateFocus = () => {
				const next = hovered ?? pinned;
				focused = next;
				neighbors = next ? new Set(graph.neighbors(next)) : new Set();
				renderer.refresh({ skipIndexation: true });
			};

			const renderer = new Sigma(graph, container, {
				primitives: {
					nodes: {
						layers: [layerFill(), layerImage({ drawingMode: 'image' })],
						// layerImage は表示データの `image` を読むので，カスタム変数として宣言する．
						variables: { image: { type: 'string', default: '' } }
					}
				},
				styles: {
					// 既定のスタイルを残したまま，`image` をノード属性に結びつける．
					nodes: [DEFAULT_STYLES.nodes, { image: { attribute: 'image' } }]
				},
				settings: {
					// sigma v4 の既定値 'positions' だとノードサイズがグラフ座標単位になり巨大に描画されるため，画面座標基準にする．
					itemSizesReference: 'screen',
					// ラベルは SDF アトラスだと日本語が崩れるので，Canvas 2D の自前オーバーレイで描く．
					renderLabels: false,
					hideEdgesOnMove: true
				},
				nodeReducer: (node, data) => {
					const target = hovered ?? pinned;
					if (!target) {
						if (!highlight) return { ...data, zIndex: 1 };
						if (dimmedAnime(node)) return { ...data, zIndex: 0, ...DIMMED };
						return { ...data, zIndex: 2 };
					}
					if (node === target) return { ...data, zIndex: 2 };
					if (neighbors.has(node)) return { ...data, zIndex: 1 };
					return graph.getNodeAttribute(node, 'kind') === 'user'
						? { ...data, zIndex: 0, color: '#d4d4d8' }
						: { ...data, zIndex: 0, color: '#e4e4e7' };
				},
				edgeReducer: (edge, data) => {
					const target = hovered ?? pinned;
					if (!target) {
						if (!highlight) return data;
						const [a, b] = graph.extremities(edge);
						return dimmedAnime(a) || dimmedAnime(b) ? { ...data, visibility: 'hidden' } : data;
					}
					return graph.hasExtremity(edge, target)
						? { ...data, size: data.size + 1, color: graph.getNodeAttribute(target, 'color') }
						: { ...data, visibility: 'hidden' };
				}
			});

			applyHighlight = (h) => {
				highlight = h;
				renderer.refresh({ skipIndexation: true });
			};

			renderer.on('enterNode', ({ node }) => {
				hovered = node;
				updateFocus();
			});
			renderer.on('leaveNode', () => {
				hovered = null;
				updateFocus();
			});
			renderer.on('clickNode', ({ node }) => {
				pinned = pinned === node ? null : node;
				updateFocus();
			});
			renderer.on('clickStage', () => {
				pinned = null;
				updateFocus();
			});

			const drawLabels = () => {
				const ctx = overlay.getContext('2d');
				if (!ctx) return;
				const dpr = window.devicePixelRatio || 1;
				const width = overlay.clientWidth;
				const height = overlay.clientHeight;
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				ctx.clearRect(0, 0, width, height);

				const target = hovered ?? pinned;
				const font = (kind: string) =>
					kind === 'user' ? `bold 13px ${FONT_FAMILY}` : `12px ${FONT_FAMILY}`;
				const candidate = (id: string, priority: number): LabelCandidate => {
					const a = graph.getNodeAttributes(id);
					const p = renderer.graphToViewport({ x: a.x, y: a.y });
					const text = truncateLabel(String(a.label ?? ''));
					ctx.font = font(a.kind);
					return {
						id,
						x: p.x,
						y: p.y,
						r: renderer.scaleSize(a.size),
						text,
						priority,
						width: ctx.measureText(text).width
					};
				};

				const candidates: LabelCandidate[] = [];
				if (target) candidates.push(candidate(target, 1e9));
				const animes: LabelCandidate[] = [];
				graph.forEachNode((id, a) => {
					if (id === target) return;
					if (a.kind === 'user') {
						candidates.push(candidate(id, 1e8 + a.size));
					} else if (target) {
						if (neighbors.has(id)) candidates.push(candidate(id, 1e6 + a.size));
					} else if (!highlight || highlight.has(id)) {
						const c = candidate(id, a.size);
						if (c.r >= MIN_ANIME_RADIUS) animes.push(c);
					}
				});
				animes.sort((a, b) => b.priority - a.priority);
				candidates.push(...animes.slice(0, MAX_ANIME_LABELS));

				ctx.textBaseline = 'middle';
				ctx.lineJoin = 'round';
				ctx.lineWidth = 3;
				ctx.strokeStyle = '#ffffff';
				for (const l of selectLabels(candidates, { width, height })) {
					ctx.font = font(graph.getNodeAttribute(l.id, 'kind'));
					ctx.fillStyle = l.id === target ? '#000000' : '#111827';
					ctx.strokeText(l.text, l.x, l.y);
					ctx.fillText(l.text, l.x, l.y);
				}
			};

			const resizeOverlay = () => {
				const dpr = window.devicePixelRatio || 1;
				overlay.width = Math.round(overlay.clientWidth * dpr);
				overlay.height = Math.round(overlay.clientHeight * dpr);
				drawLabels();
			};
			const resizeObserver = new ResizeObserver(resizeOverlay);
			resizeObserver.observe(overlay);
			renderer.on('afterRender', drawLabels);
			resizeOverlay();

			cleanup = () => {
				applyHighlight = null;
				resizeObserver.disconnect();
				renderer.off('afterRender', drawLabels);
				renderer.kill();
			};
		})();

		return () => {
			disposed = true;
			cleanup();
		};
	});
</script>

<div class="relative h-full w-full">
	<div bind:this={container} class="h-full w-full"></div>
	<canvas bind:this={overlay} class="pointer-events-none absolute inset-0 h-full w-full"></canvas>
</div>
