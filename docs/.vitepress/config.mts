import { defineConfig } from "vitepress";

const REPO = "https://github.com/ZiChuanLan/agent-purge";

export default defineConfig({
	lang: "zh-CN",
	title: "agent-purge",
	description: "一份人设，统一接管本机多个 coding agent。",
	base: "/agent-purge/",
	cleanUrls: true,
	head: [
		["link", { rel: "icon", type: "image/svg+xml", href: "/agent-purge/images/logo.svg" }],
		["meta", { name: "theme-color", content: "#0b0f14" }],
	],
	// LICENSE 指向仓库根文件，站点内不存在；它由 README/LEGAL 共用，不能改成站内路由
	ignoreDeadLinks: [/LICENSE$/],
	sitemap: { hostname: "https://zichuanlan.github.io/agent-purge/" },

	locales: {
		root: {
			label: "简体中文",
			lang: "zh-CN",
			themeConfig: {
				nav: [
					{ text: "指南", link: "/guide/getting-started", activeMatch: "/guide/" },
					{ text: "参考", link: "/reference/support", activeMatch: "/reference/" },
					{ text: "发布记录", link: "/releases/v0.2.29" },
					{ text: "合规", link: "/LEGAL" },
				],
				sidebar: {
					"/guide/": [
						{
							text: "指南",
							items: [
								{ text: "快速开始", link: "/guide/getting-started" },
								{ text: "人设与模式", link: "/guide/personas-and-modes" },
								{ text: "界面一览", link: "/guide/interfaces" },
								{ text: "应用范围", link: "/guide/scope" },
								{ text: "暂停与卸载", link: "/guide/pause-and-uninstall" },
							],
						},
					],
					"/reference/": [
						{
							text: "参考",
							items: [
								{ text: "支持情况", link: "/reference/support" },
								{ text: "兼容性与已知限制", link: "/reference/compatibility" },
								{ text: "命令行参考", link: "/reference/cli" },
								{ text: "架构", link: "/reference/architecture" },
							],
						},
						{
							text: "发布",
							items: [{ text: "发布流程", link: "/releasing" }],
						},
					],
				},
				editLink: { pattern: `${REPO}/edit/main/docs/:path`, text: "在 GitHub 上编辑此页" },
				lastUpdated: { text: "最后更新" },
				docFooter: { prev: "上一页", next: "下一页" },
				outline: { label: "本页目录", level: [2, 3] },
				langMenuLabel: "切换语言",
				darkModeSwitchLabel: "主题",
				sidebarMenuLabel: "目录",
				returnToTopLabel: "回到顶部",
			},
		},
		en: {
			label: "English",
			lang: "en-US",
			link: "/en/",
			themeConfig: {
				nav: [
					{ text: "Guide", link: "/en/guide/getting-started", activeMatch: "/en/guide/" },
					{ text: "Reference", link: "/en/reference/support", activeMatch: "/en/reference/" },
					{ text: "Legal", link: "/en/LEGAL" },
				],
				sidebar: {
					"/en/guide/": [
						{
							text: "Guide",
							items: [
								{ text: "Getting started", link: "/en/guide/getting-started" },
								{ text: "Personas and modes", link: "/en/guide/personas-and-modes" },
								{ text: "Console", link: "/en/guide/interfaces" },
								{ text: "Scope", link: "/en/guide/scope" },
								{ text: "Pause and uninstall", link: "/en/guide/pause-and-uninstall" },
							],
						},
					],
					"/en/reference/": [
						{
							text: "Reference",
							items: [
								{ text: "Support matrix", link: "/en/reference/support" },
								{ text: "Compatibility and limits (中文)", link: "/reference/compatibility" },
								{ text: "CLI reference (中文)", link: "/reference/cli" },
								{ text: "Architecture (中文)", link: "/reference/architecture" },
							],
						},
					],
				},
				editLink: { pattern: `${REPO}/edit/main/docs/en/:path`, text: "Edit this page on GitHub" },
				lastUpdated: { text: "Last updated" },
				outline: { label: "On this page", level: [2, 3] },
				langMenuLabel: "Change language",
				darkModeSwitchLabel: "Appearance",
				sidebarMenuLabel: "Menu",
				returnToTopLabel: "Return to top",
			},
		},
		ja: {
			label: "日本語",
			lang: "ja-JP",
			link: "/ja/",
			themeConfig: {
				nav: [
					{ text: "ガイド", link: "/ja/guide/getting-started", activeMatch: "/ja/guide/" },
					{ text: "リファレンス", link: "/ja/reference/support", activeMatch: "/ja/reference/" },
					{ text: "法的情報", link: "/ja/LEGAL" },
				],
				sidebar: {
					"/ja/guide/": [
						{
							text: "ガイド",
							items: [
								{ text: "はじめに", link: "/ja/guide/getting-started" },
								{ text: "ペルソナとモード", link: "/ja/guide/personas-and-modes" },
								{ text: "コンソール", link: "/ja/guide/interfaces" },
								{ text: "適用範囲", link: "/ja/guide/scope" },
								{ text: "一時停止とアンインストール", link: "/ja/guide/pause-and-uninstall" },
							],
						},
					],
					"/ja/reference/": [
						{
							text: "リファレンス",
							items: [
								{ text: "対応状況", link: "/ja/reference/support" },
								{ text: "互換性と既知の制限（中文）", link: "/reference/compatibility" },
								{ text: "CLI リファレンス（中文）", link: "/reference/cli" },
								{ text: "アーキテクチャ（中文）", link: "/reference/architecture" },
							],
						},
					],
				},
				editLink: { pattern: `${REPO}/edit/main/docs/ja/:path`, text: "GitHub でこのページを編集" },
				lastUpdated: { text: "最終更新" },
				outline: { label: "目次", level: [2, 3] },
				langMenuLabel: "言語を切り替える",
				darkModeSwitchLabel: "テーマ",
				sidebarMenuLabel: "メニュー",
				returnToTopLabel: "トップへ戻る",
			},
		},
	},

	themeConfig: {
		logo: "/images/logo.svg",
		socialLinks: [{ icon: "github", link: REPO }],
		search: {
			provider: "local",
			options: {
				locales: {
					root: { translations: { button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" } } },
					en: { translations: { button: { buttonText: "Search", buttonAriaLabel: "Search docs" } } },
					ja: { translations: { button: { buttonText: "検索", buttonAriaLabel: "ドキュメントを検索" } } },
				},
			},
		},
		footer: {
			message: "本地提示词与人设编排控制台",
			copyright: "MIT Licensed",
		},
	},
});
