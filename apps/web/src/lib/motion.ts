'use client';
import { motionReduced, type MotionPreference } from '@talk2tax/accounting-engine';
import { useEffect, useState } from 'react';

/**
 * Motion (DASH-038). The interface animates its transitions (pages rising in, charts growing,
 * 3D views gliding to where you send them, a flung globe coasting to a stop) unless the person
 * asks for stillness: their own choice (Language and formats → Motion) wins, otherwise the
 * device's reduced-motion setting. The answer is kept on <html data-motion="full|reduced">, which
 * the stylesheet and every animation read, so one switch stills the whole app.
 */
const QUERY = '(prefers-reduced-motion: reduce)';

export function deviceReducesMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches;
}

/** Whether to keep the interface still right now. */
export function isMotionReduced(): boolean {
  if (typeof document === 'undefined') return false;
  const m = document.documentElement.dataset.motion;
  if (m === 'reduced') return true;
  if (m === 'full') return false;
  return deviceReducesMotion();
}

/** Keeps <html data-motion> in step with the person's choice and the device setting. */
export function useMotionSync(preference: MotionPreference | undefined) {
  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.motion = motionReduced(preference, deviceReducesMotion()) ? 'reduced' : 'full';
    };
    apply();
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(QUERY);
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [preference]);
}

/** Whether to keep still, as React state that follows changes to the setting. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const read = () => setReduced(isMotionReduced());
    read();
    const watch = new MutationObserver(read);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    return () => watch.disconnect();
  }, []);
  return reduced;
}

export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** The way round from one angle to another that turns least, in degrees. */
export const shortestTurn = (from: number, to: number) => ((((to - from + 180) % 360) + 360) % 360) - 180;

/** Values between `from` and `to` at progress `t` (0..1), eased. */
export const between = (from: readonly number[], to: readonly number[], t: number) => from.map((f, i) => f + (to[i] - f) * easeInOut(Math.min(1, Math.max(0, t))));

/**
 * Glides from `from` to `to` over `ms`, calling `frame` on each animation frame, or once with `to`
 * when motion is reduced. Returns a function that stops it.
 */
export function tween(from: readonly number[], to: readonly number[], ms: number, frame: (v: number[]) => void, reduced = isMotionReduced()): () => void {
  if (reduced || ms <= 0 || typeof requestAnimationFrame !== 'function') {
    frame([...to]);
    return () => {};
  }
  let id = 0;
  const start = performance.now();
  const step = (now: number) => {
    const t = (now - start) / ms;
    frame(t >= 1 ? [...to] : between(from, to, t));
    if (t < 1) id = requestAnimationFrame(step);
  };
  id = requestAnimationFrame(step);
  return () => cancelAnimationFrame(id);
}

/**
 * After a drag, keeps turning with the speed it was let go at, slowing to a stop (friction per
 * frame). Does nothing when motion is reduced. Returns a function that stops it.
 */
export function coast(velocity: readonly number[], frame: (delta: number[]) => void, friction = 0.92, reduced = isMotionReduced()): () => void {
  if (reduced || typeof requestAnimationFrame !== 'function') return () => {};
  let v = [...velocity];
  let id = 0;
  const step = () => {
    v = v.map((x) => x * friction);
    if (v.every((x) => Math.abs(x) < 0.02)) return;
    frame(v);
    id = requestAnimationFrame(step);
  };
  id = requestAnimationFrame(step);
  return () => cancelAnimationFrame(id);
}
