import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadJob, loadModelConfig, publicModelConfig, save, hash, checks, grade, eligible, validateSkill, compareResults } from './core.mjs';
import { callRole, modelCall, objectSchema } from './adapter.mjs';

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

async function evaluate(cases, skill, dir, config, modelConfig, onProgress=async()=>{}) {
  const results = [];
  for (const c of cases) {
    await onProgress(path.basename(dir),c.id);
    console.log(`  ${path.basename(dir)} / ${c.id}`);
    const common = { adapter, config, root, model:options.model, modelConfig };
    const output = await callRole({ ...common, role:'runner', payload:{skill,input:c.input}, dir:path.join(dir,c.id,'runner') });
    const taskHard = checks(output, c.checks);
    const skillHard = skill !== null && c.skillChecks ? checks(output,c.skillChecks) : null;
    const hard={passed:taskHard.passed && (!skillHard || skillHard.passed),failures:[...taskHard.failures,...(skillHard?.failures || []).map(f=>`Skill 合规：${f}`)]};
    const skillRubric=skill !== null ? config.skillRubric || [] : [];
    const evaluationRubric=[...config.rubric,...skillRubric];
    const evaluationRequirements=skill !== null && config.skillRequirements ? `${config.requirements}\n\nSkill 合规要求：${config.skillRequirements}` : config.requirements;
    const judgment = await callRole({ ...common, role:'evaluator', payload:{input:c.input,output,requirements:evaluationRequirements,rubric:evaluationRubric}, dir:path.join(dir,c.id,'evaluator') });
    grade(judgment,evaluationRubric);
    const scoresFor=rubric=>({scores:judgment.scores.filter(score=>rubric.some(item=>item.id===score.id))});
    const result = { id:c.id, output, hard, taskHard, skillHard, score:grade(scoresFor(config.rubric),config.rubric), skillScore:skillRubric.length ? grade(scoresFor(skillRubric),skillRubric) : null, judgment };
    results.push(result);
    await save(path.join(dir,c.id,'result.json'), result);
  }
  return results;
}

async function run() {
  if (adapter !== 'mock' && !options.job) {
    throw Error(`真实优化必须指定任务目录，例如：node scripts/cli.mjs run --job inputs/my-skill --adapter ${adapter} --iterations 1`);
  }
  const job = await loadJob(jobDir);
  const modelConfig=adapter === 'configured' && modelsFile ? await loadModelConfig(modelsFile) : null;
  if(adapter === 'configured' && !modelConfig) throw Error('configured adapter 缺少 models.local.json');
  const config = {...job.config};
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
  await save(path.join(runDir,'manifest.json'), { id, adapter, models:visibleModels, config, skillHash:hash(job.skill), datasetHashes:Object.fromEntries(Object.entries(job.sets).map(([k,v])=>[k,hash(JSON.stringify(v))])), startedAt:new Date().toISOString() });
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
    const candidate = await callRole({role:'optimizer',payload:{skill,requirements:optimizationRequirements,rubric:[...config.rubric,...(config.skillRubric || [])],development:job.sets.development,feedback},adapter,dir:path.join(dir,'optimizer'),config,root,model:options.model,modelConfig});
    if (typeof candidate.skill !== 'string' || typeof candidate.rationale !== 'string') throw Error('优化器输出无效');
    validateSkill(candidate.skill);
    await save(path.join(dir,'candidate-skill','SKILL.md'),candidate.skill);
    const dev = await evaluate(job.sets.development,candidate.skill,path.join(dir,'development'),config,modelConfig,updateStatus);
    const reg = await evaluate(job.sets.regression,candidate.skill,path.join(dir,'regression'),config,modelConfig,updateStatus);
    const tolerance=config.scoreTolerance ?? 0.05;
    const accepted = eligible(dev,baselineDev,config.threshold,tolerance) && eligible(reg,baselineReg,config.threshold,tolerance);
    iterations.push({iteration:n,rationale:candidate.rationale,dev,reg,accepted,skillHash:hash(candidate.skill)});
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
  const report={id,adapter,status,comparisonMode,threshold:config.threshold,noSkillDev,noSkillReg,baselineDev,baselineReg,iterations,noSkillHoldout,baselineHoldout,holdout,effectiveness,finishedAt:new Date().toISOString()};
  await save(path.join(runDir,'report.json'),report);
  const rows=[];
  for (const [label,results] of [['无 Skill 开发集',noSkillDev],['原版开发集',baselineDev],['无 Skill 回归集',noSkillReg],['原版回归集',baselineReg],...iterations.flatMap(i=>[[`第 ${i.iteration} 轮开发集`,i.dev],[`第 ${i.iteration} 轮回归集`,i.reg]]),['无 Skill 保留集',noSkillHoldout],['原版保留集',baselineHoldout],['候选保留集',holdout]]) {
    for (const r of results || []) rows.push(`| ${label} | ${r.id} | ${(r.score*100).toFixed(1)}% | ${Number.isFinite(r.skillScore) ? `${(r.skillScore*100).toFixed(1)}%` : '—'} | ${r.hard.passed ? '通过' : r.hard.failures.join('；')} |`);
  }
  const conclusionLabel={improved:'提升',regressed:'退步',inconclusive:'差异不明确','insufficient-sample':'样本不足'};
  const effectivenessMarkdown = effectiveness ? `\n## 原版 Skill 相对无 Skill 的观测结果\n\n| 数据集 | 案例数 | 无 Skill 平均分 | 原版平均分 | 分数变化 | 公共硬检查变化 | 结论 |\n|---|---:|---:|---:|---:|---:|---|\n${Object.entries(effectiveness).filter(([,value])=>value).map(([split,value])=>`| ${{overall:'总体',development:'开发集',regression:'回归集',holdout:'保留集'}[split]} | ${value.sampleSize} | ${(value.baselineAverage*100).toFixed(1)}% | ${(value.subjectAverage*100).toFixed(1)}% | ${(value.scoreDelta*100).toFixed(1)} 个百分点 | ${value.hardPassDelta >= 0 ? '+' : ''}${value.hardPassDelta} | ${conclusionLabel[value.conclusion]} |`).join('\n')}\n` : '';
  const markdown=`# Skill 评估报告\n\n运行：${id}\n\n模型模式：${adapter === 'mock' ? '模拟演示，分数不可用于判断实际能力' : `真实模型执行与模型评审（${adapter}）`}\n\n对比线路：${comparisonMode}\n\n结果：${status}\n${effectivenessMarkdown}\n| 阶段 | 案例 | 公共任务评分 | Skill 合规评分 | 确定性检查 |\n|---|---|---:|---:|---|\n${rows.join('\n')}\n\n无 Skill 对比只使用公共任务评分和公共硬检查，Skill 特有约定单独报告。候选软分按数据集聚合后使用 ${(config.scoreTolerance ?? 0.05)*100} 个百分点容忍带，硬检查仍是一票否决。“样本不足”表示当前案例数不足以支持方向性结论。候选交付仍要求整体不低于原版。本文本任务小样本验证不代表技能自动触发、脚本执行或文件产物质量。保留集结果不用于本轮优化；若根据该结果改进，需要更换新的保留集。\n`;
  await save(path.join(runDir,'report.md'),markdown);
  await save(path.join(runDir,'status.md'),`# 运行状态\n\n- 状态：已结束\n- 结果：${status}\n- 更新时间：${new Date().toISOString()}\n\n查看同目录的 report.md。\n`);
  if (passed) {
    const finalDir=path.join(root,'final',id);
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
