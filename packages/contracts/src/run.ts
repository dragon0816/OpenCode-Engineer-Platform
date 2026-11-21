export type RunState = 'accepted' | 'running' | 'awaiting_permission' | 'background' | 'failed' | 'indeterminate' | 'verified' | 'cancelled';

export type FileIdentity = { device: string; inode: string; created: string; modified: string; changed: string; bytes: number; sha256: string };
export type FileDigest = { path: string; sha256: string; bytes: number; identity?: FileIdentity };

export type ModelCall = {
  request: number;
  status: number;
  upstreamStatus: number | null;
  elapsedMs: number;
  error?: 'cancelled' | 'timeout' | 'transport' | 'invalid-completion';
  output?: 'text' | 'tool' | 'empty';
  finishReason?: string;
  tokens?: { prompt: number; completion: number; total: number };
};

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
  generatedProgram?: FileDigest;
  program?: FileDigest;
  receipt?: Receipt;
  artifact?: FileDigest;
  checkedCells?: number;
  finishedAt?: number;
  modelRequestRange?: { after: number; through: number };
  modelCalls?: ModelCall[];
  retries: number;
  errors: string[];
};
