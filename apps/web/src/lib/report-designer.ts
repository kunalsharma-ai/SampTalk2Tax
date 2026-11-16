/** Types for the report designer: layouts of sections, and reports produced from them each month. */
import type { AiStatus, Catalogue as DashboardCatalogue, DashboardData, Widget, WidgetData } from './dashboards';

export type SectionType = 'HEADING' | 'TEXT' | 'COMMENTARY' | 'WIDGET';
/** A section as edited: the type decides which field is used. */
export type ReportSection =
  | { type: 'HEADING'; text: string }
  | { type: 'TEXT'; text: string }
  | { type: 'COMMENTARY'; instruction: string }
  | { type: 'WIDGET'; widget: Widget };
export interface ReportLayout {
  sections: ReportSection[];
}
export interface Catalogue extends DashboardCatalogue {
  sectionLimit: number;
}
export interface RunSummary {
  id: string;
  number: string;
  month: string;
  title: string | null;
  status: 'DRAFT' | 'FINAL';
  updatedBy: string;
  updatedAt: string;
  finalisedAt: string | null;
}
export interface DesignItem {
  id: string;
  number: string;
  name: string;
  description: string | null;
  layout: ReportLayout;
  descriptions: string[];
  version: number;
  createdBy: string;
  updatedBy: string;
  updatedAt: string;
}
export interface DesignListItem extends DesignItem {
  reports: number;
  lastMonth: string | null;
}
export interface DesignDetail extends DesignItem {
  reports: RunSummary[];
}
export interface CommentaryEntry {
  section: number;
  instruction: string;
  text: string;
  source: 'AI' | 'PERSON' | 'NONE';
  issues: string[];
}
export interface ReportDetail extends RunSummary {
  designId: string;
  designName: string;
  currency: string;
  inProgress: boolean;
  layout: ReportLayout;
  widgets: WidgetData[];
  facts: string;
  commentary: CommentaryEntry[];
  version: number;
  createdBy: string;
  finalisedBy: string | null;
}
export interface Preview extends DashboardData {
  layout: ReportLayout;
  descriptions: string[];
}
export interface AiDraft {
  name: string;
  description: string;
  layout: ReportLayout;
  notes: string[];
  questions: string[];
  issues: string[];
  descriptions: string[];
  preview: DashboardData | null;
  model: string;
}
export type { AiStatus };
export const SECTION_LABELS: Record<SectionType, string> = { HEADING: 'Heading', TEXT: 'Fixed text', COMMENTARY: 'Monthly commentary', WIDGET: 'Figures' };
