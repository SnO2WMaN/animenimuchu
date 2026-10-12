import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	ANNICT_ACCESS_TOKEN: {
		description:
			'Annict の個人用アクセストークン（https://annict.com/settings/apps で発行）．未設定なら Annict のユーザーは取得しない．',
		schema: (value) => value || undefined
	},
	COVERS_PUBLIC_URL: {
		description:
			'R2 の公開 URL（例 https://pub-xxxx.r2.dev，または独自ドメイン）．設定すると /img/* はここへのリダイレクトになる．未設定なら，R2 バインディングから直接配信する（開発用）．',
		schema: (value) => value || undefined
	}
});
