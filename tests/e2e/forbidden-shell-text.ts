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

export async function assertNoForbiddenShellText(
  page: { evaluate<T>(expression: string): Promise<T> },
  settingsSelector?: string,
) {
  const rendered = await page.evaluate<string | null>(`(() => {
    const root = ${settingsSelector ? `document.querySelector(${JSON.stringify(settingsSelector)})` : 'document.body'};
    const visible = element => element.checkVisibility({ visibilityProperty: true }) &&
      !element.closest('details:not([open]) :not(summary, summary *)');
    if (!root || !visible(root)) return null;
    return [
      root.innerText,
      root.getAttribute('aria-label'),
      root.getAttribute('title'),
      ...[...root.querySelectorAll('[aria-label], [title], [placeholder]')].filter(visible)
        .flatMap(element => [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('placeholder')]),
      ...[...root.querySelectorAll('select')].filter(visible)
        .flatMap(select => [...select.options].map(option => option.label)),
    ].join('\\n');
  })()`);
  assert.ok(typeof rendered === 'string', `Rendered UI is missing (${settingsSelector ?? 'body'})`);
  const patterns = settingsSelector ? [...forbidden, ...settingsTechnicalTerms] : forbidden;
  for (const pattern of patterns) assert.ok(!pattern.test(rendered), `Rendered UI contains ${pattern} (${settingsSelector ?? 'body'})`);
}
