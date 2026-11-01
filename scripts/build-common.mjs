import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const hashFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export function listFiles(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`发布树包含符号链接：${path}`);
    return entry.isDirectory() ? listFiles(root, path) : [relative(root, path).replaceAll('\\', '/')];
  }).sort();
}
export function runtimeFiles(root) {
  return ['bin','lib','backends','bench'].flatMap(dir => listFiles(join(root,dir)).map(file => `${dir}/${file}`))
    .concat(['web/server.mjs','web/ui.html','web/app.js','web/model.mjs','web/styles.css',...listFiles(join(root,'web','assets')).map(file=>`web/assets/${file}`),'matrix.json','package.json','README.md','CONTRIBUTING.md','LICENSE'])
    .concat(existsSync(join(root,'magpie-plugin','README.md')) ? ['magpie-plugin/README.md'] : [])
    .concat(['docs/usage.md','docs/compatibility.md','docs/architecture.md','docs/releasing.md','docs/LEGAL.md',
      'docs/images/console-desktop.png','docs/images/console-mobile.png'].filter(file => existsSync(join(root,file)))).sort();
}
export function writeManifest(root, flavor, version, sources = root) {
  const files = Object.fromEntries(listFiles(root).filter(file=>file !== 'build-manifest.json').map(file=>[file,hashFile(join(root,file))]));
  const sourceFiles = Object.fromEntries(runtimeFiles(sources).map(file=>[file,hashFile(join(sources,file))]));
  const manifest = { schema: 1, flavor, version, files, sources: sourceFiles };
  writeFileSync(join(root,'build-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
export function readJSON(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`构建 JSON 读取失败：${file}：${error.message}`, { cause: error }); }
}
export function validateThin(root, source) {
  const manifest = readJSON(join(root,'build-manifest.json'));
  const version = readJSON(join(source,'package.json')).version;
  if (manifest.schema !== 1 || manifest.flavor !== 'thin' || manifest.version !== version) throw new Error('瘦包 manifest/版本不匹配，请重新 build:js');
  const files = listFiles(root).filter(file=>file !== 'build-manifest.json');
  if (JSON.stringify(files) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error('瘦包文件清单已改变，请重新 build:js');
  for (const file of files) if (hashFile(join(root,file)) !== manifest.files[file]) throw new Error(`瘦包文件已改变：${file}`);
  const current = Object.fromEntries(runtimeFiles(source).map(file=>[file,hashFile(join(source,file))]));
  if (JSON.stringify(current) !== JSON.stringify(manifest.sources)) throw new Error('工作区与瘦包源码不一致，请重新 build:js，随后再 build:setup');
  return manifest;
}
