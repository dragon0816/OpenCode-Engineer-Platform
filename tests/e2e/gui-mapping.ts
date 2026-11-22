import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inLocales, labelInLocale } from './gui-locales.ts';

type Page = { evaluate<T>(expression: string): Promise<T> };
type Controls = { selectors?: string[]; labels?: string[] };

const layout = readFileSync(new URL('../../docs/GUI_LAYOUT.md', import.meta.url), 'utf8');
const ids = [...layout.matchAll(/<!-- ui:([\w-]+) -->$/gm)].map((match) => match[1]);

export function mappingChecks(page: Page, group: 'settings' | 'servers' | 'feature' | 'agent' | 'delegation') {
  const servers = /^settings-mcp-(?!knowledge$)/;
  const expected = ids.filter((id) => group === 'servers' ? servers.test(id) :
    id.startsWith(group + '-') && !servers.test(id));
  const covered = new Set<string>();
  const seen = (...checked: string[]) => {
    for (const id of checked) {
      assert.ok(expected.includes(id), 'Unknown mapping row ' + id);
      covered.add(id);
    }
  };
  return {
    seen,

    async check(id: string, scope: string, { selectors = [], labels = [] }: Controls) {
      await inLocales(page, async (locale) => {
        const translated = labels.map(label => labelInLocale(label, locale));
        const missing = await page.evaluate<string[]>(`(() => {
          const root = document.querySelector(${JSON.stringify(scope)});
          if (!root) return [${JSON.stringify(scope)}];
          const actions = Array.from(root.querySelectorAll('button, summary, a'), node => node.textContent.trim());
          return [
            ...${JSON.stringify(selectors)}.filter(selector => !root.querySelector(selector)),
            ...${JSON.stringify(translated)}.filter(label => !actions.includes(label)),
          ];
        })()`);
        assert.deepEqual(missing, [], locale + ' ' + id + ' (' + scope + ')');
      });
      seen(id);
    },

    finish() {
      const headings = ['### 設定控制項對照', '### 功能控制項對照', '### 助理控制項對照'];
      const rows = headings.flatMap((heading) => {
        const start = layout.indexOf(heading);
        const end = layout.indexOf('\n## ', start);
        assert.ok(start >= 0 && end > start, heading);
        return layout.slice(start, end).split(/\r?\n/).filter((line) => line.startsWith('| ') && !line.startsWith('| 舊位置'));
      });
      assert.equal(ids.length, rows.length, 'Every mapping row needs a browser check ID');
      assert.equal(new Set(ids).size, ids.length, 'Mapping IDs must be unique');
      assert.deepEqual([...covered].sort(), [...expected].sort(), 'Checked mapping rows for ' + group);
    },
  };
}
