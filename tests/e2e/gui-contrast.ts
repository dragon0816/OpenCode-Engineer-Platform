import assert from 'node:assert/strict';
import { inThemes } from './forbidden-shell-text.ts';

type Check = {
  selector: string;
  against?: string;
  property?: 'color' | 'borderTopColor' | 'outlineColor';
};

function luminance([red, green, blue]: number[]) {
  const channels = [red, green, blue].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export async function assertContrastInThemes(
  page: { evaluate<T>(expression: string): Promise<T> },
  checks: Check[],
) {
  await inThemes(page, async (theme) => {
    const results = await page.evaluate<{ missing?: string; foreground: number[]; background: number[]; opacity: number }[]>(`(() => {
      const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      const channels = color => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      return ${JSON.stringify(checks)}.map(({ selector, against, property = 'color' }) => {
        const element = document.querySelector(selector);
        const base = against ? document.querySelector(against) : element;
        if (!element?.checkVisibility() || !base?.checkVisibility()) return { missing: selector };
        const foreground = channels(getComputedStyle(element)[property]);
        let background = [0, 0, 0, 0];
        for (let parent = base; parent; parent = parent.parentElement) {
          background = channels(getComputedStyle(parent).backgroundColor);
          if (background[3]) break;
        }
        return { foreground, background, opacity: Number(getComputedStyle(element).opacity) };
      });
    })()`);
    for (const [index, { selector, against, property = 'color' }] of checks.entries()) {
      const { foreground, background, missing, opacity } = results[index];
      const label = [theme, selector, property, against].filter(Boolean).join(' ');
      assert.ok(!missing, 'Missing contrast sample: ' + label);
      assert.equal(opacity, 1, label);
      assert.equal(foreground[3], 255, label);
      assert.equal(background[3], 255, label);
      const light = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      const ratio = (light[0] + 0.05) / (light[1] + 0.05);
      assert.ok(ratio >= (property === 'color' ? 4.5 : 3), label + ' ' + ratio.toFixed(2) + ':1');
    }
  });
}
