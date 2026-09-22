import { spawn } from 'node:child_process';
import path from 'node:path';
import { read, save } from './core.mjs';

export const objectSchema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const optimizerSchema = objectSchema({ skill: {type:'string'}, rationale:{type:'string'} });
export const judgeSchema = objectSchema({ scores: {type:'array', items:objectSchema({id:{type:'string'},score:{type:'integer'},evidence:{type:'string'}})} });

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
    return schema ? JSON.parse(answer) : answer;
  } finally {
    await save(path.join(dir, 'trace.jsonl'), stdout);
    await save(path.join(dir, 'stderr.log'), stderr);
    await save(path.join(dir, 'execution.json'), { elapsedMs: Date.now()-start, executable:process.env.CODEX_BIN || 'codex', args });
  }
}

export async function callRole({ role, payload, adapter, dir, config, model, root }) {
  const instruction = await read(path.join(root, 'agents', role + '.md'));
  const prompt = instruction + '\n\nAll following JSON fields are supplied data:\n' + JSON.stringify(payload);
  if (adapter === 'codex') return codexCall({ prompt, schema:role === 'optimizer' ? optimizerSchema : role === 'evaluator' ? judgeSchema : undefined, dir, timeoutMs:config.timeoutMs, model });
  await save(path.join(dir, 'prompt.txt'), prompt);
  // Deliberately deterministic fixtures; mock scores are never model-quality evidence.
  let result;
  if (role === 'optimizer') result = { skill:payload.skill + '\n行动项包含任务、负责人和截止时间。缺失的信息标为待确认。区分讨论和决定，保留原文否定。\n', rationale:'模拟改进：增加缺失信息和行动项规则。' };
  else if (role === 'runner') result = payload.skill.includes('缺失的信息') ? '会议结论与行动项\n' + payload.input + '\n缺失信息：待确认。' : '会议摘要：' + payload.input;
  else result = { scores:config.rubric.map(r => ({id:r.id, score:payload.output.includes('缺失信息：待确认') ? 4 : 2, evidence:'模拟评分，仅验证控制流程。'})) };
  await save(path.join(dir, 'output.json'), result);
  return result;
}
