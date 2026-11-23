export const benchmarkJson = JSON.stringify({
  schemaVersion: 1,
  dataset: 'synthetic-knowledge-quality',
  settings: { locale: 'zh-TW', retrievalLimit: 5, samples: 48 },
  checks: [
    { id: 'answerable', expected: 24, verified: 24 },
    { id: 'unanswerable', expected: 24, verified: 24 },
    { id: 'citations', expected: 24, verified: 24 },
  ],
}, null, 2) + '\n';

export const benchmarkNames = ['oep-benchmark (79).json', '合成基準 (79).json'];
