// Loopback-only fixture provider: never forwards requests, never stores authorization headers.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => b.text ?? b.content ?? '').filter(x => typeof x === 'string').join('\n') : '';
export function inspectRequest(body, marker = '') {
 const sections=[];
 if(body.system) sections.push({role:'system',field:'system',text:textOf(body.system)});
 if(body.instructions) sections.push({role:'system',field:'instructions',text:textOf(body.instructions)});
 for(const key of ['messages','input']) if(Array.isArray(body[key])) body[key].forEach((m,i)=>{if(['system','developer','user'].includes(m.role))sections.push({role:m.role,field:`${key}[${i}].content`,text:textOf(m.content)});});
 // Gemini 原生协议：systemInstruction.parts + contents[]（role 是 user/model，没有 system 角色）
 if(body.systemInstruction) sections.push({role:'system',field:'systemInstruction',text:textOf(body.systemInstruction.parts)});
 if(Array.isArray(body.contents)) body.contents.forEach((m,i)=>{if(m.role==='user')sections.push({role:'user',field:`contents[${i}].parts`,text:textOf(m.parts)});});
 const privileged=sections.filter(s=>s.role!=='user');const text=privileged.map(s=>s.text).join('\n\n');
 return {roles:[...new Set(privileged.map(s=>s.role))],fields:privileged.map(s=>s.field),chars:text.length,
  sha256:createHash('sha256').update(text).digest('hex'),markerCount:marker?text.split(marker).length-1:0,
  userMarkerCount:marker?sections.filter(s=>s.role==='user').reduce((n,s)=>n+s.text.split(marker).length-1,0):0,
  identityLines:text.split('\n').filter(l=>/^\s*(?:You are|You're|你是|您是)/i.test(l) && /Claude|ChatGPT|GPT|Gemini|Codex|Copilot|DeepSeek|OpenCode|CodeBuddy|Hermes|Grok|\bpi\b|\bomp\b|AI (?:agent|assistant|model)|coding assistant/i.test(l)).map(l=>l.slice(0,240)),
  toolDefinitions:Array.isArray(body.tools)?body.tools.length:0,text};
}
// Auxiliary requests can contain the same user query; never grade a title/summary as the main turn.
export function requestKind(body, query = 'Reply CAPTURE_OK.') {
 const {text} = inspectRequest(body);
 const users = (body.messages ?? body.input ?? []).filter(m => m.role === 'user').map(m => textOf(m.content));
 // strict can replace the title system as well; its task envelope still identifies the auxiliary call.
 if (users.some(t => /^\s*Generate a title for this conversation:/i.test(t)) || /(?:^|\n)\s*(?:You are (?:tasked with generating the session title|a title generator)|You name conversations so the user can find them later|Create a concise title for an AI coding-assistant session|Write an ultra-short dashboard line)/i.test(text)) return 'auxiliary';
 // Gemini 原生协议把用户回合放在 contents[]，没有 messages/input
 return JSON.stringify(body.messages ?? body.input ?? body.contents ?? '').includes(query) ? 'main' : 'unclassified';
}
function response(res, body, protocol, id) {
 const answer='CAPTURE_OK';const model=body.model||'capture';
 if(protocol==='gemini'){
  // Gemini 原生：gemini-3.x-preview:streamGenerateContent?alt=sse → SSE data 帧
  const payload={candidates:[{content:{parts:[{text:answer}],role:'model'},finishReason:'STOP',index:0}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,totalTokenCount:12}};
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  res.write(`data: ${JSON.stringify(payload)}\n\n`);res.end();return;
 }
 const message={id:`msg_${id}`,type:'message',role:'assistant',model,content:[{type:'text',text:answer}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:2}};
 const item={id:`msg_${id}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:answer,annotations:[]}]};
 const resp={id:`resp_${id}`,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model,output:[item],usage:{input_tokens:10,output_tokens:2,total_tokens:12}};
 if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(protocol==='anthropic'?message:protocol==='responses'?resp:{id:`chatcmpl_${id}`,object:'chat.completion',created:1,model,choices:[{index:0,message:{role:'assistant',content:answer},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}}));return;}
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
 const emit=(data,event)=>res.write(`${event?`event: ${event}\n`:''}data: ${JSON.stringify(data)}\n\n`);
 if(protocol==='anthropic'){
  const events=[{type:'message_start',message:{...message,content:[],stop_reason:null}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:answer}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}},{type:'message_stop'}];
  for(const e of events)emit(e,e.type);
 }else if(protocol==='responses'){
  const events=[{type:'response.created',response:{...resp,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:answer},{type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:answer},{type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part:item.content[0]},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:resp}];
  events.forEach((e,i)=>emit({...e,sequence_number:i},e.type));
 }else{
  const base={id:`chatcmpl_${id}`,object:'chat.completion.chunk',created:1,model};
  emit({...base,choices:[{index:0,delta:{role:'assistant',content:answer},finish_reason:null}]});
  emit({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});res.write('data: [DONE]\n\n');
 }
 res.end();
}
export async function startCaptureProvider(outDir) {
 if(outDir)mkdirSync(outDir,{recursive:true});const captures=[];let seq=0;
 const server=createServer((req,res)=>{
  req.on('error',()=>{});res.on('error',()=>{});
  if(req.method==='CONNECT'||/^https?:\/\//i.test(req.url)){res.writeHead(403);res.end('No upstream forwarding');return;}
  if(req.method==='GET'&&/\/models(?:\?|$)/.test(req.url)){res.setHeader('content-type','application/json');res.end(JSON.stringify({object:'list',data:[{id:'capture',object:'model',created:1,owned_by:'fixture'}]}));return;}
  // Gemini 原生走 /v1beta/models/<model>:streamGenerateContent?alt=sse
  if(req.method!=='POST'||!/(?:\/messages|\/chat\/completions|\/responses|:streamGenerateContent|:generateContent)(?:\?|$)/.test(req.url)){res.writeHead(404);res.end('{}');return;}
  let data='';req.on('data',chunk=>{data+=chunk;if(data.length>8*1024*1024)req.destroy();});
  req.on('end',()=>{let body;try{body=JSON.parse(data);}catch{res.writeHead(400);res.end('{}');return;}
   const id=++seq,protocol=req.url.includes('/messages')?'anthropic':req.url.includes('/responses')?'responses':/:streamGenerateContent|:generateContent/.test(req.url)?'gemini':'chat';
   const record={id,at:new Date().toISOString(),url:req.url,protocol,body};captures.push(record);
   if(outDir)writeFileSync(join(outDir,`request-${id}.json`),JSON.stringify(record,null,2));response(res,body,protocol,id);
  });
 });
 server.on('connection',socket=>socket.on('error',()=>{}));
 server.on('connect',(_req,socket)=>{socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {url:`http://127.0.0.1:${server.address().port}`,captures,close:()=>new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();})};
}
