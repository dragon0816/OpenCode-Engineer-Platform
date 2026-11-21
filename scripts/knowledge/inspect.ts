import { inspectRepository, repositoryErrorReport } from '../../packages/knowledge/src/repository.ts';

const [folder, ...options] = process.argv.slice(2);
if (!folder || folder.startsWith('--') || options.length > 1 || options.some((option) => option !== '--show-names')) {
  console.error('Usage: npm run knowledge:inspect -- <folder> [--show-names]');
  process.exitCode = 1;
} else {
  const showNames = options.length === 1;
  try {
    const report = inspectRepository(folder, showNames);
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length || report.publication.state === 'artifact unavailable') process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ errors: [repositoryErrorReport(error, showNames)] }, null, 2));
    process.exitCode = 1;
  }
}
