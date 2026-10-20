# hanamaru

音楽教室の予約・回数券システム。

- 要件定義書: [docs/requirements.md](docs/requirements.md)
- 設計の決定: [docs/decisions/](docs/decisions/)
- フェーズ0 検証報告: [docs/phase0-report.md](docs/phase0-report.md)
- 運用手順書: [docs/operations.md](docs/operations.md)
- 開発のルール: [CLAUDE.md](CLAUDE.md)

```sh
pnpm install
pnpm dev     # 開発用サーバー（DB・決済は不要）と3つの画面
pnpm test    # 受入テスト
pnpm e2e     # 画面の通しテスト
```
