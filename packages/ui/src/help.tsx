'use client';
import { createContext, useContext, type ReactNode } from 'react';

/**
 * How a section's (i) help is found: given the section's title, the app returns the help control
 * to show beside it, or null for none. The app provides it once, around its pages.
 */
export const SectionHelpContext = createContext<((title: string) => ReactNode) | null>(null);

/** The help control for a section title, from the app's resolver (nothing outside one). */
export function SectionHelpSlot({ title }: { title: string }) {
  const resolve = useContext(SectionHelpContext);
  return resolve ? <>{resolve(title)}</> : null;
}
