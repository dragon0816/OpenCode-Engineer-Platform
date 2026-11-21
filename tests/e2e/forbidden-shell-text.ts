import assert from 'node:assert/strict';

const forbidden = [
  /BI 審核示範/,
  /BI review demo/i,
  /\bsynthetic-(?:browser|knowledge|mcp-browser)\b/i,
  /產物/,
  /差異/,
  /即時進度/,
  /(?<!鍵盤)快捷鍵/,
  /會話模型/,
];

const settingsTechnicalTerms = [
  /\bsoul\.md\b/i,
  /\b(?:stdio|SSH|HTTPS)\b/i,
  /HTTP 標頭|環境變數|模型閘道|提交雜湊|介面雜湊|檔雜湊|用戶端雜湊/,
];

const featureTechnicalTerms = [
  /\b(?:HTTP Gateway|JSON|SQLite|Schema|IANA|UTF-8|D03)\b/i,
  /\bRun Now\b|\bSynthetic source\b/i,
  /合成標準題集|前五段證據召回率/,
];

export async function assertNoForbiddenShellText(
  page: { evaluate<T>(expression: string): Promise<T> },
  selector?: string,
  mode: 'settings' | 'feature' = 'settings',
) {
  const rendered = await page.evaluate<string | null>(`(() => {
    const root = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body'};
    const insideAdvanced = element => {
      for (let detail = element.closest('details'); detail; detail = detail.parentElement.closest('details')) {
        const summary = detail.querySelector(':scope > summary');
        if (summary?.textContent.trim().startsWith('進階') && !summary.contains(element)) return true;
      }
      return false;
    };
    const feature = ${mode === 'feature'};
    const visible = element => element.checkVisibility({ visibilityProperty: true }) &&
      !element.closest('details:not([open]) :not(summary, summary *)') && !(feature && insideAdvanced(element));
    const content = () => {
      if (!feature) return root.innerText;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const parts = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (visible(node.parentElement)) parts.push(node.textContent);
      }
      return parts.join(' ');
    };
    if (!root || !visible(root)) return null;
    return [
      content(),
      root.getAttribute('aria-label'),
      root.getAttribute('title'),
      ...[...root.querySelectorAll('[aria-label], [title], [placeholder]')].filter(visible)
        .flatMap(element => [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('placeholder')]),
      ...[...root.querySelectorAll('select')].filter(visible)
        .flatMap(select => [...select.options].map(option => option.label)),
    ].join('\\n');
  })()`);
  assert.ok(typeof rendered === 'string', `Rendered UI is missing (${selector ?? 'body'})`);
  const technical = mode === 'feature' ? featureTechnicalTerms : settingsTechnicalTerms;
  const patterns = selector ? [...forbidden, ...technical] : forbidden;
  for (const pattern of patterns) assert.ok(!pattern.test(rendered), `Rendered UI contains ${pattern} (${selector ?? 'body'})`);
}
