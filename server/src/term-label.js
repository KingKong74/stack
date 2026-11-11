// Bound model titles at the API boundary; punctuation is not a word.
export function titleLabel(value) {
  const words = value.trim().replace(/\s+/g, ' ').split(' ');
  let count = 0;
  const title = words.filter((word) => !/^[-–—]$/.test(word) ? ++count <= 4 : count > 0 && count < 4)
    .join(' ').slice(0, 60).replace(/\s+[-–—]$/, '');
  return title.charAt(0).toUpperCase() + title.slice(1);
}

// Prompt-triggered labelling targets only that terminal; older clients may
// omit the body to request the existing output-based batch fallback.
export function labelRequest(body) {
  if (!body || !Object.keys(body).length) return null;
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('A prompt is required.');
  const sid = typeof body.sid === 'string' ? body.sid : '';
  const tmux = typeof body.tmux === 'string' ? body.tmux : '';
  if ((!sid && !tmux) || sid.length > 128 || tmux.length > 128) throw new Error('A terminal identity is required.');
  return { sid, tmux, prompt: body.prompt.trim().slice(0, 8000) };
}
