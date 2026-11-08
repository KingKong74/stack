// Native interactive agents only. No browser-supplied provider or command
// is interpolated into a shell. Each CLI uses its own account/configuration.
// A model name is interpolated into `bash -lc`, so it must be a bare token.
const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function nativeLaunch(cmd, { skipPerms = false, codexModel, claudeModel } = {}) {
  if (cmd === 'claude') {
    // An alias (opus, sonnet, haiku) or a full id; the CLI resolves it against
    // the account. Absent = whatever the CLI defaults to.
    if (claudeModel && !MODEL_RE.test(claudeModel)) throw new Error('Invalid Claude model.');
    return {
      command: `exec claude${skipPerms === true ? ' --dangerously-skip-permissions' : ''}${claudeModel ? ` --model ${claudeModel}` : ''}`,
      tag: 'anthropic:subscription',
    };
  }
  if (cmd === 'codex') {
    if (codexModel && !MODEL_RE.test(codexModel)) throw new Error('Invalid Codex model.');
    return { command: `exec codex --dangerously-bypass-approvals-and-sandbox${codexModel ? ` --model ${codexModel}` : ''}`, tag: `codex:${codexModel || 'native'}` };
  }
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
