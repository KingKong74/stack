// Native interactive agents only. No browser-supplied provider, model or command
// is interpolated into a shell. Each CLI uses its own account/configuration.
export function nativeLaunch(cmd, { skipPerms = false } = {}) {
  if (cmd === 'claude') return {
    command: `exec claude${skipPerms === true ? ' --dangerously-skip-permissions' : ''}`,
    tag: 'anthropic:subscription',
  };
  if (cmd === 'codex') return { command: 'exec codex', tag: 'codex:native' };
  throw new Error('Unknown agent. Choose Claude or Codex.');
}

// Interpret existing tmux tags on the host so reload/adoption never substitutes
// Claude for Codex. Untagged legacy sessions remain unknown.
export function agentForTag(tag) {
  const key = String(tag || '').split(':')[0];
  if (key === 'codex') return 'codex';
  if (key === 'anthropic' || key === 'omniroute') return 'claude';
  return undefined;
}
