<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import DetailPanel from '#lib/components/DetailPanel.svelte';
	import Graph from '#lib/components/Graph.svelte';
	import { trackShown } from '#lib/panel.ts';
	import { buildQuery, copyText, prettifyQuery, type Service } from '#lib/query.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let focused = $state<string | null>(null);
	// パネルに渡す ID．focused が外れても，パネルへ移動する間は少し残す．
	let shown = $state<string | null>(null);
	let panelHover = $state(false);

	$effect(() => {
		const f = focused;
		const h = panelHover;
		return trackShown(
			f,
			h,
			untrack(() => shown),
			(id) => (shown = id)
		);
	});

	type Row = { id: number; service: Service; name: string; highlight: boolean };

	const SERVICES: { id: Service; label: string; badge: string; color: string; ring: string }[] = [
		{ id: 'annict', label: 'Annict', badge: 'A', color: 'bg-[#f06]', ring: 'ring-[#f06]' },
		{ id: 'anilist', label: 'AniList', badge: 'AL', color: 'bg-[#3db4f2]', ring: 'ring-[#3db4f2]' }
	];

	let nextId = 0;
	const newRow = (service: Service, name = ''): Row => ({
		id: nextId++,
		service,
		name,
		highlight: false
	});

	const initialRows = (d: { users: { service: Service; name: string }[] }): Row[] => {
		const list = d.users.map((u) => newRow(u.service, u.name));
		return list.length > 0 ? list : [newRow('annict')];
	};

	// $state にして行オブジェクトを深くプロキシ化する（row.service などの書き換えを反応させる）．
	// SSR でも初期行が入るよう初期値を与え，data（URL）が変わったときだけ再初期化する．
	let rows = $state<Row[]>(untrack(() => initialRows(data)));
	let initialized = false;
	$effect.pre(() => {
		const rowsFromUrl = initialRows(data);
		if (!initialized) {
			initialized = true;
			return;
		}
		rows = rowsFromUrl;
	});

	// --- 強調 ---
	// 状態は URL に入れない．チェックは「表示」で反映済み（data.users にある）ユーザーの行だけ有効．
	let minWatchers = $state(1);
	let highlightedCount = $state<number | null>(null);
	const userKey = (service: Service, name: string) =>
		`user:${service}:${name.trim().replace(/^@/, '').toLowerCase()}`;
	const shownUserIds = $derived(new Set(data.users.map((u) => userKey(u.service, u.name))));
	const rowUserId = (row: Row) => userKey(row.service, row.name);
	const isShown = (row: Row) => shownUserIds.has(rowUserId(row));
	const highlightUsers = $derived(rows.filter((r) => r.highlight && isShown(r)).map(rowUserId));
	// 名前を編集して表示中のユーザーと一致しなくなった行は，チェックを外す．
	$effect(() => {
		for (const row of rows) if (row.highlight && !isShown(row)) row.highlight = false;
	});
	// データが変わって人数の上限が下がったときも，Graph へは上限に収めた値を渡す．
	const effectiveMin = $derived(Math.min(minWatchers, Math.max(1, data.users.length)));
	const clampMin = (v: number, max: number) =>
		Number.isFinite(v) ? Math.min(max, Math.max(1, Math.round(v))) : 1;

	const addRow = async () => {
		const row = newRow('annict');
		rows = [...rows, row];
		await tick();
		document.querySelector<HTMLInputElement>(`input[data-row="${row.id}"]`)?.focus();
	};

	const removeRow = (id: number) => {
		const rest = rows.filter((r) => r.id !== id);
		rows = rest.length > 0 ? rest : [newRow('annict')];
	};

	const submit = () => {
		void goto(`/${buildQuery(rows)}`, { reset: false });
	};

	const EXAMPLE = '?user=annict:tosuke,annict:rinsuki,anilist:sno2wman';

	// URL のコピー．結果は一定時間だけ表示して元に戻す．
	let copyState = $state<'idle' | 'ok' | 'error'>('idle');
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => () => clearTimeout(copyTimer));

	const copyUrl = async () => {
		const ok = await copyText(prettifyQuery(page.url.href));
		clearTimeout(copyTimer);
		copyState = ok ? 'ok' : 'error';
		copyTimer = setTimeout(() => (copyState = 'idle'), ok ? 1500 : 2000);
	};
</script>

<svelte:head>
	<title>Animenimuchu</title>
</svelte:head>

<main class="relative h-dvh w-full overflow-hidden bg-zinc-50 text-zinc-900">
	{#if data.dataset}
		{#await data.dataset}
			<div class="flex h-full items-center justify-center text-zinc-500">読み込み中…</div>
		{:then dataset}
			{#key dataset}
				<Graph
					{dataset}
					minWatchers={effectiveMin}
					{highlightUsers}
					bind:highlightedCount
					bind:focused
				/>
			{/key}

			<DetailPanel
				{dataset}
				id={shown}
				onenter={() => (panelHover = true)}
				onleave={() => (panelHover = false)}
			/>

			<aside
				class="absolute right-3 bottom-3 z-10 flex max-w-sm flex-col gap-2 text-sm"
				aria-live="polite"
			>
				<div class="rounded-lg bg-white/85 px-4 py-2 text-zinc-600 shadow-md backdrop-blur">
					{dataset.users.length} 人 · {dataset.animes.length} 作品{#if highlightedCount !== null}{' '}·
						強調: {highlightedCount} 作品{/if}
				</div>
				{#each dataset.errors as error (`${error.service}:${error.username}`)}
					<div class="rounded-lg bg-red-50/90 px-4 py-2 text-red-700 shadow-md backdrop-blur">
						{error.service}/{error.username}: {error.message}
					</div>
				{/each}
			</aside>
		{:catch error}
			<div class="flex h-full items-center justify-center text-red-600">
				取得に失敗しました: {error instanceof Error ? error.message : String(error)}
			</div>
		{/await}
	{:else}
		<div class="flex h-full items-center justify-center text-zinc-500">
			<p>
				ユーザーを指定してください．例:
				<a href={EXAMPLE} class="text-sky-700 underline">{EXAMPLE}</a>
			</p>
		</div>
	{/if}

	<div
		class="absolute top-3 left-3 z-10 flex flex-col gap-2 rounded-lg bg-white/85 p-3 text-sm shadow-md backdrop-blur"
	>
		<h1 class="font-bold">Animenimuchu</h1>
		<table>
			<tbody>
				{#each rows as row (row.id)}
					<tr>
						<td class="py-0.5 pr-2">
							<div role="radiogroup" aria-label="サービス" class="flex gap-1">
								{#each SERVICES as s (s.id)}
									<button
										type="button"
										role="radio"
										aria-checked={row.service === s.id}
										aria-label={s.label}
										title={s.label}
										onclick={() => (row.service = s.id)}
										class="flex size-7 items-center justify-center rounded-md text-[10px] font-bold text-white ring-offset-1 {s.color} {row.service ===
										s.id
											? `opacity-100 ring-2 ${s.ring}`
											: 'opacity-30 hover:opacity-60'}"
									>
										<span aria-hidden="true">{s.badge}</span>
									</button>
								{/each}
							</div>
						</td>
						<td class="py-0.5 pr-2">
							<input
								bind:value={row.name}
								data-row={row.id}
								aria-label="ユーザー名"
								placeholder={row.service === 'annict' ? 'tosuke' : 'sno2wman'}
								onkeydown={(e) => {
									if (e.key === 'Enter' && !e.isComposing) submit();
								}}
								class="w-48 rounded border border-zinc-300 bg-white px-2 py-1"
							/>
						</td>
						<td class="py-0.5 pr-1">
							<input
								type="checkbox"
								bind:checked={row.highlight}
								disabled={!isShown(row)}
								aria-label="この人が観ている作品のみ強調"
								title={isShown(row)
									? 'この人が観ている作品のみ強調'
									: '「表示」で反映すると選べます'}
								class="block size-4 accent-pink-500 disabled:cursor-not-allowed disabled:opacity-40"
							/>
						</td>
						<td class="py-0.5">
							<button
								type="button"
								aria-label="この行を削除"
								title="削除"
								onclick={() => removeRow(row.id)}
								class="size-7 rounded text-zinc-500 hover:bg-zinc-200"
							>
								×
							</button>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<div class="flex flex-col gap-0.5 text-xs">
			<label class="flex items-center gap-1">
				<input
					type="number"
					min="1"
					max={Math.max(1, data.users.length)}
					step="1"
					value={minWatchers}
					onchange={(e) => {
						const max = Math.max(1, data.users.length);
						minWatchers = clampMin(e.currentTarget.valueAsNumber, max);
						e.currentTarget.value = String(minWatchers);
					}}
					class="w-14 rounded border border-zinc-300 bg-white px-1 py-0.5"
				/>
				人以上が観ている作品を強調
			</label>
			{#if highlightUsers.length > 0}
				<p class="text-zinc-500">チェックした全員が観ている作品を強調</p>
			{/if}
		</div>
		<div class="flex items-center justify-between gap-2">
			<button
				type="button"
				onclick={addRow}
				class="rounded border border-zinc-300 bg-white px-2 py-1 hover:bg-zinc-100"
			>
				ユーザーを追加
			</button>
			<div class="flex items-center gap-2">
				<button
					type="button"
					onclick={copyUrl}
					disabled={data.users.length === 0}
					class="rounded border border-zinc-300 bg-white px-2 py-1 whitespace-nowrap hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white"
				>
					{#if copyState === 'ok'}
						<span aria-hidden="true">✓ </span>コピーしました
					{:else if copyState === 'error'}
						コピー失敗
					{:else}
						URL をコピー
					{/if}
				</button>
				<button
					type="button"
					onclick={submit}
					class="rounded bg-zinc-800 px-3 py-1 text-white hover:bg-zinc-700"
				>
					表示
				</button>
			</div>
		</div>
		<span class="sr-only" aria-live="polite">
			{copyState === 'ok' ? 'コピーしました' : copyState === 'error' ? 'コピーに失敗しました' : ''}
		</span>
		<a
			href="https://github.com/SnO2WMaN/animenimuchu"
			target="_blank"
			rel="noreferrer"
			class="text-zinc-500 hover:underline">GitHub</a
		>
	</div>
</main>
