/**
 * Report designer. A report layout is a list of sections: headings, fixed text written by
 * people, commentary written for each month (by the AI from the report's own figures, or by a
 * person), and figures, charts and tables of approved metrics (the dashboard widgets). The
 * engine checks layouts, works out every figure from the books, and turns the figures into the
 * facts the commentary must stick to: commentary quoting a number not in the facts is rejected.
 *
 * No framework or database code.
 */
import { checkSummaryFigures } from './cfo';
import { checkDashboard, DASHBOARD_METRICS, describeDashboard, type DashboardConfig, type Widget, type WidgetData } from './dashboards';

export const MAX_REPORT_SECTIONS = 30;
export const SECTION_TYPES = ['HEADING', 'TEXT', 'COMMENTARY', 'WIDGET'] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export type ReportSection =
  | { type: 'HEADING'; text: string }
  | { type: 'TEXT'; text: string }
  /** Commentary written for each month; `instruction` says what it should cover. */
  | { type: 'COMMENTARY'; instruction: string }
  | { type: 'WIDGET'; widget: Widget };

export interface ReportLayout {
  sections: ReportSection[];
}

/**
 * Checks a layout. Returns it cleaned and every problem in words, each prefixed with the
 * section it is about. Widgets are checked exactly as on a dashboard.
 */
export function checkReportLayout(input: unknown): { layout: ReportLayout; issues: string[] } {
  const issues: string[] = [];
  const raw = (input && typeof input === 'object' ? (input as { sections?: unknown }).sections : undefined) as unknown[] | undefined;
  if (!Array.isArray(raw) || !raw.length) return { layout: { sections: [] }, issues: ['Add at least one section'] };
  if (raw.length > MAX_REPORT_SECTIONS) issues.push(`At most ${MAX_REPORT_SECTIONS} sections in a report`);
  const sections: ReportSection[] = [];
  raw.slice(0, MAX_REPORT_SECTIONS).forEach((s0, i) => {
    const at = `Section ${i + 1}`;
    const s = (s0 && typeof s0 === 'object' ? s0 : {}) as Record<string, unknown>;
    const text = (k: string, max: number, what: string) => {
      const v = typeof s[k] === 'string' ? (s[k] as string).trim() : '';
      if (!v) issues.push(`${at}: ${what}`);
      else if (v.length > max) issues.push(`${at}: keep it under ${max} characters`);
      return v;
    };
    switch (s.type) {
      case 'HEADING':
        sections.push({ type: 'HEADING', text: text('text', 120, 'write the heading') });
        break;
      case 'TEXT':
        sections.push({ type: 'TEXT', text: text('text', 4000, 'write the text') });
        break;
      case 'COMMENTARY':
        sections.push({ type: 'COMMENTARY', instruction: text('instruction', 500, 'say what the commentary should cover') });
        break;
      case 'WIDGET': {
        const r = checkDashboard({ widgets: [s.widget] });
        issues.push(...r.issues.map((x) => `${at}: ${x.replace(/^Widget 1: /, '')}`));
        sections.push({ type: 'WIDGET', widget: (r.config.widgets[0] ?? s.widget) as Widget });
        break;
      }
      default:
        issues.push(`${at}: choose a kind of section (heading, text, commentary or figures)`);
    }
  });
  if (!sections.some((s) => s.type === 'WIDGET')) issues.push('Add at least one section of figures, so the report has something to report');
  return { layout: { sections }, issues };
}

/** The layout's widgets, as a dashboard, so their figures are worked out together. */
export function layoutWidgets(layout: ReportLayout): DashboardConfig {
  return { widgets: layout.sections.flatMap((s) => (s.type === 'WIDGET' ? [s.widget] : [])) };
}

/** A layout in words, for checking an AI draft. */
export function describeLayout(layout: ReportLayout): string[] {
  const widgets = describeDashboard(layoutWidgets(layout));
  let w = 0;
  return layout.sections.map((s) => {
    switch (s.type) {
      case 'HEADING':
        return `Heading: ${s.text}`;
      case 'TEXT':
        return `Text: ${s.text.length > 80 ? `${s.text.slice(0, 77)}…` : s.text}`;
      case 'COMMENTARY':
        return `Commentary: ${s.instruction}`;
      case 'WIDGET':
        return widgets[w++]!;
    }
  });
}

const fmt = (v: string | null, unit: string, currency: string) => (v === null ? 'no value' : unit === 'MONEY' ? `${currency} ${v}` : unit === 'PERCENT' ? `${v}%` : unit === 'RATIO' ? `${v} times` : unit === 'DAYS' ? `${v} days` : `${v} months`);

/**
 * The facts the commentary must stick to: every figure the report shows, in words. Commentary
 * may only quote numbers that appear here.
 */
export function reportFacts(layout: ReportLayout, data: WidgetData[], month: string, currency: string): string {
  const lines = [`Report for ${month}, currency ${currency}. Figures from the posted books.`];
  const widgets = layoutWidgets(layout).widgets;
  data.forEach((d, i) => {
    const title = widgets[i]?.title ?? `Figures ${i + 1}`;
    if (d.type === 'STAT') {
      lines.push(`- ${title}: ${d.metric.label} for ${d.month} is ${fmt(d.value, d.metric.unit, currency)}${d.compareMonth ? `; ${d.compareMonth} was ${fmt(d.compareValue, d.metric.unit, currency)}${d.change !== null ? `, a change of ${fmt(d.change, d.metric.unit, currency)}` : ''}` : ''}.${d.value === null && d.reason ? ` (${d.reason})` : ''}`);
    } else if (d.type === 'TOP_CUSTOMERS') {
      lines.push(`- ${title}: revenue from ${d.from} to ${d.to} was ${currency} ${d.total}.`);
      for (const r of d.rows) lines.push(`  - ${r.name}: ${currency} ${r.revenue}${r.share ? ` (${r.share}% of revenue)` : ''}`);
      if (d.others.count) lines.push(`  - ${d.others.count} others: ${currency} ${d.others.revenue}`);
    } else if (d.type === 'UNAVAILABLE') {
      lines.push(`- ${title}: not available (${d.reason}).`);
    } else {
      lines.push(`- ${title}, by month:`);
      for (const r of d.rows) lines.push(`  - ${r.month}: ${d.metrics.map((m) => `${m.label} ${fmt(r.values[m.key] ?? null, m.unit, currency)}`).join('; ')}`);
    }
  });
  return lines.join('\n');
}

/** Numbers in commentary that are not in the report's facts. */
export function checkCommentary(text: string, facts: string): string[] {
  return checkSummaryFigures(text, facts);
}

export const REPORT_METRIC_KEYS = DASHBOARD_METRICS.map((m) => m.key);
