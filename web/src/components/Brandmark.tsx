// THE LOGO — Claude Design project "Stack Logo" (ac7ecb0c), direction 4a
// "Tightened": three offset plates on a near-black tile, the top two blue and
// the bottom one lime. The mark says "stacked work, one of them finished
// overnight", which is the product, and the lime plate is the same lime that
// means done everywhere else in the app.
//
// THIS FILE IS THE ONLY PLACE THE MARK IS DRAWN. Before it there was no logo
// to speak of — a filled square with a terminal chevron in it, and on two
// screens an EMPTY square — so "the brand" was three different things. Every
// surface now composes from here: the topbar, the sign-in gate, a share link's
// error card, and (via scripts/lib/brandmark.cjs, which mirrors the geometry
// in ANSI blocks) the CLI. The favicon and the PWA icons are rendered from the
// same coordinates by scripts/render-icons.mjs — change a plate here and re-run
// it, or the tab and the header stop being the same logo.
//
// TWO THINGS THE DESIGN DECIDES THAT LOOK LIKE DETAILS AND ARE NOT:
//
// · THE MARK REDUCES BELOW 24px. Three 10-unit plates with 4.5 units between
//   them turn into a grey smear at 16px, so under 24 the middle plate is
//   dropped and the surviving two are thickened — the offset still reads, the
//   lime still lands. Do not "fix" the reduced form by scaling the full one.
// · THE TILE LOSES ITS INSET AND ITS HAIRLINE BELOW 32px. At hero sizes the
//   tile sits 2.5 units in with a --grey-750 edge, which is what separates a
//   near-black tile from a near-black page. At small sizes that hairline is a
//   sub-pixel and the inset just makes the mark look shrunken, so the tile goes
//   full-bleed and the plates do the separating.
//
// Clear space is one plate-step — an eighth of the icon width — on all four
// sides. Minimum wordmark size is 14px; below that use the mark alone.

import type { CSSProperties } from 'react';
import { PRODUCT_NAME } from '../lib/ui';

/** Under this the mark drops its middle plate (see the header). */
const REDUCE_BELOW = 24;
/** Under this the tile goes full-bleed and drops its hairline. */
const BLEED_BELOW = 32;

export function StackMark({ size = 24, mono = false, className, title }: {
  size?: number;
  /** One-colour inversion: a light tile with the plates knocked out of it.
      For print, stamps, and anywhere the palette can't go. */
  mono?: boolean;
  className?: string;
  /** Given only when the mark stands alone; inside a lockup the word is the
      accessible name and a second one would be read out twice. */
  title?: string;
}) {
  const reduced = size < REDUCE_BELOW;
  const bleed = size < BLEED_BELOW;
  const plate = mono ? 'var(--grey-1000)' : null;

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {bleed
        ? <rect x="0" y="0" width="64" height="64" rx="13" fill={mono ? 'var(--grey-200)' : 'var(--grey-1000)'} />
        : <rect x="2.5" y="2.5" width="59" height="59" rx="12"
            fill={mono ? 'var(--grey-200)' : 'var(--grey-1000)'}
            stroke={mono ? 'var(--grey-400)' : 'var(--grey-750)'} />}

      {reduced ? (
        <>
          <rect x="22" y="14" width="29" height="11" rx="2" fill={plate ?? 'var(--blue-400)'} />
          <rect x="13" y="39" width="29" height="11" rx="2" fill={plate ?? 'var(--lime-500)'} />
        </>
      ) : (
        <>
          <rect x="22" y="12.5" width="29" height="10" rx="2" fill={plate ?? 'var(--blue-500)'} />
          <rect x="13" y="27" width="38" height="10" rx="2" fill={plate ?? 'var(--blue-400)'} />
          <rect x="13" y="41.5" width="29" height="10" rx="2" fill={plate ?? 'var(--lime-500)'} />
        </>
      )}
    </svg>
  );
}

/**
 * The lockup — mark plus name.
 *
 * `horizontal` is the primary: every bar, every header. The design sets the
 * plate height to the wordmark's cap height so mark and name share one optical
 * line, which comes out at a word roughly three quarters of the mark.
 *
 * `stacked` is the hero — plates over the name, for the sign-in splash and
 * anywhere the logo is the only thing on screen. The mark leads there, so the
 * word sits at about four tenths of it.
 *
 * The gap is one plate-step off the mark's own grid rather than a spacing
 * token, which is why it scales with `size` instead of stepping.
 */
export function Brandmark({ lockup = 'horizontal', size = 24, mono = false, href, style }: {
  lockup?: 'horizontal' | 'stacked';
  size?: number;
  mono?: boolean;
  /** Renders the lockup as a link — the topbar's way home. */
  href?: string;
  style?: CSSProperties;
}) {
  const stacked = lockup === 'stacked';
  const word = Math.max(14, Math.round(size * (stacked ? 0.36 : 0.72)));
  const inner = (
    <>
      <StackMark size={size} mono={mono} />
      <span className="word" style={{ fontSize: `${word}px` }}>{PRODUCT_NAME}</span>
    </>
  );
  const props = {
    className: `brandmark${stacked ? ' stacked' : ''}`,
    style: { gap: `${Math.round(size * (stacked ? 0.21 : 0.36))}px`, ...style },
  };
  return href
    ? <a {...props} href={href} aria-label={`${PRODUCT_NAME} — all projects`}>{inner}</a>
    : <span {...props}>{inner}</span>;
}
