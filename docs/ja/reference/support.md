# 対応状況

以下は対応範囲と現時点の検証度です。リクエスト単位の検証は表に明記したホストのみを対象とし、すべてのバージョンに対する互換性の約束ではありません。

## まず浄化方式

ホストが用意する入口は 2 種類あり、ペルソナがホストの身元を**置き換える**のか、単に**追記する**のかが決まります：

| 浄化方式 | 意味 | ホスト |
|---|---|---|
| 置換 | ホストが system prompt 全体の入口を提供し、ペルソナが元のプロンプトを置き換える | Codex、OpenCode、DSH、Gemini CLI、Qwen、Qoder、Kimi、Kiro、CodeBuddy、Grok、omp、Claude* |
| 部分 | 置換は効くが、ホストが自前の身元文を前置する | Claude Code（62 文字の身元文が残る）、Kilo Code（`soul()` が "You are Kilo" を前置） |
| 追記 | **全体置換の入口がなく、ペルソナは追記されるだけ。元の身元はプロンプトに残る** | Antigravity（+517 文字）、Crush、Continue、Auggie、Goose、zcode |
| 未検証 | system prompt の文字数の実測がなく、浄化済みとは謳いません | pi、pi-desktop、WorkBuddy、WorkBuddy AI |

\* Claude はバイナリパッチの有無で部分置換と完全置換の両方になり得ますが、本リポジトリにそのパッチは含まれません。

判定と実測値は `matrix.json` の `purgeKind` にあり、テストが `defaultSystemChars`/`purgedSystemChars` と整合することを強制します。`purgeKind` 未指定は置換とみなします。

## 内蔵セーフティ条項の実測

何が削除されるかは、ホストがセーフティ条項をどこに書くかで決まります。11 ホストの分離 HOME・4 モードのキャプチャで、off 状態と浄化後の system prompt に含まれる「拒否 / コンテンツポリシー / ジェイルブレイク対策 / 有害利用」条項を数えました：

| ホスト | off 状態の system | 内蔵セーフティ条項 | 浄化後 | 備考 |
|---|---|---|---|---|
| CodeBuddy | 17,262 | 13 | 0 | 完全な `<content_policy>`：政治的に敏感な話題、ポルノ、違法行為（武器・爆発物・未授权のハッキング・詐欺・資金洗浄・薬物）、プライバシー漏洩、誹謗。いずれも MUST refuse |
| Claude | 27,237 | 3 | 0 | DoS / 大規模標的型 / サプライチェーン破壊 / 検出回避を拒否。疑わしい prompt injection の報告も指示 |
| Kilo | 13,717 | 1 | 0 | 唯一の命中は逆方向の「助けられないなら代替案を出し、説教するな」 |
| OpenCode | 14,351 | 1 | 0 | 同上、逆方向の表現 |
| Codex | 23,759 | 0 | 0 | 唯一の `policy` 命中は Approval policy（サンドボックス権限）で、コンテンツポリシーではない |
| Antigravity | 15,824 | 0 | 0 | `<identity>` / `<guidelines>` / `<artifacts>` / `<subagents>` / `<skills>` のみ。削除対象が存在しない |
| DSH / Grok / omp / opencode2 / pi | — | 0 | 0 | system prompt 内にセーフティ条項なし |

**結論**：内蔵セーフティ条項が実在するのは CodeBuddy と Claude のみで、どちらも replace 後にゼロになります。Antigravity はプロンプト内に 1 条も持たず、遮断は Google 側のポリシー分類器で発生するため purge の対象外です。zcode は CLI 未導入のため未キャプチャです。

計測基準：強シグナルの正規表現のみ（refuse / content policy / harmful / jailbreak / weapons など）。通常のコーディング規範に現れる `must not` は除外します。

## 対応マトリクス

| ホスト | 検証バージョン | 主なチャネル | ホットスイッチ | 浄化方式 | 備考 |
|---|---|---|---|---|---|
| pi | 1.4.0 | セッション拡張 | 対応（`/purge`） | 未検証 | 動的拡張を実測。4 モードのキャプチャ済み |
| omp | 18.14.1 | プラグイン | 対応 | 置換 | MCP tool routes は引き続き追記（約 10K） |
| OpenCode 1.x / 2.x | 1.19.5 / 2.2.5 | プラグイン | 対応 | 置換 | 19332 → 112 |
| DSH | 0.2.1-rc.5 | 設定 / SDK / プラグイン | 対応 | 置換 | headless / web / desktop すべてキャプチャ済み |
| Codex | 0.166.0 | 起動引数 / ルール | 新規セッション | 置換 | 21026 → 24 |
| Claude Code | 2.1.316 | 起動引数 / ルール | 新規セッション | 部分置換 | バイナリパッチなしでは 62 文字の身元文が残る |
| CodeBuddy | 2.179.0 | 起動引数 / ルール | 新規セッション | 置換 | `<content_policy>` 13 条がゼロに |
| Grok | 1.0.73 | 起動引数 / ルール | 新規セッション | 置換 | 5146 → 21 |
| Qwen Code | 0.27.2 | `--system-prompt` / `--append-system-prompt` | 新規セッション | 置換 | 長いペルソナはコマンドライン長の制限を受ける |
| Gemini CLI | 0.68.0 | `GEMINI_SYSTEM_MD` | 新規セッション | 置換 | `PromptProvider` が core system prompt を置換 |
| Crush | v0.100.0 | `CRUSH.md` / AGENTS.md | 新規セッション | 追記 | システムコンテキストを追記。アトミックで可逆 |
| Continue CLI | 1.5.47 | `--rule` | 新規セッション | 追記 | ルール/コンテキストを追記 |
| Qoder CLI | 1.1.87 | `--system-prompt` / `--append-system-prompt` | 新規セッション | 置換 | 両入口を検証済み |
| Kimi Code | 2.5.3 | `--agent-file` | 新規セッション | 置換 | Markdown 本文が system prompt を置換 |
| Auggie CLI | 0.37.1 | `--rules` | 新規セッション | 追記 | ルール/コンテキストを追記 |
| Goose | 1.59.0 | `session/run --system` | 新規セッション | 追記 | システム指示を追記 |
| Kiro CLI | 3.2.0 | `--agent` / カスタムエージェント | 新規セッション | 置換 | カスタム agent の `prompt` が system prompt を置換 |
| Kilo Code | @kilocode/cli 7.8.18 | `code.md` / AGENTS.md | 新規セッション | 部分置換 | `soul()` が "You are Kilo" を前置 |
| Antigravity (agy) | CLI 1.5.3 / LS 1.23.x | `~/.gemini/config/AGENTS.md` | 新規セッション | 追記 | `<identity>` はそのまま。15378 → 15895 |
| zcode | 3.16.3 | 設定 / フック | 新規セッション | 追記 | CLI は customSystemPrompt を取れず 9359 → 9359 |
| WorkBuddy / WorkBuddy AI | 5.9.3 / 5.9.4 | `app-config.json` | 新規セッション | 未検証 | 設定書き込みを実測 |
| pi-desktop | 0.21.0 | `SYSTEM.md` / プラグイン | 対応（次ターン） | 未検証 | 常駐設定と imported プラグインを実測 |

## 詳細記録

ホスト別の 4 モードのキャプチャ結果・異常・既知の落とし穴は[互換性と既知の制限](/reference/compatibility)（中文）にあります。