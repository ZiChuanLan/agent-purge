// 撤销先发布全局暂停，再按登记逐项还原；失败保留原位置的账本与 stash 供重试。
import { existsSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, resolve, sep } from "node:path";
import { changeChannel } from "./apply.mjs";
import { withControlLock } from "./control.mjs";
import { cancel, listLedger } from "./footprints.mjs";
import { removeOwnedFile, revertFile, uninstall as uninstallPersist } from "./persist.mjs";
import { removeUserPath, shimDir } from "./shim.mjs";
import { loadState, patchState } from "./state.mjs";

/**
 * 撤销全部注入并还原被改文件。
 *
 * keepFailed：还原不了的旧文件/自定义账本记为「跳过」，CLI 退出码为 3。
 * 配置、账本读取、活跃通道、PATH 与收尾失败仍阻止卸载。账本与备份原地保留，
 * 跳过项由调用方留痕（CLI 写 clean-leftovers.log），重试仍然有效。
 */
export function clean(root, { all = false, dryRun = false, keepProject = false, keepFailed = false } = {}) {
	// 必须在创建锁/写暂停状态之前拒绝危险的数据根；不能等撤销一半才发现。
	const blocked = all && refuseReason(resolve(root));
	if (blocked) return { ok: false, steps: [{ what: "data-home", ok: false, detail: blocked }], leftovers: [blocked], skipped: [] };
	if (dryRun) return runClean(root, { all, dryRun, keepProject, keepFailed });
	return withControlLock(root, () => runClean(root, { all, dryRun, keepProject, keepFailed }));
}
function runClean(root, { all, dryRun, keepProject, keepFailed }) {
	const steps = [], skipped = [], home = resolve(root);
	let blocked = false;
	const add = (what, work, { fatal = false } = {}) => {
		try {
			const detail = work();
			if (detail?.error || detail?.ok === false || detail?.status === "failed") throw new Error(detail.error ?? JSON.stringify(detail));
			steps.push({ what, ok: true, detail });
			return true;
		} catch (error) {
			const step = { what, ok: false, detail: error.message };
			steps.push(step);
			// 只有显式 --keep-failed 才容忍失败；数据目录删除这类收尾动作始终是硬失败。
			if (!keepFailed || fatal) { blocked = true; return false; }
			skipped.push(step);
			return false;
		}
	};
	let state;
	if (!add("pause", () => {
		state = loadState(root, { migrate: !dryRun }).state;
		if (dryRun) return "（dry-run：会先暂停并撤销会话启动凭据）";
		patchState(root, { default: { harness: state.default?.harness ?? null, mode: "off" },
			resumeMode: state.default?.mode && state.default.mode !== "off" ? state.default.mode : state.resumeMode ?? "replace" });
		return "已暂停；旧启动凭据不再恢复";
	}, { fatal: true })) return { ok: false, steps, leftovers: ["配置未成功暂停，未开始撤销"], skipped };

	// 无法读账本时不知道哪些文件需要还原，不能先撤通道再将损坏凭据当作「旧记录」跳过。
	let entries = [];
	if (!add("read-ledger", () => { entries = listLedger(root); return `${entries.length} 条恢复记录`; }, { fatal: true }))
		return { ok: false, steps, leftovers: ["足迹账本未成功读取，未开始撤销"], skipped };

	for (const [harness, channels] of Object.entries(state.armed ?? {})) {
		for (const channel of Array.isArray(channels) ? channels : []) {
      if (keepProject && channel === "project") continue;
			// 活跃通道无法撤销不是失效旧账本，卸载必须停下并保留程序。
			add(`${harness}/${channel}`, () => dryRun ? "（dry-run：会撤销）" : changeChannel(root, { harness, channel, enabled: false }), { fatal: true });
		}
	}
	// 通道撤销会还原文件并销账；不能重放预检快照，否则会把刚还原的用户文件再当成托管文件处理。
	if (!dryRun && !add("refresh-ledger", () => { entries = listLedger(root); return `${entries.length} 条剩余恢复记录`; }, { fatal: true }))
		return { ok: false, steps, leftovers: ["撤销后的账本未成功读取，恢复凭据已保留"], skipped };
	const customDone = new Set();
	for (const entry of [...entries].reverse()) {
    if (keepProject && entry.channel === "project") continue;
		if (dryRun) { steps.push({ what: `ledger:${entry.undo.type}`, ok: true, detail: `（dry-run：会撤销 ${entry.path}）` }); continue; }
		if (entry.undo.type === "custom" && customDone.has(entry.harness)) continue;
		add(`ledger:${entry.undo.type}`, () => {
			let detail;
			if (entry.undo.type === "custom") {
				customDone.add(entry.harness);
				detail = uninstallPersist(entry.harness, { root });
			} else detail = reverse(entry, root);
			if (detail?.error || detail?.ok === false) throw new Error(detail.error ?? JSON.stringify(detail));
			cancel(root, { id: entry.id, kind: entry.kind, path: entry.path, harness: entry.harness, channel: entry.channel });
			return detail;
		}, { fatal: !["custom", "file-delete", "block-revert"].includes(entry.undo.type) });
	}
	// 目录内允许共存用户文件；只收空目录，不递归删除未知文件。
	if (existsSync(shimDir())) add("shim-dir", () => {
		if (dryRun) return "（dry-run：仅收空目录，保留外来文件）";
		if (readdirSync(shimDir()).length) return "保留目录中未登记的文件";
		rmdirSync(shimDir());
		return "removed-empty-directory";
	}, { fatal: true });
	if (!dryRun && steps.every(s => s.ok)) add("reset-selection", () => {
		const kept = {};
		if (keepProject) for (const [harness, channels] of Object.entries(state.armed ?? {})) {
			const projects = (Array.isArray(channels) ? channels : []).filter(channel => channel === "project");
			if (projects.length) kept[harness] = projects;
		}
		return patchState(root, { armed: keepProject ? kept : {}, pausedInstalls: [], projectDirs: keepProject ? state.projectDirs ?? {} : {} });
	}, { fatal: true });
	let pending = leftovers(root, { keepProject, dryRun });
	if (all) add("data-home", () => {
		const blocked = refuseReason(home);
		if (blocked) throw new Error(blocked);
		if (dryRun) return `（dry-run：确认全部还原后删除 ${home}）`;
		if (pending.length || steps.some(s => !s.ok)) throw new Error(`保留原数据目录供重试：${home}；${pending.join("；")}`);
		if (!existsSync(home)) return "already-gone";
		const trash = `${home}.trash-${Date.now()}`;
		renameSync(home, trash);
		try { rmSync(trash, { recursive: true, force: true }); }
		catch (error) {
			try { if (!existsSync(home)) renameSync(trash, home); } catch {}
			throw new Error(`删除失败，恢复资料保留于 ${existsSync(home) ? home : trash}：${error.message}`);
		}
		return home;
	}, { fatal: true });
	pending = leftovers(root, { keepProject, dryRun });
	// keepFailed 时 pending 里剩下的就是那些「跳过」的记录：它们已经记在 skipped 里，不再把结果判成失败。
	const ok = !blocked && (dryRun || !pending.length || (keepFailed && skipped.length > 0));
	return { ok, steps, leftovers: pending, skipped };
}
function refuseReason(home) {
	const canonical = file => {
		let full = resolve(file);
		try { full = realpathSync(full); } catch (error) { if (error.code !== "ENOENT") throw error; }
		return process.platform === "win32" ? full.toLowerCase() : full;
	};
	const h = canonical(home), cwd = canonical(process.cwd());
	const contains = file => file === h || file.startsWith(h.endsWith(sep) ? h : h + sep);
	if (contains(cwd)) return `当前工作目录位于数据目录中，请手工处理：${home}`;
	const protectedDirs = [process.env.USERPROFILE || process.env.HOME || homedir(), homedir(), tmpdir()];
	if (protectedDirs.some(file => contains(canonical(file))) || !basename(h) || /^[A-Za-z]:[\\/]?$/.test(h) || h === sep)
		return `数据目录指向用户主目录、临时根或其上级，请手工处理：${home}`;
	return null;
}
function reverse(entry, root) {
	if (entry.undo.type === "file-delete") {
		const result = removeOwnedFile(entry.path, { root, expectedSha: entry.sha256 });
		if (result.action === "skipped-foreign") throw new Error(`保留外来文件与恢复记录：${entry.path}`);
		return result;
	}
	if (entry.undo.type === "block-revert") return revertFile(entry.path, { root });
	if (entry.undo.type === "path-env") return removeUserPath(entry.path);
	throw new Error(`未知撤销方式，保留账本：${entry.undo.type}`);
}
function leftovers(root, { keepProject = false, dryRun = false } = {}) {
	if (!existsSync(root)) return [];
	const out = [];
	try {
		const pending = listLedger(root).filter(entry => !(keepProject && entry.channel === "project"));
		if (pending.length) out.push(`${pending.length} 条账本记录未撤销（${pending.map(e => e.path).join(", ")}）`);
	} catch (error) { out.push(error.message); }
	try {
		const state = loadState(root, { migrate: !dryRun }).state;
		const armed = Object.entries(state.armed ?? {})
			.map(([id, channels]) => [id, keepProject ? (channels ?? []).filter(channel => channel === "project") : channels])
			.filter(([, channels]) => channels?.length && !(keepProject && channels.every(channel => channel === "project")));
		if (armed.length) out.push(`state 仍记着 armed：${armed.map(([h, cs]) => `${h}=${cs.join("+")}`).join(", ")}`);
	} catch (error) { out.push(error.message); }
	return out;
}
