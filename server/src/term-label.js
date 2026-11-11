// Bound model titles at the API boundary; punctuation is not a word.
export function titleLabel(value) {
  const words = value.trim().replace(/\s+/g, ' ').split(' ');
  let count = 0;
  const title = words.filter((word) => !/^[-–—]$/.test(word) ? ++count <= 4 : count > 0 && count < 4)
    .join(' ').slice(0, 60).replace(/\s+[-–—]$/, '');
  return title.charAt(0).toUpperCase() + title.slice(1);
}
