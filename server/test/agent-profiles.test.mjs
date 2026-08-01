// The agent spawn-and-customisation engine, tested pure — no database, no
// server, no external process.
//
//   node server/test/agent-profiles.test.mjs      # exits non-zero on any failure
//
// server/src/agents.js is the pure core: unit 2 (routes) and unit 3 (the
// runner) both build on it, and this is the one place a wrong answer is
// silent by construction — a bad fallback here means a spawn quietly runs
// with no building agent at all.
import {
  KNOWN_TOOLS, BUILTIN_PROFILES, normaliseProfile, composeAgents, resolveSpawn, mergeProfiles,
} from '../src/agents.js';

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : `  (want ${JSON.stringify(want)})`}`);
};
const checkThrows = (label, fn, messageIncludes) => {
  try {
    fn();
    fails++;
    console.log(`FAIL  ${label}: did not throw`);
  } catch (e) {
    const ok = !messageIncludes || e.message.includes(messageIncludes);
    if (!ok) fails++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: threw "${e.message}"${ok ? '' : `  (want to include "${messageIncludes}")`}`);
  }
};

console.log('--- builtins ---');
const executorBuiltin = BUILTIN_PROFILES.find((p) => p.key === 'executor');
const reviewerBuiltin = BUILTIN_PROFILES.find((p) => p.key === 'reviewer');
check('two builtins', BUILTIN_PROFILES.length, 2);
check('executor description matches stack-autopilot.mjs',
  executorBuiltin.description.includes('Delegate each commit-sized unit of work'), true);
check('executor prompt matches stack-autopilot.mjs',
  executorBuiltin.prompt.includes('Do exactly what you are asked and nothing more'), true);
check('executor has the full building set', executorBuiltin.tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
check('reviewer has no Edit/Write', reviewerBuiltin.tools.includes('Edit') || reviewerBuiltin.tools.includes('Write'), false);
check('reviewer prompt says it never edits', reviewerBuiltin.prompt.toLowerCase().includes('do not'), true);

const nExecutor = normaliseProfile(executorBuiltin);
const nReviewer = normaliseProfile(reviewerBuiltin);
check('executor builtin normalises cleanly', nExecutor.key, 'executor');
check('reviewer builtin normalises cleanly', nReviewer.key, 'reviewer');

console.log('\n--- normaliseProfile: rejections ---');
checkThrows('missing prompt', () => normaliseProfile({ key: 'foo' }), 'prompt');
checkThrows('key with a space', () => normaliseProfile({ key: 'fo o', prompt: 'x' }), 'key');
checkThrows('leading digit key', () => normaliseProfile({ key: '1foo', prompt: 'x' }), 'key');
checkThrows('one-char key', () => normaliseProfile({ key: 'a', prompt: 'x' }), 'key');
checkThrows('unknown tool names it', () => normaliseProfile({ key: 'foo', prompt: 'x', tools: ['Frobnicate'] }), 'unknown tool "Frobnicate"');
checkThrows('empty tools array', () => normaliseProfile({ key: 'foo', prompt: 'x', tools: [] }), 'at least one tool');

console.log('\n--- normaliseProfile: defaults ---');
const withDefaults = normaliseProfile({ key: 'planner', prompt: 'plan things' });
check('name defaults to key', withDefaults.name, 'planner');
check('description defaults to empty', withDefaults.description, '');
check('model defaults to empty', withDefaults.model, '');
check('enabled defaults to true', withDefaults.enabled, true);
check('tools default to the building set', withDefaults.tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);

const withDupeTools = normaliseProfile({ key: 'custom', prompt: 'x', tools: ['Bash', 'Read', 'Bash', 'WebFetch'] });
check('tools dedupe and follow KNOWN_TOOLS order', withDupeTools.tools, ['Read', 'Bash', 'WebFetch']);

const withKnownTools = normaliseProfile({ key: 'custom2', prompt: 'x', tools: KNOWN_TOOLS });
check('every known tool accepted', withKnownTools.tools, [...KNOWN_TOOLS]);

check('key is lowercased and trimmed', normaliseProfile({ key: '  Ab-Cd  ', prompt: 'x' }).key, 'ab-cd');
check('unknown input keys ignored, not an error', normaliseProfile({ key: 'ok', prompt: 'x', bogus: 1 }).key, 'ok');

console.log('\n--- composeAgents ---');
const profA = { key: 'a', description: 'desc a', prompt: 'prompt a', model: 'opus', tools: ['Read'], enabled: true };
const profB = { key: 'b', description: 'desc b', prompt: 'prompt b', model: '', tools: ['Bash'], enabled: true };
const profC = { key: 'c', description: 'desc c', prompt: 'prompt c', model: '', tools: ['Bash'], enabled: false };

check('profile model wins over executorModel', composeAgents([profA], { executorModel: 'sonnet' }).a.model, 'opus');
check('empty profile model inherits executorModel', composeAgents([profB], { executorModel: 'sonnet' }).b.model, 'sonnet');
check('both empty -> model is undefined', 'model' in composeAgents([profB], {}) ? composeAgents([profB], {}).b.model : undefined, undefined);
check('disabled profile absent from output', Object.keys(composeAgents([profA, profC], {})), ['a']);
check('empty list -> {}', composeAgents([], {}), {});
check('nullish list -> {}', composeAgents(null, {}), {});

console.log('\n--- resolveSpawn: fallback paths ---');
const emptyList = resolveSpawn({ profiles: [], executorModel: '' });
check('empty list falls back', emptyList.fallback, true);
check('empty list keeps the built-in executor', emptyList.keys, ['executor']);
check('empty list agents include executor', Object.keys(emptyList.agents), ['executor']);

const allDisabled = resolveSpawn({ profiles: [{ ...nExecutor, enabled: false }, { ...nReviewer, enabled: false }] });
check('all disabled falls back', allDisabled.fallback, true);
check('all disabled keeps executor', allDisabled.keys, ['executor']);

const unknownRequested = resolveSpawn({ profiles: [nExecutor, nReviewer], requested: 'ghost' });
check('unknown requested key falls back', unknownRequested.fallback, true);
check('unknown requested key keeps executor', unknownRequested.keys, ['executor']);

console.log('\n--- resolveSpawn: valid request ---');
const withRequest = resolveSpawn({ profiles: [nExecutor, nReviewer], requested: 'reviewer', executorModel: 'sonnet' });
check('valid request not a fallback', withRequest.fallback, false);
check('valid request yields requested key + executor', withRequest.keys, ['executor', 'reviewer']);
check('valid request keys sorted', withRequest.keys, [...withRequest.keys].sort());
check('valid request agents include both', Object.keys(withRequest.agents).sort(), ['executor', 'reviewer']);
check('reason mentions the requested profile', withRequest.reason.includes('reviewer'), true);

const noRequest = resolveSpawn({ profiles: [nExecutor, nReviewer], executorModel: 'sonnet' });
check('no request defaults to executor only', noRequest.keys, ['executor']);
check('no request is not a fallback', noRequest.fallback, false);

console.log('\n--- mergeProfiles ---');
const storedExecutorOverride = { key: 'executor', name: 'Executor (custom)', description: 'd', prompt: 'p', model: 'haiku', tools: ['Bash'], enabled: true, builtin: false };
const storedNew = { key: 'planner', name: 'Planner', description: 'd', prompt: 'p', model: '', tools: ['Read'], enabled: true, builtin: false };
const inputArr = [storedExecutorOverride, storedNew];
const inputSnapshot = JSON.stringify(inputArr);
const merged = mergeProfiles(inputArr);
const mergedByKey = Object.fromEntries(merged.map((p) => [p.key, p]));
check('stored executor overrides the builtin fields', mergedByKey.executor.model, 'haiku');
check('stored executor override stays builtin:true', mergedByKey.executor.builtin, true);
check('a new key is added', mergedByKey.planner.name, 'Planner');
check('new key stays builtin:false', mergedByKey.planner.builtin, false);
check('reviewer builtin still present unshadowed', mergedByKey.reviewer.builtin, true);
check('result sorted by key', merged.map((p) => p.key), [...merged.map((p) => p.key)].sort());
check('input array not mutated', JSON.stringify(inputArr), inputSnapshot);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
