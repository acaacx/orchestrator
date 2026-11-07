export const capabilities = ['plan', 'implement', 'review'] as const;
export type Capability = typeof capabilities[number];
export interface Task { id: string; adapter: string; capability: Capability; prompt: string; dependsOn: string[] }
export interface Config { version: 1; repository: string; enabledAdapters: string[]; tasks: Task[] }
export interface Result { version: 1; taskId: string; outcome: 'succeeded' | 'failed'; summary: string; evidence: string[] }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected an object');
  return value as Record<string, unknown>;
}
function exact(o: Record<string, unknown>, keys: string[]) {
  if (Object.keys(o).some(k => !keys.includes(k))) throw Error('Unknown field');
}
export function str(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 32000) throw Error('Expected nonempty string (maximum 32000 characters)');
  return v;
}
function strings(v: unknown): string[] { if (!Array.isArray(v)) throw Error('Expected array'); return v.map(str); }
export function identifier(v: unknown): string {
  const s = str(v); if (!/^[a-z][a-z0-9-]{0,47}$/.test(s)) throw Error('Invalid identifier'); return s;
}
export function parseConfig(value: unknown): Config {
  const o = object(value); exact(o, ['version','repository','enabledAdapters','tasks']);
  if (o.version !== 1 || !Array.isArray(o.tasks) || !o.tasks.length) throw Error('Expected version 1 and tasks');
  const tasks = o.tasks.map(value => {
    const t = object(value); exact(t, ['id','adapter','capability','prompt','dependsOn']);
    if (!capabilities.includes(t.capability as Capability)) throw Error('Unknown capability');
    return { id: identifier(t.id), adapter: identifier(t.adapter), capability: t.capability as Capability, prompt: str(t.prompt), dependsOn: strings(t.dependsOn).map(identifier) };
  });
  const ids = new Set(tasks.map(t => t.id));
  if (ids.size !== tasks.length) throw Error('Duplicate task ID');
  const done = new Set<string>(), visiting = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw Error('Dependency cycle');
    if (done.has(id)) return;
    const t = tasks.find(t => t.id === id); if (!t) throw Error('Missing dependency');
    visiting.add(id); t.dependsOn.forEach(visit); visiting.delete(id); done.add(id);
  }
  tasks.forEach(t => visit(t.id));
  return {version: 1, repository: str(o.repository), enabledAdapters: strings(o.enabledAdapters).map(identifier), tasks};
}
export function parseResult(value: unknown, taskId: string): Result {
  const o = object(value); exact(o, ['version','taskId','outcome','summary','evidence']);
  if (o.version !== 1 || o.taskId !== taskId || !['succeeded','failed'].includes(String(o.outcome))) throw Error('Invalid result contract');
  return {version: 1, taskId, outcome: o.outcome as Result['outcome'], summary: str(o.summary), evidence: strings(o.evidence)};
}
