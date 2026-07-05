import { useEffect, useRef, type ReactNode } from 'react';

// closeOnOverlay (default true): whether a click on the backdrop dismisses.
// Callers with unsaved content set it false so only Escape/explicit buttons
// close. Overlay clicks only count when the press STARTED on the overlay —
// selecting text inside the modal and releasing outside no longer dismisses.
export function Modal({ onClose, wide, closeOnOverlay = true, children }: {
  onClose: () => void; wide?: boolean; closeOnOverlay?: boolean; children: ReactNode;
}) {
  const pressedOverlay = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => { pressedOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (closeOnOverlay && pressedOverlay.current && e.target === e.currentTarget) onClose();
        pressedOverlay.current = false;
      }}
    >
      <div className={`modal ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}
