import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, readJSON } from './build-common.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = readJSON(join(root, 'package.json')).version;
const dist = join(root, 'dist');
const names = [`agent-purge-${version}.zip`, `agent-purge-${version}-setup.exe`, 'agent-purge.exe'];
for (const name of names) if (!existsSync(join(dist, name))) throw new Error(`缺少最终发行产物：${name}`);
const text = names.map(name => `${hashFile(join(dist, name))}  ${name}`).join('\n') + '\n';
writeFileSync(join(dist, 'SHA256SUMS.txt'), text);
console.log(text);
