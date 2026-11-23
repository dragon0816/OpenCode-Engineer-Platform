import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { copyFile, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { basename, isAbsolute, join, relative } from 'node:path';
import { atRepo } from '../../../launcher/src/paths.ts';
import { checkDirectory, openWorkspaceFile } from '../runs/workspace.ts';
import type { PluginManifest, VerifiedPlugin } from './package.ts';
import { PluginError, requirePlugin } from './zip.ts';

type Worker = PluginManifest['components']['pythonWorkers'][number];
type PythonFiles = { base: string; dependencies: { path: string; from: string }[] };
const environment = () => {
  const { SystemRoot, WINDIR, PATH, TEMP, TMP } = process.env;
  return { SystemRoot, WINDIR, PATH, TEMP, TMP };
};
const inspect = String.raw`
import importlib.metadata as metadata
import importlib.util as util
import json, pathlib, sys
assert sys.version_info[:2] == (3, 12)
base = pathlib.Path(sys.base_prefix).resolve(strict=True)
dependencies = {}
for dependency in json.loads(sys.argv[1]):
    dist = metadata.distribution(dependency["distribution"])
    root = pathlib.Path(dist.locate_file("")).resolve(strict=True)
    spec = util.find_spec(dependency["module"])
    assert spec is not None and dist.files
    files = []
    for entry in dist.files:
        if ".." in entry.parts or entry.is_absolute() or entry.suffix.lower() in (".pyc", ".pth"):
            continue
        path = pathlib.Path(dist.locate_file(entry))
        if not path.is_file():
            continue
        resolved = path.resolve(strict=True)
        assert resolved.is_relative_to(root) and not path.is_symlink()
        dependencies[str(entry)] = str(resolved)
        files.append(resolved)
    assert spec.origin and pathlib.Path(spec.origin).resolve() in files
print(json.dumps({"base": str(base), "dependencies": [
    {"path": path, "from": source} for path, source in dependencies.items()
]}))
`;

function pythonFiles(dependencies: Worker['dependencies']): PythonFiles {
  try {
    const result = execFileSync(process.env.OEP_PYTHON || 'python.exe', ['-I', '-c', inspect, JSON.stringify(dependencies)], {
      env: environment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 12_000,
    });
    const files = JSON.parse(result) as PythonFiles;
    requirePlugin(isAbsolute(files.base) && files.dependencies.length <= 16_000 && files.dependencies.every(({ path, from }) =>
      isAbsolute(from) && !isAbsolute(path) && !path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..' || part.includes(':'))));
    return files;
  } catch { throw new PluginError('python-dependencies'); }
}

export function validatePythonDependencies(plugin: VerifiedPlugin) {
  for (const worker of plugin.manifest.components.pythonWorkers) {
    if (worker.dependencies.length) pythonFiles(worker.dependencies);
  }
}

async function stagePython(stage: string, files: PythonFiles, signal: AbortSignal) {
  const options = { recursive: true, filter: (path: string) => {
    signal.throwIfAborted();
    return !['site-packages', '__pycache__', 'test', 'tests', 'ensurepip', 'idlelib', 'tkinter'].includes(basename(path).toLowerCase());
  } };
  const libraries = (await readdir(files.base, { withFileTypes: true })).filter((file) =>
    file.isFile() && /^(?:python\.exe|[\w.-]+\.(?:dll|pyd)|python312\.zip)$/i.test(file.name));
  await Promise.all(libraries.map(({ name }) => copyFile(join(files.base, name), join(stage, name))));
  for (const name of ['DLLs', 'Lib']) {
    const from = join(files.base, name);
    if (existsSync(from)) await cp(from, join(stage, name), options);
  }
  // The embeddable distribution keeps native stdlib extensions next to python.exe.
  const stdlib = libraries.some(({ name }) => name === 'python312.zip') ? ['python312.zip', '.'] : ['Lib', 'DLLs'];
  await writeFile(join(stage, 'python312._pth'), stdlib.join('\n') + '\n', { flag: 'wx' });
  for (const { path, from } of files.dependencies) {
    signal.throwIfAborted();
    const target = join(stage, 'dependencies', path);
    requirePlugin(!relative(join(stage, 'dependencies'), target).startsWith('..'), 'python-dependencies');
    await mkdir(join(target, '..'), { recursive: true });
    await copyFile(from, target);
  }
}

async function stagePackage(stage: string, plugin: VerifiedPlugin, signal: AbortSignal) {
  for (const { path } of plugin.manifest.files) {
    signal.throwIfAborted();
    const target = join(stage, 'package', path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, plugin.payload.get('payload/' + path)!, { flag: 'wx' });
  }
  await copyFile(atRepo('workers/plugins/bootstrap.py'), join(stage, 'bootstrap.py'));
}

type RPC = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const frameLimit = 256 * 1024;
const maxCalls = 512;
const powershell = () => join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const argumentsToJob = () => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', atRepo('scripts/windows/plugin-job.ps1')];
const jobEnvironment = (scratch: string, instance: string) => ({
  SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
  USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA,
  PATH: join(process.env.SystemRoot!, 'System32'), PATHEXT: '.EXE', TEMP: scratch, TMP: scratch, OEP_PLUGIN_INSTANCE: instance,
});

function removeProfile(scratch: string, instance: string) {
  if (existsSync(join(scratch, 'clean'))) return;
  execFileSync(powershell(), argumentsToJob(), { cwd: scratch, windowsHide: true, stdio: 'ignore',
    env: { ...jobEnvironment(scratch, instance), OEP_PLUGIN_RECOVER: '1' }, timeout: 10_000 });
}

export async function recoverPythonJobs(root: string) {
  const parent = join(root, 'plugin-workers');
  if (process.platform !== 'win32' || !process.env.SystemRoot || !existsSync(parent)) return;
  checkDirectory(parent);
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f\d]{32}$/.test(entry.name)) continue;
    const scratch = join(parent, entry.name);
    try {
      const owner = Number(openWorkspaceFile(scratch, 'owner', 20).data.toString());
      if (!Number.isSafeInteger(owner) || owner < 1) continue;
      try { process.kill(owner, 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      // An old supervisor watches the owner handle. Let it close the Job before retiring its profile.
      await new Promise((resolve) => setTimeout(resolve, 350));
      removeProfile(scratch, entry.name);
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch { /* Leave an unverifiable or locked directory for the next startup. */ }
  }
}

export async function runPython(root: string, plugin: VerifiedPlugin, worker: Worker, input: unknown, signal: AbortSignal,
  ready: () => void, rpc: RPC, resultLimit = frameLimit) {
  requirePlugin(process.platform === 'win32' && process.env.SystemRoot, 'isolation-unavailable');
  const parent = join(root, 'plugin-workers');
  mkdirSync(parent, { recursive: true });
  checkDirectory(parent);
  const instance = randomUUID().replaceAll('-', '');
  const scratch = join(parent, instance);
  const stage = join(scratch, 'runtime');
  const stop = join(scratch, 'stop');
  const clean = join(scratch, 'clean');
  const sentinel = join(scratch, 'private');
  const probe = createServer((socket) => socket.destroy());
  await mkdir(scratch);
  let launched = false;
  try {
    await writeFile(join(scratch, 'owner'), String(process.pid), { flag: 'wx' });
    await mkdir(stage);
    await writeFile(sentinel, 'private', { flag: 'wx' });
    const files = pythonFiles(worker.dependencies);
    await stagePython(stage, files, signal);
    await stagePackage(stage, plugin, signal);
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => { probe.off('error', reject); resolve(); });
    });
    signal.throwIfAborted();
    const child = spawn(powershell(), argumentsToJob(), {
        cwd: scratch, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...jobEnvironment(scratch, instance), OEP_PLUGIN_STAGE: stage, OEP_PLUGIN_STOP: stop, OEP_PLUGIN_CLEAN: clean,
          OEP_PLUGIN_TIMEOUT: String(worker.timeoutMs + 5_000), OEP_PLUGIN_OWNER: String(process.pid) },
      });
    launched = true;
    const finished = new Promise<number | null>((resolve) => {
      child.on('error', () => {});
      child.once('close', resolve);
    });
    child.stdin.on('error', () => {});
    let killTimer: NodeJS.Timeout | undefined;
    const end = () => {
      try { writeFileSync(stop, '', { flag: 'wx' }); } catch { /* Stop requests are idempotent. */ }
      child.stdin.end();
      killTimer ??= setTimeout(() => child.kill(), 5_000).unref();
    };
    signal.addEventListener('abort', end, { once: true });
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
    const chunks: Buffer[] = [];
    let buffered = 0;
    let started = false;
    let sequence = 0;
    let result: unknown;
    let returned = false;
    try {
      send({ port: (probe.address() as AddressInfo).port, sentinel });
      for await (const piece of child.stdout as AsyncIterable<Buffer>) {
        signal.throwIfAborted();
        let offset = 0;
        let newline: number;
        while ((newline = piece.indexOf(10, offset)) !== -1) {
          const tail = piece.subarray(offset, newline);
          const size = buffered + tail.length;
          requirePlugin(size <= resultLimit && !returned, 'worker-protocol');
          const bytes = buffered ? Buffer.concat([...chunks, tail], size) : tail;
          const frame = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
          chunks.length = 0;
          buffered = 0;
          offset = newline + 1;
          if (!started) {
            requirePlugin(frame?.ready === true && Object.keys(frame).length === 1, 'isolation-unavailable');
            started = true;
            ready();
            send({ entry: worker.entry, input });
          } else if (frame && Object.hasOwn(frame, 'result') && Object.keys(frame).length === 1) {
            result = frame.result;
            returned = true;
            child.stdin.end();
          } else {
            requirePlugin(size <= frameLimit && ++sequence <= maxCalls && frame?.jsonrpc === '2.0' && frame.id === sequence &&
              typeof frame.method === 'string' && frame.params && typeof frame.params === 'object' &&
              !Array.isArray(frame.params) && Object.keys(frame).length === 4, 'worker-protocol');
            const envelope = { jsonrpc: '2.0', id: sequence };
            try { send({ ...envelope, result: await rpc(frame.method, frame.params as Record<string, unknown>) }); }
            catch (error) {
              signal.throwIfAborted();
              send({ ...envelope, error: { code: -32000, message: error instanceof PluginError ? error.code : 'operation-failed' } });
            }
          }
        }
        if (offset < piece.length) {
          buffered += piece.length - offset;
          requirePlugin(buffered <= resultLimit, 'worker-protocol');
          chunks.push(piece.subarray(offset));
        }
      }
      const code = await finished;
      signal.throwIfAborted();
      requirePlugin(started && code !== 2, 'isolation-unavailable');
      requirePlugin(code === 0 && returned && !buffered, 'worker-failed');
      return result;
    } finally {
      signal.removeEventListener('abort', end);
      if (child.exitCode === null && child.signalCode === null) end();
      await finished;
      clearTimeout(killTimer);
    }
  } finally {
    probe.close();
    if (launched) removeProfile(scratch, instance);
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}
