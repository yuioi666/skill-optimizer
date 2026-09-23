import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checks, grade, eligible, loadJob, loadModelConfig, publicModelConfig, compareResults, median } from '../scripts/core.mjs';

test('确定性失败不得被高分掩盖',()=>{
  const hard=checks('已启动广告投放',{includes:['待确认'],excludes:['已启动广告投放']});
  assert.equal(hard.failures.length,2);
  assert.equal(eligible([{id:'x',hard,score:1}],[{id:'x',score:0.5}],0.8),false);
});
test('确定性检查支持任选文本、正则、长度和 JSON Pointer',()=>{
  assert.equal(checks('负责人：小林',{containsAny:['小吴','小林'],matches:['负责人[：:]'],notMatches:['已取消'],minChars:4}).passed,true);
  const jsonResult=checks('{"status":"ok","owner":{"name":"小林"}}',{jsonEquals:[{path:'/status',value:'ok'},{path:'/owner/name',value:'小林'}]});
  assert.equal(jsonResult.passed,true);
  assert.match(checks('{"status":"bad"}',{jsonEquals:[{path:'/status',value:'ok'}]}).failures[0],/JSON 字段/);
  assert.match(checks('not json',{jsonEquals:[{path:'/status',value:'ok'}]}).failures[0],/有效 JSON/);
});
test('软分按整体聚合并允许容忍带，硬检查仍否决',()=>{
  assert.equal(eligible([],[],0.8),false);
  assert.equal(eligible([{id:'x',hard:{passed:true},score:0.85}],[{id:'x',score:0.9}],0.8),false);
  assert.equal(eligible([{id:'a',hard:{passed:true},score:0.8},{id:'b',hard:{passed:true},score:1}],[{id:'a',score:0.9},{id:'b',score:0.85}],0.8,0.05),true);
  assert.equal(eligible([{id:'a',hard:{passed:false},score:1},{id:'b',hard:{passed:true},score:1}],[{id:'a',score:0.9},{id:'b',score:0.9}],0.8,0.05),false);
  assert.equal(eligible([{id:'a',hard:{passed:true},score:1,skillScore:0.7}],[{id:'a',score:0.9,skillScore:0.9}],0.8,0.05),false);
  assert.equal(eligible([{id:'x',hard:{passed:true},score:1}],[],0.8),false);
  assert.equal(eligible([{id:'x',hard:{passed:true},score:1}],[{id:'y',score:0.9}],0.8,0.05),false);
});
test('无 Skill 对比报告分数和硬性检查变化',()=>{
  const noSkill=[{id:'a',score:0.5,hard:{passed:true}},{id:'b',score:0.5,hard:{passed:false}}];
  const original=[{id:'a',score:0.75,hard:{passed:true}},{id:'b',score:0.75,hard:{passed:true}}];
  assert.deepEqual(compareResults(original,noSkill),{
    subjectAverage:0.75,baselineAverage:0.5,scoreDelta:0.25,
    subjectHardPasses:2,baselineHardPasses:1,hardPassDelta:1,tolerance:0.05,
    sampleSize:2,totalPairs:2,missingPairs:0,conclusion:'insufficient-sample',observedUplift:false
  });
  assert.equal(compareResults(original,noSkill,{minCases:2}).conclusion,'improved');
  const missing=compareResults([{...original[0],score:null},original[1]],noSkill,{minCases:2});
  assert.equal(missing.conclusion,'missing-evidence');
  assert.equal(missing.sampleSize,1);
  assert.throws(()=>compareResults(original,[noSkill[0]]),/不完整/);
});
test('重复采样使用中位数聚合',()=>{
  assert.equal(median([0.9,0.1,0.8]),0.8);
  assert.ok(Math.abs(median([0.4,0.8])-0.6)<Number.EPSILON);
  assert.throws(()=>median([]),/无效/);
});
test('评审必须覆盖全部维度且给出有效评分证据',()=>{
  const rubric=[{id:'a'},{id:'b'}];
  assert.throws(()=>grade({scores:[{id:'a',score:4,evidence:'ok'},{id:'a',score:4,evidence:'ok'}]},rubric));
  assert.throws(()=>grade({scores:[{id:'a',score:5,evidence:'ok'},{id:'b',score:4,evidence:'ok'}]},rubric));
  assert.equal(grade({scores:[{id:'a',score:3,evidence:'ok'},{id:'b',score:4,evidence:'ok'}]},rubric),0.875);
});
test('跨数据集重复输入被拒绝',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-eval-'));
  await cp('examples/meeting-summary',dir,{recursive:true});
  const first=(await readFile(path.join(dir,'development.jsonl'),'utf8')).split('\n')[0];
  await writeFile(path.join(dir,'holdout.jsonl'),first);
  await assert.rejects(loadJob(dir),/重复/);
});
test('未知检查项被拒绝，避免拼写错误静默失效',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-eval-'));
  await cp('examples/meeting-summary',dir,{recursive:true});
  await writeFile(path.join(dir,'holdout.jsonl'),JSON.stringify({id:'new',input:'独立输入',checks:{include:['x']}}));
  await assert.rejects(loadJob(dir),/未知/);
});
test('无 Skill 对比开关只接受布尔值',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-eval-'));
  await cp('examples/meeting-summary',dir,{recursive:true});
  const config=JSON.parse(await readFile(path.join(dir,'job.json'),'utf8'));
  config.compareWithoutSkill='true';
  await writeFile(path.join(dir,'job.json'),JSON.stringify(config));
  await assert.rejects(loadJob(dir),/布尔值/);
});
test('对比线路只接受三个已定义值',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-eval-'));
  await cp('examples/meeting-summary',dir,{recursive:true});
  const config=JSON.parse(await readFile(path.join(dir,'job.json'),'utf8'));
  config.comparisonMode='unknown';
  await writeFile(path.join(dir,'job.json'),JSON.stringify(config));
  await assert.rejects(loadJob(dir),/comparisonMode/);
});
test('采样次数和重试次数有安全上限',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-eval-'));
  await cp('examples/meeting-summary',dir,{recursive:true});
  const config=JSON.parse(await readFile(path.join(dir,'job.json'),'utf8'));
  config.samplesPerCase=6;
  await writeFile(path.join(dir,'job.json'),JSON.stringify(config));
  await assert.rejects(loadJob(dir),/samplesPerCase/);
  config.samplesPerCase=1;
  config.maxAttemptsPerCall=4;
  await writeFile(path.join(dir,'job.json'),JSON.stringify(config));
  await assert.rejects(loadJob(dir),/maxAttemptsPerCall/);
});
test('仅测 Skill 有效性时不调用优化器或生成候选',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-effectiveness-'));
  await cp('examples/meeting-summary',dir,{recursive:true});
  const config=JSON.parse(await readFile(path.join(dir,'job.json'),'utf8'));
  config.comparisonMode='skill-vs-none';
  await writeFile(path.join(dir,'job.json'),JSON.stringify(config));
  const result=spawnSync(process.execPath,['scripts/cli.mjs','run','--adapter','mock','--job',dir],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
  const runDir=result.stdout.match(/运行目录：([^\r\n]+)/)[1];
  const report=JSON.parse(await readFile(path.join(runDir,'report.json'),'utf8'));
  assert.equal(report.status,'effectiveness-measured');
  assert.equal(report.comparisonMode,'skill-vs-none');
  assert.equal(report.iterations.length,0);
  assert.equal(report.noSkillHoldout.length,1);
  assert.equal(report.baselineHoldout.length,1);
  assert.equal(report.holdout,null);
});
test('重复采样保留每次证据并聚合结果',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-samples-'));
  await cp('examples/meeting-summary',dir,{recursive:true});
  const config=JSON.parse(await readFile(path.join(dir,'job.json'),'utf8'));
  config.comparisonMode='skill-vs-none';
  config.samplesPerCase=3;
  config.maxAttemptsPerCall=1;
  await writeFile(path.join(dir,'job.json'),JSON.stringify(config));
  const result=spawnSync(process.execPath,['scripts/cli.mjs','run','--adapter','mock','--job',dir],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
  const runDir=result.stdout.match(/运行目录：([^\r\n]+)/)[1];
  const report=JSON.parse(await readFile(path.join(runDir,'report.json'),'utf8'));
  assert.equal(report.noSkillDev[0].trials.length,3);
  assert.equal(report.noSkillDev[0].status,'complete');
  assert.equal(report.noSkillDev[0].flaky,false);
  assert.equal(typeof await readFile(path.join(runDir,'no-skill-development','dev-owner','sample-3','runner','prompt.txt'),'utf8'),'string');
});
test('评审格式异常会有限重试并保留失败记录',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-retry-'));
  const jobDir=path.join(dir,'job');
  await cp('examples/meeting-summary',jobDir,{recursive:true});
  const config=JSON.parse(await readFile(path.join(jobDir,'job.json'),'utf8'));
  config.comparisonMode='skill-vs-none';
  config.samplesPerCase=1;
  config.maxAttemptsPerCall=2;
  await writeFile(path.join(jobDir,'job.json'),JSON.stringify(config));
  const counter=path.join(dir,'evaluator-count.txt');
  const program=`const fs=require('fs');let d='';process.stdin.on('data',x=>d+=x);process.stdin.on('end',()=>{const marker='All following JSON fields are supplied data:\\n';const raw=d.slice(d.indexOf(marker)+marker.length).split('\\n\\nReturn only JSON matching this schema.')[0];const p=JSON.parse(raw);if(d.startsWith('Evaluate')){const f=${JSON.stringify(counter)};const n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0;fs.writeFileSync(f,String(n+1));if(n===0)process.stdout.write('{\"bad\":true}');else process.stdout.write(JSON.stringify({scores:p.rubric.map(r=>({id:r.id,score:4,evidence:'retry evidence'}))}));}else process.stdout.write(p.input+'\\n待确认');});`;
  const models=path.join(dir,'models.json');
  await writeFile(models,JSON.stringify({providers:{local:{type:'command',command:process.execPath,args:['-e',program]}},roles:{runner:{provider:'local'},optimizer:{provider:'local'},evaluator:{provider:'local'}}}));
  const result=spawnSync(process.execPath,['scripts/cli.mjs','run','--job',jobDir,'--models',models],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
  const runDir=result.stdout.match(/运行目录：([^\r\n]+)/)[1];
  const report=JSON.parse(await readFile(path.join(runDir,'report.json'),'utf8'));
  assert.equal(report.noSkillDev[0].trials[0].evaluatorAttempts,2);
  assert.equal(report.noSkillDev[0].retried,true);
  assert.equal(JSON.parse(await readFile(path.join(runDir,'no-skill-development','dev-owner','evaluator','error.json'),'utf8')).attempt,1);
  assert.equal(typeof await readFile(path.join(runDir,'no-skill-development','dev-owner','evaluator','retry-2','output.txt'),'utf8'),'string');
});
test('评审重试耗尽后记录证据缺失而不中断整轮',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-missing-'));
  const jobDir=path.join(dir,'job');
  await cp('examples/meeting-summary',jobDir,{recursive:true});
  const config=JSON.parse(await readFile(path.join(jobDir,'job.json'),'utf8'));
  config.comparisonMode='skill-vs-none';
  config.samplesPerCase=1;
  config.maxAttemptsPerCall=2;
  await writeFile(path.join(jobDir,'job.json'),JSON.stringify(config));
  const program=`let d='';process.stdin.on('data',x=>d+=x);process.stdin.on('end',()=>{const marker='All following JSON fields are supplied data:\\n';const raw=d.slice(d.indexOf(marker)+marker.length).split('\\n\\nReturn only JSON matching this schema.')[0];const p=JSON.parse(raw);if(d.startsWith('Evaluate'))process.stdout.write('{\"bad\":true}');else process.stdout.write(p.input+'\\n待确认');});`;
  const models=path.join(dir,'models.json');
  await writeFile(models,JSON.stringify({providers:{local:{type:'command',command:process.execPath,args:['-e',program]}},roles:{runner:{provider:'local'},optimizer:{provider:'local'},evaluator:{provider:'local'}}}));
  const result=spawnSync(process.execPath,['scripts/cli.mjs','run','--job',jobDir,'--models',models],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
  const runDir=result.stdout.match(/运行目录：([^\r\n]+)/)[1];
  const report=JSON.parse(await readFile(path.join(runDir,'report.json'),'utf8'));
  assert.equal(report.noSkillDev[0].status,'missing');
  assert.equal(report.noSkillDev[0].score,null);
  assert.equal(report.effectiveness.overall.conclusion,'missing-evidence');
  assert.match(await readFile(path.join(runDir,'report.md'),'utf8'),/证据缺失/);
});
test('模拟流程端到端运行，保留集不进入优化器提示',async()=>{
  const result=spawnSync(process.execPath,['scripts/cli.mjs','run','--adapter','mock'],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/候选版本/);
  const runDir=result.stdout.match(/运行目录：([^\r\n]+)/)[1];
  const report=JSON.parse(await readFile(path.join(runDir,'report.json'),'utf8'));
  assert.equal(report.status,'passed');
  assert.equal(report.adapter,'mock');
  assert.equal(report.noSkillDev.length,2);
  assert.equal(report.effectiveness.development.conclusion,'insufficient-sample');
  assert.equal(report.noSkillDev.every(result=>result.skillHard === null),true);
  assert.equal(report.baselineDev.some(result=>result.skillHard !== null),true);
  assert.equal(report.holdout.length,1);
  assert.deepEqual({runner:report.usage.runnerCalls,evaluator:report.usage.evaluatorCalls,optimizer:report.usage.optimizerCalls,total:report.usage.totalModelCalls},{runner:12,evaluator:12,optimizer:1,total:25});
  assert.equal(report.usage.skillChars.original>0,true);
  const noSkillJudgePrompt=await readFile(path.join(runDir,'no-skill-development','dev-owner','evaluator','prompt.txt'),'utf8');
  const originalJudgePrompt=await readFile(path.join(runDir,'baseline-development','dev-owner','evaluator','prompt.txt'),'utf8');
  assert.equal(noSkillJudgePrompt.includes('统一填写“待确认”'),false);
  assert.equal(noSkillJudgePrompt.includes('skill_conventions'),false);
  assert.equal(originalJudgePrompt.includes('统一填写“待确认”'),true);
  assert.equal(originalJudgePrompt.includes('skill_conventions'),true);
  const snapshot=JSON.parse(await readFile(path.join(runDir,'dataset-snapshot.json'),'utf8'));
  assert.equal(Array.isArray(snapshot.development),true);
  assert.equal(snapshot.regression,undefined);
  assert.equal(snapshot.holdout,undefined);
  const frozen=JSON.parse(await readFile(path.join(runDir,'post-freeze-dataset-snapshot.json'),'utf8'));
  assert.equal(Array.isArray(frozen.holdout),true);
  const prompt=await readFile(path.join(runDir,'iteration-1','optimizer','prompt.txt'),'utf8');
  const job=await loadJob('examples/meeting-summary');
  for(const c of [...job.sets.regression,...job.sets.holdout]) assert.equal(prompt.includes(c.input),false);
});
test('被拒候选不会成为下一轮优化基底',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-rejected-base-'));
  await cp('examples/meeting-summary',dir,{recursive:true});
  const developmentPath=path.join(dir,'development.jsonl');
  const cases=(await readFile(developmentPath,'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  for(const item of cases) item.skillChecks={includes:['永远不会出现']};
  await writeFile(developmentPath,cases.map(item=>JSON.stringify(item)).join('\n')+'\n');
  const result=spawnSync(process.execPath,['scripts/cli.mjs','run','--adapter','mock','--job',dir,'--iterations','2'],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,2,result.stderr);
  const runDir=result.stdout.match(/运行目录：([^\r\n]+)/)[1];
  const secondPrompt=await readFile(path.join(runDir,'iteration-2','optimizer','prompt.txt'),'utf8');
  assert.equal(secondPrompt.includes('行动项包含任务、负责人和截止时间。'),false);
});
test('真实优化必须明确指定 inputs 任务目录',()=>{
  const result=spawnSync(process.execPath,['scripts/cli.mjs','run','--adapter','codex'],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,1);
  assert.match(result.stderr,/必须指定任务目录/);
});
test('模型配置允许未使用的 provider 模板且公开视图不含密钥',async()=>{
  const config=await loadModelConfig('config/models.example.json');
  const visible=JSON.stringify(publicModelConfig(config));
  assert.equal(visible.includes('在本地配置中填写'),false);
  assert.equal(visible.includes('apiKey'),false);
});
test('按角色模型配置可以完成端到端评估',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-configured-'));
  const jobDir=path.join(dir,'job');
  await cp('examples/meeting-summary',jobDir,{recursive:true});
  const program=`let d='';process.stdin.on('data',x=>d+=x);process.stdin.on('end',()=>{const marker='All following JSON fields are supplied data:\\n';const raw=d.slice(d.indexOf(marker)+marker.length).split('\\n\\nReturn only JSON matching this schema.')[0];const p=JSON.parse(raw);if(d.startsWith('Improve'))process.stdout.write(JSON.stringify({skill:'---\\nname: meeting-summary\\ndescription: 测试会议摘要。\\n---\\n\\n行动项缺失信息标为待确认。',rationale:'test'}));else if(d.startsWith('Evaluate'))process.stdout.write(JSON.stringify({scores:p.rubric.map(r=>({id:r.id,score:4,evidence:'test evidence'}))}));else process.stdout.write(p.input+'\\n待确认');});`;
  const models=path.join(dir,'models.json');
  await writeFile(models,JSON.stringify({providers:{local:{type:'command',command:process.execPath,args:['-e',program]}},roles:{runner:{provider:'local'},optimizer:{provider:'local'},evaluator:{provider:'local'}}}));
  const result=spawnSync(process.execPath,['scripts/cli.mjs','run','--job',jobDir,'--models',models,'--iterations','1'],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
  const runDir=result.stdout.match(/运行目录：([^\r\n]+)/)[1];
  const report=JSON.parse(await readFile(path.join(runDir,'report.json'),'utf8'));
  const manifest=JSON.parse(await readFile(path.join(runDir,'manifest.json'),'utf8'));
  assert.equal(report.status,'passed');
  assert.equal(manifest.models.optimizer.type,'command');
  assert.match(manifest.promptHashes.evaluator,/^[a-f0-9]{64}$/);
  assert.equal(await readFile(path.join(runDir,'status.md'),'utf8').then(x=>x.includes('已结束')),true);
});
