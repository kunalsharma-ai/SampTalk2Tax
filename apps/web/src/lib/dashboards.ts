/** Types for dashboards of approved metrics. */
import type { KpiUnit } from './kpis';

export type WidgetType = 'STAT' | 'LINE' | 'BAR' | 'TABLE' | 'TOP_CUSTOMERS';
export type WidgetSize = 'SMALL' | 'MEDIUM' | 'LARGE';
export type Comparison = 'PREVIOUS_MONTH' | 'SAME_MONTH_LAST_YEAR' | 'NONE';
export interface Metric {
  key: string;
  label: string;
  unit: KpiUnit;
  better: 'HIGHER' | 'LOWER';
  group: string;
  formula: string;
}
/** A widget as edited: every field present, the type deciding which are used. */
export interface Widget {
  type: WidgetType;
  title: string;
  size?: WidgetSize;
  metric?: string;
  metrics?: string[];
  compare?: Comparison;
  months?: number;
  count?: number;
}
export interface DashboardConfig {
  widgets: Widget[];
}
export interface Catalogue {
  metrics: Metric[];
  widgetTypes: { type: WidgetType; label: string }[];
  sizes: WidgetSize[];
  comparisons: Comparison[];
  limits: { widgets: number; months: number };
}
export type WidgetData =
  | { type: 'STAT'; metric: Metric; value: string | null; reason: string | null; month: string; compareMonth: string | null; compareValue: string | null; change: string | null; better: boolean | null }
  | SeriesData
  | { type: 'TOP_CUSTOMERS'; from: string; to: string; total: string; rows: { id: string; name: string; revenue: string; share: string | null }[]; others: { count: number; revenue: string; share: string | null } }
  | { type: 'UNAVAILABLE'; reason: string };
export interface SeriesData {
  type: 'LINE' | 'BAR' | 'TABLE';
  metrics: Metric[];
  rows: { month: string; values: Record<string, string | null> }[];
}
export interface DashboardData {
  currency: string;
  month: string;
  to: string;
  inProgress: boolean;
  widgets: WidgetData[];
}
export interface DashboardItem {
  id: string;
  number: string;
  name: string;
  description: string | null;
  config: DashboardConfig;
  descriptions: string[];
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}
export type DashboardDetail = DashboardItem & DashboardData;
export interface Preview extends DashboardData {
  config: DashboardConfig;
  descriptions: string[];
}
export interface AiDraft {
  draftId: string;
  name: string;
  description: string;
  config: DashboardConfig;
  notes: string[];
  questions: string[];
  issues: string[];
  descriptions: string[];
  data: DashboardData | null;
  model: string;
}
export interface AiStatus {
  configured: boolean;
  model: string | null;
  available: boolean;
  reason: string | null;
}
export const COMPARISON_LABELS: Record<Comparison, string> = { PREVIOUS_MONTH: 'Against the month before', SAME_MONTH_LAST_YEAR: 'Against the same month last year', NONE: 'No comparison' };
export const SIZE_LABELS: Record<WidgetSize, string> = { SMALL: 'Small', MEDIUM: 'Medium', LARGE: 'Full width' };
