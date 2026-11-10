// THE ARCHITECTURE DOC'S PAGE (design: Architecture.dc.html). Draws what
// lib/archDoc.ts parsed: numbered sections, the system map, cards, steps,
// callouts, chips and panels. The markdown is the source; this only reads it,
// and every shape it does not recognise draws as the plain markdown it is.

import type { ReactNode } from 'react';
import { block, inline } from '../components/Markdown';
import { archRows, pad2, type Part, type Section, type SysMap, type Deps } from '../lib/archDoc';

export function SecHead({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <div className="ad-sechead">
      <h2 className="ad-h"><span className="ad-n">{pad2(n)}</span>{inline(title)}</h2>
      {children}
    </div>
  );
}

function MapView({ map }: { map: SysMap }) {
  return (
    <div className="ad-map">
      <div className="ad-maprow">
        {map.row.map((x, i) => x.k === 'node' ? (
          <div key={i} className={`ad-node${x.node.accent ? ' accent' : ''}`}>
            <span className="ad-eyebrow">{x.node.kind}</span>
            <span className="ad-label">{x.node.name}</span>
            {x.node.sub && <span className="ad-mono">{x.node.sub}</span>}
          </div>
        ) : (
          <div key={i} className="ad-link" aria-hidden={!x.label}>
            {x.label && <span className="ad-linklabel">{x.label}</span>}
            <span className="ad-arrow">→</span>
          </div>
        ))}
      </div>
      {map.band && (
        <div className="ad-band"><span /><span className="ad-bandtag">{map.band}</span><span /></div>
      )}
      {map.groups.map((g, i) => (
        <div key={i} className="ad-group">
          {(g.title || g.caption) && (
            <div className="ad-grouphead">
              {g.title && <span className="ad-label">{g.title}</span>}
              {g.caption && <span className="ad-caption">{g.caption}</span>}
            </div>
          )}
          <div className="ad-procs">
            {g.procs.map((p, j) => (
              <div key={j} className="ad-proc">
                <div className="ad-prochead"><span className="ad-label">{p.name}</span><span className="ad-path">{p.path}</span></div>
                {p.detail && <span className="ad-mono">{p.detail}</span>}
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
    <div className="ad-deps">
      {deps.groups.map((g, i) => (
        <div key={i} className="ad-deprow">
          <span className="ad-eyebrow">{g.group}</span>
          <div className="ad-chips">
            {g.items.map((d, j) => (
              <span key={j} className="ad-dep"><span className="nm">{d.name}</span>{d.note && <span className="ad-path">{d.note}</span>}</span>
            ))}
          </div>
        </div>
      ))}
      {deps.note && <div className="ad-depnote">{inline(deps.note)}</div>}
    </div>
  );
}

function PartView({ p, narrow }: { p: Part; narrow: boolean }) {
  switch (p.k) {
    case 'map': return <MapView map={p.map} />;
    case 'deps': return <DepsView deps={p.deps} />;
    case 'cards': return (
      <div className={`ad-cards${narrow ? ' narrow' : ''}`}>
        {p.cards.map((c, i) => (
          <div key={i} className="ad-card">
            <span className={c.path ? 'ad-pathlabel' : 'ad-label'}>{inline(c.label)}</span>
            {c.text && <span className="ad-body">{inline(c.text)}</span>}
          </div>
        ))}
      </div>
    );
    case 'steps': return (
      <ol className="ad-steps">
        {p.steps.map((c, i) => (
          <li key={i} className={`ad-card${i === p.steps.length - 1 ? ' accent' : ''}`}>
            <span className="ad-stepn">{pad2(i + 1)}</span>
            <span className="ad-label">{inline(c.label)}</span>
            {c.text && <span className="ad-body">{inline(c.text)}</span>}
          </li>
        ))}
      </ol>
    );
    case 'callout': return (
      <div className="ad-callout" role="note">
        <span className="ad-eyebrow">{p.label}</span>
        <p>{inline(p.text)}</p>
      </div>
    );
    case 'panel': return (
      <div className="ad-panel">
        {p.title && (
          <div className="ad-paneltitle"><span className="ad-label">{inline(p.title)}</span>{p.tag && <span className="ad-tag">{p.tag}</span>}</div>
        )}
        {p.paras.map((t, i) => <p key={i}>{inline(t)}</p>)}
        {p.chips.length > 0 && <div className="ad-chips">{p.chips.map((c, i) => <code key={i}>{c}</code>)}</div>}
      </div>
    );
    case 'block':
      if (p.block.k === 'table') {
        const { head, rows } = p.block;
        const cols = { gridTemplateColumns: head.map((_, i) => (i === 0 ? 'minmax(0,0.9fr)' : 'minmax(0,1fr)')).join(' ') };
        return (
          <div className="ad-table" role="table">
            <div className="ad-tr head" role="row" style={cols}>{head.map((c, i) => <span key={i} role="columnheader">{inline(c)}</span>)}</div>
            {rows.map((r, j) => (
              <div key={j} className="ad-tr" role="row" style={cols}>
                {head.map((_, k) => <span key={k} role="cell" className={k === 0 ? 'key' : undefined}>{inline(r[k] ?? '')}</span>)}
              </div>
            ))}
          </div>
        );
      }
      return <div className="md ad-md">{block(p.block, 0)}</div>;
  }
}

function SectionView({ s, narrow }: { s: Section; narrow: boolean }) {
  return (
    <section className="ad-sec">
      <SecHead n={s.n} title={s.title} />
      {s.parts.map((p, i) => <PartView key={i} p={p} narrow={narrow} />)}
    </section>
  );
}

export function ArchSections({ sections }: { sections: Section[] }) {
  return (
    <>
      {archRows(sections).map((row) => row.length === 1
        ? <SectionView key={row[0].n} s={row[0]} narrow={false} />
        : (
          <div key={row[0].n} className="ad-pair">
            {row.map((s) => <SectionView key={s.n} s={s} narrow />)}
          </div>
        ))}
    </>
  );
}
