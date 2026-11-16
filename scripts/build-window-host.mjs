// 构建 WebView2 原生窗口宿主（packaging/window-host.cpp）。
//
// WebView2 SDK 只在构建期需要：头文件用于编译，WebView2Loader.dll 随包分发（运行时由宿主从 exe
// 同目录加载，不链接导入库）。SDK 从 NuGet 拉取并校验 sha256，版本与哈希都钉死在这里。
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 钉死的 WebView2 SDK：升级时同时更新版本与 sha256，并确认 window-host.cpp 里的 IID 没变。 */
const SDK_VERSION = '1.0.4314.35';
const SDK_SHA256 = '90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4';
const SDK_URL = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${SDK_VERSION}/microsoft.web.webview2.${SDK_VERSION}.nupkg`;

/** window-host.cpp 里手写的 IID 必须与 SDK 头文件一致（mingw 没有 __declspec(uuid)）。 */
const REQUIRED_IIDS = {
  ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler: '4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d',
  ICoreWebView2CreateCoreWebView2ControllerCompletedHandler: '6c4819f3-c9b7-4260-8127-c9f5bde7f68c',
  ICoreWebView2Controller2: 'c979903e-d4ca-4228-92eb-47ee3fa96eab',
};

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} 失败：${result.error?.message ?? result.stderr ?? result.stdout}`);
  return result;
}

/** 下载并校验 SDK，解出编译需要的头文件与 x64 加载器；缓存落在 dist/.cache，重复构建不再联网。 */
function ensureSdk(root, cacheRoot) {
  const cache = join(cacheRoot, `webview2-${SDK_VERSION}`);
  const header = join(cache, 'include/WebView2.h');
  const loader = join(cache, 'WebView2Loader.dll');
  if (existsSync(header) && existsSync(loader)) return { header, include: join(cache, 'include'), loader };

  mkdirSync(cache, { recursive: true });
  const nupkg = join(cache, `webview2-${SDK_VERSION}.nupkg`);
  if (!existsSync(nupkg) || sha256(nupkg) !== SDK_SHA256) {
    console.log(`下载 WebView2 SDK ${SDK_VERSION}…`);
    const download = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing -Uri '${SDK_URL}' -OutFile '${nupkg.replaceAll("'", "''")}'`],
    { encoding: 'utf8', windowsHide: true });
    if (download.status !== 0) throw new Error(`WebView2 SDK 下载失败：${download.error?.message ?? download.stderr}`);
  }
  const actual = sha256(nupkg);
  if (actual !== SDK_SHA256) throw new Error(`WebView2 SDK 校验失败：期望 ${SDK_SHA256}，实际 ${actual}`);

  const unpack = join(cache, 'unpack');
  rmSync(unpack, { recursive: true, force: true });
  mkdirSync(unpack, { recursive: true });
  run('tar', ['-xf', nupkg, '-C', unpack]); // Windows 自带 bsdtar 能解 zip
  mkdirSync(join(cache, 'include'), { recursive: true });
  for (const name of ['WebView2.h', 'WebView2EnvironmentOptions.h']) {
    copyFileSync(join(unpack, 'build/native/include', name), join(cache, 'include', name));
  }
  copyFileSync(join(unpack, 'build/native/x64/WebView2Loader.dll'), loader);
  rmSync(unpack, { recursive: true, force: true });
  return { header, include: join(cache, 'include'), loader };
}

/** 头文件里的 MIDL_INTERFACE 字符串与 window-host.cpp 的手写 IID 对账。 */
function verifyIids(header, source) {
  const text = readFileSync(header, 'utf8');
  const cpp = readFileSync(source, 'utf8');
  const written = new Set();
  for (const match of cpp.matchAll(/\{\s*(0x[0-9a-f]{1,8}),\s*(0x[0-9a-f]{1,4}),\s*(0x[0-9a-f]{1,4}),\s*\{([^}]*)\}\s*\}/gi)) {
    const hex = (value, width) => Number(value).toString(16).padStart(width, '0');
    const tail = match[4].split(',').map(part => Number(part.trim()).toString(16).padStart(2, '0')).join('');
    written.add(`${hex(match[1], 8)}-${hex(match[2], 4)}-${hex(match[3], 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`);
  }
  for (const [name, expected] of Object.entries(REQUIRED_IIDS)) {
    const match = new RegExp(`MIDL_INTERFACE\\("([0-9A-Fa-f-]+)"\\)\\s*\\r?\\n\\s*${name}\\s*:`).exec(text);
    if (!match) throw new Error(`WebView2 SDK 里找不到 ${name}，请核对 SDK 版本`);
    if (match[1].toLowerCase() !== expected) throw new Error(`${name} 的 IID 变了：SDK=${match[1]}，window-host.cpp=${expected}`);
    if (!written.has(expected)) throw new Error(`window-host.cpp 里没有 ${name} 的 IID ${expected}，请同步更新`);
  }
}

/**
 * 宿主的导入表里不许出现 MinGW 运行库。
 * 这些 DLL 只存在于构建机的工具链里，用户机器上没有，加载器会直接以 0xC0000135 退出（issue #20）。
 * 构建期用 objdump 对账，比等用户报「双击没反应」便宜得多。
 */
export function verifyStaticRuntime(exe, label = '窗口宿主', {
  inspect = file => spawnSync('objdump', ['-p', file], { encoding: 'utf8', windowsHide: true }),
} = {}) {
  const dump = inspect(exe);
  if (dump.error || dump.status !== 0)
    throw Object.assign(new Error(`objdump: ${dump.error?.message ?? dump.stderr}`), { code: 'RUNTIME_INSPECTION' });
  const imports = [...String(dump.stdout).matchAll(/DLL Name:\s*(\S+)/g)].map(match => match[1]);
  if (!imports.length)
    throw Object.assign(new Error(`${label}导入表未能读取，不能确认运行库依赖：${exe}`), { code: 'RUNTIME_INSPECTION' });
  const dynamic = imports
    .filter(name => /^(libgcc_s_.*|libstdc\+\+.*|libwinpthread.*|libssp.*|libgomp.*|libquadmath.*)\.dll$/i.test(name));
  if (!dynamic.length) return;
  // code 让调用方把这类失败当硬错误：真正的宿主构建失败可以退回浏览器窗口，发布一个加载不了的 exe 不行。
  throw Object.assign(
    new Error(`${label}仍动态依赖 MinGW 运行库（${dynamic.join('、')}）：用户机器上没有这些 DLL，会 0xC0000135 静默退出；请保持 -static`),
    { code: 'MINGW_RUNTIME' });
}
/**
 * 编译窗口宿主并放进瘦包目录。
 * @param {string} root 仓库根目录
 * @param {string} out 瘦包输出目录（dist/agent-purge）
 * @param {string} cacheRoot 构建缓存目录（dist/.cache）
 */
export function buildWindowHost(root, out, cacheRoot = join(root, 'dist', '.cache')) {
  const source = join(root, 'packaging/window-host.cpp');
  const resource = join(root, 'packaging/window-host.rc');
  const exe = join(out, 'agent-purge-window.exe');
  const sdk = ensureSdk(root, cacheRoot);
  verifyIids(sdk.header, source);

  // 安装器只发 x64：编译器不是 64 位就直接失败，别产出一个加载不了 x64 WebView2Loader.dll 的宿主。
  const machine = run('g++', ['-dumpmachine']).stdout.trim();
  if (!machine.startsWith('x86_64')) throw new Error(`窗口宿主需要 64 位编译器，当前是 ${machine}`);
  const object = join(cacheRoot, 'window-host.res');
  const windres = spawnSync('windres', [resource, '-O', 'coff', '-o', object], { cwd: root, encoding: 'utf8' });
  if (windres.status !== 0) throw new Error(`windres: ${windres.error?.message ?? windres.stderr}`);

  // -static：把 libgcc / libstdc++ / libwinpthread 静态链进来。这三个 DLL 系统不自带、安装包也不带，
  // 一旦动态依赖，用户机器上就是 0xC0000135 静默退出（issue #20）。体积从 ~70KB 涨到 ~270KB，值得。
  const gcc = spawnSync('g++', ['-std=c++17', '-O2', '-mwindows', '-s', '-static', '-I', sdk.include, source, object, '-o', exe,
    '-lole32', '-luuid', '-lshell32'], { cwd: root, encoding: 'utf8' });
  if (gcc.status !== 0) throw new Error(`g++: ${gcc.error?.message ?? gcc.stderr}`);
  if (!existsSync(exe)) throw new Error('窗口宿主没有生成');
  verifyStaticRuntime(exe);

  const loader = join(out, 'WebView2Loader.dll');
  writeFileSync(loader, readFileSync(sdk.loader));
  console.log(`窗口宿主：${exe} (${Math.round(statSync(exe).size / 1024)} KB) + WebView2Loader.dll (${Math.round(statSync(loader).size / 1024)} KB)`);
  return { exe, loader };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  buildWindowHost(root, join(root, 'dist', 'agent-purge'));
}
