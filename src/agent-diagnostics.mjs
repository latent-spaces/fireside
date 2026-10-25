import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { firesideDir } from './paths.ts';
import { rotate } from './log.mjs';

// Low-volume lifecycle data only. Never persist prompts, tool output, raw ACP
// packets, stderr, headers, or arbitrary provider error messages here.
const active = new Map();
const warned = new Set();
export function activeTurns(root, agent) {
  return [...active.values()].filter(turn => turn.root === root && (!agent || turn.agent === agent)).length;
}
export function startTurn(root, agent, key) { active.set(key, { root, agent }); }
export function endTurn(key) { active.delete(key); }

export function errorSignal(error) {
  const message = typeof error === 'string' ? error : String(error?.message || '');
  const status = message.match(/(?:last status:|HTTP(?: status)?[:=]?|status[=:])\s*([45]\d{2})\b/i);
  const details = error?.codexErrorInfo;
  const structured = details && typeof details === 'object'
    ? Object.values(details).find(value => value && typeof value === 'object' && Number.isInteger(value.httpStatusCode))?.httpStatusCode : null;
  return {
    ...(status || structured ? { httpStatus: status ? Number(status[1]) : structured } : {}),
    retryLimitReported: /exceeded retry limit/i.test(message),
    errorFingerprint: createHash('sha256').update(message).digest('hex').slice(0, 16),
  };
}

export function agentEvent(root, event, fields = {}) {
  try {
    const file = path.join(firesideDir(root), 'agent-events.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotate(file);
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, serverPid: process.pid, ...fields }) + '\n', { mode: 0o600 });
  } catch {
    // Monitoring must never block delivery or replay a prompt after a log failure.
    if (!warned.has(root)) { warned.add(root); console.warn('Cannot write agent diagnostics; chat delivery is unaffected.'); }
  }
}
