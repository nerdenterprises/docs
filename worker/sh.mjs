// One place for "run a native tool and tell me if it worked". Never throws: the
// extraction cascade is built on trying the next thing when a tool is missing or
// chokes on the input.
import { execFile } from 'node:child_process';

export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' }));
  });
}
