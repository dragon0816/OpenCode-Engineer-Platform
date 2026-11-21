import { unzipSync } from 'fflate';

export async function bundleRuntimes(files, pin, wheels, download) {
  const nodeBase = 'https://nodejs.org/dist/v' + pin.node.version + '/';
  const sumsResponse = await fetch(nodeBase + 'SHASUMS256.txt', { signal: AbortSignal.timeout(30_000) });
  if (!sumsResponse.ok || !(await sumsResponse.text()).split(/\r?\n/).includes(pin.node.sha256 + '  ' + pin.node.archive)) {
    throw new Error('Node.js upstream checksum mismatch');
  }
  const nodeSource = nodeBase + pin.node.archive;
  const pythonSource = 'https://www.python.org/ftp/python/' + pin.python.version + '/' + pin.python.archive;
  const [nodeZip, pythonZip, ...wheelZips] = await Promise.all([
    download(nodeSource, pin.node.sha256), download(pythonSource, pin.python.sha256),
    ...wheels.map((item) => download(item.source, item.sha256)),
  ]);
  const nodePrefix = pin.node.archive.slice(0, -4) + '/';
  const node = unzipSync(nodeZip, { filter: ({ name }) => ['node.exe', 'LICENSE'].some((file) => name === nodePrefix + file) });
  files['vendor/node/node.exe'] = node[nodePrefix + 'node.exe'];
  files['vendor/node/LICENSE'] = node[nodePrefix + 'LICENSE'];
  const python = unzipSync(pythonZip);
  for (const [name, bytes] of Object.entries(python)) if (!name.endsWith('/')) files['vendor/python/' + name] = bytes;
  const pth = 'vendor/python/python312._pth';
  files[pth] = Buffer.concat([files[pth], Buffer.from('\r\nLib\\site-packages\r\n')]);
  for (const wheel of wheelZips) {
    for (const [name, bytes] of Object.entries(unzipSync(wheel))) {
      if (name.endsWith('/')) continue;
      if (!/^[\w./-]+$/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..') ||
          name.split('/')[0].endsWith('.data')) throw new Error('Unsupported wheel layout');
      const path = 'vendor/python/Lib/site-packages/' + name;
      if (path in files) throw new Error('Duplicate wheel file');
      files[path] = bytes;
    }
  }
  return [
    { name: 'Node.js', version: pin.node.version, type: 'framework', purl: 'pkg:generic/nodejs@' + pin.node.version,
      source: nodeSource, sha256: pin.node.sha256, license: 'MIT', text: Buffer.from(files['vendor/node/LICENSE']).toString('utf8') },
    { name: 'Python', version: pin.python.version, type: 'framework', purl: 'pkg:generic/cpython@' + pin.python.version,
      source: pythonSource, sha256: pin.python.sha256, license: 'Python-2.0.1', text: Buffer.from(python['LICENSE.txt']).toString('utf8') },
  ];
}
