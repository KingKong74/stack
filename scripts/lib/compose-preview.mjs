// #294 — deciding which service a preview tunnel points at, and generating
// the override that lets its published port coexist with the real stack.
//
// Zero dependency and pure by construction: everything here takes an
// already-resolved `docker compose config --format json` model (or a
// Dockerfile's text) and returns data/strings. No fs, no child_process, no
// network — that is what makes it testable without docker on the box:
//
//   node server/test/compose-preview.test.mjs
//
// Why this exists: Stack's own compose file reads its published port from
// WEB_PORT ("${WEB_PORT:-8787}:80"), so a preview can pass a spare port as
// that env var and the real stack and a preview never collide. A project
// whose compose file HARDCODES the port ("8787:80") has no such knob — every
// preview of it would try to publish the same host port the real deployment
// already holds, and `docker compose up` for the second one fails outright.
//
// The fix is an override file the preview writes alongside the checkout,
// forcing exactly one remapped port. The one thing that makes this fragile
// is that a NAIVE compose override APPENDS to a `ports:` list rather than
// replacing it — verified on this host: base "8787:80" plus override
// "8795:80" publishes BOTH, so the collision survives. The YAML tags
// `!override` (replace a sequence) and `!reset []` (remove a key) are what
// actually replace, and are what buildOverride() emits. verifyMerged() is
// the guard for a Compose too old to honour those tags.

// Is a published-port string a single number, or a range like "8000-8005"?
// Only a single number can ever be the eligible port a tunnel points at —
// picking a service by a range would leave the actual host port ambiguous.
function isRange(published) {
  return typeof published === 'string' && published.includes('-');
}

// The service's port entries that publish a HOST port, normalised.
// `published` may be "" (docker assigns a random host port) — that entry
// carries no host port a tunnel could dial, so it is skipped entirely.
export function publishedPorts(service) {
  const ports = (service && Array.isArray(service.ports)) ? service.ports : [];
  return ports
    .filter((p) => p && p.published !== undefined && p.published !== null && p.published !== '')
    .map((p) => ({
      target: p.target,
      published: String(p.published),
      protocol: p.protocol || 'tcp',
      raw: p,
    }));
}

// A port entry eligible to be the tunnel's chosen port: tcp, and a single
// port rather than a range (docker itself would refuse to pick one host port
// out of a range for us to dial).
function eligible(entry) {
  return entry.protocol === 'tcp' && !isRange(entry.published);
}

const NAME_PREFERENCE = [
  'web', 'frontend', 'www', 'nginx', 'caddy', 'traefik',
  'app', 'ui', 'client', 'site', 'proxy',
];
const TARGET_PREFERENCE = [80, 8080, 3000, 5173, 4321, 8000, 5000];

// Decide which ONE service a preview tunnel should point at.
//
// `model` is the resolved compose JSON model ({ services: { name: {...} } }).
// The sentinels are the numbers passed as WEB_PORT / PORT when the model was
// resolved — a service whose published port equals one of them is PROVEN to
// read that env var, which is the strongest possible evidence and always
// wins. Everything below that is a heuristic over a compose file that has no
// such knob at all (the #294 case).
export function pickWebService(model, { webPortSentinel, portSentinel } = {}) {
  const services = (model && model.services) || {};
  const names = Object.keys(services);

  // Every eligible published port, across every service, with which service
  // it belongs to — the shared table every rule below scans.
  const rows = [];
  for (const name of names) {
    for (const entry of publishedPorts(services[name])) {
      if (eligible(entry)) rows.push({ name, ...entry, publishedNum: Number(entry.published) });
    }
  }

  const bySentinel = (sentinel) => {
    if (sentinel === undefined || sentinel === null) return [];
    return rows.filter((r) => r.publishedNum === Number(sentinel));
  };
  const lowestTarget = (list) => list.reduce((a, b) => (b.target < a.target ? b : a));

  // Rule 1 — proven by reading WEB_PORT.
  const rule1 = bySentinel(webPortSentinel);
  if (rule1.length) {
    const r = lowestTarget(rule1);
    return { service: r.name, target: r.target, protocol: r.protocol, why: 'reads WEB_PORT' };
  }

  // Rule 2 — proven by reading PORT.
  const rule2 = bySentinel(portSentinel);
  if (rule2.length) {
    const r = lowestTarget(rule2);
    return { service: r.name, target: r.target, protocol: r.protocol, why: 'reads PORT' };
  }

  // Rule 3 — a conventionally-named web-facing service.
  for (const name of NAME_PREFERENCE) {
    const hit = rows.filter((r) => r.name.toLowerCase() === name);
    if (hit.length) {
      const r = lowestTarget(hit);
      return { service: r.name, target: r.target, protocol: r.protocol, why: `named "${r.name}"` };
    }
  }

  // Rule 4 — a conventional web-facing CONTAINER port, regardless of name.
  for (const target of TARGET_PREFERENCE) {
    const hit = rows.filter((r) => r.target === target);
    if (hit.length) {
      const r = hit[0];
      return { service: r.name, target: r.target, protocol: r.protocol, why: `publishes :${r.target}` };
    }
  }

  // Rule 5 — nothing named or ported conventionally, but only one candidate.
  const candidateNames = [...new Set(rows.map((r) => r.name))];
  if (candidateNames.length === 1) {
    const r = rows[0];
    return { service: r.name, target: r.target, protocol: r.protocol, why: 'the only published port' };
  }

  if (candidateNames.length === 0) {
    return { error: 'the compose file publishes no host port — there is nothing for a preview tunnel to point at' };
  }
  return { error: `several services publish a host port and none stands out (${candidateNames.join(', ')}) — a preview cannot decide which to tunnel` };
}

// The `.stack-preview.yml` override CONTENTS: remap the chosen service to
// `port`, and drop every OTHER published port so a second stack can come up
// alongside the real one without colliding on anything.
export function buildOverride(model, chosen, port) {
  const services = (model && model.services) || {};
  const names = Object.keys(services);

  const lines = [
    '# Generated by stack-preview.mjs — DO NOT EDIT.',
    '#',
    "# The chosen service's published port is remapped so this preview can come",
    '# up alongside the real stack without colliding on a host port. Every other',
    "# service that publishes one is reset instead of remapped: a preview only",
    '# needs the ONE port the tunnel points at, and every other published port',
    "# is pure collision risk against the host's real services — those stay",
    '# reachable on the compose network, which is where they were always reached',
    '# from. Regenerated on every preview start; hand edits are lost.',
    'services:',
  ];

  for (const name of names) {
    const ports = publishedPorts(services[name]);
    if (!ports.length) continue; // nothing published, nothing to say
    lines.push(`  "${name}":`);
    if (name === chosen.service) {
      lines.push('    ports: !override');
      lines.push(`      - "${port}:${chosen.target}"`);
    } else {
      lines.push('    ports: !reset []');
    }
  }

  return `${lines.join('\n')}\n`;
}

// Given the model resolved from BOTH the base compose file and the override,
// is `port` the only host port left published across every service? This is
// what catches a Compose too old to honour !override / !reset: the override
// applies (no error) but the base file's ports survive by simple append.
export function verifyMerged(mergedModel, port) {
  const services = (mergedModel && mergedModel.services) || {};
  const problems = [];
  for (const name of Object.keys(services)) {
    for (const entry of publishedPorts(services[name])) {
      if (entry.published !== String(port)) {
        problems.push(`"${name}" still publishes ${entry.published}`);
      }
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

// EXPOSE line(s) from a Dockerfile's text: `EXPOSE 3000`, `EXPOSE 3000/tcp`,
// `EXPOSE 80 443` (first wins), lowercase `expose`, blank/comment lines.
// `/udp` is skipped (a preview tunnel is always tcp). A build-arg port like
// `EXPOSE ${PORT}` cannot be resolved here, so it is skipped rather than
// guessed — null means "found nothing usable", never "found 0".
const EXPOSE_RE = /^\s*expose\s+(.+?)\s*$/i;

export function dockerfileExpose(text) {
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const withoutComment = line.replace(/#.*$/, '');
    const m = EXPOSE_RE.exec(withoutComment);
    if (!m) continue;
    const tokens = m[1].trim().split(/\s+/);
    for (const token of tokens) {
      const [portPart, proto = 'tcp'] = token.split('/');
      if (proto.toLowerCase() === 'udp') continue;
      if (!/^\d+$/.test(portPart)) continue; // e.g. ${PORT} — unresolvable, skip
      return Number(portPart);
    }
  }
  return null;
}
