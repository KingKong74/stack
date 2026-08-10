// #380 — THE CONSOLE PRIME: the briefing a tab agent's live session is spawned
// with, and the launcher that gets it to the CLI.
//
//   node server/test/console-prime.test.mjs      # exits non-zero on any failure
//
// No database and no framework. Two pure things are pinned here, and they are
// the two that can silently lie to an agent:
//
//   • consolePrime() — the identity is always there, the snapshot always says
//     it is a snapshot, an empty section reads as "nothing" rather than being
//     dropped, and a cut briefing SAYS it was cut (#239). An agent that was
//     handed half a board and told nothing reasons confidently about the half.
//   • launchScript() — the prompt reaches claude through `$(cat …)` and never
//     through a command line, so quotes and apostrophes in a north star cannot
//     change the command; and the only two interpolated values are a path this
//     code composed and a model matched against an allow-list.
import { consolePrime, PRIME_CAP } from '../src/console-prime.js';
import { launchScript, shQuote } from '../../terminal/console-launch.mjs';

let fails = 0;
const check = (label, ok) => {
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
};

const AGENT = {
  key: 'auditor', name: 'Auditor', tabLabel: 'Quality', surface: 'tab',
  remit: "the Quality tab: the project's checks, its tracked bugs and the live application",
};
const PROJECT = { slug: 'stack', name: 'Stack', id: 1 };

// ---- the briefing ---------------------------------------------------------
const plain = consolePrime({
  agent: AGENT, guidance: '', project: PROJECT,
  sections: [{ title: 'CHECKS — 12 in the suite, 3 failing', lines: ['a: boom', 'b: boom'] }],
});
check('names the agent', plain.includes('You are Auditor'));
check('names the surface it was opened from', plain.includes('Quality tab of "Stack"'));
check('carries the remit verbatim', plain.includes(AGENT.remit));
check('says the state is a snapshot', /SNAPSHOT/.test(plain));
check('renders the section lines', plain.includes('  - a: boom'));
check('no guidance block when there is no guidance', !plain.includes('STANDING GUIDANCE'));

const steered = consolePrime({
  agent: AGENT, guidance: 'Never file a bug without a repro.', project: PROJECT, sections: [],
});
check('the owner\'s standing guidance is included', steered.includes('Never file a bug without a repro.'));
check('guidance is labelled as the owner\'s', steered.includes('STANDING GUIDANCE FROM THE OWNER'));

// An empty section is a real answer and must READ as one. Dropping it would
// make "there are no failing checks" indistinguishable from "the failing checks
// were not shown to you" — the same NULL-verdict rule the rest of Stack keeps.
const empty = consolePrime({
  agent: AGENT, guidance: '', project: PROJECT,
  sections: [{ title: 'OPEN BUGS — 0', lines: [] }],
});
check('an empty section renders as nothing-here, not as absent', empty.includes('nothing here right now'));
check('an empty section keeps its title', empty.includes('OPEN BUGS — 0'));

// A capped list says what it left out, on the axis it cut.
const noted = consolePrime({
  agent: AGENT, guidance: '', project: PROJECT,
  sections: [{ title: 'OPEN BUGS — 40', lines: ['BUG-1 x'], note: 'showing 1 of 40 open bugs' }],
});
check('a section note is rendered', noted.includes('(showing 1 of 40 open bugs)'));

// …and so does the whole briefing.
const huge = consolePrime({
  agent: AGENT, guidance: '', project: PROJECT,
  sections: [{ title: 'THE BOARD', lines: Array.from({ length: 400 }, (_, i) => `#${i} an item with a reasonably long title`) }],
});
check('an over-long briefing is cut', huge.length <= PRIME_CAP + 200);
check('and says so, and on which end', huge.includes('was cut at') && huge.includes('TAIL'));

// ---- the launcher ---------------------------------------------------------
const script = launchScript({ promptPath: '/home/me/.stack/console/stack-term-auditor-stack.md' });
check('the prompt is read from the file, never inlined', script.includes('--append-system-prompt "$(cat '));
check('APPENDS rather than replacing the CLI\'s own prompt', !script.includes('--system-prompt "'));
check('no permission flag unless asked', !script.includes('--dangerously-skip-permissions'));
check('no model flag unless pinned', !script.includes('--model'));

const armed = launchScript({ promptPath: '/tmp/p.md', skipPerms: true, model: 'sonnet' });
check('skipPerms maps to the one allow-listed flag', armed.includes('--dangerously-skip-permissions'));
check('a pinned model is passed', armed.includes("--model 'sonnet'"));

// The allow-list is the whole defence for the one value that comes from a
// database column: a model with a space in it is a second command.
const dodgy = launchScript({ promptPath: '/tmp/p.md', model: 'sonnet; rm -rf ~' });
check('a model that is not an alias is dropped, not quoted', !dodgy.includes('--model'));

check('single quotes in a path are escaped, not closed', shQuote("/tmp/it's/p.md") === `'/tmp/it'\\''s/p.md'`);

console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
