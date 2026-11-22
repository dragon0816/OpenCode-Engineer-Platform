import { dataDirectory as createDataDirectory } from '../../apps/launcher/src/paths.ts';
import { requireTestDataDir } from '../test-data-guard.ts';

export function dataDirectory() {
  requireTestDataDir();
  return createDataDirectory();
}
