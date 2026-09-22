import { spawn } from 'node:child_process';
import path from 'node:path';
import { read, save } from './core.mjs';

export const objectSchema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const optimizerSchema = objectSchema({ skill: {type:'string'}, rationale:{type:'string'} });
export const judgeSchema = objectSchema({ scores: {type:'array', items:objectSchema({id:{type:'string'},score:{type:'integer'},evidence:{type:'string'}})} });

export function parseJsonAnswer(answer) {
  const trimmed = answer.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function promptWithSchema(prompt, schema) {
  if (!schema) return prompt;
  return `${prompt}\n\nReturn only JSON matching this schema. Do not use Markdown fences:\n${JSON.stringify(schema)}`;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('');
  return '';
}

export async function codexCall({ prompt, schema, dir, timeoutMs = 180000, model }) {
  await save(path.join(dir, 'prompt.txt'), prompt);
  if (schema) await save(path.join(dir, 'schema.json'), schema);
  const output = path.resolve(dir, 'output.txt');
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-C', path.resolve(dir), '-o', output];
  if (schema) args.push('--output-schema', path.resolve(dir, 'schema.json'));
  if (model) args.push('--model', model);
  args.push('-');
  const start = Date.now();
  let stdout = '', stderr = '';
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.env.CODEX_BIN || 'codex', args, { shell:false, windowsHide:true, stdio:['pipe','pipe','pipe'] });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.stdin.on('error', () => {});
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('close', code => { clearTimeout(timer); timedOut ? reject(Error(`Codex 超时 (${timeoutMs}ms)`)) : code === 0 ? resolve() : reject(Error(`Codex 退出码 ${code}：${stderr.slice(-1600)}`)); });
      child.stdin.end(prompt);
    });
    const answer = (await read(output)).trim();
    if (!answer) throw Error('Codex 没有生成输出');
    return schema ? parseJsonAnswer(answer) : answer;
  } finally {
    await save(path.join(dir, 'trace.jsonl'), stdout);
    await save(path.join(dir, 'stderr.log'), stderr);
    await save(path.join(dir, 'execution.json'), { elapsedMs: Date.now()-start, executable:process.env.CODEX_BIN || 'codex', args });
  }
}

export async function openAICompatibleCall({ prompt, schema, dir, timeoutMs = 180000, model, baseUrl=process.env.MODEL_BASE_URL, apiKey=process.env.MODEL_API_KEY, structured=process.env.MODEL_STRUCTURED_OUTPUT || 'prompt' }) {
  if (!baseUrl) throw Error('openai-compatible 缺少 MODEL_BASE_URL');
  if (!model) throw Error('openai-compatible 缺少模型名，请使用 --model 或 MODEL_NAME');
  if (!['prompt','json_schema'].includes(structured)) throw Error('MODEL_STRUCTURED_OUTPUT 只能为 prompt 或 json_schema');
  let endpoint;
  try { endpoint = new URL(baseUrl.replace(/\/$/,'') + '/chat/completions'); }
  catch { throw Error('MODEL_BASE_URL 不是有效 URL'); }
  const sentPrompt = schema && structured === 'prompt' ? promptWithSchema(prompt,schema) : prompt;
  await save(path.join(dir,'prompt.txt'),sentPrompt);
  if(schema) await save(path.join(dir,'schema.json'),schema);
  const body={model,messages:[{role:'user',content:sentPrompt}],temperature:0,stream:false};
  if(schema && structured === 'json_schema') body.response_format={type:'json_schema',json_schema:{name:'evaluation_result',strict:true,schema}};
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  const start=Date.now();
  let responseText='';
  try {
    const headers={'content-type':'application/json'};
    if(apiKey) headers.authorization=`Bearer ${apiKey}`;
    let response;
    try { response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal}); }
    catch(e) { throw Error(e.name === 'AbortError' ? `模型接口超时 (${timeoutMs}ms)` : `模型接口连接失败：${e.message}`); }
    responseText=await response.text();
    await save(path.join(dir,'response.json'),responseText);
    if(!response.ok) throw Error(`模型接口 HTTP ${response.status}：${responseText.slice(-1600)}`);
    let responseBody;
    try { responseBody=JSON.parse(responseText); } catch { throw Error('模型接口没有返回有效 JSON'); }
    const answer=contentText(responseBody?.choices?.[0]?.message?.content).trim();
    if(!answer) throw Error('模型接口没有返回文本内容');
    await save(path.join(dir,'output.txt'),answer);
    return schema ? parseJsonAnswer(answer) : answer;
  } finally {
    clearTimeout(timer);
    await save(path.join(dir,'execution.json'),{elapsedMs:Date.now()-start,adapter:'openai-compatible',endpoint:endpoint.toString(),model,structured});
  }
}

export async function commandCall({ prompt, schema, dir, timeoutMs = 180000, model, command=process.env.MODEL_COMMAND, commandArgs }) {
  if(!command) throw Error('command adapter 缺少 MODEL_COMMAND');
  let args=commandArgs;
  if(!args) {
    try { args=JSON.parse(process.env.MODEL_ARGS_JSON || '[]'); }
    catch { throw Error('MODEL_ARGS_JSON 必须是 JSON 字符串数组'); }
  }
  if(!Array.isArray(args) || args.some(x=>typeof x !== 'string')) throw Error('MODEL_ARGS_JSON 必须是 JSON 字符串数组');
  args=args.map(x=>x.replaceAll('{model}',model || ''));
  const sentPrompt=promptWithSchema(prompt,schema);
  await save(path.join(dir,'prompt.txt'),sentPrompt);
  if(schema) await save(path.join(dir,'schema.json'),schema);
  const start=Date.now();
  let stdout='',stderr='';
  try {
    await new Promise((resolve,reject)=>{
      const child=spawn(command,args,{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
      let timedOut=false;
      const timer=setTimeout(()=>{timedOut=true; child.kill();},timeoutMs);
      child.stdout.on('data',d=>{stdout+=d;});
      child.stderr.on('data',d=>{stderr+=d;});
      child.stdin.on('error',()=>{});
      child.once('error',e=>{clearTimeout(timer); reject(e);});
      child.once('close',code=>{clearTimeout(timer); timedOut ? reject(Error(`命令行模型超时 (${timeoutMs}ms)`)) : code === 0 ? resolve() : reject(Error(`命令行模型退出码 ${code}：${stderr.slice(-1600)}`));});
      child.stdin.end(sentPrompt);
    });
    const answer=stdout.trim();
    if(!answer) throw Error('命令行模型没有生成输出');
    await save(path.join(dir,'output.txt'),answer);
    return schema ? parseJsonAnswer(answer) : answer;
  } finally {
    await save(path.join(dir,'stderr.log'),stderr);
    await save(path.join(dir,'execution.json'),{elapsedMs:Date.now()-start,adapter:'command',executable:command,args,model:model || null});
  }
}

export function modelCall({adapter,...options}) {
  if(adapter === 'codex') return codexCall(options);
  if(adapter === 'openai-compatible') return openAICompatibleCall({...options,model:options.model || process.env.MODEL_NAME});
  if(adapter === 'command') return commandCall({...options,model:options.model || process.env.MODEL_NAME});
  throw Error(`未知模型 adapter：${adapter}`);
}

export async function callRole({ role, payload, adapter, dir, config, model, root }) {
  const instruction = await read(path.join(root, 'agents', role + '.md'));
  const prompt = instruction + '\n\nAll following JSON fields are supplied data:\n' + JSON.stringify(payload);
  if (adapter !== 'mock') return modelCall({ adapter, prompt, schema:role === 'optimizer' ? optimizerSchema : role === 'evaluator' ? judgeSchema : undefined, dir, timeoutMs:config.timeoutMs, model });
  await save(path.join(dir, 'prompt.txt'), prompt);
  // Deliberately deterministic fixtures; mock scores are never model-quality evidence.
  let result;
  if (role === 'optimizer') result = { skill:payload.skill + '\n行动项包含任务、负责人和截止时间。缺失的信息标为待确认。区分讨论和决定，保留原文否定。\n', rationale:'模拟改进：增加缺失信息和行动项规则。' };
  else if (role === 'runner') result = payload.skill.includes('缺失的信息') ? '会议结论与行动项\n' + payload.input + '\n缺失信息：待确认。' : '会议摘要：' + payload.input;
  else result = { scores:config.rubric.map(r => ({id:r.id, score:payload.output.includes('缺失信息：待确认') ? 4 : 2, evidence:'模拟评分，仅验证控制流程。'})) };
  await save(path.join(dir, 'output.json'), result);
  return result;
}
