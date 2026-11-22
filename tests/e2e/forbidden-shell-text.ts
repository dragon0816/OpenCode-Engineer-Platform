import assert from 'node:assert/strict';

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

export async function assertNoForbiddenShellText(page: Page, selector = 'body') {
  const rendered = await page.evaluate<{ normal: string; advanced: string } | null>(`(() => {
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
        if (summary?.textContent.trim().startsWith('進階') &&
            !summary?.contains(element) && detail !== element) return true;
      }
      return false;
    };
    const parts = { normal: [], advanced: [] };
    const add = (element, value) => {
      if (value?.trim()) parts[insideAdvanced(element) ? 'advanced' : 'normal'].push(value.trim());
    };
    if (root === document.body) add(root, document.title);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (visible(node.parentElement)) add(node.parentElement, node.textContent);
    }
    const attributes = '[aria-label], [aria-description], [aria-describedby], [aria-labelledby], [title], [placeholder], [alt], select';
    for (const element of [root, ...root.querySelectorAll(attributes)]) {
      if (!visible(element)) continue;
      for (const key of ['aria-label', 'aria-description', 'title', 'placeholder', 'alt']) add(element, element.getAttribute(key));
      for (const key of ['aria-describedby', 'aria-labelledby']) {
        for (const id of element.getAttribute(key)?.split(/\s+/) ?? []) {
          const referenced = document.getElementById(id);
          if (referenced && !visible(referenced)) add(element, referenced.textContent);
        }
      }
      if (element.matches('select')) for (const option of element.options) add(element, option.label);
    }
    return { normal: parts.normal.join(' '), advanced: parts.advanced.join(' ') };
  })()`);
  assert.ok(rendered, 'Rendered UI is missing (' + selector + ')');
  assertUiText(rendered.normal, selector);
  assertUiText(rendered.advanced, selector, true);
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
  return inThemes(page, () => assertNoForbiddenShellText(page, scope));
}

export async function assertNativeDialogTextInThemes(page: Page, selector: string, kind: 'confirm' | 'prompt', label?: string) {
  await inThemes(page, async (theme) => {
    const message = await page.evaluate<string | null>(`(() => {
      const kind = ${JSON.stringify(kind)};
      const original = window[kind];
      let message = null;
      window[kind] = text => { message = text; return kind === 'confirm' ? false : null; };
      try {
        const scope = document.querySelector(${JSON.stringify(selector)});
        const label = ${JSON.stringify(label ?? null)};
        const opener = label ? [...scope.querySelectorAll('button')].find(button => button.textContent.trim() === label) : scope;
        opener.click();
      }
      finally { window[kind] = original; }
      return message;
    })()`);
    assert.ok(message, theme + ' ' + kind + ' did not open from ' + selector);
    assertUiText(message, theme + ' ' + selector);
  });
}
