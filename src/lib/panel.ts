export const PANEL_HIDE_DELAY_MS = 300;

/**
 * 詳細パネルに渡す ID（shown）を決める．
 * - focused が非 null なら即座に shown = focused．
 * - focused が null で，マウスがパネル上にあれば shown を維持する．
 * - そうでなければ delay ms 後に shown = null（その間に状態が変わるなら，戻り値の cancel で取り消す）．
 */
export const trackShown = (
	focused: string | null,
	panelHover: boolean,
	current: string | null,
	setShown: (id: string | null) => void,
	delay: number = PANEL_HIDE_DELAY_MS
): (() => void) => {
	if (focused !== null) {
		if (focused !== current) setShown(focused);
		return () => {};
	}
	if (panelHover || current === null) return () => {};
	const timer = setTimeout(() => setShown(null), delay);
	return () => clearTimeout(timer);
};

export const malIdOf = (animeId: string): string | null =>
	/^anime:mal:(.+)$/.exec(animeId)?.[1] ?? null;
