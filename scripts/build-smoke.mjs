import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnv } from '../lib/environment.mjs';

export async function smoke(command, prefix, { cwd, version, serve = true, withoutNode = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ap-build-smoke-'));
  const env = isolatedEnv(root);
  if (withoutNode) {
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = process.platform === 'win32' ? join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32') : '/usr/bin:/bin';
    const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'node.exe' : 'node'], { env, encoding: 'utf8', windowsHide: true });
    if (probe.status === 0) throw new Error('独立产物验收的 PATH 仍有 Node');
  }
  let child, ended;
  const run = args => {
    const result = spawnSync(command, [...prefix, ...args], { cwd, env, encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`smoke ${args.join(' ')}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
    return result.stdout;
  };
  try {
    run(['--help']);
    if (readdirSync(env.AGENT_PURGE_HOME).length || readdirSync(env.AGENT_PURGE_JOURNAL_DIR).length) throw new Error('--help 写入了数据或恢复目录');
    run(['status']);
    console.log('  smoke: --help 只读 / status 通过');
    if (!serve) return;
    child = spawn(command, [...prefix, '--serve', '0'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    ended = new Promise(resolve => child.once('close', resolve));
    const url = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('--serve 启动超时')), 20000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); reject(new Error(`--serve 提前退出 (${code}): ${output.slice(-1000)}`)); });
      child.stdout.on('data', bytes => {
        output += bytes.toString();
        const match = /agent-purge web → (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.stderr.on('data', bytes => output = (output + bytes.toString()).slice(-10000));
    });
    for (const path of ['/', '/api/state', '/app.js', '/model.mjs', '/evidence.mjs', '/styles.css', '/assets/pi.png']) {
      const response = await fetch(url + path, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`smoke GET ${path}: ${response.status}`);
      if (path === '/api/state') {
        const state = await response.json();
        if (state.version !== version) throw new Error('产物运行版本与 package.json 不一致');
        if (!state.personas?.some(p => p.id === 'neutral' && p.body?.trim())) throw new Error('全新安装缺少中性模板');
      } else await response.arrayBuffer();
    }
    child.kill(); await ended; child = null;
    console.log(`  smoke: Web 资源及运行版本 ${version} 通过`);
  } finally {
    if (child) { child.kill(); await ended; }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
