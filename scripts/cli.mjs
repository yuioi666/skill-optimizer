import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { loadJob, save, hash, checks, grade, eligible, validateSkill } from './core.mjs';
import { callRole, codexCall, objectSchema } from './adapter.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command = 'validate', ...args] = process.argv.slice(2);
const options = {};
for (let i=0; i<args.length; i+=2) {
  if (!['--job','--adapter','--model','--iterations'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw Error('参数格式错误');
  options[args[i].slice(2)] = args[i+1];
}
const jobDir = path.resolve(options.job || path.join(root, 'examples/meeting-summary'));
const adapter = options.adapter || 'mock';
if (!['mock','codex'].includes(adapter)) throw Error('adapter 只能为 mock 或 codex');
let runDir;

async function evaluate(cases, skill, dir, config) {
  const results = [];
  for (const c of cases) {
    console.log(`  ${path.basename(dir)} / ${c.id}`);
    const common = { adapter, config, root, model:options.model };
    const output = await callRole({ ...common, role:'runner', payload:{skill,input:c.input}, dir:path.join(dir,c.id,'runner') });
    const hard = checks(output, c.checks);
    const judgment = await callRole({ ...common, role:'evaluator', payload:{input:c.input,output,requirements:config.requirements,rubric:config.rubric}, dir:path.join(dir,c.id,'evaluator') });
    const result = { id:c.id, output, hard, score:grade(judgment,config.rubric), judgment };
    results.push(result);
    await save(path.join(dir,c.id,'result.json'), result);
  }
  return results;
}

async function run() {
  const job = await loadJob(jobDir);
  const config = {...job.config};
  if (options.iterations) {
    const n = Number(options.iterations);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw Error('iterations 必须为 1–10');
    config.maxIterations = n;
  }
  const id = new Date().toISOString().replace(/[:.]/g,'-') + '-' + adapter + '-' + process.pid;
  runDir = path.join(root,'runs',id);
  await mkdir(runDir,{recursive:true});
  await save(path.join(runDir,'manifest.json'), { id, adapter, model:options.model || 'Codex 本机默认配置', config, skillHash:hash(job.skill), datasetHashes:Object.fromEntries(Object.entries(job.sets).map(([k,v])=>[k,hash(JSON.stringify(v))])), startedAt:new Date().toISOString() });
  await save(path.join(runDir,'original','SKILL.md'), job.skill);
  // Keep an exact local snapshot for reproducibility, never include hidden data in optimizer prompts.
  await save(path.join(runDir,'dataset-snapshot.json'),job.sets);
  console.log(`运行目录：${runDir}\n模式：${adapter === 'mock' ? '模拟演示（不代表真实质量）' : '真实 Codex'}`);
  const baselineDev = await evaluate(job.sets.development,job.skill,path.join(runDir,'baseline-development'),config);
  const baselineReg = await evaluate(job.sets.regression,job.skill,path.join(runDir,'baseline-regression'),config);
  let skill = job.skill, feedback = baselineDev, selected = null;
  const iterations = [];
  for (let n=1;n<=config.maxIterations;n++) {
    console.log(`优化第 ${n} 轮`);
    const dir = path.join(runDir,`iteration-${n}`);
    const candidate = await callRole({role:'optimizer',payload:{skill,requirements:config.requirements,rubric:config.rubric,development:job.sets.development,feedback},adapter,dir:path.join(dir,'optimizer'),config,root,model:options.model});
    if (typeof candidate.skill !== 'string' || typeof candidate.rationale !== 'string') throw Error('优化器输出无效');
    validateSkill(candidate.skill);
    await save(path.join(dir,'candidate-skill','SKILL.md'),candidate.skill);
    const dev = await evaluate(job.sets.development,candidate.skill,path.join(dir,'development'),config);
    const reg = await evaluate(job.sets.regression,candidate.skill,path.join(dir,'regression'),config);
    const accepted = eligible(dev,baselineDev,config.threshold) && eligible(reg,baselineReg,config.threshold);
    iterations.push({iteration:n,rationale:candidate.rationale,dev,reg,accepted,skillHash:hash(candidate.skill)});
    if (accepted) { selected=candidate.skill; break; }
    skill=candidate.skill;
    feedback=dev; // Regression contents and scores never enter the optimizer payload.
  }
  let holdout = null, baselineHoldout = null, passed=false;
  if (selected) {
    // Candidate is frozen before either holdout execution. No retry on holdout failure.
    baselineHoldout = await evaluate(job.sets.holdout,job.skill,path.join(runDir,'baseline-holdout'),config);
    holdout = await evaluate(job.sets.holdout,selected,path.join(runDir,'selected-holdout'),config);
    passed=eligible(holdout,baselineHoldout,config.threshold);
  }
  const status = passed ? 'passed' : selected ? 'holdout-failed' : 'no-qualified-candidate';
  const report={id,adapter,status,threshold:config.threshold,baselineDev,baselineReg,iterations,baselineHoldout,holdout,finishedAt:new Date().toISOString()};
  await save(path.join(runDir,'report.json'),report);
  const rows=[];
  for (const [label,results] of [['原版开发集',baselineDev],['原版回归集',baselineReg],...iterations.flatMap(i=>[[`第 ${i.iteration} 轮开发集`,i.dev],[`第 ${i.iteration} 轮回归集`,i.reg]]),['原版保留集',baselineHoldout],['候选保留集',holdout]]) {
    for (const r of results || []) rows.push(`| ${label} | ${r.id} | ${(r.score*100).toFixed(1)}% | ${r.hard.passed ? '通过' : r.hard.failures.join('；')} |`);
  }
  const markdown=`# Skill 评估报告\n\n运行：${id}\n\n模式：${adapter === 'mock' ? '模拟演示，分数不可用于判断实际能力' : '真实 Codex 执行与模型评审'}\n\n结果：${status}\n\n| 阶段 | 案例 | 评分 | 确定性检查 |\n|---|---|---:|---|\n${rows.join('\n')}\n\n本报告是文本任务小样本验证，不代表技能自动触发、脚本执行或文件产物质量。模型评分存在波动。保留集结果不用于本轮优化；若根据该结果改进，需要更换新的保留集。\n`;
  await save(path.join(runDir,'report.md'),markdown);
  if (passed) {
    const finalDir=path.join(root,'final',id);
    await save(path.join(finalDir,'candidate-skill','SKILL.md'),selected);
    await save(path.join(finalDir,'report.md'),markdown);
    await save(path.join(finalDir,'report.json'),report);
    console.log(`通过；候选版本：${finalDir}`);
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
    for (const [exe,params] of [['git',['--version']],[process.env.CODEX_BIN || 'codex',['--version']],[process.env.CODEX_BIN || 'codex',['login','status']]]) {
      const r=spawnSync(exe,params,{encoding:'utf8',shell:false,windowsHide:true,timeout:15000});
      console.log(`${exe} ${params.join(' ')}\n${r.stdout || ''}${r.stderr || ''}${r.error?.message || ''}`);
      if(r.status !== 0) failed=true;
    }
    if(failed) process.exitCode=1;
  } else if (command === 'smoke') {
    runDir=path.join(root,'runs','smoke-'+Date.now());
    const result=await codexCall({prompt:'Do not use tools. Return the JSON object {"ok":true}.',schema:objectSchema({ok:{type:'boolean'}}),dir:runDir,timeoutMs:60000,model:options.model});
    if(result.ok !== true) throw Error('连接测试响应不正确');
    console.log(`Codex 真实调用成功。记录：${runDir}`);
  } else if (command === 'run') await run();
  else throw Error('命令：validate / doctor / demo（使用 npm run demo）/ run / smoke');
} catch(e) {
  if(runDir) await save(path.join(runDir,'error.json'),{message:e.message,stack:e.stack,at:new Date().toISOString()});
  console.error(e.message);
  process.exitCode=1;
}
