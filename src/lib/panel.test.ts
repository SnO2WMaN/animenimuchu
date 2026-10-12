import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { malIdOf, trackShown } from './panel.ts';

describe('trackShown', () => {
	let shown: string | null;
	const set = (id: string | null) => (shown = id);
	beforeEach(() => {
		vi.useFakeTimers();
		shown = null;
	});
	afterEach(() => vi.useRealTimers());

	it('focused が非 null なら即座に反映する', () => {
		trackShown('a', false, shown, set);
		expect(shown).toBe('a');
	});

	it('focused が null になっても 300ms は維持し，その後消える', () => {
		shown = 'a';
		trackShown(null, false, shown, set);
		vi.advanceTimersByTime(299);
		expect(shown).toBe('a');
		vi.advanceTimersByTime(1);
		expect(shown).toBeNull();
	});

	it('パネル上にマウスがあれば消えない', () => {
		shown = 'a';
		trackShown(null, true, shown, set);
		vi.advanceTimersByTime(1000);
		expect(shown).toBe('a');
	});

	it('cancel すると消えない（猶予中にパネルに入った場合など）', () => {
		shown = 'a';
		const cancel = trackShown(null, false, shown, set);
		vi.advanceTimersByTime(200);
		cancel();
		vi.advanceTimersByTime(1000);
		expect(shown).toBe('a');
	});

	it('パネルから出て focused が null なら 300ms 後に消える', () => {
		shown = 'a';
		trackShown(null, false, shown, set);
		vi.advanceTimersByTime(300);
		expect(shown).toBeNull();
	});
});

describe('malIdOf', () => {
	it('MAL の ID を取り出す', () => {
		expect(malIdOf('anime:mal:123')).toBe('123');
		expect(malIdOf('anime:annict:5')).toBeNull();
	});
});
