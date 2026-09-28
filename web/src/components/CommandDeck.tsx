import { useState } from 'react';
import type { Overview } from '../types';
import { go } from '../lib/route';
import { getProjectDetail } from '../store';
import { ExportBriefModal } from './ExportBriefModal';
import { ResumeSinceStrip } from './ResumeSinceStrip';
import { KitIcon } from '../detail/kit/KitIcon';

// "Pick up where you left off" — THE CONTINUE BOARD, drawn in the shape
// For-you's working-copy card gave it (`detail/ForYouMock.tsx`'s `WorkingCopy`,
// ported from the console kit). It shares that card's CLASSES — `.fy-wc*`, and
// the `.fy-*` helpers under them — rather than a look-alike of its own, which
// is the whole point of the resemblance: two spellings of one card drift, and
// the mockup is where the design is decided. If the For-you screen is ever
// culled, those rules stay: styles.css's block says so on its face.
//
// WHAT THE SHAPE COST, AND WHAT IT DIDN'T. The kit's card is a working copy —
// per-file diff bars, staged/unstaged, the branch's commits, its checks. Stack
// keeps NONE of that: a push is one checkpoint, not a git status, so inventing
// a file list here would be the kit's sample rows wearing this project's name.
// What goes in each slot instead is the resume card's own content, and the
// mapping is one-for-one:
//
//   the kit's ...          →  here
//   branch + ago              the checkpoint's branch and when it was written
//   the file list             "Currently in progress" — what is mid-flight
//   the folded grid           "Suggested next" | "Working well — keep"
//   the last commit line      what the fold is hiding, counted
//
// THE FOLD IS THE ONLY STATE and it persists nothing — the same rule the kit's
// card follows. Leaving the dashboard is the undo.
export function ResumeHero({ resume, keepResumeCard }: {
  resume: Overview['resume']; keepResumeCard: boolean;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  const [open, setOpen] = useState(false);
  if (!keepResumeCard) return null;

  const loadHeroInput = async () => {
    const d = await getProjectDetail(resume!.slug);
    return { project: d.project, currentPhase: d.currentPhase, blockers: d.blockers,
      directives: d.directives, activity: d.activity, bugs: d.bugs, roadmap: d.roadmap };
  };

  if (!resume) {
    return (
      <section className="fy-wc resume-wc empty">
        <header className="fy-wc-head">
          <span className="fy-caret" aria-hidden="true">▸</span>
          <div className="fy-wc-titles">
            <span className="fy-eyebrow accent">Where you left off</span>
            <span className="t">Nothing on the go yet</span>
          </div>
        </header>
        <div className="fy-wc-body">
          <span className="rwc-sum">
            Start a project or land a push and your resume point lands here — the checkpoint's own
            summary, what is mid-flight, and what it suggested doing next.
          </span>
        </div>
      </section>
    );
  }

  // The card's CONTENT time, not the last push's — ResumeSinceStrip says why
  // those are different, and shows the gap when there is one.
  const ago = resume.since?.authoredWhen || resume.when;
  const branch = resume.since?.branch || '';
  const hidden = resume.nextUp.length + resume.workingWell.length;

  return (
    <>
      <section className="fy-wc resume-wc">
        {/* The kit's head is the fold's handle. It carries real buttons, so
            every one of them stops the click from reaching the header — and
            the header answers the keyboard, since a div that only takes a
            mouse is a control half the room cannot use. */}
        <header className="fy-wc-head" role="button" tabIndex={0}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); }
          }}>
          <span className="fy-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <div className="fy-wc-titles">
            <span className="fy-eyebrow accent">Where you left off{ago ? ` · ${ago}` : ''}</span>
            <span className="t">{resume.name}</span>
          </div>
          <span className="fy-wc-right">
            {resume.currentPhase && <span className="k-tag">{resume.currentPhase}</span>}
            {branch && (
              <span className="fy-branch"><KitIcon name="git-branch" size={13} />{branch}</span>
            )}
            <button className="k-btn ghost sm"
              onClick={(e) => { e.stopPropagation(); setExportOpen(true); }}
              title="Download a markdown brief for starting back into this project">
              <KitIcon name="file-text" size={14} />Brief
            </button>
            <button className="k-btn secondary sm"
              onClick={(e) => { e.stopPropagation(); go.terminal(resume.slug, undefined, true); }}
              title="Open a Claude session in this project with a debrief of where things stand">
              <KitIcon name="terminal" size={14} />Jump back in
            </button>
            <button className="k-btn accent sm"
              onClick={(e) => { e.stopPropagation(); go.detail(resume.slug); }}>
              <KitIcon name="code" size={14} />Continue
            </button>
          </span>
        </header>

        <div className="fy-wc-body">
          <div className="fy-wc-meta">
            <span className="k-tag mono">{resume.slug}</span>
            {resume.when && <span className="fy-dim">last session {resume.when}</span>}
          </div>

          <ResumeSinceStrip since={resume.since} slug={resume.slug} />
          {/* CLAMPED WHILE THE CARD IS SHUT, and this is what the fold is FOR.
              A /checkpoint summary is a paragraph, not a commit subject — the
              kit's one-line `fy-wc-last` slot had no idea — and left loose it
              pushed the projects grid, the queue and everything under it off
              the first screen. Shut: the opening lines. Open: all of it. */}
          {resume.summary && (
            <span className={`rwc-sum${open ? '' : ' clamp'}`}>{resume.summary}</span>
          )}

          <ResumeList label="Currently in progress" mark="dot"
            items={resume.inProgress} empty="Nothing mid-flight." />

          {open ? (
            <div className="fy-wc-grid">
              <div className="fy-col">
                <ResumeList label="Suggested next" mark="arrow"
                  items={resume.nextUp} empty="Open road." />
              </div>
              <div className="fy-col">
                <ResumeList label="Working well — keep" mark="tick"
                  items={resume.workingWell} empty="—" />
              </div>
            </div>
          ) : (
            <span className="fy-wc-last">
              {hidden
                ? `${resume.nextUp.length} suggested next · ${resume.workingWell.length} working well — open for those and the full checkpoint`
                : 'This checkpoint left no next steps.'}
            </span>
          )}
        </div>
      </section>
      {exportOpen && (
        <ExportBriefModal projectName={resume.name} loadInput={loadHeroInput}
          onClose={() => setExportOpen(false)} />
      )}
    </>
  );
}

function ResumeList({ label, mark, items, empty }: {
  label: string; mark: 'dot' | 'arrow' | 'tick'; items: string[]; empty: string;
}) {
  return (
    <div className="rwc-list">
      <span className="fy-eyebrow">{label}</span>
      <div className="itemlist">
        {items.length ? items.map((t, i) => (
          <div className="item" key={i}>
            <span className={`mk ${mark}`}>{mark === 'arrow' ? '→' : mark === 'tick' ? '✓' : ''}</span>
            <span>{t}</span>
          </div>
        )) : <div className="empty-soft">{empty}</div>}
      </div>
    </div>
  );
}
