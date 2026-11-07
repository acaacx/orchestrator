import { Engine, readJson } from './engine.ts';
const [command, configFile, id, argument, token] = process.argv.slice(2);
const help = `Usage: npm start -- <command> config.json [task-id] [argument] [token]
Commands: init | status | audit | prepare ID | import ID result.json | cancel ID
          preview ID accept|cleanup|run | approve ID accept|cleanup TOKEN
          run ID TOKEN | recover ID stopped
Cursor can run only after preview and approval. Without --force, changes may be proposals. No automatic acceptance, merges, pushes, or deployments.`;
if (!configFile || command === 'help') console.log(help);
else {
  let engine: Engine | undefined;
  try {
    engine = new Engine(readJson(configFile));
    let result: unknown;
    switch(command) {
      case 'init': result={root:engine.root,tasks:engine.list()}; break;
      case 'status': result=engine.list(); break;
      case 'audit': result=engine.audit(); break;
      case 'prepare': result={task:engine.prepare(id),handoff:`${engine.root}/handoffs/${id}.json`}; break;
      case 'import': result=engine.importResult(id,readJson(argument)); break;
      case 'cancel': result=engine.cancel(id); break;
      case 'run': { const controller=new AbortController(); const abort=()=>controller.abort(); process.once('SIGINT',abort); process.once('SIGTERM',abort); try { result=await engine.run(id,argument,controller.signal); } finally { process.removeListener('SIGINT',abort); process.removeListener('SIGTERM',abort); } break; }
      case 'recover': result=engine.recover(id,argument); break;
      case 'preview': case 'approve':
        if(command === 'preview' && argument === 'run') { result=engine.previewRun(id); break; }
        if(argument !== 'accept' && argument !== 'cleanup') throw Error('Expected accept, cleanup, or preview run');
        result=command === 'preview' ? engine.preview(id,argument) : engine.approve(id,argument,token); break;
      default: throw Error(help);
    }
    console.log(JSON.stringify(result,null,2));
  } catch(error) { console.error(error instanceof Error ? error.message : 'Operation failed'); process.exitCode=1; }
  finally { engine?.close(); }
}
