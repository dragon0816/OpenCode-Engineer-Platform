import { dataDirectory } from './paths.ts';
import { startRuntime } from './runtime.ts';

const root = dataDirectory();
console.log(JSON.stringify({ event: 'starting', root }));
const stopRequested = Promise.withResolvers<void>();
process.once('SIGINT', () => stopRequested.resolve());
process.once('SIGTERM', () => stopRequested.resolve());
try {
  const runtime = await startRuntime(root);
  console.log(JSON.stringify({ event: 'ready', version: runtime.version, alias: runtime.alias, unauthenticated: runtime.unauthenticated }));
  await Promise.race([stopRequested.promise, runtime.finished]);
  const result = await runtime.stop();
  console.log(JSON.stringify({ event: 'stopped', ...result }));
  if (result.supervisorExit !== 0 || result.childExit !== 0 || result.orphans !== 0) process.exitCode = 1;
} catch {
  console.error('OEP startup or shutdown failed. See the local runtime audit directory.');
  process.exitCode = 1;
}
