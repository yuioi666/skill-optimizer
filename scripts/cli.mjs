import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, cp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { loadJob, loadModelConfig, publicModelConfig, save, hash, checks, workspaceChecks, grade, eligible, validateSkill, compareResults, median, read } from './core.mjs';
import { callRole, callWorkspaceRunner, modelCall, objectSchema } from './adapter.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command = 'validate', ...args] = process.argv.slice(2);
const options = {};
for (let i=0; i<args.length; i+=2) {
  if (!['--job','--adapter','--model','--models','--iterations'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw Error('参数格式错误');
  options[args[i].slice(2)] = args[i+1];
}
const jobDir = path.resolve(options.job || path.join(root, 'examples/meeting-summary'));
const defaultModelsFile=path.join(root,'config','models.local.json');
const modelsFile=options.models ? path.resolve(options.models) : existsSync(defaultModelsFile) ? defaultModelsFile : null;
const adapter = options.adapter || (modelsFile ? 'configured' : 'mock');
if (!['mock','configured','codex','openai-compatible','anthropic','command'].includes(adapter)) throw Error('adapter 只能为 mock、configured、codex、openai-compatible、anthropic 或 command');
let runDir;
let sourceSkillDir;

async function callRoleWithRetries(args,validate=()=>{},maxAttempts=1) {
  let lastError;
  const startedAt=Date.now();
  for(let attempt=1;attempt<=maxAttempts;attempt++) {
    const attemptDir=attempt === 1 ? args.dir : path.join(args.dir,`retry-${attempt}`);
    try {
      const value=args.invoke ? await args.invoke({...args,dir:attemptDir,invoke:undefined}) : await callRole({...args,dir:attemptDir});
      validate(value);
      return {value,attempts:attempt,elapsedMs:Date.now()-startedAt};
    } catch(error) {
      lastError=error;
      await save(path.join(attemptDir,'error.json'),{message:error.message,attempt,at:new Date().toISOString()});
    }
  }
  lastError.attempts=maxAttempts;
  lastError.elapsedMs=Date.now()-startedAt;
  throw lastError;
}

function skillName(skill) {
  return skill?.match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1] || 'target-skill';
}

async function copyWorkspaceEvidence(source,destination) {
  await mkdir(destination,{recursive:true});
  for(const entry of await readdir(source,{withFileTypes:true})) {
    if(['.git','.codex','node_modules'].includes(entry.name)) continue;
    await cp(path.join(source,entry.name),path.join(destination,entry.name),{recursive:true});
  }
}

async function runWorkspaceCase({c,skill,sampleDir,config,modelConfig,callDir}) {
  const workspace=await mkdtemp(path.join(os.tmpdir(),'skill-eval-'));
  try {
    if(c.fixture) {
      const source=path.resolve(jobDir,c.fixture);
      if(source !== jobDir && !source.startsWith(jobDir+path.sep)) throw Error('fixture 越出任务目录');
      for(const entry of await readdir(source,{withFileTypes:true})) await cp(path.join(source,entry.name),path.join(workspace,entry.name),{recursive:true});
    }
    if(skill !== null) {
      const installedSkill=path.join(workspace,'.codex','skills',skillName(skill));
      await cp(sourceSkillDir,installedSkill,{recursive:true});
      await save(path.join(installedSkill,'SKILL.md'),skill);
    }
    const output=await callWorkspaceRunner({prompt:c.input,dir:callDir,workspace,config,model:options.model,modelConfig});
    const traceText=await read(path.join(callDir,'trace.jsonl'));
    const evidence=await workspaceChecks(workspace,traceText,c.workspaceChecks || {});
    await save(path.join(callDir,'workspace-checks.json'),evidence);
    await copyWorkspaceEvidence(workspace,path.join(sampleDir,'workspace'));
    return {output,evidence};
  } finally {
    await rm(workspace,{recursive:true,force:true});
  }
}

async function evaluate(cases, skill, dir, config, modelConfig, onProgress=async()=>{}) {
  const results = [];
  for (const c of cases) {
    await onProgress(path.basename(dir),c.id);
    console.log(`  ${path.basename(dir)} / ${c.id}`);
    const common = { adapter, config, root, model:options.model, modelConfig };
    const skillRubric=skill !== null ? config.skillRubric || [] : [];
    const evaluationRubric=[...config.rubric,...skillRubric];
    const evaluationRequirements=skill !== null && config.skillRequirements ? `${config.requirements}\n\nSkill 合规要求：${config.skillRequirements}` : config.requirements;
    const samples=config.samplesPerCase ?? 1;
    const maxAttempts=config.maxAttemptsPerCall ?? 1;
    const trials=[];
    for(let sample=1;sample<=samples;sample++) {
      const sampleDir=samples === 1 ? path.join(dir,c.id) : path.join(dir,c.id,`sample-${sample}`);
      let runner;
      try {
        if(config.executionMode === 'workspace') {
          runner=await callRoleWithRetries({ ...common, role:'runner', payload:{skill,input:c.input}, dir:path.join(sampleDir,'runner'), invoke:callArgs=>runWorkspaceCase({c,skill,sampleDir,config,modelConfig,callDir:callArgs.dir}) },value=>{if(typeof value?.output !== 'string' || !value.output.trim()) throw Error('workspace runner 输出为空');},maxAttempts);
        } else {
          runner=await callRoleWithRetries({ ...common, role:'runner', payload:{skill,input:c.input}, dir:path.join(sampleDir,'runner') },value=>{if(typeof value !== 'string' || !value.trim()) throw Error('runner 输出为空');},maxAttempts);
        }
      } catch(error) {
        trials.push({sample,status:'missing',missingStage:'runner',error:error.message,runnerAttempts:error.attempts || maxAttempts,runnerElapsedMs:error.elapsedMs || null});
        continue;
      }
      const output=config.executionMode === 'workspace' ? runner.value.output : runner.value;
      const workspaceHard=config.executionMode === 'workspace' ? runner.value.evidence : null;
      const outputHard=checks(output,c.checks);
      const taskHard={passed:outputHard.passed && (!workspaceHard || workspaceHard.passed),failures:[...outputHard.failures,...(workspaceHard?.failures || []).map(f=>`工作区：${f}`)]};
      const skillHard=skill !== null && c.skillChecks ? checks(output,c.skillChecks) : null;
      const hard={passed:taskHard.passed && (!skillHard || skillHard.passed),failures:[...taskHard.failures,...(skillHard?.failures || []).map(f=>`Skill 合规：${f}`)]};
      let evaluator;
      try {
        evaluator=await callRoleWithRetries({ ...common, role:'evaluator', payload:{input:c.input,output,requirements:evaluationRequirements,rubric:evaluationRubric}, dir:path.join(sampleDir,'evaluator') },value=>grade(value,evaluationRubric),maxAttempts);
      } catch(error) {
        trials.push({sample,status:'missing',missingStage:'evaluator',error:error.message,output,runnerAttempts:runner.attempts,evaluatorAttempts:error.attempts || maxAttempts,runnerElapsedMs:runner.elapsedMs,evaluatorElapsedMs:error.elapsedMs || null,hard,taskHard,skillHard});
        continue;
      }
      const judgment=evaluator.value;
      const scoresFor=rubric=>({scores:judgment.scores.filter(score=>rubric.some(item=>item.id===score.id))});
      trials.push({sample,status:'complete',output,runnerAttempts:runner.attempts,evaluatorAttempts:evaluator.attempts,runnerElapsedMs:runner.elapsedMs,evaluatorElapsedMs:evaluator.elapsedMs,hard,taskHard,skillHard,workspaceEvidence:workspaceHard,score:grade(scoresFor(config.rubric),config.rubric),skillScore:skillRubric.length ? grade(scoresFor(skillRubric),skillRubric) : null,judgment});
    }
    const valid=trials.filter(trial=>trial.status === 'complete');
    const failures=[...new Set([...valid.flatMap(trial=>trial.hard.failures),...(valid.length === samples ? [] : ['评测证据缺失'])])];
    const taskFailures=[...new Set([...valid.flatMap(trial=>trial.taskHard.failures),...(valid.length === samples ? [] : ['评测证据缺失'])])];
    const skillFailures=skill !== null && c.skillChecks ? [...new Set([...valid.flatMap(trial=>trial.skillHard.failures),...(valid.length === samples ? [] : ['评测证据缺失'])])] : null;
    const score=valid.length ? median(valid.map(trial=>trial.score)) : null;
    const skillScore=skillRubric.length && valid.length ? median(valid.map(trial=>trial.skillScore)) : null;
    const selected=valid.length ? valid.reduce((best,trial)=>Math.abs(trial.score-score)<Math.abs(best.score-score)?trial:best) : null;
    const scoreRange=valid.length ? {min:Math.min(...valid.map(trial=>trial.score)),max:Math.max(...valid.map(trial=>trial.score))} : null;
    const result={id:c.id,activationExpectation:c.activationExpectation || null,status:valid.length === samples ? 'complete' : valid.length ? 'partial' : 'missing',output:selected?.output || null,hard:{passed:valid.length === samples && valid.every(trial=>trial.hard.passed),failures},taskHard:{passed:valid.length === samples && valid.every(trial=>trial.taskHard.passed),failures:taskFailures},skillHard:skillFailures ? {passed:valid.length === samples && valid.every(trial=>trial.skillHard.passed),failures:skillFailures} : null,workspaceEvidence:selected?.workspaceEvidence || null,score,skillScore,scoreRange,retried:valid.some(trial=>(trial.runnerAttempts || 1)>1 || (trial.evaluatorAttempts || 1)>1),flaky:valid.length !== samples || (scoreRange && scoreRange.max-scoreRange.min > (config.scoreTolerance ?? 0.05)) || (valid.some(trial=>trial.hard.passed) && valid.some(trial=>!trial.hard.passed)),judgment:selected?.judgment || null,trials};
    results.push(result);
    await save(path.join(dir,c.id,'result.json'), result);
  }
  return results;
}

async function run() {
  const runStartedAt=Date.now();
  if (adapter !== 'mock' && !options.job) {
    throw Error(`真实优化必须指定任务目录，例如：node scripts/cli.mjs run --job inputs/my-skill --adapter ${adapter} --iterations 1`);
  }
  const job = await loadJob(jobDir);
  sourceSkillDir=path.dirname(path.resolve(jobDir,job.config.skill));
  const modelConfig=adapter === 'configured' && modelsFile ? await loadModelConfig(modelsFile) : null;
  if(adapter === 'configured' && !modelConfig) throw Error('configured adapter 缺少 models.local.json');
  const config = {...job.config};
  config.executionMode=config.executionMode || 'text';
  if(config.executionMode === 'workspace' && adapter === 'mock') throw Error('workspace 模式需要真实 Codex runner，不能使用 mock');
  const runnerType=modelConfig ? modelConfig.providers[modelConfig.roles.runner.provider].type : adapter;
  if(config.executionMode === 'workspace' && runnerType !== 'codex') throw Error('workspace 模式的 runner 必须配置为 codex provider');
  const comparisonMode = config.comparisonMode || (config.compareWithoutSkill === true ? 'all' : 'original-vs-candidate');
  config.comparisonMode = comparisonMode;
  if (options.iterations) {
    const n = Number(options.iterations);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw Error('iterations 必须为 1–10');
    config.maxIterations = n;
  }
  const id = new Date().toISOString().replace(/[:.]/g,'-') + '-' + adapter + '-' + process.pid;
  runDir = path.join(root,'runs',id);
  await mkdir(runDir,{recursive:true});
  const visibleModels=modelConfig ? publicModelConfig(modelConfig) : {all:{type:adapter,model:options.model || process.env.MODEL_NAME || null}};
  const promptHashes=Object.fromEntries(await Promise.all(['runner','optimizer','evaluator'].map(async role=>[role,hash(await read(path.join(root,'agents',`${role}.md`)))])));
  await save(path.join(runDir,'manifest.json'), { id, adapter, models:visibleModels, config, skillHash:hash(job.skill), promptHashes, datasetHashes:Object.fromEntries(Object.entries(job.sets).map(([k,v])=>[k,hash(JSON.stringify(v))])), startedAt:new Date().toISOString() });
  await save(path.join(runDir,'original','SKILL.md'), job.skill);
  // Before candidate freeze, persist development data only. Hidden sets are represented by hashes.
  await save(path.join(runDir,'dataset-snapshot.json'),{development:job.sets.development,regressionHash:hash(JSON.stringify(job.sets.regression)),holdoutHash:hash(JSON.stringify(job.sets.holdout))});
  const updateStatus=async(phase,detail='')=>save(path.join(runDir,'status.md'),`# 运行状态\n\n- 状态：运行中\n- 当前阶段：${phase}\n- 当前任务：${detail || '准备中'}\n- 更新时间：${new Date().toISOString()}\n\n## 模型角色\n\n${Object.entries(visibleModels).map(([role,value])=>`- ${role}：${value.type}${value.model ? ` / ${value.model}` : ''}`).join('\n')}\n`);
  await updateStatus('准备','配置和数据快照已保存');
  console.log(`运行目录：${runDir}\n模式：${adapter === 'mock' ? '模拟演示（不代表真实质量）' : `真实模型（${adapter}）`}`);
  const compareWithoutSkill = comparisonMode === 'skill-vs-none' || comparisonMode === 'all';
  const optimizeCandidate = comparisonMode === 'original-vs-candidate' || comparisonMode === 'all';
  const noSkillDev = compareWithoutSkill ? await evaluate(job.sets.development,null,path.join(runDir,'no-skill-development'),config,modelConfig,updateStatus) : null;
  const noSkillReg = compareWithoutSkill ? await evaluate(job.sets.regression,null,path.join(runDir,'no-skill-regression'),config,modelConfig,updateStatus) : null;
  const baselineDev = await evaluate(job.sets.development,job.skill,path.join(runDir,'baseline-development'),config,modelConfig,updateStatus);
  const baselineReg = await evaluate(job.sets.regression,job.skill,path.join(runDir,'baseline-regression'),config,modelConfig,updateStatus);
  const skill = job.skill;
  let feedback = baselineDev, selected = null;
  const iterations = [];
  for (let n=1;optimizeCandidate && n<=config.maxIterations;n++) {
    console.log(`优化第 ${n} 轮`);
    const dir = path.join(runDir,`iteration-${n}`);
    await updateStatus(`第 ${n} 轮优化`,'optimizer');
    const optimizationRequirements=config.skillRequirements ? `${config.requirements}\n\nSkill 合规要求：${config.skillRequirements}` : config.requirements;
    let optimized;
    try {
      optimized=await callRoleWithRetries({role:'optimizer',payload:{skill,requirements:optimizationRequirements,rubric:[...config.rubric,...(config.skillRubric || [])],development:job.sets.development,feedback},adapter,dir:path.join(dir,'optimizer'),config,root,model:options.model,modelConfig},candidate=>{
        if (typeof candidate.skill !== 'string' || typeof candidate.rationale !== 'string') throw Error('优化器输出无效');
        validateSkill(candidate.skill);
      },config.maxAttemptsPerCall ?? 1);
    } catch(error) {
      iterations.push({iteration:n,accepted:false,status:'missing',error:error.message,optimizerAttempts:error.attempts || (config.maxAttemptsPerCall ?? 1),optimizerElapsedMs:error.elapsedMs || null});
      break;
    }
    const candidate=optimized.value;
    await save(path.join(dir,'candidate-skill','SKILL.md'),candidate.skill);
    const dev = await evaluate(job.sets.development,candidate.skill,path.join(dir,'development'),config,modelConfig,updateStatus);
    const reg = await evaluate(job.sets.regression,candidate.skill,path.join(dir,'regression'),config,modelConfig,updateStatus);
    const tolerance=config.scoreTolerance ?? 0.05;
    const accepted = eligible(dev,baselineDev,config.threshold,tolerance) && eligible(reg,baselineReg,config.threshold,tolerance);
    iterations.push({iteration:n,rationale:candidate.rationale,dev,reg,accepted,status:'complete',optimizerAttempts:optimized.attempts,optimizerElapsedMs:optimized.elapsedMs,skillHash:hash(candidate.skill)});
    if (accepted) { selected=candidate.skill; break; }
    feedback=dev; // Regression contents and scores never enter the optimizer payload.
  }
  let holdout = null, baselineHoldout = null, noSkillHoldout = null, passed=false;
  if (comparisonMode === 'skill-vs-none') {
    await save(path.join(runDir,'post-freeze-dataset-snapshot.json'),job.sets);
    noSkillHoldout = await evaluate(job.sets.holdout,null,path.join(runDir,'no-skill-holdout'),config,modelConfig,updateStatus);
    baselineHoldout = await evaluate(job.sets.holdout,job.skill,path.join(runDir,'baseline-holdout'),config,modelConfig,updateStatus);
  } else if (selected) {
    // Candidate is frozen before either holdout execution. No retry on holdout failure.
    await save(path.join(runDir,'post-freeze-dataset-snapshot.json'),job.sets);
    noSkillHoldout = compareWithoutSkill ? await evaluate(job.sets.holdout,null,path.join(runDir,'no-skill-holdout'),config,modelConfig,updateStatus) : null;
    baselineHoldout = await evaluate(job.sets.holdout,job.skill,path.join(runDir,'baseline-holdout'),config,modelConfig,updateStatus);
    holdout = await evaluate(job.sets.holdout,selected,path.join(runDir,'selected-holdout'),config,modelConfig,updateStatus);
    passed=eligible(holdout,baselineHoldout,config.threshold,config.scoreTolerance ?? 0.05);
  }
  const status = comparisonMode === 'skill-vs-none' ? 'effectiveness-measured' : passed ? 'passed' : selected ? 'holdout-failed' : 'no-qualified-candidate';
  const comparisonOptions={tolerance:config.scoreTolerance ?? 0.05,minCases:config.minComparisonCases ?? 6};
  const effectiveness = compareWithoutSkill ? {
    overall:compareResults([...baselineDev,...baselineReg,...(baselineHoldout || [])],[...noSkillDev,...noSkillReg,...(noSkillHoldout || [])],comparisonOptions),
    development:compareResults(baselineDev,noSkillDev,comparisonOptions),
    regression:compareResults(baselineReg,noSkillReg,comparisonOptions),
    holdout:noSkillHoldout && baselineHoldout ? compareResults(baselineHoldout,noSkillHoldout,comparisonOptions) : null
  } : null;
  const resultGroups=[noSkillDev,noSkillReg,baselineDev,baselineReg,...iterations.flatMap(iteration=>[iteration.dev,iteration.reg]),noSkillHoldout,baselineHoldout,holdout].filter(Array.isArray);
  const allTrials=resultGroups.flatMap(results=>results.flatMap(result=>result.trials || []));
  const usage={runnerCalls:allTrials.reduce((sum,trial)=>sum+(trial.runnerAttempts || 0),0),evaluatorCalls:allTrials.reduce((sum,trial)=>sum+(trial.evaluatorAttempts || 0),0),optimizerCalls:iterations.reduce((sum,iteration)=>sum+(iteration.optimizerAttempts || 0),0)};
  usage.totalModelCalls=usage.runnerCalls+usage.evaluatorCalls+usage.optimizerCalls;
  usage.roleElapsedMs={runner:allTrials.reduce((sum,trial)=>sum+(trial.runnerElapsedMs || 0),0),evaluator:allTrials.reduce((sum,trial)=>sum+(trial.evaluatorElapsedMs || 0),0),optimizer:iterations.reduce((sum,iteration)=>sum+(iteration.optimizerElapsedMs || 0),0)};
  usage.codexRunnerTokens=allTrials.reduce((sum,trial)=>({inputTokens:sum.inputTokens+(trial.workspaceEvidence?.tokenUsage?.inputTokens || 0),outputTokens:sum.outputTokens+(trial.workspaceEvidence?.tokenUsage?.outputTokens || 0),cachedInputTokens:sum.cachedInputTokens+(trial.workspaceEvidence?.tokenUsage?.cachedInputTokens || 0)}),{inputTokens:0,outputTokens:0,cachedInputTokens:0});
  usage.wallTimeMs=Date.now()-runStartedAt;
  usage.skillChars={original:[...job.skill].length,candidate:selected ? [...selected].length : null};
  const report={id,adapter,status,comparisonMode,executionMode:config.executionMode,threshold:config.threshold,noSkillDev,noSkillReg,baselineDev,baselineReg,iterations,noSkillHoldout,baselineHoldout,holdout,effectiveness,usage,finishedAt:new Date().toISOString()};
  await save(path.join(runDir,'report.json'),report);
  const rows=[];
  for (const [label,results] of [['无 Skill 开发集',noSkillDev],['原版开发集',baselineDev],['无 Skill 回归集',noSkillReg],['原版回归集',baselineReg],...iterations.flatMap(i=>[[`第 ${i.iteration} 轮开发集`,i.dev],[`第 ${i.iteration} 轮回归集`,i.reg]]),['无 Skill 保留集',noSkillHoldout],['原版保留集',baselineHoldout],['候选保留集',holdout]]) {
    for (const r of results || []) rows.push(`| ${label} | ${r.id} | ${r.activationExpectation || '—'} | ${Number.isFinite(r.score) ? `${(r.score*100).toFixed(1)}%` : '—'} | ${Number.isFinite(r.skillScore) ? `${(r.skillScore*100).toFixed(1)}%` : '—'} | ${r.status !== 'complete' ? '证据不完整' : r.flaky ? '波动' : r.retried ? '重试后完成' : '稳定'} | ${r.hard.passed ? '通过' : r.hard.failures.join('；')} |`);
  }
  const conclusionLabel={improved:'提升',regressed:'退步',inconclusive:'差异不明确','insufficient-sample':'样本不足','missing-evidence':'证据缺失'};
  const percent=value=>Number.isFinite(value)?`${(value*100).toFixed(1)}%`:'—';
  const effectivenessMarkdown = effectiveness ? `\n## 原版 Skill 相对无 Skill 的观测结果\n\n| 数据集 | 有效配对/总数 | 无 Skill 平均分 | 原版平均分 | 分数变化 | 公共硬检查变化 | 结论 |\n|---|---:|---:|---:|---:|---:|---|\n${Object.entries(effectiveness).filter(([,value])=>value).map(([split,value])=>`| ${{overall:'总体',development:'开发集',regression:'回归集',holdout:'保留集'}[split]} | ${value.sampleSize}/${value.totalPairs} | ${percent(value.baselineAverage)} | ${percent(value.subjectAverage)} | ${Number.isFinite(value.scoreDelta) ? `${(value.scoreDelta*100).toFixed(1)} 个百分点` : '—'} | ${value.hardPassDelta >= 0 ? '+' : ''}${value.hardPassDelta} | ${conclusionLabel[value.conclusion]} |`).join('\n')}\n` : '';
  const usageMarkdown=`\n## 调用与体积\n\n- runner 调用：${usage.runnerCalls}\n- evaluator 调用：${usage.evaluatorCalls}\n- optimizer 调用：${usage.optimizerCalls}\n- 模型调用合计：${usage.totalModelCalls}\n- Codex workspace runner tokens：输入 ${usage.codexRunnerTokens.inputTokens}，缓存输入 ${usage.codexRunnerTokens.cachedInputTokens}，输出 ${usage.codexRunnerTokens.outputTokens}\n- 运行墙钟时间：${(usage.wallTimeMs/1000).toFixed(1)} 秒\n- 原版 Skill：${usage.skillChars.original} 字符\n- 候选 Skill：${usage.skillChars.candidate ?? '未生成'}${usage.skillChars.candidate ? ` 字符（相对原版 ${usage.skillChars.candidate-usage.skillChars.original >= 0 ? '+' : ''}${usage.skillChars.candidate-usage.skillChars.original}）` : ''}\n`;
  const evidenceNote=config.executionMode === 'workspace' ? '本次在临时隔离副本中执行任务，并保存 JSONL 命令 trace、工作区检查和去除 .git/.codex/node_modules 后的产物副本。activationExpectation 表示路由案例类型；结论依据可观察行为，不声称读取到 Codex 内部 Skill 加载事件。' : '本次为文本输出评测，不覆盖工具调用、脚本和文件产物。';
  const markdown=`# Skill 评估报告\n\n运行：${id}\n\n模型模式：${adapter === 'mock' ? '模拟演示，分数不可用于判断实际能力' : `真实模型执行与模型评审（${adapter}）`}\n\n执行模式：${config.executionMode}\n\n对比线路：${comparisonMode}\n\n结果：${status}\n${usageMarkdown}${effectivenessMarkdown}\n| 阶段 | 案例 | 路由类型 | 公共任务评分 | Skill 合规评分 | 稳定性 | 确定性检查 |\n|---|---|---|---:|---:|---|---|\n${rows.join('\n')}\n\n${evidenceNote}\n\n每案例采样 ${config.samplesPerCase ?? 1} 次并使用中位数聚合；模型调用失败最多尝试 ${config.maxAttemptsPerCall ?? 1} 次。调用次数不等同于 token 或费用；不同 provider 的计费方式可能不同。证据缺失不会被记作 0 分，但会阻止候选通过。无 Skill 对比只使用公共任务评分和公共硬检查，Skill 特有约定单独报告。候选软分按数据集聚合后使用 ${(config.scoreTolerance ?? 0.05)*100} 个百分点容忍带，硬检查仍是一票否决。“样本不足”表示当前案例数不足以支持方向性结论。候选交付仍要求整体不低于原版。保留集结果不用于本轮优化；若根据该结果改进，需要更换新的保留集。\n`;
  await save(path.join(runDir,'report.md'),markdown);
  await save(path.join(runDir,'status.md'),`# 运行状态\n\n- 状态：已结束\n- 结果：${status}\n- 更新时间：${new Date().toISOString()}\n\n查看同目录的 report.md。\n`);
  if (passed) {
    const finalDir=path.join(root,'final',id);
    await cp(sourceSkillDir,path.join(finalDir,'candidate-skill'),{recursive:true});
    await save(path.join(finalDir,'candidate-skill','SKILL.md'),selected);
    await save(path.join(finalDir,'report.md'),markdown);
    await save(path.join(finalDir,'report.json'),report);
    console.log(`通过；候选版本：${finalDir}`);
  } else if (comparisonMode === 'skill-vs-none') {
    console.log('Skill 有效性对比完成；此线路不生成或发布候选版本。');
  } else { process.exitCode=2; console.log(`未达到门槛：${status}，未发布候选版本。`); }
  console.log(`报告：${path.join(runDir,'report.md')}`);
}

try {
  if (command === 'validate') {
    const job=await loadJob(jobDir);
    console.log(`配置有效：${job.config.name}；案例数：${Object.values(job.sets).flat().length}`);
  } else if (command === 'doctor') {
    console.log(`Node ${process.version}`);
    let failed=false;
    const doctorAdapter=options.adapter || (modelsFile ? 'configured' : 'codex');
    const commands=[['git',['--version']]];
    if(doctorAdapter === 'codex') commands.push([process.env.CODEX_BIN || 'codex',['--version']],[process.env.CODEX_BIN || 'codex',['login','status']]);
    for (const [exe,params] of commands) {
      const r=spawnSync(exe,params,{encoding:'utf8',shell:false,windowsHide:true,timeout:15000});
      console.log(`${exe} ${params.join(' ')}\n${r.stdout || ''}${r.stderr || ''}${r.error?.message || ''}`);
      if(r.status !== 0) failed=true;
    }
    if(doctorAdapter === 'openai-compatible') {
      console.log(`MODEL_BASE_URL: ${process.env.MODEL_BASE_URL || '未设置'}\nMODEL_NAME/--model: ${options.model || process.env.MODEL_NAME || '未设置'}`);
      if(!process.env.MODEL_BASE_URL || !(options.model || process.env.MODEL_NAME)) failed=true;
    }
    if(doctorAdapter === 'command') {
      console.log(`MODEL_COMMAND: ${process.env.MODEL_COMMAND || '未设置'}\nMODEL_NAME/--model: ${options.model || process.env.MODEL_NAME || '可选'}`);
      if(!process.env.MODEL_COMMAND) failed=true;
      try { const a=JSON.parse(process.env.MODEL_ARGS_JSON || '[]'); if(!Array.isArray(a) || a.some(x=>typeof x !== 'string')) failed=true; }
      catch { console.log('MODEL_ARGS_JSON 不是有效的 JSON 字符串数组'); failed=true; }
    }
    if(doctorAdapter === 'configured') {
      try {
        const configured=await loadModelConfig(modelsFile);
        console.log(`模型配置：${modelsFile}\n${JSON.stringify(publicModelConfig(configured),null,2)}`);
      } catch(e) { console.log(e.message); failed=true; }
    }
    if(failed) process.exitCode=1;
  } else if (command === 'smoke') {
    runDir=path.join(root,'runs','smoke-'+Date.now());
    let smokeAdapter=options.adapter || (modelsFile ? 'configured' : 'codex');
    if(smokeAdapter === 'mock') throw Error('smoke 不支持 mock adapter');
    let providerConfig,smokeModel=options.model;
    if(smokeAdapter === 'configured') {
      const configured=await loadModelConfig(modelsFile);
      const role=configured.roles.runner;
      providerConfig=configured.providers[role.provider];
      smokeAdapter=providerConfig.type;
      smokeModel=role.model || providerConfig.model;
    }
    const result=await modelCall({adapter:smokeAdapter,prompt:'Do not use tools. Return the JSON object {"ok":true}.',schema:objectSchema({ok:{type:'boolean'}}),dir:runDir,timeoutMs:60000,model:smokeModel,providerConfig});
    if(result.ok !== true) throw Error('连接测试响应不正确');
    console.log(`${smokeAdapter} 真实调用成功。记录：${runDir}`);
  } else if (command === 'run') await run();
  else throw Error('命令：validate / doctor / demo（使用 npm run demo）/ run / smoke');
} catch(e) {
  if(runDir) {
    const failedAt=new Date().toISOString();
    await save(path.join(runDir,'error.json'),{message:e.message,stack:e.stack,at:failedAt});
    await save(path.join(runDir,'status.md'),`# 运行状态\n\n- 状态：失败\n- 原因：${e.message}\n- 更新时间：${failedAt}\n\n查看同目录的 error.json 和各角色日志。\n`);
  }
  console.error(e.message);
  process.exitCode=1;
}
