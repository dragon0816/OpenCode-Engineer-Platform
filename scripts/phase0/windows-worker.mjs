import { spawn } from 'node:child_process';
import { writeFileSync, renameSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';

const blocker = createServer();
blocker.listen(0, '127.0.0.1', () => {
  const conflict = createServer();
  conflict.once('error', (error) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    child.once('spawn', () => {
      const result = { worker: process.pid, grandchild: child.pid, conflict: error.code, address: blocker.address().address };
      writeFileSync('ready.tmp', JSON.stringify(result));
      renameSync('ready.tmp', 'ready.json');
    });
    const interval = setInterval(() => {
      if (!existsSync('stop')) return;
      clearInterval(interval);
      blocker.close();
      child.kill();
    }, 100);
  });
  conflict.listen(blocker.address().port, '127.0.0.1');
});
