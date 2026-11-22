import assert from 'node:assert/strict';
import { assertLanguage, contentAttributes, contentText, inLocales, labelInLocale } from './gui-locales.ts';
import type { Locale } from './gui-locales.ts';

const forbidden = [
  /BI\s*審核示範/,
  /\bBI\s+review\s+demo\b/i,
  /\b(?:oep-synthetic-demo|synthetic-(?:browser|knowledge|mcp-browser))\b/i,
  /知識庫示範（合成資料）|合成標準題集|測試模型/,
  /產物|差異|即時進度|(?<!鍵盤)快捷鍵|會話模型/,
];

// Product names and file formats such as Telegram, Excel and Markdown use
// their official spelling. Implementation terms below require a disclosure.
const advancedOnly = [
  /\b(?:soul\.md|MCP|stdio|SSH|HTTPS|HTTP Gateway|JSON|SQLite|Schema|IANA|UTF-8|D03|SHA-256)\b/i,
  /\bRun Now\b|HTTP 標頭|環境變數|模型閘道|(?:提交|介面|執行檔|用戶端)雜湊|前五段證據召回率/,
];

type Page = { evaluate<T>(expression: string): Promise<T> };

export function assertUiText(rendered: string, scope: string, advanced = false) {
  for (const pattern of advanced ? forbidden : [...forbidden, ...advancedOnly]) {
    const match = pattern.exec(rendered);
    assert.ok(!match, 'Rendered UI contains ' + match?.[0] + ' (' + scope + ')');
  }
}

export async function assertNoForbiddenShellText(page: Page, selector = 'body', locale?: Locale) {
  const rendered = await page.evaluate<{ normal: string; advanced: string; shell: { text: string; source: string }[] } | null>(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)});
    const visible = element => element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
      !element.closest('template, script, style') &&
      [...closed].every(detail => !detail.contains(element) || detail === element ||
        detail.querySelector(':scope > summary')?.contains(element));
    const closed = document.querySelectorAll('details:not([open])');
    if (!root || !visible(root)) return null;
    const insideAdvanced = element => {
      for (let detail = element.closest('details'); detail; detail = detail.parentElement.closest('details')) {
        const summary = detail.querySelector(':scope > summary');
        if (summary?.textContent.trim().startsWith(document.documentElement.lang === 'en' ? 'Advanced' : '進階') &&
            !summary?.contains(element) && detail !== element) return true;
      }
      return false;
    };
    const parts = { normal: [], advanced: [] };
    const shell = [];
    const add = (element, value, attribute = false, contentSource = element) => {
      if (!value?.trim()) return;
      const text = value.trim();
      const modelSurface = contentSource.matches('#model, #default-alias option, #session-alias option, #quality-aliases option, ' +
        '#model-health label span, #model-health button, #session-model-fallback');
      const checked = modelSurface ? text.replace(/\\bsynthetic-(?:browser|knowledge|mcp-browser)\\b/g, '') : text;
      parts[insideAdvanced(element) ? 'advanced' : 'normal'].push(checked);
      if (!contentSource.closest(${JSON.stringify(contentText)}) &&
          (!attribute || !contentSource.closest(${JSON.stringify(contentAttributes)}))) {
        const source = contentSource.localName + (contentSource.id ? '#' + contentSource.id : '');
        const label = contentSource.id === 'remove-session-question' ? text.replace(/[「“].*[」”]/u, '') :
          contentSource.id === 'project-working-root' ? text.split(' · ')[0] :
          contentSource.id === 'knowledge-repository-status' ? text.replace(/\\btag-[a-z]\\b/g, '') : text;
        shell.push({ text: label, source });
      }
    };
    if (root === document.body) add(root, document.title);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (visible(node.parentElement)) add(node.parentElement, node.textContent);
    }
    const attributes = '[aria-label], [aria-description], [aria-describedby], [aria-labelledby], [title], [placeholder], [alt], select';
    for (const element of [root, ...root.querySelectorAll(attributes)]) {
      if (!visible(element)) continue;
      for (const key of ['aria-label', 'aria-description', 'title', 'placeholder', 'alt']) add(element, element.getAttribute(key), true);
      for (const key of ['aria-describedby', 'aria-labelledby']) {
        for (const id of element.getAttribute(key)?.split(/\\s+/) ?? []) {
          const referenced = document.getElementById(id);
          if (referenced && !visible(referenced)) add(element, referenced.textContent, true, referenced);
        }
      }
      if (element.matches('select')) for (const option of element.options) add(element, option.label, false, option);
    }
    return { normal: parts.normal.join(' '), advanced: parts.advanced.join(' '), shell };
  })()`);
  assert.ok(rendered, 'Rendered UI is missing (' + selector + ')');
  assertUiText(rendered.normal, selector);
  assertUiText(rendered.advanced, selector, true);
  if (locale) for (const { text, source } of rendered.shell) assertLanguage(text, locale, selector + ' ' + source);
}

export async function inThemes(page: Page, check: (theme: string) => Promise<void>) {
  const original = await page.evaluate<string | null>("document.documentElement.getAttribute('data-theme')");
  try {
    for (const theme of ['light', 'dark']) {
      await page.evaluate('document.documentElement.dataset.theme = ' + JSON.stringify(theme));
      await check(theme);
    }
  } finally {
    await page.evaluate("document.documentElement.toggleAttribute('data-theme', " + (original !== null) + "); " +
      (original === null ? '' : 'document.documentElement.dataset.theme = ' + JSON.stringify(original)));
  }
}

export function assertUiTextInThemes(page: Page, scope = 'body') {
  return inLocales(page, locale => inThemes(page, () => assertNoForbiddenShellText(page, scope, locale)));
}

export async function assertNativeDialogTextInThemes(page: Page, selector: string, kind: 'confirm' | 'prompt', label?: string) {
  await inLocales(page, locale => inThemes(page, async (theme) => {
    const message = await page.evaluate<string | null>(`(() => {
      const kind = ${JSON.stringify(kind)};
      const original = window[kind];
      let message = null;
      window[kind] = text => { message = text; return kind === 'confirm' ? false : null; };
      try {
        const scope = document.querySelector(${JSON.stringify(selector)});
        const label = ${JSON.stringify(label ? labelInLocale(label, locale) : null)};
        const opener = label ? [...scope.querySelectorAll('button')].find(button => button.textContent.trim() === label) : scope;
        opener.click();
      }
      finally { window[kind] = original; }
      return message;
    })()`);
    assert.ok(message, theme + ' ' + kind + ' did not open from ' + selector);
    assertUiText(message, theme + ' ' + selector);
    assertLanguage(selector === '#attachments' ? message.replace(/[「“].*[」”]/u, '') : message, locale, selector + ' dialog');
  }));
}
