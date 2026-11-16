'use client';
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';

export interface InvoiceFrameHandle {
  print: () => void;
}

/**
 * Shows a rendered invoice page. The page is a separate document in a sandboxed frame: no
 * script in it can run (no allow-scripts) and its own Content-Security-Policy stops it loading
 * anything from the network. allow-same-origin lets this page size the frame and call print.
 */
export const InvoiceFrame = forwardRef<InvoiceFrameHandle, { html: string; title: string; scale?: number; className?: string }>(function InvoiceFrame({ html, title, scale = 1, className }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(1120);
  const measure = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (doc?.body) setHeight(Math.max(600, doc.documentElement.scrollHeight + 8));
  }, []);
  useImperativeHandle(ref, () => ({ print: () => frame.current?.contentWindow?.print() }), []);
  return (
    <div className={className} style={{ height: height * scale, overflow: 'hidden' }}>
      <iframe
        ref={frame}
        title={title}
        srcDoc={html}
        sandbox="allow-same-origin allow-modals"
        onLoad={measure}
        className="block w-full rounded-md border border-line bg-white shadow-sm"
        style={{ height, width: `${100 / scale}%`, transform: scale === 1 ? undefined : `scale(${scale})`, transformOrigin: 'top left' }}
      />
    </div>
  );
});
