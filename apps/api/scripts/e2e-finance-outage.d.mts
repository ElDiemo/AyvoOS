import type { ChildProcess } from 'node:child_process';

export function financeOutageControl(options: {
  start: () => ChildProcess;
  onUnexpectedExit: (code: number | null) => void;
  graceMs?: number;
}): { readonly child: ChildProcess; stop(): void; restart(): void };
