import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { detect } from '../phase0/secret-scan.mjs';
import { complianceArtifacts, npmComponent, openCodeComponent, productionPackages, pythonComponents } from './compliance.mjs';

const read = (path) => readFileSync(new URL('../../' + path, import.meta.url));
const pin = JSON.parse(read('config/opencode.pin.json'));
const lock = JSON.parse(read('package-lock.json'));

function inventory() {
  const npm = productionPackages(lock).map(([path, entry]) => {
    const files = Object.fromEntries(readdirSync(new URL('../../' + path + '/', import.meta.url), { withFileTypes: true })
      .filter((file) => file.isFile()).map((file) => [path + '/' + file.name, read(path + '/' + file.name)]));
    return npmComponent(path, entry, files, pin);
  });
  return [...npm, ...pythonComponents(read('tests/oracles/requirements.txt').toString('utf8')),
    openCodeComponent({ name: 'OpenCode', version: pin.tag, source: 'https://github.com/anomalyco/opencode',
      license: 'MIT', sha256: pin.windowsX64.sha256, binarySha256: pin.windowsX64.binarySha256 }, pin)];
}

test('CycloneDX fields, production coverage, license texts, and repeatable artifacts', () => {
  const components = inventory();
  const artifacts = complianceArtifacts(components);
  assert.deepEqual(artifacts, complianceArtifacts(inventory()));
  const sbom = JSON.parse(artifacts['sbom.cdx.json']);
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.5');
  assert.equal(sbom.version, 1);
  const refs = sbom.components.map((component) => component['bom-ref']);
  assert.equal(new Set(refs).size, refs.length);
  const expected = Object.entries(lock.packages).filter(([path, entry]) => path && !entry.dev).map(([path]) => path);
  assert.deepEqual(refs.filter((ref) => ref.startsWith('node_modules/')).sort(), expected.sort());
  for (const [index, component] of sbom.components.entries()) {
    assert.match(component.type, /^(application|library|framework)$/);
    assert.ok(component.name && component.version);
    assert.match(component.purl, /^pkg:[^/]+\/.+@.+/);
    assert.ok(component.licenses[0].expression);
    assert.equal(new URL(component.externalReferences[0].url).protocol, 'https:');
    assert.ok(component.hashes.length);
    assert.match(artifacts.NOTICE.toString(), new RegExp(components[index].license.replaceAll('.', '\\.')));
    const text = components[index].text.replace(/\r\n/g, '\n').trimEnd();
    assert.ok(text.length > 100);
    assert.ok(artifacts['THIRD_PARTY_LICENSES.md'].toString().includes(text.split('\n').map((line) => line ? '    ' + line : '').join('\n')));
  }
  for (const bytes of Object.values(artifacts)) assert.deepEqual(detect(bytes.toString(), []), []);
});

test('an unknown license in a synthetic production lock fails the artifact build', () => {
  const path = 'node_modules/synthetic';
  const entry = { version: '1.0.0', license: 'Unknown-fixture', resolved: 'https://example.invalid/synthetic' };
  const fixture = { packages: { '': {}, [path]: entry } };
  const components = productionPackages(fixture).map(([name, item]) => npmComponent(name, item,
    { [path + '/package.json']: JSON.stringify(entry), [path + '/LICENSE']: Buffer.from('Synthetic license') }, pin));
  assert.throws(() => complianceArtifacts(components), /synthetic 1.0.0/);
});
