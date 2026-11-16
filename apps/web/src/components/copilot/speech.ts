'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/** The parts of the Web Speech API used here (not in TypeScript's DOM types everywhere). */
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionClass = new () => Recognition;

function recognitionClass(): RecognitionClass | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'The browser was not allowed to use the microphone. Allow it in the address bar, then try again.',
  'service-not-allowed': 'The browser was not allowed to use the microphone. Allow it in the address bar, then try again.',
  'no-speech': 'Nothing was heard. Try again a little closer to the microphone.',
  'audio-capture': 'No microphone was found.',
  network: "The browser's speech service could not be reached. Type the question instead.",
};

/**
 * Speech to text in the browser. The browser turns speech into text (in Chrome and Edge this uses
 * the browser maker's speech service); Talk2Tax only receives the text.
 */
export function useSpeechInput(onFinal: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const final = useRef('');
  const done = useRef(onFinal);
  done.current = onFinal;
  useEffect(() => setSupported(!!recognitionClass()), []);
  useEffect(() => () => rec.current?.abort(), []);

  const start = useCallback(() => {
    const C = recognitionClass();
    if (!C || rec.current) return;
    const r = new C();
    r.lang = 'en-IN';
    r.interimResults = true;
    r.continuous = false;
    final.current = '';
    setHeard('');
    setError(null);
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) final.current += res[0].transcript;
        else interim += res[0].transcript;
      }
      setHeard((final.current + interim).trim());
    };
    r.onerror = (e) => setError(ERRORS[e.error] ?? `Speech could not be turned into text (${e.error}).`);
    r.onend = () => {
      rec.current = null;
      setListening(false);
      const text = final.current.trim();
      if (text) done.current(text);
    };
    rec.current = r;
    setListening(true);
    r.start();
  }, []);
  const stop = useCallback(() => rec.current?.stop(), []);
  return { supported, listening, heard, error, start, stop };
}

/** Plain text for reading aloud: markdown marks and table pipes removed. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/[*_`#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canSpeak() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function speak(text: string) {
  if (!canSpeak()) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(speakable(text));
  u.lang = 'en-IN';
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (canSpeak()) window.speechSynthesis.cancel();
}
