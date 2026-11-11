// THE SPINE DOCS' PAGES (designs: Architecture.dc.html, Charter.dc.html). Draws
// what lib/archDoc.ts parsed: numbered sections, the system map, cards, steps,
// principle rows, goals, callouts, chips and panels. The markdown is the source; this only reads it,
// and every shape it does not recognise draws as the plain markdown it is.
// Use doc-* class names: ad-* gets hidden by browser ad-blocking filters,
// silently removing charter cards, principles and goals.

import type { ReactNode } from 'react';
import { block, inline } from '../components/Markdown';
import { archRows, pad2, type Card, type Part, type Section, type SysMap, type Deps } from '../lib/archDoc';

/** A heading's tag: "This phase" reads as now (info); anything else is neutral. */
const tagTone = (tag: string) => (/phase|current/i.test(tag) ? 'info' : 'neutral');

export function SecHead({ n, title, tag, id, children }: { n: number; title: string; tag?: string; id?: string; children?: ReactNode }) {
  return (
    <div className="doc-sechead" id={id}>
      <h2 className="doc-h"><span className="doc-n">{pad2(n)}</span>{inline(title)}</h2>
      {tag && <span className={`doc-pill ${tagTone(tag)}`}>{tag}</span>}
      {children}
    </div>
  );
}

function CardView({ c, accent }: { c: Card; accent?: boolean }) {
  return (
    <div className={`doc-card${c.eyebrow ? ' big' : ''}`}>
      {c.eyebrow && <span className={`doc-eyebrow${accent ? ' accent' : ''}`}>{c.eyebrow}</span>}
      {c.tag ? (
        <div className="doc-paneltitle"><span className="doc-label">{inline(c.label)}</span><span className="doc-tag">{c.tag}</span></div>
      ) : (
        <span className={c.path ? 'doc-pathlabel' : c.eyebrow ? 'doc-cardhead' : 'doc-label'}>{inline(c.label)}</span>
      )}
      {c.text && <span className="doc-body">{inline(c.text)}</span>}
    </div>
  );
}

export function sectionId(s: Section) { return `doc-s${s.n}`; }

function MapView({ map }: { map: SysMap }) {
  return (
    <div className="doc-map">
      <div className="doc-maprow">
        {map.row.map((x, i) => x.k === 'node' ? (
          <div key={i} className={`doc-node${x.node.accent ? ' accent' : ''}`}>
            <span className="doc-eyebrow">{x.node.kind}</span>
            <span className="doc-label">{x.node.name}</span>
            {x.node.sub && <span className="doc-mono">{x.node.sub}</span>}
          </div>
        ) : (
          <div key={i} className="doc-link" aria-hidden={!x.label}>
            {x.label && <span className="doc-linklabel">{x.label}</span>}
            <span className="doc-arrow">→</span>
          </div>
        ))}
      </div>
      {map.band && (
        <div className="doc-band"><span /><span className="doc-bandtag">{map.band}</span><span /></div>
      )}
      {map.groups.map((g, i) => (
        <div key={i} className="doc-group">
          {(g.title || g.caption) && (
            <div className="doc-grouphead">
              {g.title && <span className="doc-label">{g.title}</span>}
              {g.caption && <span className="doc-caption">{g.caption}</span>}
            </div>
          )}
          <div className="doc-procs">
            {g.procs.map((p, j) => (
              <div key={j} className="doc-proc">
                <div className="doc-prochead"><span className="doc-label">{p.name}</span><span className="doc-path">{p.path}</span></div>
                {p.detail && <span className="doc-mono">{p.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DepsView({ deps }: { deps: Deps }) {
  return (
    <div className="doc-deps">
      {deps.groups.map((g, i) => (
        <div key={i} className="doc-deprow">
          <span className="doc-eyebrow">{g.group}</span>
          <div className="doc-chips">
            {g.items.map((d, j) => (
              <span key={j} className="doc-dep"><span className="nm">{d.name}</span>{d.note && <span className="doc-path">{d.note}</span>}</span>
            ))}
          </div>
        </div>
      ))}
      {deps.note && <div className="doc-depnote">{inline(deps.note)}</div>}
    </div>
  );
}

function PartView({ p, narrow }: { p: Part; narrow: boolean }) {
  switch (p.k) {
    case 'map': return <MapView map={p.map} />;
    case 'deps': return <DepsView deps={p.deps} />;
    case 'cards': {
      const eyebrowed = p.cards.some((c) => c.eyebrow);
      return (
        <div className={`doc-cards${narrow || eyebrowed ? ' narrow' : ''}`}>
          {p.cards.map((c, i) => <CardView key={i} c={c} accent={eyebrowed && i === 0} />)}
        </div>
      );
    }
    case 'rows': return (
      <div className="doc-rows">
        {p.rows.map((r, i) => (
          <div key={i} className="doc-row">
            <span className="doc-label">{inline(r.label)}</span>
            <span className="doc-body">{inline(r.text)}</span>
          </div>
        ))}
      </div>
    );
    case 'goals': return (
      <ol className="doc-goals">
        {p.goals.map((g, i) => (
          <li key={i}>
            <span className="doc-goaln">{i + 1}</span>
            <div className="doc-goal">
              <span className="doc-label">{inline(g.label)}</span>
              {g.chain.length > 0 && (
                <div className="doc-chain">
                  {g.chain.map((c, j) => (
                    <span key={j} className="doc-chainlink">
                      {j > 0 && <span className="doc-arrowsm" aria-hidden>→</span>}
                      <span className={`doc-chip${j === g.chain.length - 1 ? ' accent' : ''}`}>{c}</span>
                    </span>
                  ))}
                </div>
              )}
              {g.text && <span className="doc-body">{inline(g.text)}</span>}
            </div>
          </li>
        ))}
      </ol>
    );
    case 'mixed': return (
      <div className="doc-mixed">
        {p.items.map((it, i) => it.k === 'card'
          ? <div key={i} className="doc-panel slim"><CardView c={it.card} /></div>
          : <div key={i} className="doc-line"><span aria-hidden>—</span><span>{inline(it.text)}</span></div>)}
      </div>
    );
    case 'steps': return (
      <ol className="doc-steps">
        {p.steps.map((c, i) => (
          <li key={i} className={`doc-card${i === p.steps.length - 1 ? ' accent' : ''}`}>
            <span className="doc-stepn">{pad2(i + 1)}</span>
            <span className="doc-label">{inline(c.label)}</span>
            {c.text && <span className="doc-body">{inline(c.text)}</span>}
          </li>
        ))}
      </ol>
    );
    case 'callout': return (
      <div className="doc-callout" role="note">
        <span className="doc-eyebrow">{p.label}</span>
        <p>{inline(p.text)}</p>
      </div>
    );
    case 'panel': return (
      <div className="doc-panel">
        {p.title && (
          <div className="doc-paneltitle"><span className="doc-label">{inline(p.title)}</span>{p.tag && <span className="doc-tag">{p.tag}</span>}</div>
        )}
        {p.paras.map((t, i) => <p key={i}>{inline(t)}</p>)}
        {p.chips.length > 0 && <div className="doc-chips">{p.chips.map((c, i) => <code key={i}>{c}</code>)}</div>}
      </div>
    );
    case 'block':
      if (p.block.k === 'table') {
        const { head, rows } = p.block;
        const cols = { gridTemplateColumns: head.map((_, i) => (i === 0 ? 'minmax(0,0.9fr)' : 'minmax(0,1fr)')).join(' ') };
        return (
          <div className="doc-table" role="table">
            <div className="doc-tr head" role="row" style={cols}>{head.map((c, i) => <span key={i} role="columnheader">{inline(c)}</span>)}</div>
            {rows.map((r, j) => (
              <div key={j} className="doc-tr" role="row" style={cols}>
                {head.map((_, k) => <span key={k} role="cell" className={k === 0 ? 'key' : undefined}>{inline(r[k] ?? '')}</span>)}
              </div>
            ))}
          </div>
        );
      }
      return <div className="md doc-md">{block(p.block, 0)}</div>;
  }
}

function SectionView({ s, narrow, ruled }: { s: Section; narrow: boolean; ruled?: boolean }) {
  return (
    <section className={`doc-sec${ruled ? ' ruled' : ''}`} id={sectionId(s)}>
      <SecHead n={s.n} title={s.title} tag={s.tag} />
      {s.parts.map((p, i) => <PartView key={i} p={p} narrow={narrow} />)}
    </section>
  );
}

/** `ruled`: the Charter's reading column, one section under a rule after another, never paired. */
export function ArchSections({ sections, ruled }: { sections: Section[]; ruled?: boolean }) {
  if (ruled) return <>{sections.map((s) => <SectionView key={s.n} s={s} narrow={false} ruled />)}</>;
  return (
    <>
      {archRows(sections).map((row) => row.length === 1
        ? <SectionView key={row[0].n} s={row[0]} narrow={false} />
        : (
          <div key={row[0].n} className="doc-pair">
            {row.map((s) => <SectionView key={s.n} s={s} narrow />)}
          </div>
        ))}
    </>
  );
}
