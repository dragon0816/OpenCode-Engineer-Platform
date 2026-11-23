import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { chromium } from './chromium.ts';
import { selectLocale } from './gui-locales.ts';

type Page = Awaited<ReturnType<typeof chromium>>;
const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const hint = "document.querySelector('#drop-hint')";
const prompt = "document.querySelector('#prompt')";
const status = "document.querySelector('#upload-status')";

export async function verifyComposerAttachments(page: Page, audit: string, capture: boolean, captureEngineering: boolean) {
  const attachment = (name: string) =>
    `[...document.querySelectorAll('#attachments li')].find(row => row.querySelector('label').textContent === ${JSON.stringify(name)})`;
  const resource = (name: string) =>
    `[...document.querySelectorAll('#chat-resources button')].find(button => button.textContent === ${JSON.stringify(name)})`;
  const point = (selector: string) => page.evaluate<{ x: number; y: number }>(`(() => {
    const { left, top, width, height } = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: Math.floor(left + width / 2), y: Math.floor(top + height / 2) };
  })()`);
  const drag = async (selector: string, names: string[], text?: string, content = 'Synthetic composer attachment') => {
    const at = await point(selector);
    assert.equal(await page.evaluate(`document.elementFromPoint(${at.x}, ${at.y}).closest(${JSON.stringify(selector)})?.matches(${JSON.stringify(selector)})`), true);
    const files = names.map((name) => {
      const path = join(audit, name);
      writeFileSync(path, content);
      return path;
    });
    const data = { items: text ? [{ mimeType: 'text/plain', data: text }] : [], files, dragOperationsMask: 1 };
    const event = (type: string) => page.command('Input.dispatchDragEvent', { type, ...at, data });
    await event('dragEnter');
    await event('dragOver');
    return () => event('drop');
  };
  const expectHint = async (label: string) => {
    assert.equal(await page.evaluate(`${hint}.checkVisibility() && ${hint}.textContent === ${JSON.stringify(label)}`), true);
    assert.equal(await page.evaluate(`(() => {
      const box = ${hint}.getBoundingClientRect();
      return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight &&
        getComputedStyle(${hint}).pointerEvents === 'none' &&
        ['#drop', '#messages'].every(selector => getComputedStyle(document.querySelector(selector)).outlineStyle === 'dashed');
    })()`), true);
  };
  const expectSelected = async (name: string) => {
    const row = attachment(name);
    await page.ready(`${row}?.querySelector('input').checked && ${row}?.querySelector('[data-classification="unclassified"]')`);
  };
  const preview = async (name: string) => {
    await page.evaluate(`${resource(name)}.click()`);
    await page.ready(`!document.querySelector('#chat-files').hidden &&
      [...document.querySelectorAll('#file-preview > div:not([hidden])')].some(panel =>
        panel.querySelector('h2').textContent === ${JSON.stringify(name)} && panel.querySelector('img')?.naturalWidth > 0)`);
    await page.evaluate("document.querySelector('#close-files').click()");
  };
  const screenshotName = 'composer-drop-hint-zh-TW-narrow.png';
  await page.evaluate(`if (!document.querySelector('#chat-files').hidden) document.querySelector('#close-files').click();
    ${prompt}.value = ''; ${prompt}.focus();`);
  await page.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  try {
    await page.ready("innerWidth === 390 && document.querySelector('#session-sidebar').hidden && !document.querySelector('#pick').disabled");
    const dropOnPrompt = await drag('#prompt', ['drop-textarea.txt']);
    await expectHint('放開以附加檔案');
    if (capture) {
      // Keep the historical turn alert in the test, but omit it from the drop-hint image.
      const hidden = await page.evaluate<boolean>(`(() => {
        const alert = document.querySelector('#error');
        const hidden = alert.hidden;
        alert.hidden = true;
        return hidden;
      })()`);
      try {
        const { data } = await page.command<{ data: string }>('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join('docs', 'validation', 'gui', screenshotName), Buffer.from(data, 'base64'));
      } finally {
        await page.evaluate(`document.querySelector('#error').hidden = ${hidden}`);
      }
    }
    await dropOnPrompt();
    await expectSelected('drop-textarea.txt');
    assert.equal(await page.evaluate(`${status}.textContent.includes('已上傳 1') && !${hint}.checkVisibility() && ${prompt}.value === ''`), true);

    await selectLocale(page, 'en');
    const dropOnMessages = await drag('#messages', ['drop-messages-a.txt', 'drop-messages-b.txt']);
    await expectHint('Release to attach files');
    await dropOnMessages();
    for (const name of ['drop-messages-a.txt', 'drop-messages-b.txt']) await expectSelected(name);
    assert.match(await page.evaluate<string>(`${status}.textContent`), /Upload complete \(files: 2\)/);

    const dropText = await drag('#prompt', [], 'Plain dragged text');
    assert.equal(await page.evaluate(`${hint}.checkVisibility()`), false);
    await dropText();
    await page.ready(`${prompt}.value === 'Plain dragged text'`);

    const canceled = await page.evaluate<boolean>(`(() => {
      const data = new DataTransfer();
      data.setData('text/plain', 'Plain pasted text');
      ${prompt}.focus();
      ${prompt}.select();
      return !${prompt}.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    })()`);
    // Synthetic paste has no browser default action, so assert the app leaves it available to Chromium.
    assert.equal(canceled, false);
    await page.command('Input.insertText', { text: 'Plain pasted text' });
    assert.equal(await page.evaluate(`${prompt}.value`), 'Plain pasted text');

    const pasteImage = (name: string, itemOnly: boolean) => page.evaluate(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.getContext('2d').fillRect(0, 0, 20, 20);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const data = new DataTransfer();
      data.items.add(new File([blob], ${JSON.stringify(name)}, { type: blob.type }));
      if (${itemOnly}) Object.defineProperty(data, 'files', { value: [] });
      return !${prompt}.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    })()`);
    assert.equal(await pasteImage('image.png', false), true);
    const pastedLabel = `[...document.querySelectorAll('#attachments label')].find(label => label.textContent.startsWith('pasted-image-'))`;
    await page.ready(pastedLabel);
    const englishName = await page.evaluate<string>(`${pastedLabel}.textContent`);
    assert.match(englishName, /^pasted-image-\d{8}-\d{6}\.png$/);
    await expectSelected(englishName);
    assert.equal(await page.evaluate(`${prompt}.value`), 'Plain pasted text');
    await preview(englishName);

    await selectLocale(page, 'zh-TW');
    assert.equal(await pasteImage('', true), true);
    const chineseLabel = `[...document.querySelectorAll('#attachments label')].find(label => label.textContent.startsWith('貼上的圖片-'))`;
    await page.ready(chineseLabel);
    assert.match(await page.evaluate<string>(`${chineseLabel}.textContent`), /^貼上的圖片-\d{8}-\d{6}\.png$/);

    assert.equal(await page.evaluate(`(async () => {
      const canvas = document.createElement('canvas');
      const webp = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp'));
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob('${gif}'), char => char.charCodeAt(0))], 'paste-photo.gif', { type: 'image/gif' }));
      data.items.add(new File([webp], 'paste-photo.webp', { type: webp.type }));
      data.items.add(new File(['unsupported'], 'paste-unsupported.bin', { type: 'application/octet-stream' }));
      data.setData('text/plain', 'Mixed');
      const prompt = ${prompt};
      prompt.focus();
      prompt.setSelectionRange(0, 5);
      return !prompt.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    })()`), true);
    assert.equal(await page.evaluate(`${prompt}.value`), 'Mixed pasted text');
    for (const name of ['paste-photo.gif', 'paste-photo.webp']) await expectSelected(name);
    await page.ready("!document.querySelector('#error').hidden && document.querySelector('#error').textContent.includes('不支援這種檔案類型。')");
    assert.match(await page.evaluate<string>(`${status}.textContent`), /已上傳 2.*無法附加 1 個檔案/);
    assert.equal(await page.evaluate(`Boolean(${attachment('paste-unsupported.bin')})`), false);
    await selectLocale(page, 'en');
    assert.match(await page.evaluate<string>("document.querySelector('#error').textContent"), /This file type isn’t supported/);
    assert.match(await page.evaluate<string>("document.querySelector('#error').textContent"), /image.*PDF.*Excel.*plain text.*configuration or source code/);
    assert.match(await page.evaluate<string>(`${status}.textContent`), /Could not attach files \(1\)/);
    for (const name of ['paste-photo.gif', 'paste-photo.webp']) await preview(name);

    const paste = (name: string, content: string | number[], type: string) => page.evaluate(`(() => {
      const data = new DataTransfer();
      const content = ${JSON.stringify(content)};
      data.items.add(new File([typeof content === 'string' ? content : Uint8Array.from(content)],
        ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
      return !${prompt}.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    })()`);
    const json = '{\n  "compilerOptions": { "strict": true }\n}\n';
    const python = 'def sample():\n    return "合成"\n';
    for (const [width, height, layout, locale, pasted, dropped] of [
      [390, 844, 'narrow', 'en', ['tsconfig.json', json, 'application/json'], ['sample.py', python]],
      [1440, 900, 'wide', 'zh-TW', ['sample.py', python, 'text/x-python'], ['tsconfig.json', json]],
    ] as const) {
      await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await page.ready(`innerWidth === ${width}`);
      await selectLocale(page, locale);
      for (const [name, content, type] of [pasted, dropped]) {
        const rows = `[...document.querySelectorAll('#attachments li')].filter(row => row.querySelector('label').textContent === ${JSON.stringify(name)})`;
        const count = await page.evaluate<number>(`${rows}.length`);
        if (type) assert.equal(await paste(name, content, type), true);
        else await (await drag('#prompt', [name], undefined, content))();
        await page.ready(`${rows}.length === ${count + 1} && ${rows}.at(-1).querySelector('input').checked &&
          ${rows}.at(-1).querySelector('[data-classification=unclassified]')`);
        await page.evaluate(`[...document.querySelectorAll('#chat-resources button')]
          .filter(button => button.textContent === ${JSON.stringify(name)}).at(-1).click()`);
        await page.ready(`(() => {
          const pre = document.querySelector('#file-preview > div:not([hidden]) pre');
          return pre?.textContent === ${JSON.stringify(content)} && getComputedStyle(pre).fontFamily.includes('monospace');
        })()`);
        if (captureEngineering && name === 'tsconfig.json') {
          const { data } = await page.command<{ data: string }>('Page.captureScreenshot', { format: 'png' });
          writeFileSync(join('docs', 'validation', 'gui', `owner-round2-text-preview-${locale}-${layout}.png`), Buffer.from(data, 'base64'));
        }
        await page.evaluate("document.querySelector('#close-files').click()");
      }
      const rejected = 'binary.json';
      assert.equal(await paste(rejected, [0x50, 0x4b, 0x03, 0x04, 0x00], 'application/json'), true);
      const encodingError = locale === 'en' ? 'Text attachments must use UTF-8 encoding.' : '文字附件須使用 UTF-8 編碼。';
      await page.ready(`document.querySelector('#error').textContent.includes(${JSON.stringify(rejected + ' · ' + encodingError)})`);
      assert.equal(await page.evaluate(`Boolean(${attachment(rejected)})`), false);
    }
  } finally {
    await selectLocale(page, 'zh-TW');
    await page.command('Emulation.clearDeviceMetricsOverride');
  }
  console.log('Composer attachments passed in Chromium (zh-TW and en, 390 px and 1440 px).');
}
