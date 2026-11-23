import assert from 'node:assert/strict';
import { gatewayAliases } from '../../apps/adapter/src/opencode/gateway.ts';

export type Page = { evaluate<T>(expression: string): Promise<T> };
export type Locale = 'zh-TW' | 'en';

type Catalog = { default: Record<string, string> };
const [zh, en] = await Promise.all(['zh-TW', 'en'].map(async (locale) =>
  await import(new URL('../../apps/web/src/i18n/' + locale + '.js', import.meta.url).href) as Catalog));

export function labelInLocale(label: string, locale: Locale) {
  if (locale === 'zh-TW') return label;
  const keys = Object.keys(zh.default).filter(key => zh.default[key] === label);
  assert.ok(keys.length, 'Missing mapping label in Traditional Chinese catalog: ' + label);
  return en.default[keys[0]];
}

export async function selectLocale(page: Page, locale: Locale, selector = '#settings-locale') {
  await page.evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    select.value = ${JSON.stringify(locale)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  assert.equal(await page.evaluate('document.documentElement.lang'), locale);
}

export async function inLocales(page: Page, check: (locale: Locale) => Promise<void>) {
  const original = await page.evaluate<{ lang: Locale; saved: string | null }>(
    "({ lang: document.documentElement.lang, saved: localStorage.getItem('oep.locale') })");
  assert.ok(original.lang === 'zh-TW' || original.lang === 'en');
  try {
    for (const locale of ['zh-TW', 'en'] as const) {
      if (await page.evaluate('document.documentElement.lang') !== locale) await selectLocale(page, locale);
      await check(locale);
    }
  } finally {
    if (await page.evaluate('document.documentElement.lang') !== original.lang) await selectLocale(page, original.lang);
    if (original.saved === null) await page.evaluate("localStorage.removeItem('oep.locale')");
  }
}

// Only the data-bearing parts of the workbench are excluded. Titles and labels
// within those views stay in scope unless their text comes from user content.
export const contentText = [
  '[data-ui-content]', '#sidebar-assistant-name', '#sidebar-assistant-intro', '#session-title', '.session-name',
  '.message-quote', '.message > div :is(p, li, code, th, td, h2, h3, h4, h5, h6)',
  '.tool-details pre', '#chat-resources button', '#attachments label', '#artifacts a[download]',
  '#file-preview .preview-title', '#chat-files .table-scroll td', '#file-preview pre',
  '#panel-notes li label', '[data-file-name]', '#project-folder-list li > span', '#project-read-folder',
  '#about-details dd', '#runtime-details dd', '#runtime-fingerprints dd',
  '#vault', '#vault-details dd:nth-of-type(-n+2)', '#vault-technical dd:nth-of-type(-n+3)',
  '#knowledge-answer .knowledge-reference', '#knowledge-answer strong', '#knowledge-answer small',
  '#knowledge-answer h2 + p', '#knowledge-cards td', '#knowledge-matches p:not(:only-child)',
  '#quality-sets', '#quality-questions .question-content', '#quality-results td:first-child',
  '.mcp-result li strong', '.mcp-result li p',
  '.feature-preview blockquote', '.feature-preview pre', '.feature-preview textarea', '.feature-preview input',
  '#review-view li > button', '#review-view li > small:not(.review-agent-source)', '#review-import-jobs details p',
].join(', ');

export const contentAttributes = [
  '[data-session][title]', '.session-list [aria-label]', '#chat-resources button', '#attachments [aria-label]',
  '#artifacts [aria-label]', '#file-preview img', '#file-preview iframe', '#panel-tabs .close-tab',
  '.mcp-result li button',
  '.agent-row summary[aria-label], #sessions [data-agent-start][aria-label]',
].join(', ');

const names = /\b(?:OEP|AEP|Atlas|OpenCode|Windows|Telegram|Excel|Python|Markdown|JSON|CSV|PNG|JPEG|JPG|PDF|HTML|HTM|TXT|MD|XLSX|ZIP|KiB|MiB|MB|URL|MCP|HTTPS?|TLS|SSH|stdio|SQLite|Schema|WAL|UTF|SHA|BI|IANA|D03|UTC|GMT|Ctrl|Shift|Enter|Esc|End|Home|Tab|ms|soul\.md|light|dark|Codex|Claude Code)\b|\bSkill(?= 即將開放)/gi;
const fileNames = /\b[^\s<>]+\.(?:txt|md|markdown|xlsx|csv|html?|jpe?g|png|pdf|json|sqlite|exe)\b/gi;
// Commands and paths are syntax or content. Aliases are the runtime model names.
const syntax = /\bAsia\/Taipei\b|\bfixture-notice\b|\bSYN-[A-Z0-9]+\b|\bsynthetic-(?:browser|knowledge|mcp-browser|model-[a-d])\b|(?:^|\s)\/(?:new|stop|model|theme|attach|ask|clear-search|help)\b|\b[A-Z]:[/\\][^\r\n ·]+|\b[0-9a-f]{8,}(?:-[\da-f]+)*\b/gi;

export function assertLanguage(text: string, locale: Locale, scope: string) {
  if (locale === 'en') {
    const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/u);
    assert.ok(!cjk, scope + ' contains CJK UI text: ' + cjk?.[0]);
    return;
  }
  const clean = gatewayAliases.reduce((value, alias) => value.replaceAll(alias, ''), text)
    .replace(syntax, '').replace(fileNames, '').replace(names, '');
  // Telegram's setup labels retain its official names, field name and command.
  const localized = /^#(?:settings-channels|agent-view|channel-dialog)(?:\s|$)/.test(scope)
    ? clean.replace(/\b(?:bot|token|BotFather)\b|\/start\b|@[A-Za-z0-9_]+/g, '') : clean;
  const mcp = /^#(?:settings-mcp|mcp-editor|capability-mcp-panel)(?:\s|$)/.test(scope)
    ? localized.replace(/\b(?:OAuth|API key|ID)\b/g, '') : localized;
  const word = mcp.match(/\b[A-Za-z]{2,}\b/);
  assert.ok(!word, scope + ' contains English UI text: ' + word?.[0]);
}

export async function assertWorkbenchFits(page: Page, context: string) {
  await inLocales(page, async (locale) => {
    const result = await page.evaluate<{ scroll: number; client: number; clipped: string[] }>(`(() => {
      const root = document.documentElement;
      const clipped = [...document.querySelectorAll('button, summary, label, legend, [data-i18n], .session-name-default, #sidebar-assistant-intro:not([data-ui-content])')]
        .filter(element => element.clientWidth && element.checkVisibility() && element.scrollWidth > element.clientWidth + 2 &&
          !element.closest('.message-table, .table-scroll, #knowledge-cards') &&
          (!element.closest('button[data-session]') || element.matches('.session-name-default')))
        .map(element => element.id || element.textContent.trim());
      const context = document.createElement('canvas').getContext('2d');
      for (const select of document.querySelectorAll('.locale-picker select, #settings-section, #theme, #density, #agent, #notes-filter, #session-alias, #agent-model, #agent-channel, #agent-reply-locale, #channel-agent')) {
        if (!select.checkVisibility() || !select.selectedOptions.length) continue;
        const style = getComputedStyle(select);
        context.font = style.font;
        const width = context.measureText(select.selectedOptions[0].label).width;
        if (width > select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 14) clipped.push(select.id);
      }
      return { scroll: root.scrollWidth, client: root.clientWidth, clipped };
    })()`);
    assert.ok(result.scroll <= result.client, `${locale} ${context}: ${result.scroll} > ${result.client}`);
    assert.deepEqual(result.clipped, [], `${locale} ${context}: clipped UI labels`);
  });
}
