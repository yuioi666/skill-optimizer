import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checks, grade, eligible, loadJob } from '../scripts/core.mjs';

test('确定性失败不得被高分掩盖',()=>{
  const hard=checks('已启动广告投放',{includes:['待确认'],excludes:['已启动广告投放']});
  assert.equal(hard.failures.length,2);
  assert.equal(eligible([{id:'x',hard,score:1}],[{id:'x',score:0.5}],0.8),false);
});
test('逐案例阻止退步，拒绝缺失基线',()=>{
  assert.equal(eligible([],[],0.8),false);
  assert.equal(eligible([{id:'x',hard:{passed:true},score:0.85}],[{id:'x',score:0.9}],0.8),false);
  assert.equal(eligible([{id:'x',hard:{passed:true},score:1}],[],0.8),false);
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
test('模拟流程端到端运行，保留集不进入优化器提示',async()=>{
  const result=spawnSync(process.execPath,['scripts/cli.mjs','run','--adapter','mock'],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/候选版本/);
  const runDir=result.stdout.match(/运行目录：([^\r\n]+)/)[1];
  const report=JSON.parse(await readFile(path.join(runDir,'report.json'),'utf8'));
  assert.equal(report.status,'passed');
  assert.equal(report.adapter,'mock');
  assert.equal(report.holdout.length,1);
  const prompt=await readFile(path.join(runDir,'iteration-1','optimizer','prompt.txt'),'utf8');
  const job=await loadJob('examples/meeting-summary');
  for(const c of [...job.sets.regression,...job.sets.holdout]) assert.equal(prompt.includes(c.input),false);
});
test('真实优化必须明确指定 inputs 任务目录',()=>{
  const result=spawnSync(process.execPath,['scripts/cli.mjs','run','--adapter','codex'],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,1);
  assert.match(result.stderr,/必须指定任务目录/);
});
