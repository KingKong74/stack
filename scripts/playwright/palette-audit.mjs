// palette-audit.mjs — does the app actually WEAR the palette? (#432)
//
// The UI smoke (smoke.mjs) proves a screen renders, loads and does not
// overflow. It is blind to colour, and colour is exactly where a repalette
// breaks: the console kit inverted --ink from near-black to near-white, so a
// rule that had always said `color: #fff` on a light chip kept building,
// kept passing the smoke, and drew white on white.
//
// Reading a screenshot does not catch this either — a downscaled PNG of a
// pale bar on a dark page reads as "dark bar" to the eye. This script asks the
// BROWSER instead, which cannot be fooled by scaling:
//
//   1. CONTRAST — every text-bearing element is measured against the
//      background actually painted behind it (walking up through transparent
//      ancestors, compositing alpha as it goes). Anything under the WCAG AA
//      ratio for its size is a finding. This is what catches white-on-white.
//   2. STRAY TONES — every painted colour is checked against the kit ramp
//      declared on :root. A literal that never rode a token shows up here as
//      soon as the ramp moves under it.
//
// Findings carry the selector, the tone, and what it sits on, because
// "something is off-palette" that cannot be located is not actionable.
//
// There is a THIRD bucket, and it is the honest one: text whose real ground
// this cannot compute — a gradient scrim, a cover image, an iframe preview
// between the element and anything measurable. Those are reported apart and
// do not fail the run. Asserting a ratio against a layer that is not actually
// behind the text is a made-up number, and a made-up number that says PASS is
// worse than one that says FAIL.
//
// Fails LOUD, in the sense scripts/playwright/smoke.mjs's header sets out: an
// app it could not reach exits 1 with a reason, never 0 with no findings —
// "looked and found nothing" and "could not look" must never read alike.
//
// Usage:
//   node scripts/playwright/palette-audit.mjs                     # localhost:8787
//   node scripts/playwright/palette-audit.mjs --url http://…      # elsewhere
//   node scripts/playwright/palette-audit.mjs --screens overview  # a subset
//   node scripts/playwright/palette-audit.mjs --json              # machine-readable
//
// Needs the same chromium the smoke uses; run it through the same wrapper
// (scripts/run-palette-audit.sh) so the rootless dep prefix is on the path.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------- args + env

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const FLAG = (n) => process.argv.includes(`--${n}`);

function readStackEnv() {
  try {
    const out = {};
    for (const line of readFileSync(join(homedir(), '.stack', 'env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
    return out;
  } catch { return {}; }
}

const SCREENS = [
  { slug: 'dashboard', hash: '#/' },
  { slug: 'overview', hash: '#/p/{slug}' },
  { slug: 'quality', hash: '#/p/{slug}/quality' },
  { slug: 'roadmap', hash: '#/p/{slug}/roadmap' },
  { slug: 'activity', hash: '#/p/{slug}/activity' },
  { slug: 'settings', hash: '#/settings' },
  { slug: 'skills', hash: '#/skills' },
  { slug: 'timeline', hash: '#/timeline' },
];

// -------------------------------------------------------- the in-page audit
//
// Runs inside the browser. Everything it needs must be self-contained: this
// function is serialised across, so it may not close over anything above.

/* c8 ignore start — executes in the page, not under node */
function auditInPage() {
  const AA_NORMAL = 4.5, AA_LARGE = 3.0;

  const parse = (c) => {
    const m = String(c).match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const over = (fg, bg) => ({           // composite fg (with alpha) onto bg
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const hex = ({ r, g, b }) =>
    '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  // The background actually painted behind an element.
  //
  // Two things have to be composited, and missing either one invents findings
  // or hides them:
  //
  //  1. ANCESTORS. An element whose own background is see-through does not sit
  //     on nothing, it sits on whatever its ancestors painted. Skipping this
  //     is what makes a naive `getComputedStyle(el).backgroundColor` check
  //     blind to white-on-white.
  //  2. OVERLAY LAYERS. A positioned element that COVERS the target and paints
  //     before it — a scrim over a cover image, a tint wash — is between the
  //     ancestor's background and this text, even though it is nowhere on the
  //     ancestor chain. Skipping this reports every scrimmed caption as
  //     unreadable: the project cards read as white-on-pale at 1.4:1 when the
  //     scrim they actually sit on takes them past AA.
  const rectOf = (n) => n.getBoundingClientRect();
  const covers = (a, b) =>
    a.left <= b.left + 0.5 && a.right >= b.right - 0.5 &&
    a.top <= b.top + 0.5 && a.bottom >= b.bottom - 0.5;

  // Returns the composited ground AND whether anything sat in the way that
  // this cannot evaluate — a gradient scrim, a cover image, an iframe preview.
  // Those are reported apart from real findings rather than asserted on: a
  // ratio measured against a layer that is not actually the one behind the
  // text is a made-up number, and a made-up number that says PASS is worse
  // than one that says FAIL.
  const groundOf = (el) => {
    const target = rectOf(el);
    const layers = [];                                  // nearest-first
    let unverified = '';
    let child = el;
    for (let n = el; n && n.nodeType === 1; child = n, n = n.parentElement) {
      // overlays painted inside n, on top of n's own background, that cover
      // the target — but only those before `child` in paint order, since a
      // later sibling would cover the TEXT too and it would not be legible
      // regardless of colour.
      if (n !== el) {
        const kids = Array.from(n.children);
        const stop = kids.indexOf(child);
        for (let i = 0; i < (stop < 0 ? kids.length : stop); i++) {
          const k = kids[i];
          const ks = getComputedStyle(k);
          if (ks.position !== 'absolute' && ks.position !== 'fixed') continue;
          if (ks.visibility === 'hidden' || ks.display === 'none') continue;
          const opacity = isNaN(+ks.opacity) ? 1 : +ks.opacity;
          if (opacity === 0) continue;
          if (!covers(rectOf(k), target)) continue;
          if (ks.backgroundImage && ks.backgroundImage !== 'none') {
            unverified = unverified || `a ${ks.backgroundImage.split('(')[0]} layer sits between`;
            continue;
          }
          if (k.querySelector('iframe, img, video, canvas')) {
            unverified = unverified || 'a media layer sits between';
            continue;
          }
          const kc = parse(ks.backgroundColor);
          if (!kc || kc.a === 0) continue;
          layers.push({ ...kc, a: kc.a * opacity });
        }
      }
      const ns = getComputedStyle(n);
      if (n !== el && ns.backgroundImage && ns.backgroundImage !== 'none') {
        unverified = unverified || 'an ancestor paints an image or gradient';
      }
      const c = parse(ns.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a === 1) break; }
    }
    let ground = { r: 255, g: 255, b: 255, a: 1 };       // the canvas under everything
    for (let i = layers.length - 1; i >= 0; i--) ground = over(layers[i], ground);
    return { ground, unverified };
  };

  const sel = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  // ---- 1. the declared ramp, straight off :root ----
  //
  // A custom property's computed value is its RAW declared text — '#BFEC7E',
  // or 'var(--lime-500)', or a whole `font` shorthand — never rgb(). Parsing
  // it directly finds almost nothing and then reports the entire app as
  // off-palette. So resolve each one the only way the browser will do it
  // honestly: assign it as a real colour on a probe element and read back what
  // the engine computed.
  const rootStyle = getComputedStyle(document.documentElement);
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const ramp = new Set();
  for (const name of Array.from(rootStyle).filter((n) => n.startsWith('--'))) {
    probe.style.color = '';
    probe.style.color = `var(${name})`;
    const c = parse(getComputedStyle(probe).color);
    // an unresolvable/non-colour token leaves the probe at its inherited
    // colour, so only keep what actually changed to something of its own
    if (c) ramp.add(hex(c));
  }
  probe.remove();

  const contrast = [];
  const unverified = [];
  const strays = [];
  const seenStray = new Set();

  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) continue;

    // does this element render its OWN text? (not just its children's)
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');

    // ---- contrast ----
    if (own) {
      const fgRaw = parse(cs.color);
      // `color: transparent` is text deliberately HIDDEN — the roadmap's
      // unticked checkbox holds its ✓ invisible until it is ticked. Composited
      // it equals its own ground and scores 1:1, which is the tool describing
      // an intention as a defect.
      if (fgRaw && fgRaw.a > 0) {
        const { ground, unverified: why } = groundOf(el);
        const fg = over(fgRaw, ground);
        const size = parseFloat(cs.fontSize) || 14;
        const bold = (+cs.fontWeight || 400) >= 700;
        const large = size >= 24 || (size >= 18.66 && bold);
        const need = large ? AA_LARGE : AA_NORMAL;
        const got = ratio(fg, ground);
        if (got < need) {
          const row = {
            selector: sel(el), text: own.slice(0, 60), fg: hex(fg), bg: hex(ground),
            ratio: +got.toFixed(2), need, fontSize: size,
          };
          if (why) unverified.push({ ...row, why }); else contrast.push(row);
        }
      }
    }

    // ---- stray tones ----
    //
    // A colour written by a component from a DATA value is not a palette
    // violation: a project's stored tint is its identity, chosen per project
    // and living in the database, and it has no business being on the app's
    // ramp. Those arrive as inline styles, which is exactly what distinguishes
    // them from a literal somebody typed into the stylesheet.
    const inline = el.getAttribute('style') || '';
    for (const prop of ['color', 'backgroundColor', 'borderTopColor']) {
      const c = parse(cs[prop]);
      if (!c || c.a === 0) continue;
      if (prop === 'backgroundColor' && c.a === 0) continue;
      const cssProp = prop === 'backgroundColor' ? 'background'
        : prop === 'borderTopColor' ? 'border' : 'color';
      if (inline.includes(cssProp)) continue;
      const h = hex(c);
      if (ramp.has(h)) continue;
      // translucent tones composite to something off-ramp by definition
      if (c.a < 1) continue;
      const key = `${h}|${prop}`;
      if (seenStray.has(key)) continue;
      seenStray.add(key);
      strays.push({ selector: sel(el), prop, tone: h });
    }
  }

  // worst first, and cap so one broken screen cannot flood the report
  contrast.sort((a, b) => a.ratio - b.ratio);
  return {
    contrast: contrast.slice(0, 40),
    unverified: unverified.slice(0, 20),
    strays: strays.slice(0, 40),
    ramp: ramp.size,
  };
}
/* c8 ignore stop */

// ------------------------------------------------------------------ runner

async function main() {
  const url = (arg('url') || process.env.STACK_UI_URL
    || `http://localhost:${process.env.WEB_PORT || 8787}`).replace(/\/$/, '');
  const token = arg('token') || readStackEnv().STACK_TOKEN;
  const slug = arg('slug') || 'stack';
  const only = arg('screens');
  const wanted = only ? new Set(only.split(',').map((s) => s.trim())) : null;

  if (!token) {
    process.stderr.write('palette-audit: no bearer token — pass --token or set STACK_TOKEN in ~/.stack/env.\n');
    process.exit(1);
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    process.stderr.write(`palette-audit: could not launch chromium — ${e.message}\n`);
    process.stderr.write('run it through scripts/run-palette-audit.sh so the rootless dep prefix is set.\n');
    process.exit(1);
  }

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(([k, v]) => {
    try { localStorage.setItem(k, v); } catch { /* private mode */ }
  }, ['stack.token', token]);

  const findings = [];
  let audited = 0;

  for (const screen of SCREENS) {
    if (wanted && !wanted.has(screen.slug)) continue;
    const page = await ctx.newPage();
    const target = `${url}/${screen.hash.replace('{slug}', slug)}`;
    try {
      await page.goto(target, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1200);
      // A screen still sitting on the token gate has not been audited — say so
      // rather than reporting its handful of clean elements as a pass.
      const gated = await page.evaluate(() => !!document.querySelector('.gate, .token-gate'));
      if (gated) {
        findings.push({ screen: screen.slug, kind: 'unreachable', detail: 'token gate — not audited' });
        await page.close();
        continue;
      }
      const res = await page.evaluate(auditInPage);
      audited++;
      for (const c of res.contrast) findings.push({ screen: screen.slug, kind: 'contrast', ...c });
      for (const u of res.unverified) findings.push({ screen: screen.slug, kind: 'unverified', ...u });
      for (const s of res.strays) findings.push({ screen: screen.slug, kind: 'stray-tone', ...s });
    } catch (e) {
      findings.push({ screen: screen.slug, kind: 'unreachable', detail: e.message.split('\n')[0] });
    }
    await page.close();
  }

  await browser.close();

  if (FLAG('json')) {
    process.stdout.write(JSON.stringify({ url, audited, findings }, null, 2) + '\n');
  } else {
    const contrast = findings.filter((f) => f.kind === 'contrast');
    const strays = findings.filter((f) => f.kind === 'stray-tone');
    const murky = findings.filter((f) => f.kind === 'unverified');
    const dead = findings.filter((f) => f.kind === 'unreachable');

    if (contrast.length) {
      process.stdout.write('\ncontrast below WCAG AA:\n');
      for (const f of contrast) {
        process.stdout.write(
          `  ${f.screen.padEnd(10)} ${String(f.ratio).padStart(5)}:1 (needs ${f.need})  ` +
          `${f.fg} on ${f.bg}  ${f.selector}\n      “${f.text}”\n`);
      }
    }
    if (murky.length) {
      process.stdout.write('\ncould not be measured (a layer this cannot evaluate is in the way —\nnot a finding, and not a pass either):\n');
      for (const f of murky) {
        process.stdout.write(`  ${f.screen.padEnd(10)} ${f.selector}  — ${f.why}\n      \u201c${f.text}\u201d\n`);
      }
    }
    if (strays.length) {
      process.stdout.write('\ntones that are not on the :root ramp:\n');
      for (const f of strays) {
        process.stdout.write(`  ${f.screen.padEnd(10)} ${f.tone}  ${f.prop.padEnd(15)} ${f.selector}\n`);
      }
    }
    if (dead.length) {
      process.stdout.write('\ncould not audit:\n');
      for (const f of dead) process.stdout.write(`  ${f.screen.padEnd(10)} ${f.detail}\n`);
    }
    process.stdout.write(
      `\n${audited} screens audited — ${contrast.length} contrast, ${strays.length} stray tones, ` +
      `${murky.length} unmeasurable, ${dead.length} unreachable.\n`);
  }

  // An unreachable screen is a FAILURE, not a clean pass: absence of findings
  // from a screen nobody could open is exactly the NULL-verdict lie.
  const bad = findings.filter((f) => f.kind === 'contrast' || f.kind === 'unreachable').length;
  if (!audited) { process.stderr.write('palette-audit: nothing was audited.\n'); process.exit(1); }
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`palette-audit: ${e?.stack || e}\n`);
  process.exit(1);
});
