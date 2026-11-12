#!/usr/bin/env node
// 在 Linux 上生成单文件二进制、tar.gz 便携包、.deb 与（可选）.AppImage。
// 交叉架构（x64 / arm64）由 Bun 直接产出；本机架构会真实跑一次 smoke 验收。
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureBin, spawnBin } from '../lib/spawn.mjs';
import { hashFile, listFiles, readJSON } from './build-common.mjs';
import { smoke } from './build-smoke.mjs';

if (process.platform !== 'linux') {
  throw new Error('构建 Linux 产物需要 Linux 环境（Windows/macOS 可通过 GitHub Actions release.yml 的 build_linux job 构建）。');
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ENTRY = join(ROOT, '.build-linux-entry.mjs');
const pkg = readJSON(join(ROOT, 'package.json'));
const version = pkg.version;
const maintainer = process.env.AGENT_PURGE_MAINTAINER || 'ZiChuanLan <ZiChuanLan@users.noreply.github.com>';
const homepage = (pkg.homepage || 'https://github.com/ZiChuanLan/agent-purge').replace(/#readme$/, '');

const bun = captureBin('bun', ['--version']);
if (!bun) throw new Error('构建 Linux 产物需要 Bun，请先安装 Bun');

const assets = [
  'matrix.json', 'package.json', 'lib/evidence.mjs',
  'web/ui.html', 'web/app.js', 'web/model.mjs', 'web/styles.css',
  ...listFiles(join(ROOT, 'web/assets')).map(file => `web/assets/${file}`),
  ...listFiles(join(ROOT, 'lib/templates/personas')).map(file => `lib/templates/personas/${file}`),
];
const duplicates = assets.map(file => file.split('/').pop()).filter((file, index, all) => all.indexOf(file) !== index);
if (duplicates.length) throw new Error('内嵌资源重名：' + duplicates.join(', '));

const run = (cmd, args, label, options = {}) => {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', ...options });
  if (res.error) throw new Error(`${label} 失败：${res.error.message}`);
  if (res.status !== 0) throw new Error(`${label} 失败（exit ${res.status ?? 'null'}）`);
  return res;
};
const hasCommand = (cmd) => spawnSync('which', [cmd], { encoding: 'utf8', windowsHide: true }).status === 0;

const DEB_ARCH = { x64: 'amd64', arm64: 'arm64' };
const APPIMAGE_ARCH = { x64: 'x86_64', arm64: 'aarch64' };

const desktopEntry = `[Desktop Entry]
Type=Application
Name=agent-purge
GenericName=Agent Persona Switch
Comment=Switch session personas across coding agents
Exec=agent-purge web
Icon=agent-purge
Terminal=false
Categories=Development;Utility;
Keywords=agent;prompt;persona;cli;
StartupWMClass=agent-purge
`;

const installScript = `#!/bin/sh
# 将 agent-purge 安装到当前用户目录（无需 root）：~/.local/bin + 桌面入口。
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN="\${HOME}/.local/bin"
APPS="\${XDG_DATA_HOME:-\${HOME}/.local/share}/applications"
ICONS="\${XDG_DATA_HOME:-\${HOME}/.local/share}/icons/hicolor/512x512/apps"
mkdir -p "$BIN" "$APPS" "$ICONS"
install -m 0755 "$HERE/agent-purge" "$BIN/agent-purge"
install -m 0644 "$HERE/agent-purge.png" "$ICONS/agent-purge.png"
install -m 0644 "$HERE/agent-purge.desktop" "$APPS/agent-purge.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" || true
echo "已安装：$BIN/agent-purge"
echo "启动：agent-purge web"
`;

const debControl = (arch) => `Package: agent-purge
Version: ${version}
Section: utils
Priority: optional
Architecture: ${DEB_ARCH[arch]}
Maintainer: ${maintainer}
Homepage: ${homepage}
Installed-Size: ${Math.ceil(statSync(join(DIST, `agent-purge-${version}-linux-${arch}`)).size / 1024)}
Description: switch session personas across coding agents
 Replace or append system prompts across pi, omp, OpenCode, Codex, Claude Code,
 dsh, Qwen Code, Gemini CLI, Crush, Kiro and other coding agents, with an
 always-reversible ledger and a local web console.
`;

const appRun = `#!/bin/sh
HERE=$(dirname "$(readlink -f "$0")")
if [ "$#" -eq 0 ]; then
  exec "$HERE/usr/bin/agent-purge" web
fi
exec "$HERE/usr/bin/agent-purge" "$@"
`;

const onlyNative = process.argv.includes('--native-only');
const serveCheck = !process.argv.includes('--no-serve-check');
const wantDeb = !process.argv.includes('--no-deb');
const wantAppImage = !process.argv.includes('--no-appimage');
const arches = onlyNative ? [process.arch] : ['x64', 'arm64'];

mkdirSync(DIST, { recursive: true });
const buildTemp = mkdtempSync(join(tmpdir(), 'ap-linux-'));
console.log(`Bun ${bun.trim()} -> Linux 产物（${arches.join(', ')}）`);

const artifacts = {};
try {
  const browserEvidence = join(buildTemp, 'browser-evidence.txt');
  writeFileSync(browserEvidence, readFileSync(join(ROOT, 'lib/evidence.mjs')));
  writeFileSync(
    ENTRY,
    [
      ...assets.map((file, index) => `import a${index} from ${JSON.stringify(file === 'lib/evidence.mjs' ? browserEvidence.replaceAll('\\', '/') : './' + file)} with { type: "file" };`),
      `globalThis.__AGENT_PURGE_FILES = {${assets.map((file, index) => `${JSON.stringify(file)}:a${index}`).join(',')}};`,
      'import("./bin/agent-purge.mjs");',
    ].join('\n'),
  );

  for (const arch of arches) {
    const target = `bun-linux-${arch}`;
    const binPath = join(DIST, `agent-purge-${version}-linux-${arch}`);
    rmSync(binPath, { force: true });
    const args = ['build', ENTRY, '--compile', `--target=${target}`, `--outfile=${binPath}`, '--asset-naming=[name].[ext]'];
    const code = await new Promise((resolveCode, reject) => {
      const child = spawnBin('bun', args, { cwd: ROOT, env: { ...process.env, TEMP: buildTemp, TMP: buildTemp }, stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', resolveCode);
    });
    if (code !== 0 || !existsSync(binPath)) throw new Error(`bun build --compile (${target}) 失败`);
    chmodSync(binPath, 0o755);
    artifacts[`agent-purge-${version}-linux-${arch}`] = hashFile(binPath);

    if (arch === process.arch) {
      await smoke(binPath, [], { cwd: buildTemp, version, serve: serveCheck });
    }

    // 便携包：解包即用，附 install.sh 可无 root 装进 ~/.local
    const stage = join(buildTemp, `stage-${arch}`, `agent-purge-${version}-linux-${arch}`);
    mkdirSync(stage, { recursive: true });
    copyFileSync(binPath, join(stage, 'agent-purge'));
    chmodSync(join(stage, 'agent-purge'), 0o755);
    copyFileSync(join(ROOT, 'web/assets/agent-purge.png'), join(stage, 'agent-purge.png'));
    copyFileSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'));
    copyFileSync(join(ROOT, 'README.md'), join(stage, 'README.md'));
    writeFileSync(join(stage, 'agent-purge.desktop'), desktopEntry);
    writeFileSync(join(stage, 'install.sh'), installScript);
    chmodSync(join(stage, 'install.sh'), 0o755);
    // 不在 Windows 挂载盘上构建时权限也是确定的：显式归一化，避免继承宿主 0666/0777。
    for (const name of ['agent-purge.png', 'LICENSE', 'README.md', 'agent-purge.desktop']) chmodSync(join(stage, name), 0o644);

    const tarball = join(DIST, `agent-purge-${version}-linux-${arch}.tar.gz`);
    rmSync(tarball, { force: true });
    const folder = `agent-purge-${version}-linux-${arch}`;
    run('tar', ['-czf', tarball, '-C', dirname(stage), folder], `tar ${arch}`);
    const list = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8', windowsHide: true });
    for (const entry of ['agent-purge', 'install.sh', 'LICENSE', 'README.md', 'agent-purge.desktop', 'agent-purge.png']) {
      if (!list.stdout.includes(`${folder}/${entry}`)) throw new Error(`便携包缺少 ${entry}（${arch}）`);
    }
    artifacts[`agent-purge-${version}-linux-${arch}.tar.gz`] = hashFile(tarball);
    console.log(`便携包：${tarball} (${(statSync(tarball).size / 1048576).toFixed(1)} MB)`);

    if (wantDeb) {
      if (!hasCommand('dpkg-deb')) {
        console.log('  跳过 .deb：未找到 dpkg-deb（Debian/Ubuntu 可用 apt install dpkg 安装）');
      } else {
        const debRoot = join(buildTemp, `deb-${arch}`);
        mkdirSync(join(debRoot, 'DEBIAN'), { recursive: true });
        mkdirSync(join(debRoot, 'opt', 'agent-purge'), { recursive: true });
        mkdirSync(join(debRoot, 'usr', 'bin'), { recursive: true });
        mkdirSync(join(debRoot, 'usr', 'share', 'applications'), { recursive: true });
        mkdirSync(join(debRoot, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps'), { recursive: true });
        mkdirSync(join(debRoot, 'usr', 'share', 'doc', 'agent-purge'), { recursive: true });
        copyFileSync(binPath, join(debRoot, 'opt', 'agent-purge', 'agent-purge'));
        chmodSync(join(debRoot, 'opt', 'agent-purge', 'agent-purge'), 0o755);
        copyFileSync(join(ROOT, 'LICENSE'), join(debRoot, 'opt', 'agent-purge', 'LICENSE'));
        copyFileSync(join(ROOT, 'README.md'), join(debRoot, 'opt', 'agent-purge', 'README.md'));
        symlinkSync('/opt/agent-purge/agent-purge', join(debRoot, 'usr', 'bin', 'agent-purge'));
        writeFileSync(join(debRoot, 'usr', 'share', 'applications', 'agent-purge.desktop'), desktopEntry);
        copyFileSync(join(ROOT, 'web/assets/agent-purge.png'), join(debRoot, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps', 'agent-purge.png'));
        chmodSync(join(debRoot, 'opt', 'agent-purge', 'LICENSE'), 0o644);
        chmodSync(join(debRoot, 'opt', 'agent-purge', 'README.md'), 0o644);
        chmodSync(join(debRoot, 'usr', 'share', 'applications', 'agent-purge.desktop'), 0o644);
        chmodSync(join(debRoot, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps', 'agent-purge.png'), 0o644);
        writeFileSync(join(debRoot, 'usr', 'share', 'doc', 'agent-purge', 'copyright'), `Format
Upstream-Name: agent-purge
Source: ${homepage}

Files: *
Copyright: agent-purge contributors
License: MIT
 Same as the LICENSE file shipped in /opt/agent-purge/LICENSE.
`);
        writeFileSync(join(debRoot, 'usr', 'share', 'doc', 'agent-purge', 'changelog.Debian'), `agent-purge (${version}) unstable; urgency=medium

  * Release ${version}.

 -- ${maintainer}  Thu, 01 Jan 1970 00:00:00 +0000
`);
        writeFileSync(join(debRoot, 'DEBIAN', 'control'), debControl(arch));
        chmodSync(join(debRoot, 'DEBIAN'), 0o755);
        const deb = join(DIST, `agent-purge-${version}-linux-${arch}.deb`);
        rmSync(deb, { force: true });
        run('dpkg-deb', ['--build', '--root-owner-group', debRoot, deb], `dpkg-deb ${arch}`);
        const info = spawnSync('dpkg-deb', ['-f', deb, 'Package', 'Version', 'Architecture'], { encoding: 'utf8', windowsHide: true });
        if (info.status !== 0 || !info.stdout.includes(version) || !info.stdout.includes(DEB_ARCH[arch])) {
          throw new Error(`.deb 元数据校验失败（${arch}）：${info.stderr || info.stdout}`);
        }
        const contents = spawnSync('dpkg-deb', ['-c', deb], { encoding: 'utf8', windowsHide: true });
        if (!contents.stdout.includes('./opt/agent-purge/agent-purge') || !contents.stdout.includes('./usr/bin/agent-purge')) {
          throw new Error(`.deb 文件清单缺少入口（${arch}）`);
        }
        artifacts[`agent-purge-${version}-linux-${arch}.deb`] = hashFile(deb);
        console.log(`Debian 包：${deb} (${(statSync(deb).size / 1048576).toFixed(1)} MB)`);
      }
    }

    if (wantAppImage) {
      if (!hasCommand('appimagetool')) {
        console.log('  跳过 .AppImage：未找到 appimagetool（可从 AppImageKit releases 获取后放入 PATH）');
      } else {
        const appDir = join(buildTemp, `AppDir-${arch}`);
        mkdirSync(join(appDir, 'usr', 'bin'), { recursive: true });
        mkdirSync(join(appDir, 'usr', 'share', 'applications'), { recursive: true });
        mkdirSync(join(appDir, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps'), { recursive: true });
        copyFileSync(binPath, join(appDir, 'usr', 'bin', 'agent-purge'));
        chmodSync(join(appDir, 'usr', 'bin', 'agent-purge'), 0o755);
        copyFileSync(join(ROOT, 'web/assets/agent-purge.png'), join(appDir, 'agent-purge.png'));
        copyFileSync(join(ROOT, 'web/assets/agent-purge.png'), join(appDir, '.DirIcon'));
        copyFileSync(join(ROOT, 'web/assets/agent-purge.png'), join(appDir, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps', 'agent-purge.png'));
        writeFileSync(join(appDir, 'agent-purge.desktop'), desktopEntry);
        copyFileSync(join(appDir, 'agent-purge.desktop'), join(appDir, 'usr', 'share', 'applications', 'agent-purge.desktop'));
        writeFileSync(join(appDir, 'AppRun'), appRun);
        chmodSync(join(appDir, 'AppRun'), 0o755);
        const image = join(DIST, `agent-purge-${version}-linux-${arch}.AppImage`);
        rmSync(image, { force: true });
        run('appimagetool', ['--no-appstream', appDir, image], `appimagetool ${arch}`, {
          env: { ...process.env, ARCH: APPIMAGE_ARCH[arch], APPIMAGE_EXTRACT_AND_RUN: '1' },
        });
        chmodSync(image, 0o755);
        const probeRun = spawnSync(image, ['--help'], { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' } });
        if (probeRun.status !== 0) {
          console.log(`  警告：AppImage 自检未通过（exit ${probeRun.status ?? 'null'}）：${(probeRun.stderr || '').slice(-300)}`);
        }
        artifacts[`agent-purge-${version}-linux-${arch}.AppImage`] = hashFile(image);
        console.log(`AppImage：${image} (${(statSync(image).size / 1048576).toFixed(1)} MB)`);
      }
    }
  }

  const manifest = { schema: 1, flavor: 'linux', version, platform: process.platform, arch: process.arch, files: artifacts };
  writeFileSync(join(DIST, 'linux-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`清单：${join(DIST, 'linux-manifest.json')}（${Object.keys(artifacts).length} 个产物）`);
} finally {
  rmSync(ENTRY, { force: true });
  rmSync(buildTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
