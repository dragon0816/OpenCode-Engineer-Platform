export const benchmarkJson = JSON.stringify([
  { id: 'synthetic-1', query: 'What is the synthetic limit?', class: 'answerable',
    answer: '合成上限為 5。', evidence: ['synthetic-passage-1'] },
  { id: 'synthetic-2', query: 'What is the synthetic serial number?', class: 'unanswerable',
    answer: null, evidence: [] },
], null, 2) + '\n';

export const benchmarkNames = ['oep-benchmark (79).json', '合成基準 (79).json'];
