import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function syntheticMcpCertificate(root: string) {
  const git = join(process.env.ProgramFiles ?? '', 'Git/usr/bin/openssl.exe');
  const openssl = existsSync(git) ? git : 'openssl';
  const key = join(root, 'test.key');
  const cert = join(root, 'test.pem');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert, 'utf8') };
}
