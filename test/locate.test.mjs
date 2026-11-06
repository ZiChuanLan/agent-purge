import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { locate, readShortcutTarget, scanDrives } from "../lib/locate.mjs";

/** 造一个最小的 .lnk：只有 Header + LinkInfo(LocalBasePath)，够验解析器 */
function makeLnk(path, target) {
	const header = Buffer.alloc(0x4c);
	header.writeUInt32LE(0x4c, 0);
	header.writeUInt32LE(0x02, 0x14); // HasLinkInfo
	const body = Buffer.from(target, "latin1");
	const info = Buffer.alloc(0x1c);
	info.writeUInt32LE(0x1c + body.length + 1, 0); // LinkInfoSize
	info.writeUInt32LE(0x1c, 4); // LinkInfoHeaderSize
	info.writeUInt32LE(0x01, 8); // VolumeIDAndLocalBasePath
	info.writeUInt32LE(0x1c, 16); // LocalBasePathOffset
	writeFileSync(path, Buffer.concat([header, info, body, Buffer.from([0])]));
}

function sources(extra = {}) {
	return { home: "C:\\Users\\t", local: "C:\\Users\\t\\AppData\\Local", roaming: "C:\\Users\\t\\AppData\\Roaming", drives: [], shortcuts: new Map(), entries: [], ...extra };
}

test("locate: 解析 .lnk 的 LocalBasePath（装在任何盘都指得对）", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ap-lnk-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const lnk = join(dir, "WorkBuddy.lnk");
	makeLnk(lnk, "F:\\workbuddy\\WorkBuddy.exe");
	assert.equal(readShortcutTarget(lnk), "F:\\workbuddy\\WorkBuddy.exe");
});

test("locate: LinkInfo 缺失时从二进制里兜底捞 exe 路径", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ap-lnk-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const lnk = join(dir, "broken.lnk");
	const buf = Buffer.concat([Buffer.from([0x4c, 0, 0, 0]), Buffer.alloc(0x48), Buffer.from("garbage\0F:\\apps\\ZCode\\ZCode.exe\0", "latin1")]);
	writeFileSync(lnk, buf);
	assert.equal(readShortcutTarget(lnk), "F:\\apps\\ZCode\\ZCode.exe");
});

test("locate: 快捷方式装在 F 盘也能定位（不再只看默认目录）", () => {
	const s = sources({ shortcuts: new Map([["workbuddy", "F:\\workbuddy\\WorkBuddy.exe"]]) });
	const hit = locate({ names: ["WorkBuddy"], exe: ["WorkBuddy.exe"], folder: ["WorkBuddy"] }, s);
	assert.deepEqual(hit, { dir: "F:\\workbuddy", exe: "F:\\workbuddy\\WorkBuddy.exe", source: "shortcut" });
});

test("locate: 同名前缀的另一个程序不会把 antigravity 抢走", () => {
	const s = sources({
		shortcuts: new Map([
			["antigravity tools", "H:\\Antigravity Tools\\antigravity-tools.exe"],
			["antigravity", "C:\\Users\\t\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe"],
		]),
	});
	const hit = locate({ names: ["Antigravity"], exe: ["Antigravity.exe"], folder: ["antigravity"] }, s);
	assert.equal(hit.exe, "C:\\Users\\t\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe");
});

test("locate: 没有快捷方式时扫各盘常见根", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ap-drive-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "Apps", "WorkBuddy"), { recursive: true });
	writeFileSync(join(dir, "Apps", "WorkBuddy", "WorkBuddy.exe"), "", "utf8");

	const hit = locate({ names: ["WorkBuddy"], exe: ["WorkBuddy.exe"], folder: ["WorkBuddy"] }, sources({ drives: [dir] }));
	assert.equal(hit.dir, join(dir, "Apps", "WorkBuddy"));
	assert.equal(hit.source, "guess");
});

test("locate: 最后回落到注册表卸载项", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ap-reg-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "WorkBuddy.exe"), "", "utf8");

	const hit = locate(
		{ names: ["WorkBuddy"], exe: ["WorkBuddy.exe"], folder: ["WorkBuddy"] },
		sources({ entries: [{ name: "WorkBuddy 5.9.3", location: dir, icon: join(dir, "WorkBuddy.exe") }] }),
	);
	assert.equal(hit.dir, dir);
	assert.equal(hit.source, "registry");
});

test("locate: 目录名不标准、也没快捷方式时靠盘内浅扫兜底", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ap-scan-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const deep = join(dir, "Green", "WorkBuddy2");
	mkdirSync(deep, { recursive: true });
	writeFileSync(join(deep, "WorkBuddy.exe"), "", "utf8");

	const hit = locate({ names: ["WorkBuddy"], exe: ["WorkBuddy.exe"], folder: ["WorkBuddy"] }, sources({ drives: [dir] }));
	assert.equal(hit.dir, deep);
	assert.equal(hit.source, "scan");
});

test("scanDrives: 跳过系统目录，找不到就返回空", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ap-scan2-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "Windows", "Sys"), { recursive: true });
	writeFileSync(join(dir, "Windows", "Sys", "WorkBuddy.exe"), "", "utf8");
	assert.deepEqual(scanDrives(["WorkBuddy.exe"], [dir]), []);
});

test("locate: 什么都没找到时返回 null", () => {
	assert.equal(locate({ names: ["Nope"], exe: ["Nope.exe"], folder: ["Nope"] }, sources()), null);
});

test("locate: 便携版 exe 带版本号也能认（PI-Desktop-Portable-0.21.0.exe）", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ap-portable-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const deep = join(dir, "Vivaldi");
	mkdirSync(deep, { recursive: true });
	writeFileSync(join(deep, "PI-Desktop-Portable-0.21.0.exe"), "", "utf8");

	const hit = locate(
		{ names: ["PI-Desktop"], exe: ["PI-Desktop.exe", "PI-Desktop-Portable*.exe"], folder: ["PI-Desktop"] },
		sources({ drives: [dir] }),
	);
	assert.equal(hit.dir, deep);
	assert.equal(hit.exe, join(deep, "PI-Desktop-Portable-0.21.0.exe"));
	assert.equal(hit.source, "scan");
});

test("matchExeName: 通配符只按显式 * 生效，antigravity-tools 不会冒充 Antigravity.exe", async () => {
	const { matchExeName } = await import("../lib/locate.mjs");
	assert.equal(matchExeName("PI-Desktop-Portable-0.21.0.exe", "PI-Desktop-Portable*.exe"), true);
	assert.equal(matchExeName("antigravity-tools.exe", "Antigravity.exe"), false);
});

test("locate: .lnk 的 ANSI 路径按系统码页解码（中文目录名不再乱码）", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "ap-lnk-cjk-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const lnk = join(dir, "WorkBuddy AI.lnk");
	// `D:\WorkBuddy国际版\WorkBuddyAI\WorkBuddyAI.exe` 里的中文段按 GBK 编码
	const gbk = Buffer.from([
		0x44, 0x3a, 0x5c, 0x57, 0x6f, 0x72, 0x6b, 0x42, 0x75, 0x64, 0x64, 0x79, // D:\WorkBuddy
		0xb9, 0xfa, 0xbc, 0xca, 0xb0, 0xe6, // 国际版（GBK）
		0x5c, 0x57, 0x6f, 0x72, 0x6b, 0x42, 0x75, 0x64, 0x64, 0x79, 0x41, 0x49, // \WorkBuddyAI
		0x5c, 0x57, 0x6f, 0x72, 0x6b, 0x42, 0x75, 0x64, 0x64, 0x79, 0x41, 0x49, 0x2e, 0x65, 0x78, 0x65, // \WorkBuddyAI.exe
	]);
	const header = Buffer.alloc(0x4c);
	header.writeUInt32LE(0x4c, 0);
	header.writeUInt32LE(0x02, 0x14);
	const info = Buffer.alloc(0x1c);
	info.writeUInt32LE(0x1c + gbk.length + 1, 0);
	info.writeUInt32LE(0x1c, 4);
	info.writeUInt32LE(0x01, 8);
	info.writeUInt32LE(0x1c, 16);
	writeFileSync(lnk, Buffer.concat([header, info, gbk, Buffer.from([0])]));

	const parsed = readShortcutTarget(lnk);
	assert.ok(parsed && parsed.endsWith("WorkBuddyAI.exe"), `应认出 exe：${parsed}`);
	// 解码结果取决于本机 ANSI 码页：中文机（936）必须解出中文；CI 常见的 1252 机器上，
	// GBK 字节本来就不会出现在真实 .lnk 里，此时退回 latin1 是可接受的，不能断言成 bug。
	if (process.platform === "win32" && ansiCodePage() === "936") {
		assert.match(parsed, /WorkBuddy国际版/, `936 机器上必须解对：${parsed}`);
	}
	// 非 936 码页：不解出中文是预期行为，这里不做断言
});

/** 本机 ANSI 码页；取不到返回空串（调用方按「不强制」处理） */
function ansiCodePage() {
	if (process.platform !== "win32") return "";
	try {
		const out = execFileSync("reg", ["query", String.raw`HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage`, "/v", "ACP"], {
			encoding: "utf8",
			windowsHide: true,
		});
		return out.match(/ACP\s+REG_SZ\s+([0-9]+)/)?.[1] ?? "";
	} catch {
		return "";
	}
}
