---
layout: home

hero:
  name: agent-purge
  text: 1つのペルソナで、複数のコーディングエージェントを
  tagline: ローカル完結のプロンプト／ペルソナ制御コンソール · 本番依存ゼロ · 書き込みはバイト単位で復元
  image:
    src: /images/logo.svg
    alt: agent-purge
  actions:
    - theme: brand
      text: はじめに
      link: /ja/guide/getting-started
    - theme: alt
      text: 対応状況
      link: /ja/reference/support
    - theme: alt
      text: GitHub
      link: https://github.com/ZiChuanLan/agent-purge

features:
  - title: 1つの設定、多彩な入口
    details: CLI と Web がペルソナと管理状態を共有。単発起動、常駐設定、セッション内 <code>/purge</code>、プロジェクトルールに対応します。
  - title: エージェントごとの独立設定
    details: 既定では全体設定に追従しつつ、特定のエージェントにだけペルソナとモードを割り当てられます。実測で動くチャネルしか表示しません。
  - title: ホットスイッチと明確な境界
    details: 毎ターン再構築するエージェントは次ターンで反映、静的設定は新規セッションが必要。その違いを UI に明示します。
  - title: バイト単位で復元
    details: 書き込み前に元バイトを退避し、解除時に完全復元。プロジェクトルールは diff プレビューと SHA 競合検出つき。
  - title: ローカルファースト
    details: 外部バックエンドなし、設定のアップロードなし。データは <code>~/.agent-purge/</code> に置かれ、更新でも上書きされません。
  - title: 主張ではなく実測
    details: ホストごとの浄化効果・内蔵セーフティ条項・残留は分離 HOME の実キャプチャに基づき、矛盾する数値はテストが落とします。
---

## 何を解決するか

各コーディングエージェントは独自のシステムプロンプトを持っています。製品アイデンティティ、行動規範、拒否条項、ツール説明。自分のやり方で協働するにはホストごとに別の設定を書き換える必要があり、失敗すると戻すのが大変です。

agent-purge はそれらの入口を 1 か所にまとめます。**同じペルソナを、選んだホストへ。同じコマンドで、元の状態へ。**

## 2 つの使い方

::: code-group

```bash [コンソール]
agent-purge web
```

```bash [CLI]
agent-purge codex --mode replace
agent-purge use concise
agent-purge arm pi --slash
```

:::

## まず実測を見る

ホストごとに浄化能力は大きく異なり、このプロジェクトはその差を明記します：

- **完全置換**：Codex、OpenCode、DSH、Claude、Gemini CLI、Qwen、Qoder、Kimi、Kiro、CodeBuddy、Grok、omp —— ホストが system prompt 全体の入口を提供します。
- **部分置換**：Claude（62 文字の身元文が残留）、Kilo（`soul()` が身元を前置）。
- **追記のみ**：Antigravity、Crush、Continue、Auggie、Goose、zcode —— 全体入口がなく、元の身元がプロンプトに残ります。

ホスト別の根拠・実測値・内蔵セーフティ条項は[対応状況](/ja/reference/support)にあります。

## コンソール

![agent-purge コンソール](/images/console-desktop.png)

![agent-purge プロジェクトルール](/images/project-rules.png)
