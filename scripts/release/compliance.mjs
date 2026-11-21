import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const licenseText = (name) => readFileSync(new URL('./licenses/' + name + '.license', import.meta.url), 'utf8');
const policy = JSON.parse(readFileSync(new URL('../../config/license-allowlist.json', import.meta.url), 'utf8'));
const python = {
  defusedxml: ['0.7.1', 'PSF-2.0', '07/6c/aa3f2f849e01cb6a001cd8554a88d4c77c5c1a31c95bdf1cf9301e6d9ef4/defusedxml-0.7.1-py2.py3-none-any.whl'],
  'et-xmlfile': ['2.0.0', 'MIT AND Python-2.0.1', 'c1/8b/5fe2cc11fee489817272089c4203e679c63b570a5aaeb18d852ae3cbba6a/et_xmlfile-2.0.0-py3-none-any.whl'],
  openpyxl: ['3.1.5', 'MIT', 'c0/da/977ded879c29cbd04de313843e76868e6e13408a94ed6b987245dc7c8506/openpyxl-3.1.5-py2.py3-none-any.whl'],
};

export function productionPackages(lock) {
  return Object.entries(lock.packages).filter(([path, entry]) => path && !entry.dev).sort();
}

export function pythonComponents(requirements) {
  const components = new Map();
  for (const line of requirements.trim().split(/\r?\n/)) {
    const [, name, version, sha256] = /^([\w-]+)==([^ ]+) --hash=sha256:([a-f0-9]{64})$/.exec(line) ?? [];
    const pin = python[name];
    if (!pin || version !== pin[0] || components.has(name)) throw new Error('Python compliance pin mismatch');
    components.set(name, { name, version, sha256, license: pin[1], text: licenseText(name),
      type: 'library', purl: 'pkg:pypi/' + name + '@' + version,
      source: 'https://files.pythonhosted.org/packages/' + pin[2] });
  }
  if (components.size !== Object.keys(python).length) throw new Error('Missing Python compliance pin');
  return [...components.values()];
}

export function npmComponent(path, entry, files, pin) {
  const name = path.split('node_modules/').at(-1);
  const metadata = JSON.parse(files[path + '/package.json']);
  const fallback = /^@opencode\/(client|protocol|schema)$/.test(name) && entry.version === pin.client.version;
  const texts = Object.keys(files).filter((file) =>
    file.startsWith(path + '/') && /^(licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(file.slice(path.length + 1))
    && !file.slice(path.length + 1).includes('/')).sort();
  return { name, version: entry.version, source: entry.resolved, integrity: entry.integrity,
    license: entry.license === metadata.license ? entry.license ?? 'UNKNOWN' : 'UNKNOWN',
    purl: 'pkg:npm/' + name.replace('@', '%40') + '@' + entry.version, ref: path, type: 'library',
    text: texts.map((file) => Buffer.from(files[file]).toString('utf8')).join('\n\n') || (fallback ? licenseText('opencode') : '') };
}

export function openCodeComponent(component, pin) {
  if (pin.commit !== 'c0ad18b402eb2827fc1ee71c171b1177b3fc02d1') throw new Error('Review the pinned OpenCode license');
  return { ...component, type: 'application', text: licenseText('opencode'),
    purl: 'pkg:github/anomalyco/opencode@' + pin.tag };
}

const categories = new Map(Object.entries({
  MIT: 'permissive', 'Apache-2.0': 'permissive', 'BSD-2-Clause': 'permissive', 'BSD-3-Clause': 'permissive',
  'PSF-2.0': 'permissive', 'Python-2.0.1': 'permissive', '0BSD': 'permissive',
  'MPL-2.0': 'weak copyleft', 'LGPL-2.1-only': 'weak copyleft', 'LGPL-3.0-only': 'weak copyleft',
}));

export function classify(license) {
  const parts = license.split(/ (?:AND|OR) /);
  const classes = parts.map((id) => categories.get(id) ??
    (/^(?:A?GPL)-(?:[123]\.0)-(?:only|or-later)$/.test(id) ? 'strong copyleft' :
      /^LicenseRef-[\w.-]+$/.test(id) ? 'custom' : 'unknown'));
  return ['strong copyleft', 'unknown', 'custom', 'weak copyleft', 'permissive'].find((kind) => classes.includes(kind));
}

export function complianceArtifacts(components) {
  const notices = ['# NOTICE', 'OpenCode-Engineer-Platform is distributed under the MIT license. See LICENSE.', 'Third-party terms and copyright notices are reproduced in THIRD_PARTY_LICENSES.md.'];
  const licenses = ['# Third-party licenses'];
  const inventory = components.map(({ name, version, license, purl, ref, type, text, source, integrity, sha256, binarySha256 }) => {
    const classification = classify(license);
    if (['unknown', 'strong copyleft', 'custom'].includes(classification) &&
        !policy.some((item) => item.purl === purl && item.license === license && item.justification?.trim())) {
      throw new Error('授權未通過審核：' + name + ' ' + version);
    }
    if (!text.trim()) throw new Error('缺少授權全文：' + name + ' ' + version);
    notices.push('- ' + name + ' ' + version + ' (' + license + ')');
    licenses.push('## ' + name + ' ' + version + '\n\nLicense: ' + license + ' (' + classification + ')\n\nSource: ' + source + '\n\n' +
      text.replace(/\r\n/g, '\n').trimEnd().split('\n').map((line) => line ? '    ' + line : '').join('\n'));
    const hashes = [];
    if (integrity?.startsWith('sha512-')) hashes.push({ alg: 'SHA-512', content: Buffer.from(integrity.slice(7), 'base64').toString('hex') });
    for (const content of new Set([sha256, binarySha256].filter(Boolean))) hashes.push({ alg: 'SHA-256', content });
    return { type, 'bom-ref': ref ?? purl, name, version, purl, hashes,
      licenses: [classification === 'unknown' ? { license: { name: license } } : { expression: license }],
      externalReferences: [{ type: 'distribution', url: source }] };
  });
  const sbom = { $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json', bomFormat: 'CycloneDX', specVersion: '1.5',
    version: 1, components: inventory };
  return { 'sbom.cdx.json': Buffer.from(JSON.stringify(sbom, null, 2) + '\n'),
    'THIRD_PARTY_LICENSES.md': Buffer.from(licenses.join('\n\n') + '\n'),
    NOTICE: Buffer.from(notices.join('\n\n') + '\n') };
}
