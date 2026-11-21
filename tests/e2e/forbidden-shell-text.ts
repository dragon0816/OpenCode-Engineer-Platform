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

export async function assertNoForbiddenShellText(page: { evaluate<T>(expression: string): Promise<T> }) {
  const rendered = await page.evaluate<string>(`(() => {
    const visible = element => element.checkVisibility({ visibilityProperty: true }) &&
      !element.closest('details:not([open]) :not(summary, summary *)');
    return [
      document.body.innerText,
      ...[...document.querySelectorAll('[aria-label], [title]')].filter(visible)
        .flatMap(element => [element.getAttribute('aria-label'), element.getAttribute('title')]),
      ...[...document.querySelectorAll('select')].filter(visible)
        .flatMap(select => [...select.options].map(option => option.label)),
    ].join('\\n');
  })()`);
  for (const pattern of forbidden) assert.ok(!pattern.test(rendered), `Rendered UI contains ${pattern}`);
}
