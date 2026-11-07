import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync, readFileSync, lstatSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseConfig, parseResult, identifier } from './contracts.ts';
import type { Config, Task, Result } from './contracts.ts';
import { builtins, resolveExecutable, ProcessGroupStillAliveError } from './adapters.ts';
import type { Registry } from './adapters.ts';
export type Status = 'pending' | 'preparing' | 'ready' | 'running' | 'result-ready' | 'accepted' | 'failed' | 'cancelled' | 'cleaning' | 'cleaned';
interface RecordState { task: Task; status: Status; base: string; branch: string; worktree: string; result?: Result; acceptedHead?: string; cleanupToken?: string; allocated?: boolean; runId?: string }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export class Engine {
  readonly root: string;
  readonly repository: string;
  readonly config: Config;
  readonly registry: Registry;
  private db: DatabaseSync;
  private options: { executable?: string; timeoutMs?: number; maxOutput?: number };
  constructor(value: unknown, registry?: Registry, options: { executable?: string; timeoutMs?: number; maxOutput?: number } = {}) {
    this.options=options;
    this.config = parseConfig(value);
    this.registry = registry ?? builtins(this.config.enabledAdapters);
    this.config.tasks.forEach(t => {
      if (!this.config.enabledAdapters.includes(t.adapter)) throw Error('Adapter disabled');
      this.registry.get(t.adapter, t.capability);
    });
    this.repository = realpathSync(this.config.repository);
    if (realpathSync(this.git(['rev-parse','--show-toplevel'])) !== this.repository) throw Error('repository must be the Git root');
    this.root = join(realpathSync(this.git(['rev-parse','--path-format=absolute','--git-common-dir'])), 'local-orchestrator');
    mkdirSync(this.root, {recursive:true, mode:0o700});
    this.db = new DatabaseSync(join(this.root, 'state.sqlite'));
    this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, task TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);');
    try { this.transaction(() => {
      const canonical = JSON.stringify({...this.config, repository: this.repository});
      const stored = this.db.prepare('SELECT value FROM meta WHERE key=?').get('config') as {value:string} | undefined;
      if (stored && stored.value !== canonical) throw Error('Configuration differs from initialized project; use the original immutable configuration');
      if (!stored) {
        this.db.prepare('INSERT INTO meta VALUES (?,?)').run('config', canonical);
        const base = this.git(['rev-parse','HEAD']);
        for (const task of this.config.tasks) {
          const token = randomUUID();
          this.save({task, status:'pending', base, branch:`orchestrator/${task.id}-${token}`, worktree:join(this.root,'worktrees',token)}, 'created');
        }
      }
    }); } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private git(args: string[], cwd = this.repository): string {
    return execFileSync('git', ['-c','core.hooksPath=/dev/null', ...args], {cwd, encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout:30000, maxBuffer:8*1024*1024}).trim();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private save(record: RecordState, action: string, detail = '') {
    this.db.prepare('INSERT OR REPLACE INTO tasks VALUES (?,?)').run(record.task.id, JSON.stringify(record));
    this.db.prepare('INSERT INTO events(at,task,action,detail) VALUES (?,?,?,?)').run(new Date().toISOString(),record.task.id,action,detail);
  }
  get(id: string): RecordState {
    identifier(id);
    const row = this.db.prepare('SELECT value FROM tasks WHERE id=?').get(id) as {value:string} | undefined;
    if (!row) throw Error('Unknown task'); return JSON.parse(row.value);
  }
  list() { return this.config.tasks.map(t => this.get(t.id)); }
  audit() { return this.db.prepare('SELECT * FROM events ORDER BY seq').all(); }
  private verify(r: RecordState) {
    if (lstatSync(r.worktree).isSymbolicLink() || realpathSync(r.worktree) !== r.worktree) throw Error('Worktree path changed');
    const entries = this.git(['worktree','list','--porcelain']).split('\n\n');
    if (!entries.some(e => e.split('\n').includes(`worktree ${r.worktree}`) && e.split('\n').includes(`branch refs/heads/${r.branch}`))) throw Error('Worktree ownership mismatch');
    if (this.git(['symbolic-ref','--short','HEAD'],r.worktree) !== r.branch) throw Error('Worktree branch changed');
  }
  prepare(id: string) {
    this.transaction(() => {
      const r = this.get(id);
      if (r.status !== 'pending') return;
      for (const dep of r.task.dependsOn) if (!this.get(dep).acceptedHead) throw Error(`Dependency not accepted: ${dep}`);
      r.allocated = true; r.status = 'preparing'; this.save(r,'prepare-intent');
    });
    return this.transaction(() => {
      const r = this.get(id);
      if (r.status === 'ready') return r;
      if (r.status !== 'preparing') throw Error('Task cannot be prepared in this state');
      mkdirSync(join(this.root,'worktrees'),{recursive:true, mode:0o700});
      if (!existsSync(r.worktree)) this.git(['worktree','add','-b',r.branch,r.worktree,r.base]);
      this.verify(r);
      const packet = this.registry.get(r.task.adapter,r.task.capability).handoff(r.task,r.worktree,r.task.dependsOn.map(d => this.get(d).result!));
      const packetDir = join(this.root,'handoffs'); mkdirSync(packetDir,{recursive:true,mode:0o700});
      writeFileSync(join(packetDir,`${id}.json`),JSON.stringify(packet,null,2),{mode:0o600});
      r.status='ready'; this.save(r,'prepared'); return r;
    });
  }
  importResult(id: string, value: unknown) {
    const result = parseResult(value,id);
    return this.transaction(() => {
      const r=this.get(id); if (r.status !== 'ready') throw Error('Task must be ready');
      this.verify(r); r.result=result; r.status=result.outcome === 'succeeded' ? 'result-ready' : 'failed';
      this.save(r,'result-imported',hash(JSON.stringify(result))); return r;
    });
  }
  private previewRecord(r: RecordState, action: 'accept'|'cleanup') {
    if (!r.allocated && action === 'cleanup') {
      if (existsSync(r.worktree)) throw Error('Unexpected worktree at unallocated path');
      const detail={action,taskId:r.task.id,worktree:r.worktree,branch:r.branch,head:r.base,resultHash:hash('null')};
      return {...detail, token:hash(JSON.stringify(detail))};
    }
    this.verify(r);
    if (this.git(['status','--porcelain','--untracked-files=all','--ignored'],r.worktree)) throw Error('Worktree is dirty; review and commit changes first');
    const head=this.git(['rev-parse','HEAD'],r.worktree);
    const detail={action,taskId:r.task.id,worktree:r.worktree,branch:r.branch,head,resultHash:hash(JSON.stringify(r.result ?? null))};
    return {...detail, token:hash(JSON.stringify(detail))};
  }
  preview(id: string, action: 'accept'|'cleanup') {
    return this.transaction(() => {
      const r=this.get(id);
      if (action === 'accept' ? r.status !== 'result-ready' : !['accepted','failed','cancelled','cleaning'].includes(r.status)) throw Error('Action not permitted in this state');
      return this.previewRecord(r,action);
    });
  }
  approve(id: string, action: 'accept'|'cleanup', token: string) {
    if (action === 'accept') return this.transaction(() => {
      const r=this.get(id); if(r.status !== 'result-ready') throw Error('No result awaiting acceptance');
      const preview=this.previewRecord(r,action); if (preview.token !== token) throw Error('Approval is stale or invalid');
      r.status='accepted'; r.acceptedHead=preview.head; this.save(r,'accepted',token); return r;
    });
    this.transaction(() => {
      const r=this.get(id); if (!['accepted','failed','cancelled','cleaning'].includes(r.status)) throw Error('Cleanup not permitted');
      if (r.status === 'cleaning' && !existsSync(r.worktree)) {
        if (r.cleanupToken !== token) throw Error('Approval is stale or invalid');
      } else if (this.previewRecord(r,action).token !== token) throw Error('Approval is stale or invalid');
      r.cleanupToken=token; r.status='cleaning'; this.save(r,'cleanup-approved',token);
    });
    return this.transaction(() => {
      const r=this.get(id);
      if (r.status !== 'cleaning') throw Error('Cleanup state changed');
      if (existsSync(r.worktree)) {
        if(this.previewRecord(r,action).token !== token) throw Error('Worktree changed after approval');
        this.git(['worktree','remove',r.worktree]);
      }
      r.status='cleaned'; this.save(r,'cleaned',token); return r;
    });
  }
  private runPreview(r: RecordState) {
    if (r.status !== 'ready') throw Error('Task must be ready to run');
    const adapter=this.registry.get(r.task.adapter,r.task.capability);
    if (r.task.adapter !== 'cursor' || !adapter.execute) throw Error('Adapter does not support automated execution');
    this.verify(r);
    if (this.git(['status','--porcelain','--untracked-files=all','--ignored'],r.worktree)) throw Error('Worktree is dirty');
    const dependencies=r.task.dependsOn.map(id => { const dep=this.get(id); if (!dep.acceptedHead || !dep.result) throw Error('Dependency not accepted'); return {task:dep.task,result:dep.result,acceptedHead:dep.acceptedHead}; });
    const prompt=JSON.stringify({instruction:'Perform the task in the worktree. Return your findings and proposed changes as text. Do not commit, merge, push, or deploy. Changes may require human review and application.',task:r.task,dependencies});
    const executable=resolveExecutable(this.options.executable);
    const args=['--print','--output-format','json','--sandbox','enabled',...(r.task.capability === 'plan' ? ['--mode','plan'] : r.task.capability === 'review' ? ['--mode','ask'] : []),prompt];
    const detail={action:'run',previousRunId:r.runId ?? null,task:r.task,dependencies,executable,executableHash:hash(readFileSync(executable).toString('base64')),args,cwd:r.worktree,head:this.git(['rev-parse','HEAD'],r.worktree),timeoutMs:this.options.timeoutMs ?? 600000,maxOutput:this.options.maxOutput ?? 1048576};
    return {...detail,token:hash(JSON.stringify(detail))};
  }
  previewRun(id: string) { return this.transaction(()=>this.runPreview(this.get(id))); }
  async run(id: string, token: string, signal?: AbortSignal) {
    const claim=this.transaction(()=>{
      const r=this.get(id); const preview=this.runPreview(r);
      if(preview.token !== token) throw Error('Approval is stale or invalid');
      r.status='running'; r.runId=randomUUID(); this.save(r,'run-started',r.runId);
      return {preview,runId:r.runId,adapter:this.registry.get(r.task.adapter,r.task.capability)};
    });
    try {
      const output=await claim.adapter.execute!({executable:claim.preview.executable,args:claim.preview.args,cwd:claim.preview.cwd,timeoutMs:claim.preview.timeoutMs,maxOutput:claim.preview.maxOutput},signal);
      const result=parseResult({...output,taskId:id},id);
      return this.transaction(()=>{ const r=this.get(id); if(r.status !== 'running' || r.runId !== claim.runId) throw Error('Run state changed'); this.verify(r); r.result=result; r.status=result.outcome === 'succeeded' ? 'result-ready' : 'failed'; this.save(r,'run-finished',claim.runId); return r; });
    } catch(error) {
      if (!(error instanceof ProcessGroupStillAliveError)) this.transaction(()=>{ const r=this.get(id); if(r.status === 'running' && r.runId === claim.runId) { r.status='failed'; this.save(r,'run-failed',claim.runId); } });
      throw error;
    }
  }
  retry(id: string) {
    return this.transaction(() => {
      const r=this.get(id);
      if (r.status !== 'failed' || !r.runId || r.task.adapter !== 'cursor' || r.result) throw Error('Only failed Cursor process attempts without a result can be retried');
      this.verify(r);
      if (this.git(['status','--porcelain','--untracked-files=all','--ignored'],r.worktree)) throw Error('Worktree is dirty');
      r.status='ready'; this.save(r,'retry-prepared',r.runId); return r;
    });
  }
  recover(id: string, confirmation: string) {
    if(confirmation !== 'stopped') throw Error('Confirm all child processes have stopped with: stopped');
    return this.transaction(()=>{const r=this.get(id); if(r.status !== 'running') throw Error('Task is not running'); r.status='failed'; this.save(r,'run-recovered',r.runId ?? ''); return r;});
  }
  cancel(id: string) {
    return this.transaction(() => {
      const r=this.get(id); if (!['pending','ready','result-ready'].includes(r.status)) throw Error('Cannot cancel in this state');
      r.status='cancelled'; this.save(r,'cancelled'); return r;
    });
  }
}
export function readJson(path: string): unknown {
  const file=resolve(path); if(statSync(file).size>1024*1024) throw Error('JSON exceeds 1 MiB');
  return JSON.parse(readFileSync(file,'utf8'));
}
