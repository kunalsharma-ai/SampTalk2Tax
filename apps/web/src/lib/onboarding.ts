export type OnboardingStatus = 'OPEN' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

export const ONBOARDING_STATUS: Record<OnboardingStatus, { label: string; tone: 'accent' | 'warning' | 'positive' | 'negative' }> = {
  OPEN: { label: 'In progress', tone: 'accent' },
  SUBMITTED: { label: 'Waiting for approval', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'positive' },
  REJECTED: { label: 'Rejected', tone: 'negative' },
};

export interface Onboarding {
  id: string;
  status: OnboardingStatus;
  contact: { id: string; name: string; creditLimit: string | null; paymentTermsDays: number };
  creditLimit: string | null;
  paymentTermsDays: number | null;
  notes: string | null;
  details: { key: string; label: string; done: boolean; hint: string }[];
  checks: { id: string; label: string; needsFile: boolean; done: boolean; doneBy: string | null; doneAt: string | null; note: string | null; file: { id: string; fileName: string } | null; fileRemoved: boolean }[];
  files: { id: string; fileName: string }[];
  progress: number;
  issues: string[];
  submittedBy: string | null;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  selfApproved: boolean;
  submitterMayDecide: boolean;
  createdAt: string;
}

export interface ContactOnboarding {
  onboarding: Onboarding | null;
  can: { manage: boolean; decide: boolean; setUp: boolean; start?: boolean };
}

export interface OnboardingList {
  required: boolean;
  onboardings: { id: string; status: OnboardingStatus; contact: { id: string; name: string }; progress: number; creditLimit: string | null; paymentTermsDays: number | null; submittedAt: string | null; decidedAt: string | null; createdAt: string }[];
  counts: Record<OnboardingStatus, number>;
  can: { manage: boolean; decide: boolean; setUp: boolean };
}

export interface OnboardingSettings {
  required: boolean;
  requirements: { id: string; label: string; needsFile: boolean }[];
  can: { manage: boolean; decide: boolean; setUp: boolean };
}
