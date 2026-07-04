import { useState } from 'react';
import { Modal } from './Modal';
import { PRODUCT_NAME } from '../lib/ui';

// The in-app onboarding guide: how to link a machine + any project to Stack,
// and the parallel-lanes playbook for running a team of sessions on one
// project. Commands are stamped with this instance's URL; the token is never
// shown — the reader pastes their own.

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — the text is still selectable */ }
  };
  return (
    <div className="guide-code">
      <pre>{code}</pre>
      <button className="guide-copy" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
    </div>
  );
}

export function ConnectGuide({ onClose }: { onClose: () => void }) {
  const api = window.location.origin;

  return (
    <Modal onClose={onClose} wide>
      <h3>Connect a project</h3>
      <div className="confirm-body" style={{ marginBottom: 20 }}>
        One machine setup, then every repo connects itself: the first checkpoint creates the
        project here automatically. Nothing to register per project.
      </div>

      <div className="guide">
        <div className="guide-step">
          <div className="guide-step-title"><span className="n">1</span> One-time: install the hooks + <span className="mono">/checkpoint</span></div>
          <div className="guide-step-body">From your {PRODUCT_NAME} checkout, on whichever machine runs Claude Code:</div>
          <CodeBlock code={`cd /path/to/stack   # your checkout of this repo
mkdir -p ~/.stack ~/.claude/commands
cp hook/stack-session-start.mjs hook/stack-session-end.mjs \\
   hook/stack-post.mjs hook/stack-checkpoint.mjs ~/.stack/
cp .claude/commands/checkpoint.md ~/.claude/commands/`} />
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">2</span> Secrets — <span className="mono">~/.stack/env</span></div>
          <div className="guide-step-body">
            The token is the same value as the server's <span className="mono">API_TOKEN</span> (what you pasted into the gate). Never commit it.
          </div>
          <CodeBlock code={`cat > ~/.stack/env <<'ENV'
STACK_API=${api}
STACK_TOKEN=paste-your-api-token-here
ENV`} />
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">3</span> Register the hooks in <span className="mono">~/.claude/settings.json</span></div>
          <div className="guide-step-body">Merge this in (SessionStart injects "where you left off"; SessionEnd records the backstop):</div>
          <CodeBlock code={`{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command",
      "command": "node \\"$HOME/.stack/stack-session-start.mjs\\"" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command",
      "command": "node \\"$HOME/.stack/stack-session-end.mjs\\"", "async": true }] }]
  }
}`} />
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">4</span> Per project — just start working</div>
          <div className="guide-step-body">
            Open Claude Code in any repo and do a unit of work. Run <span className="mono">/checkpoint</span> when
            you wrap up — the first one creates the project here, names it from the git remote, and fills the
            resume card. The next session opens already knowing where you left off. Optionally give the
            project's agents the full manual:
          </div>
          <CodeBlock code={`node scripts/stack-context.mjs --slug <project-slug> --api ${api} >> /path/to/project/CLAUDE.md`} />
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">5</span> Verify the round-trip</div>
          <CodeBlock code={`node ~/.stack/stack-checkpoint.mjs --settings     # token + API reachable
node ~/.stack/stack-session-start.mjs --demo      # prints the block Claude will see`} />
        </div>

        <div className="guide-step">
          <div className="guide-step-title"><span className="n">✦</span> Parallel lanes — a team on one project</div>
          <div className="guide-step-body">
            Run several sessions on one project without them tripping over each other: one git worktree
            per lane, one terminal per worktree, one directive per lane. Each session shows up in
            <b> Live now</b> with its branch, and each lane's checkpoints land in Activity under that branch.
          </div>
          <CodeBlock code={`cd /path/to/project
git worktree add ../project-ui  -b lane/ui     # lane 1
git worktree add ../project-api -b lane/api    # lane 2

# terminal 1:  cd ../project-ui  && claude   → "you own the UI lane: <task>"
# terminal 2:  cd ../project-api && claude   → "you own the API lane: <task>"
#   (set each lane's steer in Overview → Directives before starting)

# when both lanes have pushed, a third session plays integrator:
cd /path/to/project && claude
#   → "merge lane/ui and lane/api into main, resolve conflicts, run the build"
git worktree remove ../project-ui ../project-api   # tidy up after the merge`} />
          <div className="guide-step-body">
            Ingest is already safe for this: sessions are idempotent per commit, extractions dedupe by
            fingerprint, and the resume card only takes authored checkpoints — so parallel lanes never
            corrupt each other's state.
          </div>
        </div>
      </div>

      <div className="modal-actions">
        <button className="btn-submit" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
