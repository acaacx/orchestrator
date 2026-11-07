import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Engine } from '../src/engine.ts';
import { parseConfig, parseResult } from '../src/contracts.ts';
import { Registry, builtins } from '../src/adapters.ts';
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'orchestrator-test-'));
  const git=(args:string[],cwd=dir)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git(['init']); git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);
  writeFileSync(join(dir,'README.md'),'base\n');git(['add','.']);git(['commit','-m','base']);
  const config={version:1,repository:dir,enabledAdapters:['grok-bot','cursor'],tasks:[
    {id:'plan',adapter:'grok-bot',capability:'plan',prompt:'Plan a change',dependsOn:[]},
    {id:'code',adapter:'cursor',capability:'implement',prompt:'Implement the accepted plan',dependsOn:['plan']}
  ]};
  const engine=new Engine(config);
  return {dir,git,config,engine,cleanup:()=>{engine.close();rmSync(dir,{recursive:true,force:true});}};
}
const result=(taskId:string)=>({version:1,taskId,outcome:'succeeded',summary:'Reviewed work',evidence:['Human verified test output']});
test('Grok to Cursor handoff, restart, acceptance and non-forced cleanup',()=>{
  const f=fixture();try {
    assert.throws(()=>f.engine.prepare('code'),/Dependency/);
    const plan=f.engine.prepare('plan'); assert.equal(plan.status,'ready');
    assert.equal(f.engine.prepare('plan').worktree,plan.worktree);
    f.engine.importResult('plan',result('plan'));
    assert.throws(()=>f.engine.approve('plan','accept','invalid'),/Approval/);
    const approval=f.engine.preview('plan','accept');f.engine.approve('plan','accept',approval.token);
    const cleanup=f.engine.preview('plan','cleanup');f.engine.approve('plan','cleanup',cleanup.token);
    assert.equal(existsSync(plan.worktree),false);
    const code=f.engine.prepare('code'); assert.notEqual(code.worktree,plan.worktree);
    assert.equal(f.git(['show','HEAD:README.md'],code.worktree).trim(),'base');
    const reopened=new Engine(f.config);assert.equal(reopened.get('code').status,'ready'); reopened.close();
    assert.ok(f.engine.audit().length>=9);
  } finally {f.cleanup();}
});
test('dirty files, ignored files, stale approval and branch changes block actions',()=>{
  const f=fixture();try {
    const r=f.engine.prepare('plan');f.engine.importResult('plan',result('plan'));
    const approval=f.engine.preview('plan','accept');
    writeFileSync(join(r.worktree,'new.txt'),'changed');
    assert.throws(()=>f.engine.preview('plan','accept'),/dirty/);
    f.git(['add','.'],r.worktree);f.git(['commit','-m','change'],r.worktree);
    assert.throws(()=>f.engine.approve('plan','accept',approval.token),/stale/);
    f.engine.approve('plan','accept',f.engine.preview('plan','accept').token);
    writeFileSync(join(r.worktree,'.gitignore'),'secret.txt\n');f.git(['add','.'],r.worktree);f.git(['commit','-m','ignore'],r.worktree);
    writeFileSync(join(r.worktree,'secret.txt'),'private');assert.throws(()=>f.engine.preview('plan','cleanup'),/dirty/);
    rmSync(join(r.worktree,'secret.txt'));f.git(['checkout','--detach'],r.worktree);
    assert.throws(()=>f.engine.preview('plan','cleanup'),/ownership/);
  }finally{f.cleanup();}
});
test('strict contracts reject cycles, traversal, unknown capabilities and mismatched results',()=>{
  const f=fixture();try{
    const c=structuredClone(f.config);c.tasks[0].dependsOn=['code'];assert.throws(()=>parseConfig(c),/cycle/);
    c.tasks[0].dependsOn=[];c.tasks[0].id='../escape';assert.throws(()=>parseConfig(c),/identifier/);
    c.tasks[0].id='plan';c.tasks[0].capability='deploy';assert.throws(()=>parseConfig(c),/capability/);
    assert.throws(()=>parseResult(result('wrong'),'plan'),/contract/);
    assert.throws(()=>new Engine({...f.config,enabledAdapters:['cursor']}),/disabled/);
    assert.throws(()=>new Engine({...f.config,tasks:[{...f.config.tasks[0],prompt:'changed'}]}),/Configuration/);
  }finally{f.cleanup();}
});
test('failed results and cancellation do not satisfy dependencies',()=>{
  const f=fixture();try{
    f.engine.prepare('plan');f.engine.importResult('plan',{...result('plan'),outcome:'failed'});
    assert.throws(()=>f.engine.preview('plan','accept'),/not permitted/);
    assert.throws(()=>f.engine.prepare('code'),/Dependency/);
    assert.equal(f.engine.cancel('code').status,'cancelled');
  }finally{f.cleanup();}
});
test('registry supports independently registered future harness',()=>{
  const registry=new Registry().register({id:'claude-code',capabilities:['review'],handoff:(task,worktree,dependencyResults)=>({task,worktree,dependencyResults,instructions:'Manual future integration'})});
  assert.equal(registry.get('claude-code','review').id,'claude-code');
  assert.throws(()=>registry.get('claude-code','implement'),/Unsupported/);
});

test('durable preparation intent resumes after simulated interruption',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const f=fixture();try {
    const db=new DatabaseSync(join(f.engine.root,'state.sqlite'));
    const record=f.engine.get('plan');record.status='preparing';
    db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(record),'plan');db.close();
    const resumed=f.engine.prepare('plan');assert.equal(resumed.status,'ready');
    // Simulate a crash after Git succeeded but before the state transaction committed.
    const db2=new DatabaseSync(join(f.engine.root,'state.sqlite'));
    resumed.status='preparing';db2.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(resumed),'plan');db2.close();
    assert.equal(f.engine.prepare('plan').worktree,resumed.worktree);
  }finally{f.cleanup();}
});
test('cleanup resumes after removal with persisted approval',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const f=fixture();try{
    const record=f.engine.prepare('plan');f.engine.cancel('plan');
    const preview=f.engine.preview('plan','cleanup');
    const db=new DatabaseSync(join(f.engine.root,'state.sqlite'));
    const pending={...f.engine.get('plan'),status:'cleaning',cleanupToken:preview.token};
    db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(pending),'plan');db.close();
    f.git(['worktree','remove',record.worktree]);
    assert.throws(()=>f.engine.approve('plan','cleanup','wrong'),/invalid/);
    assert.equal(f.engine.approve('plan','cleanup',preview.token).status,'cleaned');
  }finally{f.cleanup();}
});
test('SQLite serializes writers without a second worktree creation',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const f=fixture();try{
    const db=new DatabaseSync(join(f.engine.root,'state.sqlite'));db.exec('BEGIN IMMEDIATE');
    assert.throws(()=>f.engine.prepare('plan'),/locked/);
    db.exec('ROLLBACK');db.close();
    assert.equal(f.engine.get('plan').status,'pending');
    assert.equal(f.engine.prepare('plan').status,'ready');
  }finally{f.cleanup();}
});

test('CLI produces a handoff packet and reports errors with a failing exit code',()=>{
  const f=fixture();try{
    const configFile=join(f.dir,'config.json');writeFileSync(configFile,JSON.stringify(f.config));
    const cli=new URL('../src/cli.ts',import.meta.url);
    const output=execFileSync(process.execPath,[cli.pathname,'prepare',configFile,'plan'],{encoding:'utf8'});
    const packet=JSON.parse(output);assert.equal(packet.task.status,'ready');assert.ok(existsSync(packet.handoff));
    assert.throws(()=>execFileSync(process.execPath,[cli.pathname,'prepare',configFile,'code'],{stdio:'pipe'}));
  }finally{f.cleanup();}
});
test('optional Codex adapter stays disabled until explicitly enabled',()=>{
  assert.throws(()=>builtins(['grok-bot','cursor']).get('codex','implement'),/Unsupported/);
  assert.equal(builtins(['codex']).get('codex','implement').id,'codex');
});
test('cancelling an unprepared task supports approved cleanup without Git removal',()=>{
  const f=fixture();try{
    f.engine.cancel('plan');
    const preview=f.engine.preview('plan','cleanup');
    assert.throws(()=>f.engine.approve('plan','cleanup','wrong'),/invalid/);
    assert.equal(f.engine.approve('plan','cleanup',preview.token).status,'cleaned');
  }finally{f.cleanup();}
});

test('Cursor execution is approved, bounded, and never automatically accepted',async()=>{
  const f=fixture(); try {
    f.engine.prepare('plan'); f.engine.importResult('plan',result('plan')); f.engine.approve('plan','accept',f.engine.preview('plan','accept').token); f.engine.prepare('code');
    const script=join(f.dir,'agent'); const capture=join(f.dir,'capture.json');
    writeFileSync(script,`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),secret:process.env.AWS_SECRET_ACCESS_KEY})); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Proposed change',session_id:'s'}));\n`,{mode:0o755});
    const e=new Engine(f.config,undefined,{executable:script}); try {
      assert.throws(()=>e.previewRun('plan'),/ready/);
      const preview=e.previewRun('code'); await assert.rejects(e.run('code','bad'),/stale/);
      const finished=await e.run('code',preview.token); assert.equal(finished.status,'result-ready'); assert.equal(finished.result?.summary,'Proposed change');
      const captured=JSON.parse((await import('node:fs')).readFileSync(capture,'utf8'));
      assert.equal(captured.cwd,finished.worktree); assert.deepEqual(captured.args.slice(0,5),['--print','--output-format','json','--sandbox','enabled']); assert.equal(captured.secret,undefined);
      assert.equal(e.get('code').acceptedHead,undefined);
    } finally {e.close();}
  } finally { f.cleanup(); }
});

test('Cursor errors, limits, cancellation and concurrent claims are safe',async()=>{
  for(const mode of ['malformed','nonzero','timeout','output','abort','duplicate','missing']) {
    const f=fixture(); try {
      f.engine.prepare('plan');f.engine.importResult('plan',result('plan'));f.engine.approve('plan','accept',f.engine.preview('plan','accept').token);f.engine.prepare('code');
      const script=join(f.dir,'agent');
      const body=mode === 'malformed' ? "console.log('bad')" : mode === 'nonzero' ? 'process.exit(2)' : mode === 'output' ? "console.log('x'.repeat(5000))" : 'setTimeout(()=>{},5000)';
      writeFileSync(script,`#!${process.execPath}\n${body}\n`,{mode:0o755});
      const e=new Engine(f.config,undefined,{executable:mode === 'missing' ? join(f.dir,'missing') : script,timeoutMs:mode === 'timeout' ? 50 : 5000,maxOutput:1024}); try {
        if(mode === 'missing') { assert.throws(()=>e.previewRun('code'),/not found/); continue; }
        const preview=e.previewRun('code'); const controller=new AbortController(); const running=e.run('code',preview.token,controller.signal);
        if(mode === 'abort') controller.abort();
        if(mode === 'duplicate') { await assert.rejects(e.run('code',preview.token),/ready/); assert.throws(()=>e.cancel('code'),/state/); assert.throws(()=>e.importResult('code',result('code')),/ready/); assert.throws(()=>e.preview('code','cleanup'),/permitted/); controller.abort(); }
        await assert.rejects(running); assert.equal(e.get('code').status,'failed'); assert.ok(!JSON.stringify(e.audit()).includes('x'.repeat(20)));
      } finally {e.close();}
    } finally {f.cleanup();}
  }
});

test('run approval detects changes and recovery requires explicit confirmation',async()=>{
  const {DatabaseSync}=await import('node:sqlite'); const f=fixture(); try {
    const plan=f.engine.prepare('plan');
    assert.throws(()=>f.engine.previewRun('plan'),/automated/);
    f.engine.importResult('plan',result('plan'));f.engine.approve('plan','accept',f.engine.preview('plan','accept').token); const code=f.engine.prepare('code');
    const script=join(f.dir,'agent');writeFileSync(script,`#!${process.execPath}\nconsole.log('{}')\n`,{mode:0o755});
    const e=new Engine(f.config,undefined,{executable:script}); try {
      const preview=e.previewRun('code');writeFileSync(join(code.worktree,'change'),'x');
      await assert.rejects(e.run('code',preview.token),/dirty/);rmSync(join(code.worktree,'change'));
      writeFileSync(script,`#!${process.execPath}\nconsole.log('changed')\n`,{mode:0o755});
      await assert.rejects(e.run('code',preview.token),/stale/);
      const db=new DatabaseSync(join(e.root,'state.sqlite')); const record=e.get('code'); record.status='running'; record.runId='crashed'; db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(record),'code'); db.close();
      assert.throws(()=>e.recover('code',''),/Confirm/); assert.equal(e.recover('code','stopped').status,'failed');
      assert.throws(()=>e.previewRun('code'),/ready/); assert.ok(existsSync(plan.worktree));
    } finally { e.close(); }
  } finally { f.cleanup(); }
});

test('Cursor waits for an uncooperative descendant before settling', {skip:process.platform === 'win32'}, async()=>{
  const { executeCursor }=await import('../src/adapters.ts'); const f=fixture();
  let pid=0; try {
    const marker=join(f.dir,'descendant'); const script=join(f.dir,'agent');
    const grandchild=`process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>{},1000)`;
    writeFileSync(script,`#!${process.execPath}\nconst fs=require('fs'); require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'}).unref(); const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(wait);console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'proposal',session_id:'s'}));}},10);\n`,{mode:0o755});
    const started=Date.now();
    await executeCursor({executable:script,args:[],cwd:f.dir,timeoutMs:5000,maxOutput:1024});
    pid=Number((await import('node:fs')).readFileSync(marker,'utf8'));
    assert.ok(Date.now()-started >= 900); assert.throws(()=>process.kill(pid,0),/ESRCH/);
  } finally {if(pid) try {process.kill(pid,'SIGKILL');} catch {} f.cleanup();}
});

test('CLI waits for descendant cleanup before exiting', {skip:process.platform === 'win32'}, async()=>{
  const f=fixture(); let pid=0; const marker=join(f.dir,'descendant'); try {
    f.engine.prepare('plan');f.engine.importResult('plan',result('plan'));f.engine.approve('plan','accept',f.engine.preview('plan','accept').token);f.engine.prepare('code');
    const script=join(f.dir,'agent'); const grandchild=`process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>{},1000)`;
    writeFileSync(script,`#!${process.execPath}\nconst fs=require('fs'); require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'}).unref(); const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(wait);console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'proposal',session_id:'s'}));}},10);\n`,{mode:0o755});
    const configFile=join(f.dir,'config.json');writeFileSync(configFile,JSON.stringify(f.config));
    const cli=new URL('../src/cli.ts',import.meta.url).pathname; const env={...process.env,PATH:`${f.dir}:${process.env.PATH}`};
    const preview=JSON.parse(execFileSync(process.execPath,[cli,'preview',configFile,'code','run'],{env,encoding:'utf8'}));
    const output=JSON.parse(execFileSync(process.execPath,[cli,'run',configFile,'code',preview.token],{env,encoding:'utf8'}));
    pid=Number((await import('node:fs')).readFileSync(marker,'utf8')); assert.equal(output.status,'result-ready'); assert.throws(()=>process.kill(pid,0),/ESRCH/);
  } finally {if(pid) try {process.kill(pid,'SIGKILL');} catch {} f.cleanup();}
});

test('Cursor cannot publish a result after changing its worktree branch',async()=>{
  const f=fixture(); try {
    f.engine.prepare('plan');f.engine.importResult('plan',result('plan'));f.engine.approve('plan','accept',f.engine.preview('plan','accept').token);f.engine.prepare('code');
    const script=join(f.dir,'agent');writeFileSync(script,`#!${process.execPath}\nrequire('child_process').execFileSync('git',['checkout','--detach']); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'proposal',session_id:'s'}));\n`,{mode:0o755});
    const e=new Engine(f.config,undefined,{executable:script}); try { await assert.rejects(e.run('code',e.previewRun('code').token),/ownership/); assert.equal(e.get('code').status,'failed'); assert.equal(e.get('code').result,undefined); } finally {e.close();}
  } finally {f.cleanup();}
});

test('explicit retry preserves failed attempts and invalidates old run approvals',async()=>{
  const f=fixture();try{
    f.engine.prepare('plan');f.engine.importResult('plan',result('plan'));f.engine.approve('plan','accept',f.engine.preview('plan','accept').token);
    const work=f.engine.prepare('code');
    const marker=join(f.dir,'attempted');const script=join(f.dir,'agent');
    writeFileSync(script,`#!${process.execPath}\nconst fs=require('fs');if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'yes');process.exit(1)};console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'proposal',session_id:'s'}));\n`,{mode:0o755});
    const e=new Engine(f.config,undefined,{executable:script});try{
      assert.throws(()=>e.retry('code'),/Only failed/);
      const original=e.previewRun('code');await assert.rejects(e.run('code',original.token),/failed/);
      const firstRun=e.get('code').runId;
      writeFileSync(join(work.worktree,'dirty'),'x');assert.throws(()=>e.retry('code'),/dirty/);rmSync(join(work.worktree,'dirty'));
      assert.equal(e.retry('code').status,'ready');await assert.rejects(e.run('code',original.token),/stale/);
      const fresh=e.previewRun('code');assert.notEqual(fresh.token,original.token);
      assert.equal((await e.run('code',fresh.token)).status,'result-ready');assert.notEqual(e.get('code').runId,firstRun);
      const history=e.audit();assert.ok(history.some(row=>row.action==='run-failed' && row.detail===firstRun));assert.ok(history.some(row=>row.action==='retry-prepared' && row.detail===firstRun));
      assert.throws(()=>e.retry('code'),/Only failed/);
    }finally{e.close();}
  }finally{f.cleanup();}
});

test('Cursor classifies startup errors without exposing raw credentials',async()=>{
  const {executeCursor}=await import('../src/adapters.ts');const f=fixture();try{
    const script=join(f.dir,'agent');writeFileSync(script,`#!${process.execPath}\nconsole.error('Workspace trust required; token=private-sentinel');process.exit(1);\n`,{mode:0o755});
    await assert.rejects(executeCursor({executable:script,args:[],cwd:f.dir,timeoutMs:5000,maxOutput:1024}),error=>{assert.match(String(error),/workspace trust required/);assert.ok(!String(error).includes('private-sentinel'));return true;});
  }finally{f.cleanup();}
});
