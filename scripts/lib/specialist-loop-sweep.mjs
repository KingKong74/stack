// Called by the existing minute dispatcher, before its normal queue claim.
// No scheduler/model calls here. Any unknown host/API/Git input stops this sweep.
import { realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
export async function sweepSpecialistLoops({ api, root, localMinutes, gitRead }) {
  const policies = await api('GET','/api/specialist-loops');
  if (!Array.isArray(policies) || policies.length > 256) throw Error('Unknown loop policy response.');
  const reports = [];
  for (const policy of policies) {
    if (!/^\d+$/.test(String(policy.id)) || !/^[a-zA-Z0-9_-]+$/.test(policy.slug)) throw Error('Invalid policy identity.');
    const git = gitRead || ((slug, args) => {
      const jail = realpathSync(root), repo = realpathSync(join(jail,slug));
      const rel = relative(jail,repo);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Checkout is outside the dispatcher root.');
      const r = spawnSync('git',['-C',repo,...args],{encoding:'utf8',timeout:5000,maxBuffer:8192});
      if (r.status !== 0) throw Error('Loop Git evidence is unavailable.');
      return r.stdout.trim();
    });
    try {
      const head = git(policy.slug,['rev-parse','HEAD']);
      const base = policy.last_head || git(policy.slug,['rev-parse','HEAD^']);
      if (!/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(base)) throw Error('Exact loop revisions unavailable.');
      git(policy.slug,['merge-base','--is-ancestor',base,head]);
      reports.push(await api('POST',`/api/projects/${policy.slug}/specialists/loops/${policy.id}/dispatch`,{head,base,connected:true,localMinutes}));
    } catch {
      // Still report unknown host state, so a disconnected/moved checkout never looks healthy.
      reports.push(await api('POST',`/api/projects/${policy.slug}/specialists/loops/${policy.id}/dispatch`,{connected:false,localMinutes}));
    }
  }
  return reports;
}
