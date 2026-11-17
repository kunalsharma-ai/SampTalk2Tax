'use client';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_PREFERENCES, LANGUAGES, type DisplayDateFormat, type Language, type NumberFormat } from '@talk2tax/accounting-engine';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { api } from './api';
import { setDisplayPreferences } from './format';
import { hi } from './messages/hi';

/**
 * Interface languages. English text is the key: a catalogue maps it to another language, and any
 * text a catalogue does not have is shown in English. Adding a language means adding a catalogue
 * here and its code in the engine's LANGUAGES (and the database check).
 */
const CATALOGUES: Record<Language, Record<string, string>> = { en: {}, hi };

export interface Preferences {
  language: Language;
  numberFormat: NumberFormat;
  dateFormat: DisplayDateFormat;
  timeZone: string | null;
}

export type Translate = (text: string, vars?: Record<string, string | number>) => string;

export function translate(language: Language, text: string, vars?: Record<string, string | number>): string {
  let out = CATALOGUES[language]?.[text] ?? text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

const I18nContext = createContext<{ language: Language; t: Translate; preferences: Preferences }>({
  language: 'en',
  t: (text, vars) => translate('en', text, vars),
  preferences: { ...DEFAULT_PREFERENCES, timeZone: null },
});

/** The signed-in person's preferences (from /v1/auth/me); English and defaults until known or when signed out. */
export function usePreferencesQuery() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<{ user: { id: string; name: string; email: string }; preferences: Preferences }>('/v1/auth/me'), staleTime: 5 * 60_000, retry: false });
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const me = usePreferencesQuery();
  const preferences: Preferences = me.data?.preferences ?? { ...DEFAULT_PREFERENCES, timeZone: null };
  // Set before the children render, so every formatter in this render uses these preferences.
  setDisplayPreferences(preferences);
  const language = preferences.language;
  useEffect(() => {
    document.documentElement.lang = language === 'hi' ? 'hi' : 'en';
    document.documentElement.dir = LANGUAGES.find((l) => l.code === language)?.dir ?? 'ltr';
  }, [language]);
  const key = `${preferences.language}|${preferences.numberFormat}|${preferences.dateFormat}|${preferences.timeZone ?? ''}`;
  return (
    <I18nContext.Provider value={{ language, preferences, t: (text, vars) => translate(language, text, vars) }}>
      {/* Remounted when a preference changes, so text formatted outside React state is redone. */}
      <div key={key} className="contents">
        {children}
      </div>
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
export function useT(): Translate {
  return useContext(I18nContext).t;
}
