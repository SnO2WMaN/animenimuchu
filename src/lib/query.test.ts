import { describe, expect, it } from 'vitest';
import { buildQuery, prettifyQuery } from './query.ts';

describe('buildQuery', () => {
	it('空なら空文字列', () => {
		expect(buildQuery([])).toBe('');
		expect(buildQuery([{ service: 'annict', name: '  ' }])).toBe('');
	});
	it('1 人', () => {
		expect(buildQuery([{ service: 'anilist', name: 'c' }])).toBe('?user=anilist:c');
	});
	it('行の順序を保つ', () => {
		expect(
			buildQuery([
				{ service: 'annict', name: 'a' },
				{ service: 'anilist', name: 'b' },
				{ service: 'annict', name: 'c' }
			])
		).toBe('?user=annict:a,anilist:b,annict:c');
	});
	it('同一サービス・同一名（大文字小文字無視）の重複をまとめる', () => {
		expect(
			buildQuery([
				{ service: 'annict', name: 'a' },
				{ service: 'anilist', name: 'a' },
				{ service: 'annict', name: 'A' }
			])
		).toBe('?user=annict:a,anilist:a');
	});
	it('@ と空白を除き，空の行を無視する', () => {
		expect(
			buildQuery([
				{ service: 'annict', name: ' @a ' },
				{ service: 'anilist', name: '' }
			])
		).toBe('?user=annict:a');
	});
	it('名前にカンマがあれば分割する', () => {
		expect(buildQuery([{ service: 'annict', name: 'a,b' }])).toBe('?user=annict:a,annict:b');
	});
});

describe('prettifyQuery', () => {
	it('%3A と %2C を戻す', () => {
		expect(prettifyQuery('https://x.test/?user=annict%3Aa%2Canilist%3Ab')).toBe(
			'https://x.test/?user=annict:a,anilist:b'
		);
		expect(prettifyQuery('?user=annict%3aa%2canilist%3Ab')).toBe('?user=annict:a,anilist:b');
	});
	it('他はそのまま', () => {
		expect(prettifyQuery('https://x.test/?q=%E3%81%82')).toBe('https://x.test/?q=%E3%81%82');
	});
});
