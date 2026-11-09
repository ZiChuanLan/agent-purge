// 假 DOM + 假 magpie，直接跑真实的 page/app.js。
// 真页面跑在 magpie 沙箱里，这里只验逻辑：搜索过滤、options 合并（agents 不丢）、
// 连点不丢、保存失败回滚。跑法：node test/magpie/page.test.mjs
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const appSrc = readFileSync(new URL("../../magpie-plugin/page/app.js", import.meta.url), "utf8");

class Node {
	constructor(tag = "div") {
		this.tag = tag;
		this.children = [];
		this.dataset = {};
		this.attrs = {};
		this.className = "";
		this.value = "";
		this.title = "";
		this.disabled = false;
		this.hidden = false;
		this.checked = false;
		this._text = "";
	}
	set textContent(v) {
		this._text = String(v);
		this.children = [];
	}
	get textContent() {
		return this._text;
	}
	append(...kids) {
		for (const k of kids) this.children.push(k);
	}
	setAttribute(k, v) {
		this.attrs[k] = String(v);
	}
}

const ids = [
	"now-persona",
	"now-mode",
	"mode",
	"q",
	"list",
	"status",
	"count",
	"file",
	"body",
	"pid",
	"pname",
	"import-save",
	"import-reset",
	"del-all",
	"import-count",
	"import-err",
	"scope-all",
	"scope-include",
	"scope-exclude",
	"agents-panel",
	"agents-list",
	"custom-agent",
	"add-agent-btn",
];
const nodes = Object.fromEntries(ids.map((id) => [id, new Node()]));
// index.html 上 #status / #import-err 带 hidden，app.js 必须自己解开它
nodes.status.hidden = true;
nodes["import-err"].hidden = true;
nodes["agents-panel"].hidden = true;
const document = { getElementById: (id) => nodes[id], createElement: (tag) => new Node(tag) };
class Option {
	constructor(text, value) {
		this.text = text;
		this.value = value;
	}
}

// 假时钟：把 1 秒限流变成瞬时，测试才能确定性地跑完
const realSetTimeout = globalThis.setTimeout;
let clock = 1_000_000;
const fakeSetTimeout = (fn) => {
	clock += 5000;
	queueMicrotask(fn);
	return 0;
};

const PERSONAS = [
	{ id: "terse", name: "极简", description: "只回答，不解释" },
	{ id: "neutral", name: "中性助手", description: "最小身份" },
	{ id: "ctf", name: "ctf", description: "" },
];
const window = { PERSONAS };

const calls = [];
let store = { persona: "terse", mode: "append", agents: ["claude"] };
let failNext = false;
const magpie = {
	ready: Promise.resolve(),
	options: {
		async get() {
			return { ...store };
		},
		async set(o) {
			calls.push({ ...o });
			if (failNext) {
				failNext = false;
				throw new Error("boom");
			}
			store = { ...o };
			return { ...store };
		},
	},
};

const tick = () => new Promise((r) => realSetTimeout(r, 0));
// 按钮的文字在子节点里，取整棵子树的文本
const textOf = (n) => (n._text ?? "") + (n.children ?? []).map(textOf).join(" ");
const ok = (cond, msg) => {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else console.log(`✓ ${msg}`);
};
const btn = (name) => nodes.list.children.find((b) => textOf(b).includes(name));

// page/app.js 是 classic script（不是 module），在沙箱里跑就和浏览器里一样
runInNewContext(appSrc, {
	magpie,
	document,
	Option,
	window,
	Promise,
	setTimeout: fakeSetTimeout,
	Date: { now: () => clock },
});
await tick();

// 1) 初始渲染：当前设置、状态行可见、模式下拉、人设列表
ok(nodes["now-persona"].textContent === "极简", "当前人设显示名字而不是 id");
ok(nodes["now-mode"].textContent === "append", "当前模式已显示");
ok(nodes.status.hidden === false, "状态行不再被 hidden 藏住（原 bug）");
ok(nodes.mode.children.length === 5, "模式下拉有 5 项（含跟随）");
ok(nodes.mode.value === "append", "模式下拉回显已保存的值");
ok(nodes.list.children.length === 3, "人设列表渲染了 3 个");
ok(nodes.count.textContent === "全部 3", "标题显示总数");
ok(nodes.status.textContent.includes("只对 claude 生效"), "状态行提示 agents 过滤仍然生效");

// 2) 搜索框真的过滤（原 bug：从未绑定）
nodes.q.value = "极简";
nodes.q.oninput();
ok(nodes.list.children.length === 1 && textOf(nodes.list.children[0]).includes("极简"), "搜索「极简」只剩 1 个");
ok(nodes.count.textContent === "匹配 1 / 3", "标题跟着过滤结果变");
nodes.q.value = "zzz";
nodes.q.oninput();
ok(nodes.list.children.length === 1 && nodes.list.children[0].className === "empty", "搜不到时给出空状态");
nodes.q.value = "";
nodes.q.oninput();

// 3) 点人设：options.set 必须带上原有的 agents（原 bug：整对象覆盖，丢用户 CLI 配置）
btn("中性助手").onclick();
await tick();
const first = calls.at(-1);
ok(first.persona === "neutral", "点击写入 persona");
ok(JSON.stringify(first.agents) === '["claude"]', "agents 过滤被保留，没有被覆盖掉（原 bug）");
ok(first.mode === "append", "没动的 mode 原样带回去");

// 4) 模式下拉：改 mode 不能丢 persona / agents
nodes.mode.value = "strict";
nodes.mode.onchange({ target: nodes.mode });
await tick();
const byMode = calls.at(-1);
ok(byMode.mode === "strict", "改 mode 会写进 options");
ok(byMode.persona === "neutral" && JSON.stringify(byMode.agents) === '["claude"]', "改 mode 时 persona 和 agents 都在");

// 5) 连点两次：不能丢最后一次（原 bug：1.1s 内直接 return）
btn("ctf").onclick();
btn("中性助手").onclick();
await tick();
ok(store.persona === "neutral", "第二次连点生效（最终状态以最后一次为准）");

// 6) 保存失败要回滚，不能显示假状态
failNext = true;
btn("ctf").onclick();
await tick();
ok(nodes.status.dataset.state === "error", "失败时状态行标成 error");
ok(nodes.status.textContent.includes("保存失败"), "失败时显示原因");
ok(nodes["now-persona"].textContent === "中性助手", "失败后 UI 回滚到已保存的值（原 bug：乐观更新不回滚）");

// 7) 导入 md：选文件 → 自动填 id/名字 → 存进 options，并直接选中
const raw = "---\nname: 我的人设\ndescription: 自测\n---\nBe mine.";
nodes.file.files = [{ name: "my persona.md", text: async () => raw }];
await nodes.file.onchange({ target: nodes.file });
ok(nodes.body.value === raw, "选文件后正文进了输入框");
ok(nodes.pname.value === "我的人设", "名字取自 frontmatter");
ok(nodes.pid.value === "my-persona", "id 从文件名猜出来（空格换连字符）");

const beforeImport = calls.length;
nodes["import-save"].onclick();
await tick();
const imported = calls.at(-1);
ok(calls.length > beforeImport && imported.persona === "my-persona", "导入后直接选中这个人设");
ok(Array.isArray(imported.inlinePersonas) && imported.inlinePersonas[0]?.text === raw, "正文写进 options.inlinePersonas");
ok(imported.inlinePersonas[0]?.name === "我的人设", "名字一起存下来，列表才有东西显示");
ok(nodes.list.children.length === 4 && textOf(nodes.list.children[0]).includes("我的人设"), "导入的人设排在最前面");
ok(nodes.count.textContent === "全部 4", "标题计数包含导入的人设");
ok(nodes["import-count"].textContent === "已导入 1 个", "导入计数更新");
ok(nodes.body.value === "" && nodes.pid.value === "", "存完清空表单");

// 重名内置 id、非法 id 都要拦住，而且一次 options.set 都不能发
const guarded = calls.length;
nodes.file.files = [{ name: "x.md", text: async () => "hi" }];
await nodes.file.onchange({ target: nodes.file });
nodes.pid.value = "terse";
nodes["import-save"].onclick();
ok(nodes["import-err"].hidden === false && nodes["import-err"].textContent.includes("重名"), "和内置人设重名时拒绝");
nodes.pid.value = "../bad";
nodes["import-save"].onclick();
ok(nodes["import-err"].textContent.includes("id"), "非法 id 时拒绝并说明规则");
ok(calls.length === guarded, "被拒绝时一次 options.set 都没发");

// 删除全部导入：被选中的人设要回到跟随，不能留一个悬空 id
nodes["del-all"].onclick();
await tick();
const afterDelete = calls.at(-1);
ok(Array.isArray(afterDelete.inlinePersonas) && afterDelete.inlinePersonas.length === 0, "删除全部导入");
ok(afterDelete.persona === "", "被删掉的人设不再选中（回到跟随）");
ok(nodes["import-count"].textContent === "还没有导入", "计数回到空");

// 8) 生效 Agent 范围配置（全部 / 仅勾选 / 排除）
ok(nodes["scope-include"].checked === true, "初始 options.agents 有值时范围自动为仅勾选");
ok(nodes["agents-panel"].hidden === false, "仅勾选时展示 agent 面板");
ok(nodes["agents-list"].children.length >= 9, "预置了常见 Agent 列表");

// 切换到排除模式
nodes["scope-exclude"].onchange();
await tick();
const scopeExcludeCall = calls.at(-1);
ok(Array.isArray(scopeExcludeCall.agents) && scopeExcludeCall.agents.length === 0, "切换排除模式时清空 agents 白名单");

// 在排除模式下勾选 claude
const claudeChip = nodes["agents-list"].children.find((c) => c.dataset?.agent === "claude");
ok(claudeChip !== undefined, "存在 claude 选项");
const claudeCb = claudeChip.children.find((k) => k.type === "checkbox");
claudeCb.checked = true;
claudeCb.onchange();
await tick();
const excludeClaudeCall = calls.at(-1);
ok(JSON.stringify(excludeClaudeCall.disabledAgents) === '["claude"]', "勾选 claude 写入 disabledAgents");
ok(nodes.status.textContent.includes("已排除 claude"), "状态行提示已排除 claude");

// 添加自定义 agent
nodes["custom-agent"].value = "kilo";
nodes["add-agent-btn"].onclick();
await tick();
const addKiloCall = calls.at(-1);
ok(addKiloCall.disabledAgents.includes("kilo"), "添加自定义 agent kilo 并写入 disabledAgents");

// 切换到全部生效
nodes["scope-all"].onchange();
await tick();
const scopeAllCall = calls.at(-1);
ok(scopeAllCall.agents.length === 0 && scopeAllCall.disabledAgents.length === 0, "全部生效时清空过滤列表");
ok(nodes["agents-panel"].hidden === true, "全部生效时隐藏 agent 面板");
// 9) 读不到 options 时不开放交互（否则这期间的点击会用空 base 把 agents 写没）
const nodes2 = Object.fromEntries(ids.map((id) => [id, new Node()]));
nodes2.status.hidden = true;
runInNewContext(appSrc, {
	magpie: {
		ready: Promise.resolve(),
		options: {
			async get() {
				throw new Error("offline");
			},
		},
	},
	document: { getElementById: (id) => nodes2[id], createElement: (tag) => new Node(tag) },
	Option,
	window,
	Promise,
	setTimeout: fakeSetTimeout,
	Date: { now: () => clock },
});
await tick();
ok(nodes2.status.hidden === false && nodes2.status.dataset.state === "error", "读不到 options 时把错误写在状态行");
ok(nodes2.list.children.length === 0 && nodes2.mode.onchange === undefined, "读不到 options 时一个人设都不渲染、事件也不绑");

console.log(process.exitCode ? "\n有失败项" : `\n全部通过（共 ${calls.length} 次 options.set）`);
