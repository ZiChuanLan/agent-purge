# はじめに

## 動作要件

**Node.js 20+** と、管理対象のコーディングエージェントがローカルにインストールされている必要があります。agent-purge 自体はモデルも認証情報も同梱しません。

## インストール

```bash
npm install -g agent-purge
agent-purge web
```

グローバルインストールなしで直接実行することもできます：

```bash
npx agent-purge web
```

## 最初の 3 ステップ

1. 「ペルソナライブラリ」で初期テンプレートを編集するか、新しいペルソナを作成します。
2. 「コンソール」でペルソナとモードを選んで保存し、対象エージェントを有効化します。
3. エージェントごとの案内に従い、プラグインを再読み込みするか新規セッションを開始します。

コンソールは既定で `http://127.0.0.1:7788` をリッスンします。ポートが予約済み・使用中の場合は `7890–7909` の空きポートへ順に移り、独立したデスクトップウィンドウを開きます。**初回起動時に何も自動接収しません。**

## インストール形式

| 形式 | 動作要件 | 用途 |
|---|---|---|
| npm | Node.js 20+ | 標準的なクロスプラットフォーム導入・更新 |
| `agent-purge-<version>-setup.exe` | Windows、外部 Node.js 20+ | GUI インストール・アンインストール |
| `agent-purge-<version>.zip` | Windows、外部 Node.js 20+ | 解凍して利用するポータブル版 |
| `agent-purge.exe` | Windows x64、ランタイム内蔵 | Node 未導入環境向けのスタンドアロン版 |
| `agent-purge-<version>-darwin-arm64.dmg` / `x64.dmg` | macOS 12+（ランタイム内蔵） | 未署名 `.app`。初回は右クリック→開く、または `xattr -cr` |
| `agent-purge-<version>-linux-x64` / `-linux-arm64` | 主要 Linux ディストリビューション | 単一バイナリ。`chmod +x` で実行 |
| `agent-purge-<version>-linux-<arch>.tar.gz` | 主要 Linux ディストリビューション | `.desktop`、アイコン、root 不要の `install.sh` を含む |
| `agent-purge-<version>-linux-<arch>.deb` | Debian / Ubuntu 系 | `sudo apt install ./*.deb` |
| `agent-purge-<version>-linux-<arch>.AppImage` | 主要 Linux ディストリビューション（生成時のみ） | ダブルクリック、または `--appimage-extract-and-run` |

バイナリは [GitHub Releases](https://github.com/ZiChuanLan/agent-purge/releases) から取得してください。未リリース版には添付がありません。SHA-256 と署名状態を確認してください。ZIP 内の EXE は薄いランチャーであり、スタンドアロン版ではありません。

SSH / WSL などヘッドレス環境では `agent-purge web --no-open` を使います。Web はループバックのみをリッスンします。

## アップグレード

コンソール右上のバージョンバッジが、インストール形態に応じた更新経路を開きます：

- スタンドアロン EXE：ダウンロードしてその場で差し替え
- npm グローバル：`npm install -g` を実行
- **ソースチェックアウト**（`git clone` 後に `node bin/agent-purge.mjs`）：インストールディレクトリで `git pull --ff-only` を実行し、リリース成果物は取得しません

ソースチェックアウトの更新判定は上流コミットで行うため、バージョン番号が同じでも更新と表示されることがあります。未コミットの変更、detached HEAD、上流のないブランチでは理由を添えて拒否します。

## 次に読む

- [ペルソナとモード](/ja/guide/personas-and-modes) —— 4 つのモードが実際に変えるもの
- [適用範囲](/ja/guide/scope) —— 単発起動・常駐・コマンド接管・プロジェクトルール
- [対応状況](/ja/reference/support) —— ホスト別の実測浄化と残留