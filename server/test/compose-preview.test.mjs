// #294 — previews for projects whose compose file hardcodes its published
// port. Pure module, so this needs no docker, no DB and no dependencies:
//
//   node server/test/compose-preview.test.mjs      # exits non-zero on failure
//
// Same shape as fleet-roles.test.mjs — a tiny check() helper, plain console
// output, process.exit(1) on any failure.
import {
  publishedPorts, pickWebService, buildOverride, verifyMerged, dockerfileExpose,
} from '../../scripts/lib/compose-preview.mjs';

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : `  (want ${JSON.stringify(want)})`}`);
};

const port = (target, published, protocol = 'tcp') => ({ mode: 'ingress', target, published: String(published), protocol });

// --------------------------------------------------------------------------
console.log('--- Stack\'s own shape: web reads WEB_PORT ---');
const stackModel = {
  services: {
    web: { image: 'stack-web', ports: [port(80, 8801)] },
    server: { image: 'stack-server', ports: [] },
    db: { image: 'postgres', ports: [] },
  },
};
const stackPick = pickWebService(stackModel, { webPortSentinel: 8801, portSentinel: 8801 });
check('picks web', stackPick.service, 'web');
check('why mentions WEB_PORT', stackPick.why, 'reads WEB_PORT');
check('target is 80', stackPick.target, 80);

const stackOverride = buildOverride(stackModel, stackPick, 8801);
check('override has one !override', (stackOverride.match(/!override/g) || []).length, 1);
check('override has no !reset (nothing else publishes)', stackOverride.includes('!reset'), false);
check('override remaps to the chosen port:target', stackOverride.includes('"8801:80"'), true);

// --------------------------------------------------------------------------
console.log('\n--- the #294 bug: a HARDCODED port with no sentinel anywhere ---');
const hardModel = {
  services: {
    web: { image: 'someapp-web', ports: [port(80, 8787)] },
    db: { image: 'postgres', ports: [port(5432, 5432)] },
  },
};
const hardPick = pickWebService(hardModel, { webPortSentinel: 9999, portSentinel: 9999 });
check('still picks web (named)', hardPick.service, 'web');
check('why names the rule', hardPick.why, 'named "web"');

const hardOverride = buildOverride(hardModel, hardPick, 8802);
check('override overrides web', hardOverride.includes('"web"') && hardOverride.includes('!override'), true);
check('override resets db', /"db":\s*\n\s*ports: !reset \[\]/.test(hardOverride), true);
check('override remaps web to the new port', hardOverride.includes('"8802:80"'), true);

// --------------------------------------------------------------------------
console.log('\n--- rule 4: no helpful names, target preference decides ---');
const noNamesModel = {
  services: {
    alpha: { image: 'x', ports: [port(5432, 9000)] },
    beta: { image: 'y', ports: [port(80, 8080)] },
  },
};
const noNamesPick = pickWebService(noNamesModel, {});
check('picks beta (target :80 preferred over :5432)', noNamesPick.service, 'beta');
check('why names the target', noNamesPick.why, 'publishes :80');

// --------------------------------------------------------------------------
console.log('\n--- no published ports at all ---');
const nothingModel = { services: { worker: { image: 'z', ports: [] } } };
const nothingPick = pickWebService(nothingModel, {});
check('errors', typeof nothingPick.error, 'string');
check('mentions there is nothing to point a tunnel at', /nothing/i.test(nothingPick.error) && /tunnel/i.test(nothingPick.error), true);

// --------------------------------------------------------------------------
console.log('\n--- ambiguity: several equally plausible candidates ---');
const ambiguousModel = {
  services: {
    gizmo: { image: 'a', ports: [port(9001, 9001)] },
    gadget: { image: 'b', ports: [port(9002, 9002)] },
  },
};
const ambiguousPick = pickWebService(ambiguousModel, {});
check('errors', typeof ambiguousPick.error, 'string');
check('names both candidates', ambiguousPick.error.includes('gizmo') && ambiguousPick.error.includes('gadget'), true);

// --------------------------------------------------------------------------
console.log('\n--- a range publish and a udp publish are never chosen ---');
const rangeModel = {
  services: {
    ranged: { image: 'r', ports: [port(8000, '8000-8005')] },
    udponly: { image: 'u', ports: [port(53, 53, 'udp')] },
    fine: { image: 'f', ports: [port(80, 7777)] },
  },
};
check('publishedPorts still reports the range entry (raw)', publishedPorts(rangeModel.services.ranged).length, 1);
const rangePick = pickWebService(rangeModel, {});
check('range/udp skipped, only "fine" is eligible', rangePick.service, 'fine');

// --------------------------------------------------------------------------
console.log('\n--- verifyMerged ---');
check('ok for a single matching port', verifyMerged({ services: { web: { ports: [port(80, 8801)] } } }, 8801), { ok: true });

// The real trap: a naive override APPENDS rather than replaces, so a Compose
// too old to honour !override / !reset leaves the base file's port alive
// alongside the remapped one. This is exactly what verifyMerged exists to
// catch — silently trusting the override would let the collision through.
const appended = {
  services: {
    web: { ports: [port(80, 8787), port(80, 8795)] },
  },
};
const mergedResult = verifyMerged(appended, 8795);
check('append case fails', mergedResult.ok, false);
check('names the service and the leftover port', mergedResult.problems.some((p) => p.includes('web') && p.includes('8787')), true);

// --------------------------------------------------------------------------
console.log('\n--- dockerfileExpose ---');
check('EXPOSE 3000', dockerfileExpose('FROM node\nEXPOSE 3000\n'), 3000);
check('EXPOSE 3000/tcp', dockerfileExpose('EXPOSE 3000/tcp'), 3000);
check('EXPOSE 80 443 (first wins)', dockerfileExpose('EXPOSE 80 443'), 80);
check('lowercase expose', dockerfileExpose('expose 4321'), 4321);
check('EXPOSE .../udp skipped, falls through to next EXPOSE', dockerfileExpose('EXPOSE 53/udp\nEXPOSE 8080'), 8080);
check('comments and blanks ignored', dockerfileExpose('# EXPOSE 1111\n\nEXPOSE 2222'), 2222);
check('build-arg form unresolvable -> null', dockerfileExpose('EXPOSE ${PORT}'), null);
check('no EXPOSE at all -> null', dockerfileExpose('FROM node\nCMD ["node", "index.js"]'), null);
check('a single udp-only EXPOSE -> null', dockerfileExpose('EXPOSE 53/udp'), null);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
