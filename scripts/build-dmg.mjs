#!/usr/bin/env node
// Build unsigned macOS .app bundles and .dmg disk images on a macOS runner.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureBin, spawnBin } from '../lib/spawn.mjs';
import { listFiles, readJSON } from './build-common.mjs';
import { smoke } from './build-smoke.mjs';

if (process.platform !== 'darwin') {
  throw new Error('构建 macOS .dmg 需要 macOS 环境（本地非 macOS 可通过 GitHub Actions release.yml 构建）。');
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ENTRY = join(ROOT, '.build-entry.mjs');
const version = readJSON(join(ROOT, 'package.json')).version;

const bun = captureBin('bun', ['--version']);
if (!bun) throw new Error('构建 macOS 产物需要 Bun，请先安装 Bun');

const assets = [
  'matrix.json', 'package.json', 'lib/evidence.mjs',
  'web/ui.html', 'web/app.js', 'web/model.mjs', 'web/styles.css',
  ...listFiles(join(ROOT, 'web/assets')).map(file => `web/assets/${file}`),
  ...listFiles(join(ROOT, 'lib/templates/personas')).map(file => `lib/templates/personas/${file}`),
];
const duplicates = assets.map(file => file.split('/').pop()).filter((file, index, all) => all.indexOf(file) !== index);
if (duplicates.length) throw new Error('内嵌资源重名：' + duplicates.join(', '));

const run = (cmd, args, label) => {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`${label} 失败（exit ${res.status ?? 'null'}）`);
};

const buildIcns = (workDir) => {
  const srcPng = join(ROOT, 'web', 'assets', 'agent-purge.png');
  if (!existsSync(srcPng)) throw new Error(`缺少图标源文件：${srcPng}`);
  const iconset = join(workDir, 'AppIcon.iconset');
  mkdirSync(iconset, { recursive: true });
  const specs = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
  ];
  for (const [px, name] of specs) {
    run('sips', ['-z', String(px), String(px), srcPng, '--out', join(iconset, name)], `sips ${name}`);
  }
  const icns = join(workDir, 'AppIcon.icns');
  run('iconutil', ['-c', 'icns', iconset, '-o', icns], 'iconutil');
  return icns;
};

const infoPlist = (ver) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>agent-purge</string>
  <key>CFBundleExecutable</key>
  <string>agent-purge</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>top.zichuanlan.agent-purge</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>agent-purge</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${ver}</string>
  <key>CFBundleVersion</key>
  <string>${ver}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;

const onlyNative = process.argv.includes('--native-only');
const arches = onlyNative ? [process.arch] : ['arm64', 'x64'];

mkdirSync(DIST, { recursive: true });
const buildTemp = mkdtempSync(join(tmpdir(), 'ap-dmg-'));
console.log(`Bun ${bun.trim()} -> macOS .dmg (${arches.join(', ')})`);

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

  const icnsPath = buildIcns(buildTemp);

  for (const arch of arches) {
    const target = `bun-darwin-${arch}`;
    const binPath = join(buildTemp, `agent-purge-darwin-${arch}`);
    const args = ['build', ENTRY, '--compile', `--target=${target}`, `--outfile=${binPath}`, '--asset-naming=[name].[ext]'];
    const code = await new Promise((resolveCode, reject) => {
      const child = spawnBin('bun', args, { cwd: ROOT, env: { ...process.env, TEMP: buildTemp, TMP: buildTemp }, stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', resolveCode);
    });
    if (code !== 0 || !existsSync(binPath)) throw new Error(`bun build --compile (${target}) 失败`);
    chmodSync(binPath, 0o755);

    if (arch === process.arch) {
      await smoke(binPath, [], { cwd: buildTemp, version, serve: !process.argv.includes('--no-serve-check') });
    }

    const stage = join(buildTemp, `stage-${arch}`);
    const appDir = join(stage, 'agent-purge.app');
    const macosDir = join(appDir, 'Contents', 'MacOS');
    const resDir = join(appDir, 'Contents', 'Resources');
    mkdirSync(macosDir, { recursive: true });
    mkdirSync(resDir, { recursive: true });

    copyFileSync(binPath, join(macosDir, 'agent-purge'));
    chmodSync(join(macosDir, 'agent-purge'), 0o755);
    copyFileSync(icnsPath, join(resDir, 'AppIcon.icns'));
    writeFileSync(join(appDir, 'Contents', 'Info.plist'), infoPlist(version));
    symlinkSync('/Applications', join(stage, 'Applications'));

    const dmgName = `agent-purge-${version}-darwin-${arch}.dmg`;
    const dmgPath = join(DIST, dmgName);
    rmSync(dmgPath, { force: true });
    run('hdiutil', ['create', '-volname', `agent-purge ${version}`, '-srcfolder', stage, '-ov', '-format', 'UDZO', dmgPath], `hdiutil create ${dmgName}`);
    run('hdiutil', ['verify', dmgPath], `hdiutil verify ${dmgName}`);
    console.log(`macOS 未签名镜像：${dmgPath} (${(statSync(dmgPath).size / 1048576).toFixed(1)} MB)`);
  }
} finally {
  rmSync(ENTRY, { force: true });
  rmSync(buildTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
