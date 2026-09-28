// The brief a board card hands a NEW claude session as its first prompt (#525).
//
// The board's ⌨ Run in terminal is one click: it claims the card, opens a claude
// tab in the project, and that tab starts working the item without anybody
// pasting anything. The only way to give claude a first prompt that it acts on
// is its positional argument, and the only way to get untrusted text there
// safely is to never put the text on a command line at all. So the brief is
// written to a file and the command reads it back with `$(cat …)`.
//
// The rules, and why each one:
//
//  • THE TEXT NEVER TOUCHES A COMMAND LINE. The spawn string passes through
//    two shells (tmux runs it with `sh -c`, and it is itself `/bin/bash -lc
//    "…"`), and a brief is a card title somebody typed. `briefArg` escapes the
//    `$` so the OUTER shell leaves the substitution alone and bash expands it
//    inside double quotes, where the result is one word and is never re-parsed.
//    The only thing interpolated is the path, and the path is built here from
//    a name `validName` already vouched for.
//  • ONLY A SESSION BEING CREATED GETS ONE. The start frame is re-sent on every
//    reconnect, and `new-session -A` ignores its command when the session
//    already exists, so a re-attach cannot fire a brief twice. The daemon asks
//    before it writes, and a brief is never written for a re-attach.
//  • THE FILE REMOVES ITSELF. The same substitution that reads it deletes it
//    (`cat f; rm -f f`), so a spawn that got as far as claude leaves nothing
//    behind. `pruneBriefs` takes whatever a spawn that never ran left over,
//    and like the drops pruner it only ever touches plain files in its own
//    directory. Pruning deletes, so it fails safe.
//  • 0600. The directory is Stack's own, but a brief can quote a card's note,
//    which is the owner's text and nobody else's business on a shared host.
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Card title + note + the instructions around them. Far above any real brief,
// far below anything that would trouble argv's limit once expanded.
export const BRIEF_MAX_CHARS = 8000;

// An hour: a spawn that has not consumed its brief by then never will.
export const BRIEF_KEEP_MS = 60 * 60 * 1000;

// A function, not a constant, so a test can point $HOME somewhere else first.
export function briefsDir() {
  return join(homedir(), '.stack', 'briefs');
}

// The path is the ONE thing interpolated into the command, so it must not be
// able to close the single quotes around it. `name` is already `validName`'s
// `stack-[A-Za-z0-9_-]+`; this refuses anything else rather than trusting that.
export function briefPath(name, dir = briefsDir()) {
  if (!/^stack-[A-Za-z0-9_-]{1,64}$/.test(String(name || ''))) return null;
  const p = join(dir, `${name}.md`);
  return /['"\\$`]/.test(p) ? null : p;
}

/** Write the brief for a session about to be created. Returns the path, or
 *  null when there is nothing (or nothing safe) to write. */
export function writeBrief(name, text, dir = briefsDir()) {
  const body = String(text || '').trim().slice(0, BRIEF_MAX_CHARS);
  const p = briefPath(name, dir);
  if (!body || !p) return null;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(p, body, { mode: 0o600 });
  chmodSync(p, 0o600); // an existing file keeps its old mode through writeFileSync
  return p;
}

/** The claude argument that reads the brief and deletes it, spelled for the
 *  inside of the daemon's `/bin/bash -lc "…"`. See the header for the `\$`. */
export function briefArg(path) {
  return ` \\"\\$(cat '${path}'; rm -f '${path}')\\"`;
}

/** Remove briefs no spawn consumed. Plain files older than `keepMs` only. */
export function pruneBriefs({ dir = briefsDir(), keepMs = BRIEF_KEEP_MS, now = Date.now() } = {}) {
  if (!existsSync(dir)) return 0;
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const f of names) {
    const p = join(dir, f);
    try {
      const st = statSync(p);
      if (st.isFile() && now - st.mtimeMs > keepMs) { unlinkSync(p); n++; }
    } catch { /* could not stat: leave it */ }
  }
  return n;
}
