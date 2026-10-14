<script lang="ts">
	import { malIdOf } from '#lib/panel.ts';
	import type { Dataset, Service, WatchStatus } from '#lib/types.ts';

	let {
		dataset,
		id,
		onenter,
		onleave
	}: { dataset: Dataset; id: string | null; onenter?: () => void; onleave?: () => void } = $props();

	const SERVICE: Record<Service, { label: string; badge: string; bg: string }> = {
		annict: { label: 'Annict', badge: 'A', bg: 'bg-[#f06]' },
		anilist: { label: 'AniList', badge: 'AL', bg: 'bg-[#3db4f2]' }
	};
	const STATUS_LABEL: Record<WatchStatus, string> = {
		WATCHING: '視聴中',
		WATCHED: '視聴済み',
		PLANNING: '見たい'
	};

	const STATUS_ORDER: Record<WatchStatus, number> = { PLANNING: 0, WATCHED: 1, WATCHING: 2 };

	// Annict のアイコンは直接参照できない（ホットリンク対策）ので，Graph と同じ同一オリジンのプロキシ経由にする．
	const proxied = (url: string) => {
		try {
			return new URL(url).hostname === 'image.annict.com'
				? `/api/image?url=${encodeURIComponent(url)}`
				: url;
		} catch {
			return url;
		}
	};

	const user = $derived(id ? (dataset.users.find((u) => u.id === id) ?? null) : null);
	const anime = $derived(id ? (dataset.animes.find((a) => a.id === id) ?? null) : null);

	const watchers = $derived.by(() => {
		if (!anime) return [];
		const byId = new Map(dataset.users.map((u) => [u.id, u]));
		return dataset.statuses
			.filter((s) => s.animeId === anime.id)
			.flatMap((s) => {
				const u = byId.get(s.userId);
				return u ? [{ user: u, status: s.status }] : [];
			})
			.sort(
				(a, b) =>
					STATUS_ORDER[b.status] - STATUS_ORDER[a.status] || a.user.name.localeCompare(b.user.name)
			);
	});

	const watching = $derived(watchers.filter((w) => w.status !== 'PLANNING'));
	const planning = $derived(watchers.filter((w) => w.status === 'PLANNING'));

	const userCounts = $derived.by(() => {
		const mine = user ? dataset.statuses.filter((s) => s.userId === user.id) : [];
		return {
			watching: mine.filter((s) => s.status === 'WATCHING').length,
			watched: mine.filter((s) => s.status === 'WATCHED').length,
			planning: mine.filter((s) => s.status === 'PLANNING').length
		};
	});

	const links = $derived(
		anime
			? [
					{ label: 'AniList', href: anime.links.anilist, bg: 'bg-[#3db4f2]', mal: null },
					{ label: 'Annict', href: anime.links.annict, bg: 'bg-[#f06]', mal: null },
					{
						label: 'MyAnimeList',
						href: anime.links.mal,
						bg: 'bg-[#2e51a2]',
						mal: malIdOf(anime.id)
					}
				].filter((l): l is typeof l & { href: string } => l.href !== null)
			: []
	);
</script>

{#snippet avatar(name: string, url: string | null, size: string)}
	{#if url}
		<img
			src={proxied(url)}
			alt=""
			referrerpolicy="no-referrer"
			class="shrink-0 rounded-full object-cover {size}"
		/>
	{:else}
		<span
			class="flex shrink-0 items-center justify-center rounded-full bg-zinc-300 text-xs font-bold text-zinc-700 {size}"
			aria-hidden="true">{[...name][0] ?? '?'}</span
		>
	{/if}
{/snippet}

{#snippet userList(list: typeof watchers)}
	<ul class="flex flex-col gap-1.5">
		{#each list as w (w.user.id)}
			<li class="flex items-center gap-2">
				{@render avatar(w.user.name, w.user.avatarUrl, 'size-5')}
				<a
					href={w.user.url}
					target="_blank"
					rel="noreferrer noopener"
					class="min-w-0 flex-1 truncate hover:underline">{w.user.name}</a
				>
				<span
					class="rounded px-1 text-[10px] font-bold text-white {SERVICE[w.user.service].bg}"
					title={SERVICE[w.user.service].label}>{SERVICE[w.user.service].badge}</span
				>
				<span
					class="rounded px-1.5 py-0.5 text-xs {w.status === 'WATCHING'
						? 'bg-emerald-600 font-bold text-white'
						: 'bg-zinc-200 text-zinc-600'}">{STATUS_LABEL[w.status]}</span
				>
			</li>
		{/each}
	</ul>
{/snippet}

{#if user || anime}
	<section
		role="complementary"
		aria-label="詳細"
		data-testid="detail-panel"
		onmouseenter={() => onenter?.()}
		onmouseleave={() => onleave?.()}
		class="absolute top-3 right-3 z-10 max-h-[calc(100dvh-1.5rem-5rem)] w-80 overflow-y-auto rounded-lg bg-white/90 p-4 text-sm shadow-md backdrop-blur"
	>
		{#if anime}
			<div class="flex items-start gap-3">
				{#if anime.imageUrl}
					<img
						src={anime.imageUrl}
						alt={anime.title}
						referrerpolicy="no-referrer"
						class="w-28 shrink-0 rounded"
					/>
				{/if}
				<h2 class="min-w-0 text-base font-bold break-words">{anime.title}</h2>
			</div>

			{#if links.length > 0}
				<div class="mt-3 flex flex-wrap items-center gap-2">
					{#each links as l (l.label)}
						<a
							href={l.href}
							target="_blank"
							rel="noreferrer noopener"
							class="rounded-md px-2 py-1 text-xs font-bold text-white hover:opacity-80 {l.bg}"
							>{l.label}{#if l.mal}<span class="ml-1 font-normal opacity-80">MAL #{l.mal}</span
								>{/if}</a
						>
					{/each}
				</div>
			{/if}

			{#if watching.length > 0}
				<h3 class="mt-4 mb-1 font-semibold">観ている人（{watching.length} 人）</h3>
				{@render userList(watching)}
			{/if}
			{#if planning.length > 0}
				<h3 class="mt-4 mb-1 font-semibold">見たい人（{planning.length} 人）</h3>
				{@render userList(planning)}
			{/if}
		{:else if user}
			<div class="flex items-center gap-3">
				{@render avatar(user.name, user.avatarUrl, 'size-12')}
				<div class="min-w-0">
					<a
						href={user.url}
						target="_blank"
						rel="noreferrer noopener"
						class="text-base font-bold break-words hover:underline">{user.name}</a
					>
					<div>
						<span
							class="rounded px-1.5 py-0.5 text-[10px] font-bold text-white {SERVICE[user.service]
								.bg}">{SERVICE[user.service].label}</span
						>
					</div>
				</div>
			</div>
			<p class="mt-3">{user.size} 作品</p>
			<p class="text-zinc-600">
				視聴中 {userCounts.watching} · 視聴済み {userCounts.watched} · 見たい {userCounts.planning}
			</p>
		{/if}
	</section>
{/if}
