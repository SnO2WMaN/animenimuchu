# AGENTS.md

## 作業の分担

- 設計（構成・データモデル・ライブラリ選定・API の仕様・実装方針の決定）は上位モデル（Claude Opus）が行う．
- 実装（コードの記述・修正，テストの追加，ドキュメントの更新などの手作業）は Sonnet や Haiku などの軽量なモデルのサブエージェントに任せる．
  - 指示には，変更の範囲，守るべき仕様・既存の規約，検証方法（実行するコマンドと期待する結果）を具体的に書く．
  - 上位モデルはサブエージェントの報告を鵜呑みにせず，差分と検証結果を確認してから完了とする．
- 調査やデバッグで原因を特定するところまでは上位モデルが行い，判明した修正方針ごと実装を渡す．

## 概要

複数人のアニメの視聴状況（Annict，AniList）を，ユーザーと作品のグラフとして可視化するアプリ．
SvelteKit 3（Svelte 5 の runes）で，フロントエンドと API を 1 つにまとめ，Cloudflare Pages にデプロイする．

- 同じ作品は MyAnimeList の ID で同一視してマージする．
- サムネイルは AniList のカバー画像を使う．AniList の API のレート制限に備え，MAL ID からの逆引き結果を D1 に，画像そのものを R2 にキャッシュ（ミラー）する．キャッシュ・ミラーが無い環境でも動くこと．
- グラフの描画（sigma + graphology）は，ブラウザ専用なのでクライアントでのみ読み込む．

## 規約

- パッケージマネージャは bun．
- ファイルは関心事ごとにまとめ，小さなファイルを増やさない．`+server.ts` は HTTP メソッド以外を export できないので，テストする純粋関数は `lib` に置く．
- `#lib/...` の import には拡張子を付ける．
- CommonJS のパッケージは名前付き import せず default import から取る（dev の SSR で壊れる．ビルドと vitest では気付けないので，import を追加したら `bun run dev` でも確認する）．
- 変更後は `bun run check`，`bun run test`，`bun run build` が通ることを確認する．画面に関わる変更は，実際にブラウザ（Chromium）で確認する．
- Annict の GraphQL API はトークン必須（環境変数 `ANNICT_ACCESS_TOKEN`）．AniList は不要．
- ユーザー指定の URL は `?user=<サービス>:<名前>,...`（サービスは `annict` / `anilist`）．旧形式の `?annict=`/`?anilist=` は廃止．
- 動作確認用のサンプルユーザーは Annict が `tosuke`，`rinsuki`，AniList が `sno2wman`．
- Cloudflare のアカウントに対する操作（リソースの作成，リモートへの migration，デプロイなど）は，人間が行う．エージェントは実行しない．

## 設計メモの置き場

ファイルの構成，ファイルパス，リソース名，本番の手順など，変わりやすい・ローカルな内容は，このファイルには書かない．
git 管理しない `.claude/` 配下（`.claude/CLAUDE.md`）に置く．
