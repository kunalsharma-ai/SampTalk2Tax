/**
 * Feature flags (M9 slice 6). Flags are declared here, in code, with what they switch and their
 * default; platform administrators turn them on or off for everyone, roll them out to a share of
 * organisations, or set them for one organisation. The share is decided by a stable hash of the
 * flag and the organisation, so an organisation keeps its answer as the share grows.
 */

export interface FlagDefinition {
  key: string;
  name: string;
  description: string;
  /** On or off when no administrator has set it. */
  defaultOn: boolean;
}

export const FEATURE_FLAGS = [
  { key: 'benchmarking', name: 'Benchmarking', description: 'Comparing an organisation with anonymised peers (Planning → Benchmarking).', defaultOn: true },
  { key: 'forecast-lab', name: 'Forecast lab', description: 'Backtesting forecast methods on the books (Planning → Forecast lab).', defaultOn: true },
  { key: 'disaster-simulation', name: 'Disaster simulation', description: 'Shock scenarios and stress tests (Planning → Disaster simulation).', defaultOn: true },
  { key: 'opportunities', name: 'Growth opportunities', description: 'Opportunity intelligence from the books (Planning → Growth opportunities).', defaultOn: true },
] as const satisfies readonly FlagDefinition[];

export type FlagKey = (typeof FEATURE_FLAGS)[number]['key'];

export function isFlagKey(k: string): k is FlagKey {
  return FEATURE_FLAGS.some((f) => f.key === k);
}

/** 0 to 99, the same every time for this flag and organisation (FNV-1a). */
export function flagBucket(key: string, orgId: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${key}:${orgId}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

export interface FlagSetting {
  /** Off stops it for everyone not overridden; on serves it to the rollout share. */
  enabled: boolean;
  /** 0 to 100: the share of organisations served while enabled. */
  rolloutPercent: number;
}

export type FlagReason = 'DEFAULT' | 'OFF' | 'ROLLOUT' | 'OVERRIDE';

/** Whether a flag is on for an organisation, and why. An organisation's own setting wins. */
export function evaluateFlag(def: FlagDefinition, setting: FlagSetting | null, orgId: string, override: boolean | null): { on: boolean; reason: FlagReason } {
  if (override !== null) return { on: override, reason: 'OVERRIDE' };
  if (!setting) return { on: def.defaultOn, reason: 'DEFAULT' };
  if (!setting.enabled) return { on: false, reason: 'OFF' };
  if (!Number.isInteger(setting.rolloutPercent) || setting.rolloutPercent < 0 || setting.rolloutPercent > 100) throw new RangeError('A rollout is a whole percentage from 0 to 100');
  return { on: flagBucket(def.key, orgId) < setting.rolloutPercent, reason: 'ROLLOUT' };
}
