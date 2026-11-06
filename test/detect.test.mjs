import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detect } from "../lib/detect.mjs";

// 探测只看文件系统与 PATH；这里把 USERPROFILE / LOCALAPPDATA 指到沙盒，
// 就能在没有真装的机器上复现「装了却显示未安装」的每个判据。
function sandbox(t) {
	const root = mkdtempSync(join(tmpdir(), "ap-detect-"));
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const saved = {
		USERPROFILE: process.env.USERPROFILE,
		HOME: process.env.HOME,
		LOCALAPPDATA: process.env.LOCALAPPDATA,
		APPDATA: process.env.APPDATA,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		PATH: process.env.PATH,
		ProgramFiles: process.env.ProgramFiles,
		"ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
		ProgramData: process.env.ProgramData,
		PUBLIC: process.env.PUBLIC,
		AGENT_PURGE_DRIVES: process.env.AGENT_PURGE_DRIVES,
		PI_DESKTOP_DATA_DIR: process.env.PI_DESKTOP_DATA_DIR,
		PI_DESKTOP_AGENT_DIR: process.env.PI_DESKTOP_AGENT_DIR,
	};
	process.env.USERPROFILE = home;
	process.env.HOME = home;
	process.env.LOCALAPPDATA = join(home, "AppData", "Local");
	process.env.APPDATA = join(home, "AppData", "Roaming");
	process.env.XDG_CONFIG_HOME = join(home, ".config");
	process.env.ProgramFiles = join(root, "ProgramFiles");
	process.env["ProgramFiles(x86)"] = join(root, "ProgramFilesX86");
	// 开始菜单/桌面快捷方式与盘符也要隔离，否则会扫到真机上的安装
	process.env.ProgramData = join(root, "ProgramData");
	process.env.PUBLIC = join(root, "Public");
	process.env.AGENT_PURGE_DRIVES = join(root, "no-drive");
	process.env.PATH = "";
	for (const key of ["PI_DESKTOP_DATA_DIR", "PI_DESKTOP_AGENT_DIR"]) delete process.env[key];
	t.after(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(root, { recursive: true, force: true });
	});
	return home;
}

test("detect: opencode 只用 jsonc / 只有 plugins 目录时也算装上（不再误报未安装）", (t) => {
	const home = sandbox(t);
	const cfg = join(home, ".config", "opencode");
	mkdirSync(join(cfg, "plugins"), { recursive: true });
	writeFileSync(join(cfg, "opencode.jsonc"), "{}\n", "utf8");

	const opencode = detect().opencode;
	assert.equal(opencode.found, true);
	assert.equal(opencode.homeExists, true);
	assert.equal(opencode.home, cfg);
	assert.equal(opencode.bin, null, "PATH 为空时不能凭空造出命令入口");
});

test("detect: opencode PATH 里没有时回落到常见安装落点", (t) => {
	const home = sandbox(t);
	const bin = join(home, ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
	mkdirSync(join(home, ".opencode", "bin"), { recursive: true });
	writeFileSync(bin, "", "utf8");

	assert.equal(detect().opencode.found, true);
	assert.equal(detect().opencode.bin, bin);
});

test("detect: 什么都没装时 opencode 仍是未安装", (t) => {
	sandbox(t);
	assert.equal(detect().opencode.found, false);
	assert.equal(detect().opencode.homeExists, false);
});

test("detect: WorkBuddy 安装目录没有旧模板文件也算装上", (t) => {
	const home = sandbox(t);
	const install = join(home, "AppData", "Local", "Programs", "WorkBuddy");
	mkdirSync(join(install, "resources"), { recursive: true });
	writeFileSync(join(install, "WorkBuddy.exe"), "", "utf8");

	const wb = detect().workbuddy;
	assert.equal(wb.found, true, "旧判据要求 resources/app.asar.unpacked/.../workbuddy-prompt.tpl，版本一改就误报");
	assert.equal(wb.homeExists, true);
});

test("detect: WorkBuddy 装在别处时靠 ~/.workbuddy 认出来，并把配置根指向它", (t) => {
	const home = sandbox(t);
	const cfg = join(home, ".workbuddy");
	mkdirSync(cfg, { recursive: true });
	writeFileSync(join(cfg, "settings.json"), "{}\n", "utf8");

	const wb = detect().workbuddy;
	assert.equal(wb.found, true);
	assert.equal(wb.home, cfg);
});

test("detect: WorkBuddy 完全没装时仍是未安装", (t) => {
	sandbox(t);
	assert.equal(detect().workbuddy.found, false);
	assert.equal(detect().workbuddy.homeExists, false);
});

test("detect: WorkBuddy AI 国际版安装目录（WorkBuddyAI.exe）被正确识别", (t) => {
	const home = sandbox(t);
	const install = join(home, "AppData", "Local", "Programs", "WorkBuddyAI");
	mkdirSync(join(install, "resources"), { recursive: true });
	writeFileSync(join(install, "WorkBuddyAI.exe"), "", "utf8");

	const wbAi = detect()["workbuddy-ai"];
	assert.equal(wbAi.found, true);
	assert.equal(wbAi.homeExists, true);
	assert.equal(detect().workbuddy.found, false, "国际版不应触发国内版命中");
});

test("detect: WorkBuddy AI 国际版靠 ~/.workbuddy-ai 认出来，并把配置根指向它", (t) => {
	const home = sandbox(t);
	const cfg = join(home, ".workbuddy-ai");
	mkdirSync(cfg, { recursive: true });
	writeFileSync(join(cfg, "settings.json"), "{}\n", "utf8");

	const wbAi = detect()["workbuddy-ai"];
	assert.equal(wbAi.found, true);
	assert.equal(wbAi.home, cfg);
	assert.equal(detect().workbuddy.found, false, "国际版配置根不应触发国内版命中");
});

test("detect: 桌面端装在 F 盘（不在任何默认目录）也能靠盘符扫到", (t) => {
	const home = sandbox(t);
	const root = dirname(home);
	const drive = join(root, "F");
	mkdirSync(join(drive, "WorkBuddy", "resources"), { recursive: true });
	writeFileSync(join(drive, "WorkBuddy", "WorkBuddy.exe"), "", "utf8");
	process.env.AGENT_PURGE_DRIVES = `${drive};`;

	const wb = detect().workbuddy;
	assert.equal(wb.found, true, "不能只认 C:/D: 默认目录");
	assert.equal(wb.install, join(drive, "WorkBuddy"));
});

test("detect: 新装但还没写过配置文件的 CLI 也算装上（配置根存在即命中）", (t) => {
	const home = sandbox(t);
	mkdirSync(join(home, ".claude"), { recursive: true });

	const claude = detect().claude;
	assert.equal(claude.found, true, "claude 新装没有 settings.json，不能因此算没装");
	assert.equal(claude.home, join(home, ".claude"));
});

test("detect: PI-Desktop 只看自己的数据根，不把 pi CLI 当成 PI-Desktop", (t) => {
	const home = sandbox(t);
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	assert.equal(detect()["pi-desktop"].found, false, "~/.pi/agent 是 pi CLI 的，不是 PI-Desktop 的");

	mkdirSync(join(home, ".pi-desktop", "plugins"), { recursive: true });
	assert.equal(detect()["pi-desktop"].found, true);
	assert.equal(detect()["pi-desktop"].home, join(home, ".pi-desktop"));
});
