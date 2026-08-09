// THE INSTRUCTIONS TREE's parser — the CLAUDE.md file, read as rules.
//
// **The markdown IS the truth, and everything the Instructions tab shows is
// derived from it.** Sections, rules, a rule's scope, whether it is switched
// off, whether it declares an override, the merge preview and the token
// estimate are all computed here, and none of them is stored anywhere. That is
// deliberate and it is the same rule as a feature's STAGE or a branch's merge
// state (`lib/feature.ts`, `lib/branch.ts`): a rules table beside the file
// would be a second truth, and it would be wrong the moment somebody edits the
// file on disk — which they will, because the file is what Claude reads and a
// repo is a place people type in.
//
// So the annotations live IN the file, as HTML comments on the line above the
// rule they annotate:
//
//     <!-- stack: off -->
//     <!-- stack: scope=api/** -->
//     <!-- stack: overrides -->
//     <!-- stack: off scope=api/** overrides -->
//
// HTML comments because markdown swallows them and Claude reading the file
// gets the rule without the bookkeeping. A rule with no comment above it is on,
// unscoped and claims nothing — the shape of every CLAUDE.md ever hand-written,
// which is what lets this parse somebody else's file on the first read.
//
// Three things worth knowing before editing this:
//
//  1. **A rule is a BLOCK of lines, and every edit splices by line range.**
//     Not a re-render. Re-rendering the file from the parse would quietly drop
//     everything the parse does not model — code fences, tables, links, the
//     spacing somebody chose — and this file is somebody's writing, not a
//     record. Anything unrecognised survives an edit untouched because nothing
//     ever rewrites the lines it did not target.
//
//  2. **A paragraph is a rule too.** Plenty of real CLAUDE.md files state a
//     rule as prose under a heading rather than as a bullet, and a parser that
//     only saw bullets would show those files as empty — the worst possible
//     first impression, because it reads as "Stack cannot see your rules".
//
//  3. **`overrides` is DECLARED, never inferred.** Two rules in one section
//     across two files are not necessarily in conflict, and guessing produces
//     a chip that is wrong often enough to be ignored. The owner (or the
//     Scribe, proposing) says so. Undeclared conflicts are what the Gemini
//     contradictions pass is for.

export type Rule = {
  /** Index into the file's flat rule list — the handle every edit takes. */
  index: number;
  section: string;
  /** The rule as prose: bullet marker stripped, continuations folded in. */
  text: string;
  on: boolean;
  /** A glob, or '' for "wherever this file reaches". */
  scope: string;
  overrides: boolean;
  /** An ESTIMATE (chars/4). Labelled as one everywhere it is shown. */
  tokens: number;
  /** Was this rule written as a `-` bullet, or as a paragraph? */
  bullet: boolean;
  /** Line range in the raw file, [start, end) — including its annotation. */
  from: number;
  to: number;
};

export type Section = { name: string; rules: Rule[] };

export type Parsed = {
  title: string;
  sections: Section[];
  rules: Rule[];
};

const ANNOTATION = /^\s*<!--\s*stack:\s*(.*?)\s*-->\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/** The marker the HOST writes into a file Stack manages. Never in `body`. */
export const MANAGED_MARKER = '<!-- stack-managed -->';

/** chars/4. An estimate, and every surface that prints it says so. */
export const estimateTokens = (text: string): number =>
  Math.max(0, Math.round(String(text || '').trim().length / 4));

type Annotation = { on: boolean; scope: string; overrides: boolean };
const NO_ANNOTATION: Annotation = { on: true, scope: '', overrides: false };

// `off scope=api/** overrides` — order-free, unknown words ignored. A scope
// may not contain whitespace (it is a glob, and the writer's spacing is not
// ours to guess at), so splitting on whitespace is safe.
function readAnnotation(inner: string): Annotation {
  const out: Annotation = { ...NO_ANNOTATION };
  for (const word of String(inner || '').split(/\s+/).filter(Boolean)) {
    if (word === 'off') out.on = false;
    else if (word === 'on') out.on = true;
    else if (word === 'overrides') out.overrides = true;
    else if (word.startsWith('scope=')) out.scope = word.slice(6);
  }
  return out;
}

function writeAnnotation(a: Annotation): string {
  const words: string[] = [];
  if (!a.on) words.push('off');
  if (a.scope) words.push(`scope=${a.scope}`);
  if (a.overrides) words.push('overrides');
  return words.length ? `<!-- stack: ${words.join(' ')} -->` : '';
}

const isBlank = (line: string) => !line.trim();

/**
 * Parse a CLAUDE.md into sections and rules. Never throws: a file that is not
 * shaped like this comes back with whatever rules could be found, because the
 * Raw view is right there and an editor that refuses to open a file is worse
 * than one that shows an incomplete outline of it.
 */
export function parseInstructions(body: string): Parsed {
  const lines = String(body ?? '').split('\n');
  const rules: Rule[] = [];
  const order: string[] = [];
  const bySection = new Map<string, Rule[]>();
  let title = '';
  let section = '';
  let pending: Annotation | null = null;
  let pendingAt = -1;
  let i = 0;

  const push = (rule: Rule) => {
    rules.push(rule);
    if (!bySection.has(rule.section)) { bySection.set(rule.section, []); order.push(rule.section); }
    bySection.get(rule.section)!.push(rule);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) { i++; continue; }

    const ann = line.match(ANNOTATION);
    if (ann) {
      pending = readAnnotation(ann[1]);
      pendingAt = i;
      i++;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      // `#` is the file's title; `##` and deeper name a section. A file with no
      // `##` at all keeps section '' and still lists its rules — the outline
      // just has one unnamed group, which is the honest rendering of a file
      // that never grouped anything.
      if (heading[1].length === 1 && !title) title = heading[2].trim();
      else section = heading[2].trim();
      pending = null;
      i++;
      continue;
    }

    // A block: this line plus everything that continues it. A bullet continues
    // through indented lines; a paragraph continues through plain ones. Both
    // swallow a fenced block whole, so a code sample inside a rule never reads
    // as the start of a new one.
    const start = i;
    const bullet = BULLET.test(line);
    let fence = '';
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (fence) {
        if (next.trim().startsWith(fence)) fence = '';
        i++;
        continue;
      }
      const opening = next.match(FENCE);
      if (opening) { fence = opening[1]; i++; continue; }
      if (isBlank(next) || HEADING.test(next) || ANNOTATION.test(next)) break;
      // A new bullet ends the previous block; an indented line continues it.
      if (BULLET.test(next) && !/^\s\s+/.test(next)) break;
      if (bullet && !/^\s+/.test(next) && BULLET.test(next)) break;
      i++;
    }

    const raw = lines.slice(start, i);
    const text = raw
      .map((l, n) => (n === 0 && bullet ? l.replace(BULLET, '$1') : l.trim()))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text) {
      const a = pending ?? NO_ANNOTATION;
      push({
        index: rules.length,
        section,
        text,
        on: a.on,
        scope: a.scope,
        overrides: a.overrides,
        tokens: estimateTokens(text),
        bullet,
        from: pending ? pendingAt : start,
        to: i,
      });
    }
    pending = null;
  }

  return { title, sections: order.map((name) => ({ name, rules: bySection.get(name)! })), rules };
}

// ---------------------------------------------------------------------------
// Edits. Each takes a body and returns a body, splicing only the lines it owns.
// ---------------------------------------------------------------------------

/** Rewrite one rule's annotation line, inserting or removing it as needed. */
export function setRuleFlags(
  body: string,
  index: number,
  patch: Partial<Pick<Rule, 'on' | 'scope' | 'overrides'>>,
): string {
  const parsed = parseInstructions(body);
  const rule = parsed.rules[index];
  if (!rule) return body;
  const lines = String(body ?? '').split('\n');
  const next: Annotation = {
    on: patch.on ?? rule.on,
    scope: patch.scope ?? rule.scope,
    overrides: patch.overrides ?? rule.overrides,
  };
  const comment = writeAnnotation(next);
  // The rule's own first line — `from` points at the annotation when there is
  // one, so the body starts one line later in that case.
  const hadAnnotation = ANNOTATION.test(lines[rule.from] ?? '');
  const bodyStart = hadAnnotation ? rule.from + 1 : rule.from;
  const before = lines.slice(0, rule.from);
  const after = lines.slice(bodyStart);
  return [...before, ...(comment ? [comment] : []), ...after].join('\n');
}

/** Move a rule within its section. Out-of-section targets are refused. */
export function moveRule(body: string, from: number, to: number): string {
  const parsed = parseInstructions(body);
  const a = parsed.rules[from];
  const b = parsed.rules[to];
  if (!a || !b || a === b || a.section !== b.section) return body;
  const lines = String(body ?? '').split('\n');
  const block = lines.slice(a.from, a.to);
  const without = [...lines.slice(0, a.from), ...lines.slice(a.to)];
  // The target's position shifts when the removed block sat above it.
  const shift = a.from < b.from ? a.to - a.from : 0;
  const at = (from < to ? b.to : b.from) - shift;
  return [...without.slice(0, at), ...block, ...without.slice(at)].join('\n');
}

export function removeRule(body: string, index: number): string {
  const parsed = parseInstructions(body);
  const rule = parsed.rules[index];
  if (!rule) return body;
  const lines = String(body ?? '').split('\n');
  return [...lines.slice(0, rule.from), ...lines.slice(rule.to)].join('\n');
}

/**
 * Append a rule to a section, creating the heading when the section is new.
 * Always a bullet: a rule somebody typed into a one-line box is a bullet, and
 * guessing prose from a short string produces a file that reads as a mess.
 */
export function addRule(body: string, section: string, text: string): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return body;
  const name = String(section ?? '').trim();
  const parsed = parseInstructions(body);
  const lines = String(body ?? '').split('\n');
  const target = parsed.sections.find((s) => s.name === name);
  if (!target || !target.rules.length) {
    const heading = name ? [``, `## ${name}`, ``] : [``];
    return [...lines, ...heading, `- ${clean}`].join('\n');
  }
  const last = target.rules[target.rules.length - 1];
  return [...lines.slice(0, last.to), `- ${clean}`, ...lines.slice(last.to)].join('\n');
}

// ---------------------------------------------------------------------------
// The merge preview — "what Claude actually sees".
// ---------------------------------------------------------------------------

export type MergeFile = { label: string; body: string };
export type MergeLine = { src: string; line: string };

/**
 * The assembled context for an edit, in PRECEDENCE ORDER (weakest first — the
 * personal file, then the project root, then the nested files), with switched-
 * off rules dropped. Off rules are dropped because that is what "off" means:
 * a preview that still showed them would answer a different question from the
 * one the view's title asks.
 */
export function mergeContext(files: MergeFile[]): MergeLine[] {
  const out: MergeLine[] = [];
  for (const file of files) {
    const parsed = parseInstructions(file.body);
    const live = parsed.rules.filter((r) => r.on);
    if (!live.length) continue;
    if (out.length) out.push({ src: '', line: '' });
    out.push({ src: file.label, line: `# ${parsed.title || file.label}` });
    let section = '';
    for (const rule of live) {
      if (rule.section && rule.section !== section) {
        section = rule.section;
        out.push({ src: file.label, line: `## ${section}` });
      }
      out.push({
        src: file.label,
        line: rule.text + (rule.overrides ? '   ← overrides' : ''),
      });
    }
  }
  return out;
}

/** What the merged context costs, as an estimate. */
export const mergeTokens = (files: MergeFile[]): number =>
  mergeContext(files).reduce((n, l) => n + estimateTokens(l.line), 0);

// ---------------------------------------------------------------------------
// Shapes the screen reads off a file without re-parsing it three times.
// ---------------------------------------------------------------------------

export type FileStats = { rules: number; on: number; overrides: number; tokens: number };

export function fileStats(body: string): FileStats {
  const { rules } = parseInstructions(body);
  return {
    rules: rules.length,
    on: rules.filter((r) => r.on).length,
    overrides: rules.filter((r) => r.overrides).length,
    tokens: rules.filter((r) => r.on).reduce((n, r) => n + r.tokens, 0),
  };
}

/**
 * Precedence: the personal file first (weakest), the repo root next, then
 * nested files deepest-last. Claude Code resolves the closest file to the edit
 * last, so "last wins" — and the Precedence card on screen numbers them the
 * other way up, strongest first, because that is the order a human asks the
 * question in ("which file wins?").
 */
export const precedenceRank = (scope: string, dir: string): number => {
  if (scope === 'global') return 0;
  if (!dir) return 1;
  return 2 + dir.split('/').filter(Boolean).length;
};
