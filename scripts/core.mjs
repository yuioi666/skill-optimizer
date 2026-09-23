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
  if(config.skillRequirements !== undefined && (typeof config.skillRequirements !== 'string' || !config.skillRequirements.trim())) throw Error('Skill 合规需求必须为非空字符串');
  if (!Array.isArray(config.rubric) || !config.rubric.length || config.rubric.some(c => !/^[a-z][a-z0-9_-]*$/.test(c.id) || !c.description) || new Set(config.rubric.map(c=>c.id)).size !== config.rubric.length) throw Error('评分标准无效');
  if (config.skillRubric !== undefined && (!Array.isArray(config.skillRubric) || config.skillRubric.some(c => !/^[a-z][a-z0-9_-]*$/.test(c.id) || !c.description))) throw Error('Skill 合规评分标准无效');
  const allRubricIds=[...config.rubric,...(config.skillRubric || [])].map(c=>c.id);
  if(new Set(allRubricIds).size !== allRubricIds.length) throw Error('任务评分与 Skill 合规评分的 ID 不得重复');
  if (!(config.threshold > 0 && config.threshold <= 1) || !Number.isInteger(config.maxIterations) || config.maxIterations < 1 || config.maxIterations > 10 || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000) throw Error('阈值、迭代次数或超时无效');
  if (config.scoreTolerance !== undefined && (typeof config.scoreTolerance !== 'number' || !Number.isFinite(config.scoreTolerance) || config.scoreTolerance < 0 || config.scoreTolerance > 0.25)) throw Error('scoreTolerance 必须为 0–0.25');
  if (config.minComparisonCases !== undefined && (!Number.isInteger(config.minComparisonCases) || config.minComparisonCases < 2)) throw Error('minComparisonCases 必须为不小于 2 的整数');
  if (config.samplesPerCase !== undefined && (!Number.isInteger(config.samplesPerCase) || config.samplesPerCase < 1 || config.samplesPerCase > 5)) throw Error('samplesPerCase 必须为 1–5 的整数');
  if (config.maxAttemptsPerCall !== undefined && (!Number.isInteger(config.maxAttemptsPerCall) || config.maxAttemptsPerCall < 1 || config.maxAttemptsPerCall > 3)) throw Error('maxAttemptsPerCall 必须为 1–3 的整数');
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
      for(const rules of [c.checks,c.skillChecks].filter(Boolean)) {
        if (Object.keys(rules).some(k => !['includes','containsAny','excludes','matches','notMatches','jsonEquals','minChars','maxChars'].includes(k))) throw Error('未知确定性检查');
        for (const k of ['includes','containsAny','excludes','matches','notMatches']) if (rules[k] !== undefined && (!Array.isArray(rules[k]) || !rules[k].length || rules[k].some(v => typeof v !== 'string' || !v))) throw Error('检查词或正则必须为非空字符串数组');
        for(const k of ['matches','notMatches']) for(const pattern of rules[k] || []) { try { new RegExp(pattern,'u'); } catch { throw Error(`无效正则：${pattern}`); } }
        if(rules.jsonEquals !== undefined && (!Array.isArray(rules.jsonEquals) || !rules.jsonEquals.length || rules.jsonEquals.some(item=>!item || typeof item.path !== 'string' || !item.path.startsWith('/') || !Object.hasOwn(item,'value')))) throw Error('jsonEquals 必须包含 JSON Pointer 路径和值');
        if (rules.minChars !== undefined && (!Number.isInteger(rules.minChars) || rules.minChars < 0)) throw Error('minChars 无效');
        if (rules.maxChars !== undefined && (!Number.isInteger(rules.maxChars) || rules.maxChars < 1)) throw Error('maxChars 无效');
        if(rules.minChars !== undefined && rules.maxChars !== undefined && rules.minChars > rules.maxChars) throw Error('minChars 不得大于 maxChars');
      }
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
  if (rules.containsAny?.length && !rules.containsAny.some(s=>output.includes(s))) failures.push(`至少包含一个：${rules.containsAny.join(' / ')}`);
  for (const s of rules.excludes ?? []) if (output.includes(s)) failures.push(`包含禁用内容：${s}`);
  for (const pattern of rules.matches ?? []) if (!new RegExp(pattern,'u').test(output)) failures.push(`未匹配正则：${pattern}`);
  for (const pattern of rules.notMatches ?? []) if (new RegExp(pattern,'u').test(output)) failures.push(`匹配禁用正则：${pattern}`);
  if (rules.minChars !== undefined && [...output].length < rules.minChars) failures.push('低于长度下限');
  if (rules.maxChars && [...output].length > rules.maxChars) failures.push('超出长度限制');
  if(rules.jsonEquals?.length) {
    let value;
    try { value=JSON.parse(output); }
    catch { failures.push('输出不是有效 JSON'); }
    if(value !== undefined) for(const expected of rules.jsonEquals) {
      const actual=expected.path.split('/').slice(1).map(part=>part.replaceAll('~1','/').replaceAll('~0','~')).reduce((current,key)=>current?.[key],value);
      if(JSON.stringify(actual) !== JSON.stringify(expected.value)) failures.push(`JSON 字段不匹配：${expected.path}`);
    }
  }
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
export function median(values) {
  if(!Array.isArray(values) || !values.length || values.some(value=>!Number.isFinite(value))) throw Error('中位数输入无效');
  const sorted=[...values].sort((a,b)=>a-b);
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
}
const averageScore = (results,key='score') => results.reduce((sum,result)=>sum+result[key],0)/results.length;

export function eligible(candidate, baseline, threshold, tolerance=0) {
  if (!candidate.length || candidate.length !== baseline.length || new Set(candidate.map(c=>c.id)).size !== candidate.length) return false;
  const baselineIds=new Set(baseline.map(result=>result.id));
  if(baselineIds.size !== baseline.length || candidate.some(result=>!baselineIds.has(result.id))) return false;
  if(candidate.some(c=>!c.hard?.passed || !Number.isFinite(c.score)) || baseline.some(c=>!Number.isFinite(c.score))) return false;
  if(averageScore(candidate) < threshold || averageScore(candidate) < averageScore(baseline)-tolerance) return false;
  const candidateCompliance=candidate.filter(c=>Number.isFinite(c.skillScore));
  const baselineCompliance=baseline.filter(c=>Number.isFinite(c.skillScore));
  if(candidateCompliance.length || baselineCompliance.length) {
    if(candidateCompliance.length !== candidate.length || baselineCompliance.length !== baseline.length) return false;
    if(averageScore(candidateCompliance,'skillScore') < threshold || averageScore(candidateCompliance,'skillScore') < averageScore(baselineCompliance,'skillScore')-tolerance) return false;
  }
  return true;
}

export function compareResults(subject, baseline, {tolerance=0.05,minCases=6}={}) {
  if (!Array.isArray(subject) || !Array.isArray(baseline) || subject.length !== baseline.length || !subject.length) throw Error('对比结果不完整');
  const baselineById = new Map(baseline.map(result => [result.id, result]));
  if (baselineById.size !== baseline.length || subject.some(result => !baselineById.has(result.id))) throw Error('对比结果案例不匹配');
  const validPairs=subject.map(result=>[result,baselineById.get(result.id)]).filter(pair=>pair.every(result=>Number.isFinite(result.score)));
  const average = results => results.length ? results.reduce((sum, result) => sum + result.score, 0) / results.length : null;
  const hardPasses = results => results.filter(result => (result.taskHard || result.hard).passed).length;
  const validSubject=validPairs.map(pair=>pair[0]);
  const validBaseline=validPairs.map(pair=>pair[1]);
  const subjectAverage = average(validSubject);
  const baselineAverage = average(validBaseline);
  const subjectHardPasses = hardPasses(subject);
  const baselineHardPasses = hardPasses(baseline);
  let conclusion='inconclusive';
  if(validPairs.length !== subject.length) conclusion='missing-evidence';
  else if(subject.length < minCases) conclusion='insufficient-sample';
  else if(subjectHardPasses < baselineHardPasses || subjectAverage < baselineAverage-tolerance) conclusion='regressed';
  else if(subjectHardPasses >= baselineHardPasses && subjectAverage > baselineAverage+tolerance) conclusion='improved';
  return {
    subjectAverage,
    baselineAverage,
    scoreDelta: subjectAverage === null || baselineAverage === null ? null : subjectAverage - baselineAverage,
    subjectHardPasses,
    baselineHardPasses,
    hardPassDelta: subjectHardPasses - baselineHardPasses,
    tolerance,
    sampleSize:validPairs.length,
    totalPairs:subject.length,
    missingPairs:subject.length-validPairs.length,
    conclusion,
    observedUplift: conclusion === 'improved'
  };
}
