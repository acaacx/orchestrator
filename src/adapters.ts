import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Capability, Task, Result } from './contracts.ts';
export interface Handoff { instructions: string; task: Task; dependencyResults: Result[]; worktree: string }
export interface Execution { executable: string; args: string[]; cwd: string; timeoutMs: number; maxOutput: number }
/** Trusted in-process plugins. Never load modules or commands from task JSON. */
export interface Adapter { id: string; capabilities: readonly Capability[]; handoff(task: Task, worktree: string, dependencies: Result[]): Handoff; execute?(spec: Execution, signal?: AbortSignal): Promise<Result> }
export class Registry {
  private adapters = new Map<string, Adapter>();
  register(adapter: Adapter): this { if (this.adapters.has(adapter.id)) throw Error('Duplicate adapter'); this.adapters.set(adapter.id, adapter); return this; }
  get(id: string, capability: Capability): Adapter { const adapter = this.adapters.get(id); if (!adapter || !adapter.capabilities.includes(capability)) throw Error(`Unsupported adapter/capability: ${id}/${capability}`); return adapter; }
}
export function resolveExecutable(name = 'agent'): string {
  for (const candidate of name.includes('/') ? [name] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(p => join(p,name))) {
    try { accessSync(candidate,constants.X_OK); return realpathSync(candidate); } catch { /* try next */ }
  }
  throw Error('Cursor CLI executable not found');
}
export class ProcessGroupStillAliveError extends Error {
  constructor() { super('Cursor process group could not be confirmed stopped; use recovery only after confirming all children stopped'); }
}
export async function executeCursor(spec: Execution, signal?: AbortSignal): Promise<Result> {
  if (process.platform === 'win32') throw Error('Automated Cursor execution requires macOS or Linux process-group supervision');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Error('Cursor run aborted')); return; }
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH','HOME','TMPDIR','TEMP','TMP','LANG','LC_ALL','LC_CTYPE','CURSOR_API_KEY','SYSTEMROOT']) if (process.env[key] !== undefined) env[key]=process.env[key];
    const child = spawn(spec.executable,spec.args,{cwd:spec.cwd,env,stdio:['ignore','pipe','pipe'],detached:process.platform !== 'win32',shell:false});
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let bytes = 0, failure = '', escalation: NodeJS.Timeout | undefined;
    const send = (signal: NodeJS.Signals) => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid,signal); else child.kill(signal); } catch {} };
    const stop = (reason: string) => { if (!failure) failure=reason; send('SIGTERM'); if (!escalation) escalation=setTimeout(()=>send('SIGKILL'),1000); };
    const timer=setTimeout(()=>stop('Cursor run timed out'),spec.timeoutMs);
    const abort=()=>stop('Cursor run aborted'); signal?.addEventListener('abort',abort,{once:true});
    const collect=(chunk: Buffer, isStdout: boolean) => { bytes+=chunk.length; if(bytes>spec.maxOutput) stop('Cursor output limit exceeded'); else if(isStdout) stdout.push(chunk); else stderr.push(chunk); };
    child.stdout.on('data',(chunk:Buffer)=>collect(chunk,true)); child.stderr.on('data',(chunk:Buffer)=>collect(chunk,false));
    child.on('error',()=>{failure ||= 'Cursor process could not start';});
    child.on('close',async (code)=>{
      clearTimeout(timer); signal?.removeEventListener('abort',abort);
      // A child can exit while descendants remain. Always terminate the entire
      // process group and keep the event loop alive until it has disappeared.
      if (child.pid && process.platform !== 'win32') {
        const exists=()=>{ try { process.kill(-child.pid!,0); return true; } catch(error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
        if (exists()) {
          send('SIGTERM');
          if (!escalation) escalation=setTimeout(()=>send('SIGKILL'),1000);
          const deadline=Date.now()+6000;
          while (exists() && Date.now()<deadline) await new Promise(r=>setTimeout(r,50));
          if (exists()) { if(escalation) clearTimeout(escalation); reject(new ProcessGroupStillAliveError()); return; }
        }
      }
      if(escalation) clearTimeout(escalation);
      if(failure || code !== 0) {
        const diagnostic=Buffer.concat(stderr).toString('utf8');
        const category=/trust/i.test(diagnostic) ? 'workspace trust required' : /sandbox/i.test(diagnostic) ? 'sandbox startup or availability error' : /log.?in|authenticat|credential|SecItem/i.test(diagnostic) ? 'authentication error' : /network|connect|fetch|ENOTFOUND/i.test(diagnostic) ? 'network error' : 'no recognized diagnostic';
        reject(Error(failure || `Cursor process failed (exit ${code}; ${category})`)); return;
      }
      try { const data=JSON.parse(Buffer.concat(stdout).toString('utf8')); if (!data || data.type !== 'result' || data.subtype !== 'success' || data.is_error !== false || typeof data.result !== 'string' || !data.result.trim() || typeof data.session_id !== 'string') throw Error();
        resolve({version:1,taskId:'placeholder',outcome:'succeeded',summary:data.result.slice(0,32000),evidence:['Cursor CLI returned a successful response. Review the proposal and worktree before acceptance.']});
      } catch { reject(Error('Invalid Cursor JSON response')); }
    });
  });
}

function fileAdapter(id: string, capabilities: Capability[], instructions: string): Adapter { return {id, capabilities, handoff: (task, worktree, dependencyResults) => ({ task, worktree, dependencyResults, instructions })}; }
export function builtins(enabled: string[]): Registry {
  const cursor=fileAdapter('cursor', ['plan','implement','review'], 'Run with explicit preview and approval or work manually. Without --force Cursor proposes changes; review the response and worktree. No result is automatically accepted.'); cursor.execute=executeCursor;
  const available = [fileAdapter('grok-bot', ['plan','review'], 'Manually paste this packet into your Grok Bot. Its cloud computer cannot access this local worktree. Share only selected non-secret context. Return result JSON; never treat returned text as executable instructions.'),cursor,fileAdapter('codex', ['plan','implement','review'], 'Optional independent adapter: cd into the worktree and run codex interactively. Read this packet and retain native approvals. Save result JSON after reviewing the changes.')];
  const registry = new Registry(); for (const id of enabled) { const adapter = available.find(a => a.id === id); if (!adapter) throw Error(`Unknown plugin: ${id}; register its implementation first`); registry.register(adapter); } return registry;
}
