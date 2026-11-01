// Read-only publication check: uses the Git candidate set, not the entire
// workstation tree, and never stages, deletes, commits or uploads anything.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_ROOTS = /^(?:node_modules|out|dist|coverage|playwright-report|test-results|\.pi|\.opencode|\.playwright-mcp|\.superdesign|\.sandbox|\.tmp|notes|personas)\//;
const GENERATED = /(?:^|\/)(?:node_modules|__pycache__)\//;
const BINARY_OUTPUT = /\.(?:exe|dll|tgz|zip|log|pyc)$/i;

export function publicationProblem(file, { distribution = false, size = 0 } = {}) {
  const name = file.replaceAll('\\', '/');
  if (PRIVATE_ROOTS.test(name) || GENERATED.test(name) ||
      /^(?:state\.json|\.build-entry\.mjs)$/.test(name) ||
      /^web\/shots\//.test(name) || /^docs\/evidence\//.test(name) ||
      name === 'magpie-plugin/page/personas.js') return '本机数据或生成产物';
  if (/(?:^|\/)\.env(?:\..*)?$/.test(name) && !name.endsWith('.env.example')) return '本地环境变量文件';
  if (BINARY_OUTPUT.test(name)) return '二进制发行包、压缩包或日志';
  if (size > 5 * 1024 * 1024) return '超过 5 MiB；检查是否应放入 Release';
  if (distribution && /^(?:test|scripts|packaging|\.github)\//.test(name)) return '开发文件不应进入运行包';
  if (distribution && /^magpie-plugin\//.test(name) && name !== 'magpie-plugin/README.md') return '可选插件不应混入 CLI 包';
  if (distribution && /^(?:playwright\.config\.mjs|package-lock\.json)$/.test(name)) return '开发配置不应进入运行包';
  return null;
}

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, ...options });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `git ${args.join(' ')} failed`);
  return result.stdout;
}

function anchors(markdown) {
  const counts = new Map(), result = new Set();
  const text = markdown.replace(/^```[\s\S]*?^```/gm, '');
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const name = match[1].replace(/<[^>]*>/g, '').toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '').replaceAll(' ', '-');
    const count = counts.get(name) || 0;
    counts.set(name, count + 1);
    result.add(count ? `${name}-${count}` : name);
  }
  return result;
}

export function checkDocumentationLinks(files, root = ROOT) {
  const names = new Set(files.map(file => file.replaceAll('\\', '/'))), errors = [];
  for (const file of files.filter(file => file.endsWith('.md'))) {
    const text = readFileSync(resolve(root, file), 'utf8');
    // Local inline Markdown links, including README screenshots and anchors.
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1].replace(/^<|>$/g, '');
      if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith('//')) continue;
      let target, fragment;
      try { [target, fragment] = href.split('#').map(decodeURIComponent); }
      catch { errors.push(`${file}: 无效链接 ${href}`); continue; }
      const full = target ? resolve(dirname(resolve(root, file)), target.split('?')[0]) : resolve(root, file);
      const local = relative(root, full).replaceAll('\\', '/');
      if (isAbsolute(local) || local === '..' || local.startsWith('../') || !names.has(local)) {
        errors.push(`${file}: 链接不在可提交文件中 ${href}`); continue;
      }
      if (fragment && local.endsWith('.md') && !anchors(readFileSync(full, 'utf8')).has(fragment))
        errors.push(`${file}: 标题锚点不存在 ${href}`);
    }
  }
  return errors;
}

export function checkRepository() {
  const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))]
    .filter(file => existsSync(resolve(ROOT, file))).sort();
  const errors = [];
  for (const file of files) {
    const stat = lstatSync(resolve(ROOT, file));
    if (!stat.isFile()) { errors.push(`${file}: 非普通文件`); continue; }
    const problem = publicationProblem(file, { size: stat.size });
    if (problem) errors.push(`${file}: ${problem}`);
  }
  errors.push(...checkDocumentationLinks(files));
  const template = 'lib/templates/personas/neutral.md';
  if (!files.includes(template)) errors.push(`${template}: 缺失或被忽略`);
  const sentinels = [
    'out/request.json', 'dist/app.exe', '.pi/plans/local.md', '.opencode/package.json',
    '.tmp/debug.json', 'personas/private.md', 'state.json', '.env', 'web/shots/wip.png',
    'docs/evidence/local.json', 'packaging/launcher.exe', 'download.tgz',
  ];
  const ignored = new Set(git(['check-ignore', '--no-index', '-z', '--stdin'], { input: sentinels.join('\0') + '\0' }).split('\0'));
  for (const file of sentinels) if (!ignored.has(file)) errors.push(`.gitignore 未排除 ${file}`);
  if (errors.length) throw new Error(`仓库检查失败：\n${errors.map(e => `- ${e}`).join('\n')}`);
  return { files, message: `仓库检查通过：${files.length} 个可提交文件；私人数据、构建产物与文档链接已检查。` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(checkRepository().message); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
