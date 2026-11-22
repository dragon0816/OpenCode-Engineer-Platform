import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { webMessage } from '../../apps/adapter/src/http/messages.ts';

const web = new URL('../../apps/web/', import.meta.url);
const source = new URL('src/', web);
const read = (url: URL) => readFileSync(url, 'utf8');
const parse = (url: URL) => ts.createSourceFile(url.pathname, read(url), ts.ScriptTarget.Latest, true);
const entries = (object: ts.ObjectLiteralExpression) => {
  const values = new Map<string, string>();
  for (const property of object.properties) {
    assert.ok(ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name) &&
      ts.isStringLiteral(property.initializer), 'Catalog entries must be literal key–value pairs');
    const { text: key } = property.name;
    assert.ok(!values.has(key), 'Duplicate catalog key ' + key);
    assert.ok(property.initializer.text.trim(), 'Empty catalog entry ' + key);
    values.set(key, property.initializer.text);
  }
  return values;
};
function catalog(locale: string) {
  const [statement] = parse(new URL('i18n/' + locale + '.js', source)).statements;
  assert.ok(ts.isExportAssignment(statement) && ts.isObjectLiteralExpression(statement.expression));
  return entries(statement.expression);
}

test('workbench catalogs cover every UI and adapter key in both languages', () => {
  const zh = catalog('zh-TW');
  const en = catalog('en');
  assert.deepEqual([...zh.keys()].sort(), [...en.keys()].sort());

  const used = new Set<string>();
  const html = read(new URL('index.html', web));
  for (const [, key] of html.matchAll(/\bdata-i18n(?:-[\w-]+)?="([^"]+)"/g)) used.add(key);
  for (const file of readdirSync(source).filter(file => file.endsWith('.js'))) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['message', 't'].includes(node.expression.text)) {
        const [key] = node.arguments;
        if (ts.isStringLiteral(key)) used.add(key.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(new URL(file, source)));
  }

  // serverText resolves these codes at runtime. The adapter table defines the allowed codes.
  const adapter = new URL('../../apps/adapter/src/', import.meta.url);
  const messagesFile = new URL('http/messages.ts', adapter);
  const definitions = parse(messagesFile).statements
    .filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .find(declaration => declaration.name.getText() === 'messages');
  assert.ok(definitions?.initializer && ts.isObjectLiteralExpression(definitions.initializer));
  const references = new Set<string>();
  const adapterFiles = readdirSync(adapter, { encoding: 'utf8', recursive: true }).filter(path => path.endsWith('.ts'))
    .map(path => new URL(path.replaceAll('\\', '/'), adapter));
  adapterFiles.push(new URL('../../apps/launcher/src/custom-mcp-probe.ts', import.meta.url));
  for (const url of adapterFiles) {
    const visit = (node: ts.Node) => {
      if (url.href === messagesFile.href && ts.isVariableDeclaration(node) && node.name.getText() === 'messages') return;
      if (ts.isStringLiteral(node)) references.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(parse(url));
  }
  for (const [code, fallback] of entries(definitions.initializer)) {
    // Some retained records and probe results are matched by their original fallback text.
    assert.ok(references.has(code) || references.has(fallback), 'Unreferenced adapter message ' + code);
    const key = 'server.' + code;
    used.add(key);
    assert.equal(zh.get(key), fallback, 'Traditional Chinese fallback for ' + code);
  }
  assert.deepEqual([...used].filter(key => !zh.has(key)).sort(), [], 'Unknown keys');
  assert.deepEqual([...zh.keys()].filter(key => !used.has(key)).sort(), [], 'Unused keys');

  for (const [key, value] of en) {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(placeholders(value), placeholders(zh.get(key)!), 'Interpolation parameters for ' + key);
    assert.doesNotMatch(value, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u, key);
  }
  assert.deepEqual(webMessage('upload-too-large', { size: 20 }), {
    code: 'upload-too-large', params: { size: 20 }, text: '檔案超過 20 MiB。',
  });
});
