const stopWords = new Set('a an and are at be can could do does for from how in is it of on or should the to was what when where which who with would'.split(' '));
const han = /^\p{Script=Han}+$/u;
const exactPattern = /\b(?=[a-z\d._/-]*[a-z])(?=[a-z\d._/-]*\d)[a-z\d]+(?:[._/-][a-z\d]+)+\b|\b[a-z]+\d+[a-z\d]*\b/gu;
const specPattern = /(?<![a-z\d])([+±-]?\d+(?:\.\d+)?)\s*(khz|mhz|ghz|hz|dbm|db|mm|cm|ms|ma|mv|kv|v|a|w|kω|mω|ω|°c|n·m|%)(?![a-z])/gu;
const token = (prefix: string, text: string) => prefix + Buffer.from(text).toString('hex');

export function searchTerms(raw: string) {
  const text = raw.normalize('NFKC').toLowerCase().replace(/[‐‑‒–—−]/g, '-');
  const parts = [...new Set(text.match(exactPattern) ?? [])].map((term) => token('p', term));
  const specs = [...text.matchAll(specPattern)].map(([, value, unit]) => token('s', value + unit));
  const singles: string[] = [];
  const words: string[] = [];
  for (const run of text.match(/\p{Script=Han}+|[a-z0-9]+/gu) ?? []) {
    if (han.test(run)) {
      const characters = Array.from(run);
      for (const [index, character] of characters.entries()) {
        singles.push(character);
        if (index > 0) words.push(characters[index - 1] + character);
      }
    } else if (!stopWords.has(run)) {
      words.push(run);
      if (run.length > 4 && /[a-z]s$/.test(run)) words.push(run.slice(0, -1));
    }
  }
  return { parts, specs: [...new Set(specs)], words: [...new Set(words)], singles: [...new Set(singles)] };
}

export function indexedTerms(text: string) {
  const { parts, specs, words, singles } = searchTerms(text);
  return [parts.join(' '), specs.join(' '), words.join(' '), singles.join(' ')] as const;
}

export function matchQuery(text: string) {
  const { parts, specs, words, singles } = searchTerms(text);
  const alternatives = (column: string, terms: string[]) =>
    terms.slice(0, 96).map((term) => `${column}:"${term}"`).join(' OR ');
  if (parts.length) return parts.slice(0, 16).map((part) => `parts:"${part}"`).join(' OR ');
  const lexical = [alternatives('specs', specs), alternatives('words', words)].filter(Boolean).join(' OR ');
  return lexical || alternatives('singles', singles);
}
