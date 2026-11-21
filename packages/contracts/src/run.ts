export type RunState = 'accepted' | 'running' | 'awaiting_permission' | 'background' | 'failed' | 'indeterminate' | 'verified';

export type FileDigest = { path: string; sha256: string; bytes: number };

export type Receipt = {
  runID: string;
  programSha256: string;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type RunRecord = {
  id: string;
  state: RunState;
  createdAt: number;
  workspace: string;
  mode: string;
  alias?: string;
  sessionID?: string;
  submissionID?: string;
  program?: FileDigest;
  receipt?: Receipt;
  artifact?: FileDigest;
  checkedCells?: number;
  finishedAt?: number;
  retries: number;
  errors: string[];
};
