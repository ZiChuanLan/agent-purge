import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, patchState } from '../lib/state.mjs';
import { desktopExitOnClose, saveSettings, settingsOf, settingsWithSecret } from '../lib/settings.mjs';
import { MANIFEST, applyArchive, backup, download, pruneSnapshots, remoteUrl, restore, testConnection } from '../lib/webdav.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'ap-settings-'));
test.after(() => rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const freshHome = name => {
	const home = join(sandbox, name);
	mkdirSync(join(home, 'personas'), { recursive: true });
	writeFileSync(join(home, 'personas', 'alpha.md'), '---\nid: alpha\nname: Alpha\n---\nPERSONA_ALPHA');
	writeFileSync(join(home, 'personas', 'active.md'), 'DERIVED');
	writeFileSync(join(home, 'state.json'), JSON.stringify({ v: 1, persona: 'alpha' }), { mode: 0o600 });
	return home;
};

/* ── settings ─────────────────────────────────────────────────────────── */

test('settings: 默认是「关窗退出 + 退出前确认」，密码只报 hasPassword', () => {
	const home = freshHome('defaults');
	const view = settingsOf(loadState(home).state);
	assert.deepEqual(view.desktop, { exitOnClose: true, confirmOnClose: true });
	assert.equal(view.webdav.dir, 'agent-purge');
	assert.equal(view.webdav.hasPassword, false);
	assert.equal('password' in view.webdav, false, '密码绝不能出现在前端视图里');
	assert.equal(desktopExitOnClose(loadState(home).state), true);
});

test('settings: 保存只覆盖点名的键，密码不回显但能取到', () => {
	const home = freshHome('save');
	patchState(home, { piAuto: true });
	saveSettings(home, { webdav: { url: ' https://dav.example.com/dav/ ', username: 'admin', password: 's3cret', dir: '/backups/agent-purge/' } });
	saveSettings(home, { desktop: { exitOnClose: false } });

	const { state } = loadState(home);
	assert.equal(state.piAuto, true, '别的字段不能被顺手抹掉');
	const view = settingsOf(state);
	assert.equal(view.webdav.url, 'https://dav.example.com/dav/');
	assert.equal(view.webdav.dir, 'backups/agent-purge');
	assert.equal(view.webdav.hasPassword, true);
	assert.equal(settingsWithSecret(state).webdav.password, 's3cret');
	assert.equal(view.desktop.exitOnClose, false);
	assert.equal(view.desktop.confirmOnClose, true, '没点名的键保持原值');
});

test('settings: 空密码等于清除；地址与目录做基本校验', () => {
	const home = freshHome('clear');
	saveSettings(home, { webdav: { url: 'https://dav.example.com', password: 'x' } });
	assert.equal(settingsOf(loadState(home).state).webdav.hasPassword, true);
	saveSettings(home, { webdav: { password: '' } });
	assert.equal(settingsOf(loadState(home).state).webdav.hasPassword, false);
	assert.throws(() => saveSettings(home, { webdav: { url: 'ftp://nope' } }), /http/);
	assert.throws(() => saveSettings(home, { webdav: { dir: '../../etc' } }), /\.\./);
});

/* ── WebDAV：用一个最小 WebDAV 服务端打真请求 ────────────────────────────── */

/** 严格 WebDAV 桩：要求先逐层 MKCOL 建目录才允许 PUT，目录不在时 PROPFIND 返回 404（贴近真实服务端）。 */
function davServer() {
	const files = new Map();
	const collections = new Set(['/dav/']);
	const seen = [];
	const normDir = path => (path.endsWith('/') ? path : `${path}/`);
	const parentOf = path => {
		const trimmed = path.replace(/\/+$/, '');
		const slash = trimmed.lastIndexOf('/');
		return slash <= 0 ? '/' : `${trimmed.slice(0, slash)}/`;
	};
	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		seen.push(`${req.method} ${url.pathname}`);
		const auth = req.headers.authorization ?? '';
		if (auth !== `Basic ${Buffer.from('admin:s3cret').toString('base64')}`) {
			res.writeHead(401).end('unauthorized');
			return;
		}
		if (req.method === 'PROPFIND') {
			const dir = normDir(url.pathname);
			if (!collections.has(dir)) { res.writeHead(404).end('missing collection'); return; }
			res.writeHead(207, { 'content-type': 'application/xml' }).end('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"/>');
			return;
		}
		if (req.method === 'MKCOL') {
			const dir = normDir(url.pathname);
			if (collections.has(dir)) { res.writeHead(405).end('exists'); return; }
			if (!collections.has(parentOf(dir))) { res.writeHead(409).end('missing parent'); return; }
			collections.add(dir);
			res.writeHead(201).end();
			return;
		}
		if (req.method === 'PUT') {
			if (!collections.has(parentOf(url.pathname))) { res.writeHead(409).end('missing parent'); return; }
			const chunks = [];
			req.on('data', c => chunks.push(c));
			req.on('end', () => { files.set(url.pathname, Buffer.concat(chunks)); res.writeHead(201).end(); });
			return;
		}
		if (req.method === 'GET') {
			const body = files.get(url.pathname);
			if (!body) { res.writeHead(404).end('not found'); return; }
			res.writeHead(200, { 'content-type': 'application/json' }).end(body);
			return;
		}
		res.writeHead(405).end();
	});
	return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
		server, files, seen,
		url: `http://127.0.0.1:${server.address().port}/dav/`,
	})));
}

test('webdav: 备份→下载→恢复走完一圈，密码不随备份出走', async () => {
	const dav = await davServer();
	try {
		const home = freshHome('roundtrip');
		saveSettings(home, { webdav: { url: dav.url, username: 'admin', password: 's3cret', dir: 'agent-purge' } });
		const settings = settingsWithSecret(loadState(home).state);

		// 首次配置：远端目录 agent-purge 还没建好时，测试连接也不能报 404
		const probed = await testConnection(settings);
		assert.equal(probed.ok, true);
		assert.equal(probed.willCreateDir, true);
		assert.deepEqual(remoteUrl(settings.webdav, MANIFEST), `${dav.url}agent-purge/${MANIFEST}`);

		const result = await backup(home, settings);
		assert.equal(result.files, 2, '两个人设文件 + state.json 里 active.md 被排除 → alpha.md 与 state.json');
		const archive = JSON.parse(dav.files.get(`/dav/agent-purge/${MANIFEST}`).toString('utf8'));
		const stateEntry = archive.entries.find(e => e.path === 'state.json');
		assert.equal(stateEntry.sha256, createHash('sha256').update(Buffer.from(stateEntry.base64, 'base64')).digest('hex'));
		const uploadedState = JSON.parse(Buffer.from(stateEntry.base64, 'base64').toString('utf8'));
		assert.equal(uploadedState.settings.webdav.password, undefined, '备份里不许有明文密码');
		assert.equal(archive.entries.some(e => e.path === 'personas/active.md'), false, '派生物不进备份');

		// 改本地，再从远端恢复回来
		writeFileSync(join(home, 'personas', 'alpha.md'), 'LOCAL_EDIT');
		saveSettings(home, { desktop: { exitOnClose: false } });
		const restored = await restore(home, settings);
		assert.equal(restored.written.includes('personas/alpha.md'), true);
		assert.equal(readFileSync(join(home, 'personas', 'alpha.md'), 'utf8'), '---\nid: alpha\nname: Alpha\n---\nPERSONA_ALPHA');
		// 密码是「这台机器」的属性：备份里没有，恢复后本机仍要能继续用
		assert.equal(settingsWithSecret(loadState(home).state).webdav.password, 's3cret');
		assert.ok(restored.snapshot && readdirSync(join(home, 'backups')).length === 1, '恢复前要留本地快照');
	} finally {
		await new Promise(r => dav.server.close(r));
	}
});

test('webdav: 认证失败、找不到备份、哈希不符都要说人话且不写盘', async () => {
	const dav = await davServer();
	try {
		const home = freshHome('errors');
		const wrong = { url: dav.url, username: 'admin', password: 'nope', dir: 'agent-purge' };
		await assert.rejects(testConnection(wrong), /401\/403/);
		await assert.rejects(download(wrong), /401\/403/);

		const settings = settingsWithSecret({ settings: { webdav: { url: dav.url, username: 'admin', password: 's3cret', dir: 'agent-purge' } } });
		await assert.rejects(download(settings), /没有找到 agent-purge 备份/);

		// 篡改一个字节 → 校验失败，本地文件保持原样
		await backup(home, settings);
		const archive = JSON.parse(dav.files.get(`/dav/agent-purge/${MANIFEST}`).toString('utf8'));
		archive.entries[0].base64 = Buffer.from('TAMPERED').toString('base64');
		dav.files.set(`/dav/agent-purge/${MANIFEST}`, Buffer.from(JSON.stringify(archive)));
		const before = readFileSync(join(home, 'personas', archive.entries[0].path.split('/')[1]), 'utf8');
		await assert.rejects(restore(home, settings), /校验失败/);
		assert.equal(readFileSync(join(home, 'personas', archive.entries[0].path.split('/')[1]), 'utf8'), before);
	} finally {
		await new Promise(r => dav.server.close(r));
	}
});

test('webdav: 备份里的路径必须落在人设与配置文件范围内', () => {
	const home = freshHome('paths');
	const malicious = {
		archive: { format: 1, createdAt: '2026-01-01T00:00:00.000Z' },
		entries: [{ path: '../../evil.md', bytes: Buffer.from('x') }],
	};
	assert.throws(() => applyArchive(home, malicious, { snapshotBefore: false }), /不认识的路径/);
});

test('webdav: 快照只保留最近若干份', () => {
	const home = freshHome('prune');
	const dir = join(home, 'backups');
	mkdirSync(dir, { recursive: true });
	for (let i = 0; i < 14; i += 1) writeFileSync(join(dir, `pre-restore-${String(i).padStart(2, '0')}.json`), '{}');
	assert.equal(pruneSnapshots(home, 10), 4);
	assert.equal(readdirSync(dir).length, 10);
});

test('webdav: 嵌套目录与 history 子目录按层 MKCOL，不把 dir 拼两遍', async () => {
	const dav = await davServer();
	try {
		const home = freshHome('nested-mkcol');
		saveSettings(home, { webdav: { url: dav.url, username: 'admin', password: 's3cret', dir: 'team/agent-purge' } });
		const settings = settingsWithSecret(loadState(home).state);
		const result = await backup(home, settings);
		assert.equal(result.ok, true);
		assert.ok(dav.files.has('/dav/team/agent-purge/agent-purge-backup.json'));
		assert.ok([...dav.files.keys()].some(p => p.startsWith('/dav/team/agent-purge/history/agent-purge-')));
		assert.ok(dav.seen.includes('MKCOL /dav/team/'));
		assert.ok(dav.seen.includes('MKCOL /dav/team/agent-purge/'));
		assert.ok(dav.seen.includes('MKCOL /dav/team/agent-purge/history/'));
		assert.equal(dav.seen.some(line => line.includes('MKCOL /dav/team/agent-purge/team/')), false, 'MKCOL 绝不能把目录名拼两遍');
	} finally {
		await new Promise(r => dav.server.close(r));
	}
});
