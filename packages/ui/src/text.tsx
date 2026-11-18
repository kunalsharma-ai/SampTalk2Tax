'use client';
import { createContext, useContext, type ReactNode } from 'react';

/**
 * Interface language for the shared components: the app provides a function that turns English
 * text into the reader's language (English text it does not know comes back unchanged). Outside a
 * provider, text is shown as written.
 */
export const UiTextContext = createContext<(text: string) => string>((text) => text);

/** Plain text in the reader's language. */
export function UiText({ text }: { text: string }) {
  return <>{useContext(UiTextContext)(text)}</>;
}

/** A label or heading: plain text is translated, anything else (links, numbers, markup) is left as it is. */
export function tx(node: ReactNode): ReactNode {
  return typeof node === 'string' && node.trim() ? <UiText text={node} /> : node;
}
