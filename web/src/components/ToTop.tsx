import { useEffect, useState } from 'react';

// Floating "↑ Top" button — appears after the user has scrolled down two
// full viewports. Clicking scrolls back to the top smoothly, or instantly
// when prefers-reduced-motion is set. Bottom-right of the viewport.
export function ToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const threshold = () => window.innerHeight * 2;
    const onScroll = () => setVisible(window.scrollY >= threshold());
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!visible) return null;

  const scrollTop = () => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduced ? 'instant' : 'smooth' });
  };

  return (
    <button
      className="totop"
      onClick={scrollTop}
      aria-label="Back to top"
      title="Back to top"
    >
      ↑ Top
    </button>
  );
}
