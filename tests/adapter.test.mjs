import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { anthropicCall, callWorkspaceRunner, codexCall, commandCall, objectSchema, openAICompatibleCall, parseJsonAnswer } from '../scripts/adapter.mjs';

test('解析纯 JSON 和 Markdown JSON 代码块',()=>{
  assert.deepEqual(parseJsonAnswer('{"ok":true}'),{ok:true});
  assert.deepEqual(parseJsonAnswer('```json\n{"ok":true}\n```'),{ok:true});
});

test('OpenAI 兼容接口发送 schema 且不把密钥写入执行记录',async t=>{
  let requestBody,authorization;
  const server=http.createServer((req,res)=>{
    authorization=req.headers.authorization;
    let body='';
    req.on('data',d=>{body+=d;});
    req.on('end',()=>{
      requestBody=JSON.parse(body);
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-api-'));
  const address=server.address();
  const result=await openAICompatibleCall({prompt:'test',schema:objectSchema({ok:{type:'boolean'}}),dir,model:'local-model',baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'test-secret',structured:'json_schema'});
  assert.deepEqual(result,{ok:true});
  assert.equal(authorization,'Bearer test-secret');
  assert.equal(requestBody.response_format.type,'json_schema');
  const execution=await readFile(path.join(dir,'execution.json'),'utf8');
  assert.equal(execution.includes('test-secret'),false);
});

test('通用命令行 adapter 通过 stdin 调用模型程序',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-command-'));
  const program="process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('{\\\"ok\\\":true}'))";
  const result=await commandCall({prompt:'test',schema:objectSchema({ok:{type:'boolean'}}),dir,command:process.execPath,commandArgs:['-e',program],timeoutMs:10000});
  assert.deepEqual(result,{ok:true});
  assert.match(await readFile(path.join(dir,'prompt.txt'),'utf8'),/Return only JSON/);
});

test('工作区 runner 拒绝无工具能力的第三方 provider',async()=>{
  const modelConfig={providers:{local:{type:'openai-compatible'}},roles:{runner:{provider:'local'}}};
  await assert.rejects(callWorkspaceRunner({prompt:'test',dir:'x',workspace:'x',config:{timeoutMs:1000},modelConfig}),/必须使用 codex provider/);
});

test('Codex workspace 调用使用可写沙箱、指定目录并保留 trace',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-codex-call-'));
  const workspace=await mkdtemp(path.join(os.tmpdir(),'skill-codex-workspace-'));
  const fake=path.join(dir,'fake-codex.mjs');
  await writeFile(fake,`import {writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2);\nconst output=args[args.indexOf('-o')+1];\nif(args[args.indexOf('--sandbox')+1]!=='workspace-write') process.exit(2);\nif(args[args.indexOf('-C')+1]!==${JSON.stringify(workspace)}) process.exit(3);\nwriteFileSync(output,'done');\nprocess.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:7,output_tokens:2}})+'\\n');\n`);
  const result=await codexCall({prompt:'create',dir,workspace,cwd:workspace,sandbox:'workspace-write',executable:process.execPath,executableArgs:[fake]});
  assert.equal(result,'done');
  assert.match(await readFile(path.join(dir,'trace.jsonl'),'utf8'),/turn.completed/);
  assert.match(await readFile(path.join(dir,'execution.json'),'utf8'),/workspace-write/);
});

test('Anthropic adapter 使用 Messages API 且不记录密钥',async t=>{
  let requestBody,apiKey;
  const server=http.createServer((req,res)=>{
    apiKey=req.headers['x-api-key'];
    let body='';
    req.on('data',d=>{body+=d;});
    req.on('end',()=>{
      requestBody=JSON.parse(body);
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({content:[{type:'text',text:'{"ok":true}'}]}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  const dir=await mkdtemp(path.join(os.tmpdir(),'skill-anthropic-'));
  const address=server.address();
  const result=await anthropicCall({prompt:'test',schema:objectSchema({ok:{type:'boolean'}}),dir,model:'test-model',baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'anthropic-secret'});
  assert.deepEqual(result,{ok:true});
  assert.equal(apiKey,'anthropic-secret');
  assert.equal(requestBody.messages[0].role,'user');
  assert.equal((await readFile(path.join(dir,'execution.json'),'utf8')).includes('anthropic-secret'),false);
});
