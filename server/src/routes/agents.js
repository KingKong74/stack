import { Router } from 'express';
import { termAgentConnected } from '../term.js';
import { AGENT_MODELS, agentByKey, agentShape, readAgents, readAgent, writeAgent } from '../agents.js';

// The TAB AGENTS surface (#361) — app-wide, no slug, read by Mission Control's
// Agents room. Two routes and nothing else:
//
//   GET  /api/agents       the three agents: who they are, which tab each is
//                          bound to, which ops they own, how they are tuned and
//                          when each last ran.
//   PATCH /api/agents/:key what the owner may change. Deliberately a SHORT list:
//                          enabled, model, guidance, opsOff. Which tab an agent
//                          works in and which ops it owns are registry facts in
//                          agents.js — they are the restriction the item is
//                          about, and a route that could edit them would be a
//                          route that could unbind an agent from its tab.
export const agents = Router();

agents.get('/', async (_req, res) => {
  const all = await readAgents();
  res.json({
    // #364 — whether the BACKEND is reachable is the frame around every switch
    // on this screen: an agent can be ON and still unable to act. The agents
    // run Claude on the host now, so the frame is the daemon, not a key.
    // Saying so here is what stops the room reading a disconnected host as
    // three healthy agents. (`geminiReady` is deliberately gone from this
    // payload rather than left lying: it stopped being this room's question.)
    hostReady: termAgentConnected(),
    defaultModel: '',
    models: AGENT_MODELS,
    agents: all.map(agentShape),
  });
});

agents.patch('/:key', async (req, res) => {
  const agent = agentByKey(req.params.key);
  if (!agent) return res.status(404).json({ error: 'No such agent.' });
  const b = req.body ?? {};
  const patch = {};
  if ('enabled' in b) patch.enabled = !!b.enabled;
  if ('model' in b) patch.model = b.model;
  if ('guidance' in b) patch.guidance = b.guidance;
  if ('opsOff' in b) patch.opsOff = b.opsOff;
  // A single op toggle, so the client doesn't have to send the whole set back
  // (and can't clobber a concurrent change to a different op).
  if ('op' in b && 'opEnabled' in b) {
    const live = await readAgent(agent.key);
    const off = new Set(live?.config.opsOff ?? []);
    if (b.opEnabled) off.delete(String(b.op)); else off.add(String(b.op));
    patch.opsOff = [...off];
  }
  const updated = await writeAgent(agent.key, patch);
  if (!updated) return res.status(404).json({ error: 'No such agent.' });
  res.json(agentShape(updated));
});
