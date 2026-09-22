import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const read = p => readFile(p, 'utf8');
export const json = async p => JSON.parse(await read(p));
export const hash = s => createHash('sha256').update(s).digest('hex');
export async function save(p, value) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}
export function validateSkill(text) {
  if (!/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(text)) throw Error('SKILL.md 缺少 YAML frontmatter');
  const front = text.split(/\r?\n---/)[0];
  if (!/^name: [a-z0-9-]{1,63}\s*$/m.test(front) || !/^description: \S.+$/m.test(front)) throw Error('Skill name 或 description 无效（本 MVP 要求单行字段）');
}
export async function loadJob(dir) {
  const config = await json(path.join(dir, 'job.json'));
  if (!config.name || typeof config.requirements !== 'string' || !config.requirements.trim()) throw Error('缺少名称或需求');
  if (!Array.isArray(config.rubric) || !config.rubric.length || config.rubric.some(c => !/^[a-z][a-z0-9_-]*$/.test(c.id) || !c.description) || new Set(config.rubric.map(c=>c.id)).size !== config.rubric.length) throw Error('评分标准无效');
  if (!(config.threshold > 0 && config.threshold <= 1) || !Number.isInteger(config.maxIterations) || config.maxIterations < 1 || config.maxIterations > 10 || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000) throw Error('阈值、迭代次数或超时无效');
  if (config.comparisonMode !== undefined && !['skill-vs-none','original-vs-candidate','all'].includes(config.comparisonMode)) throw Error('comparisonMode 必须为 skill-vs-none、original-vs-candidate 或 all');
  if (config.compareWithoutSkill !== undefined && typeof config.compareWithoutSkill !== 'boolean') throw Error('compareWithoutSkill 必须为布尔值');
  if (typeof config.skill !== 'string' || path.isAbsolute(config.skill) || config.skill.split(/[\\/]/).includes('..')) throw Error('Skill 路径必须位于任务目录');
  const skill = await read(path.join(dir, config.skill));
  validateSkill(skill);
  const sets = {};
  const ids = new Set(), inputs = new Set();
  for (const split of ['development', 'regression', 'holdout']) {
    sets[split] = (await read(path.join(dir, split + '.jsonl'))).split(/\r?\n/).filter(l => l.trim()).map(JSON.parse);
    if (!sets[split].length) throw Error(`${split} 不能为空`);
    for (const c of sets[split]) {
      if (!/^[a-zA-Z0-9_-]+$/.test(c.id) || typeof c.input !== 'string' || !c.input.trim() || !c.checks) throw Error('案例格式无效');
      if (ids.has(c.id) || inputs.has(c.input.trim())) throw Error('案例 ID 或输入重复，可能发生测试集泄漏');
      ids.add(c.id); inputs.add(c.input.trim());
      if (Object.keys(c.checks).some(k => !['includes','excludes','maxChars'].includes(k))) throw Error('未知确定性检查');
      for (const k of ['includes','excludes']) if (c.checks[k] !== undefined && (!Array.isArray(c.checks[k]) || c.checks[k].some(v => typeof v !== 'string' || !v))) throw Error('检查词必须为非空字符串');
      if (c.checks.maxChars !== undefined && (!Number.isInteger(c.checks.maxChars) || c.checks.maxChars < 1)) throw Error('maxChars 无效');
    }
  }
  return { config, skill, sets };
}
export async function loadModelConfig(file) {
  const config=await json(file);
  if(!config?.providers || typeof config.providers !== 'object' || Array.isArray(config.providers)) throw Error('模型配置缺少 providers');
  if(!config?.roles || typeof config.roles !== 'object' || Array.isArray(config.roles)) throw Error('模型配置缺少 roles');
  const types=new Set(['codex','openai-compatible','anthropic','command']);
  for(const [name,provider] of Object.entries(config.providers)) {
    if(!name || !provider || !types.has(provider.type)) throw Error(`模型 provider 无效：${name}`);
  }
  const used=new Set();
  for(const role of ['runner','optimizer','evaluator']) {
    const setting=config.roles[role];
    if(!setting || !config.providers[setting.provider]) throw Error(`角色 ${role} 没有引用有效 provider`);
    used.add(setting.provider);
  }
  for(const name of used) {
    const provider=config.providers[name];
    if(provider.type === 'openai-compatible' && !provider.baseUrl) throw Error(`provider ${name} 缺少 baseUrl`);
    if(provider.type === 'anthropic' && (!provider.baseUrl || !provider.apiKey || provider.apiKey === '在本地配置中填写')) throw Error(`provider ${name} 缺少可用的 baseUrl 或 apiKey`);
    if(provider.type === 'command' && !provider.command) throw Error(`provider ${name} 缺少 command`);
  }
  return config;
}

export function publicModelConfig(config) {
  return Object.fromEntries(Object.entries(config.roles).map(([role,setting])=>{
    const provider=config.providers[setting.provider];
    return [role,{provider:setting.provider,type:provider.type,model:setting.model || provider.model || null}];
  }));
}
export function checks(output, rules) {
  const failures = [];
  if (!output.trim()) failures.push('输出为空');
  for (const s of rules.includes ?? []) if (!output.includes(s)) failures.push(`缺少：${s}`);
  for (const s of rules.excludes ?? []) if (output.includes(s)) failures.push(`包含禁用内容：${s}`);
  if (rules.maxChars && [...output].length > rules.maxChars) failures.push('超出长度限制');
  return { passed: failures.length === 0, failures };
}
export function grade(value, rubric) {
  if (!value || !Array.isArray(value.scores) || value.scores.length !== rubric.length) throw Error('评审返回了无效评分');
  for (const r of rubric) {
    const found = value.scores.filter(s => s.id === r.id);
    if (found.length !== 1 || !Number.isInteger(found[0].score) || found[0].score < 0 || found[0].score > 4 || typeof found[0].evidence !== 'string' || !found[0].evidence.trim()) throw Error('评审分数或证据无效');
  }
  return value.scores.reduce((a, b) => a + b.score, 0) / (4 * rubric.length);
}
export function eligible(candidate, baseline, threshold) {
  if (!candidate.length || candidate.length !== baseline.length || new Set(candidate.map(c=>c.id)).size !== candidate.length) return false;
  return candidate.every(c => c.hard.passed && c.score >= threshold && c.score >= baseline.find(b => b.id === c.id)?.score);
}

export function compareResults(subject, baseline) {
  if (!Array.isArray(subject) || !Array.isArray(baseline) || subject.length !== baseline.length || !subject.length) throw Error('对比结果不完整');
  const baselineById = new Map(baseline.map(result => [result.id, result]));
  if (baselineById.size !== baseline.length || subject.some(result => !baselineById.has(result.id))) throw Error('对比结果案例不匹配');
  const average = results => results.reduce((sum, result) => sum + result.score, 0) / results.length;
  const hardPasses = results => results.filter(result => result.hard.passed).length;
  const subjectAverage = average(subject);
  const baselineAverage = average(baseline);
  const subjectHardPasses = hardPasses(subject);
  const baselineHardPasses = hardPasses(baseline);
  return {
    subjectAverage,
    baselineAverage,
    scoreDelta: subjectAverage - baselineAverage,
    subjectHardPasses,
    baselineHardPasses,
    hardPassDelta: subjectHardPasses - baselineHardPasses,
    observedUplift: subjectAverage > baselineAverage && subjectHardPasses >= baselineHardPasses
  };
}
