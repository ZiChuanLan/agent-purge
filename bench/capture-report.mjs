// Summaries retain protocol roles and observations; marker delivery is not model behavior.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export function verificationSummary(report) {
 return {schema:1,at:report.at,reportPath:report.out,kind:report.kind,limitations:report.limitations??[],results:report.harnesses.map(h=>{
  const modes=(h.modes??[]).map(m=>({mode:m.mode,status:m.status,reason:m.reason??null,exitCode:m.exitCode,timedOut:m.timedOut,requests:(m.requests??[]).filter(r=>r.kind==='main').map(r=>({roles:r.roles,chars:r.chars,markerCount:r.markerCount,identityLines:r.identityLines,toolDefinitions:r.toolDefinitions}))}));
  const evidence=modes.map(m=>`${m.mode}: ${m.status} · ${m.requests.map(r=>`${r.roles.join('+')} ${r.chars}字 / 人设${r.markerCount} / 身份句${r.identityLines.length} / 工具${r.toolDefinitions}`).join('; ')}`).join('；');
  return {harness:h.harness,version:h.version||null,status:h.status,reason:h.reason||null,at:report.at,scope:h.scope??null,processFile:h.processFile??null,evidence,modes,hotSwitch:h.hotSwitch??{status:'not-tested'}};
 })};
}
export function writeVerification(file, report) {
 mkdirSync(dirname(file),{recursive:true});const temp=`${file}.${randomUUID()}.tmp`;
 writeFileSync(temp,JSON.stringify(verificationSummary(report),null,2));renameSync(temp,file);
}
