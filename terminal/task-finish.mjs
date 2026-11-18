// Called inside an interactive Task mode pane. The tmux option survives detaches
// and daemon restarts. Only a matching API receipt permits ending the session.
import { execFileSync } from 'node:child_process';
import { loadStackEnv } from '../hook/stack-post.mjs';

const tmuxEnv = { ...process.env };
delete tmuxEnv.STACK_API;
delete tmuxEnv.STACK_TOKEN;
const tmux = (args) => execFileSync('tmux', args, { env: tmuxEnv, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function taskPane() {
  const pane = process.env.TMUX_PANE || '';
  if (!/^%\d+$/.test(pane) || !process.env.TMUX) return null;
  try {
    const [pid, target, sessionName, id, runtime] = tmux([
      'display-message', '-p', '-t', pane, '#{pid}:#{session_id}:#{session_name}:#{@stack-task-mode}',
    ]).split(':');
    if (!/^\d+$/.test(pid) || !/^\$\d+$/.test(target) || !/^stack-term-[A-Za-z0-9_-]{1,64}$/.test(sessionName)
        || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
        || (runtime !== 'claude' && runtime !== 'codex')) return null;
    return { pid, target, sessionName, id, runtime };
  } catch {
    return null;
  }
}

async function finish() {
  const task = taskPane();
  if (!task) throw Error('Run this command inside a Stack Task mode terminal.');
  const [title, summary] = process.argv.slice(2).map((value) => value.trim());
  if (process.argv.length !== 4 || !title || title.length > 160 || !summary || summary.length > 4000) {
    throw Error('Supply a task title (up to 160 characters) and summary (up to 4000 characters).');
  }
  loadStackEnv();
  const { STACK_API, STACK_TOKEN } = process.env;
  if (!STACK_API || !STACK_TOKEN) throw Error('Stack access is unavailable. The session is still open.');

  const { id, runtime, sessionName, target, pid } = task;
  try {
    const response = await fetch(`${STACK_API.replace(/\/$/, '')}/api/terminal/task-inbox`, {
      method: 'POST',
      headers: { authorization: `Bearer ${STACK_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id, runtime, sessionName, title, summary }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok || (await response.json()).id !== id) throw Error();
  } catch {
    throw Error('Stack could not confirm saving the brief. The session is still open.');
  }

  const current = taskPane();
  if (current?.id !== id || current.pid !== pid || current.target !== target) {
    throw Error('Brief saved. Stack could not confirm the terminal identity for closure.');
  }
  try {
    tmux(['kill-session', '-t', target]);
  } catch {
    throw Error('Brief saved. Stack could not close the terminal.');
  }
}

finish().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
