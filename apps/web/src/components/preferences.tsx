'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { COMMON_TIME_ZONES, DISPLAY_DATE_FORMATS, displayDate, displayDateTime, displayMoney, LANGUAGES, NUMBER_FORMATS, timeZoneLabel, type DisplayDateFormat, type Language, type NumberFormat } from '@talk2tax/accounting-engine';
import { Button, Card, CardHeader, Field, Select } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';
import { useI18n, type Preferences } from '@/lib/i18n';
import { useOrg } from '@/lib/org';
import { can, type Org } from '@/lib/types';

const SAMPLE_AMOUNT = '1234567.89';
const SAMPLE_DATE = '2026-03-31';

/** The zones offered: the common ones, plus whatever is set now. */
function zones(...extra: (string | null | undefined)[]): string[] {
  return [...new Set([...COMMON_TIME_ZONES, ...extra.filter((z): z is string => !!z)])];
}

/** The signed-in person's language, number and date formats and time zone. */
export function PreferencesCard() {
  const { t, preferences } = useI18n();
  const { org } = useOrg();
  const qc = useQueryClient();
  const [language, setLanguage] = useState<Language>(preferences.language);
  const [numberFormat, setNumberFormat] = useState<NumberFormat>(preferences.numberFormat);
  const [dateFormat, setDateFormat] = useState<DisplayDateFormat>(preferences.dateFormat);
  const [timeZone, setTimeZone] = useState<string>(preferences.timeZone ?? '');
  const save = useMutation({
    mutationFn: () => api<Preferences>('/v1/auth/me/preferences', { method: 'PUT', body: { language, numberFormat, dateFormat, timeZone: timeZone || null } }),
    // The whole app re-renders in the new language and formats.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const currency = org?.functionalCurrency ?? 'INR';
  const zone = timeZone || org?.timeZone || 'Asia/Kolkata';
  const changed = language !== preferences.language || numberFormat !== preferences.numberFormat || dateFormat !== preferences.dateFormat || (timeZone || null) !== preferences.timeZone;
  let sample = '';
  try {
    sample = `${displayMoney(SAMPLE_AMOUNT, currency, numberFormat)} · ${displayDate(SAMPLE_DATE, dateFormat, language)} · ${displayDateTime(new Date(), { dateFormat, timeZone: zone, language })}`;
  } catch {
    sample = '';
  }
  return (
    <Card className="mb-6" aria-label={t('Language and formats')}>
      <CardHeader title={t('Language and formats')} description={t('How Talk2Tax looks to you. These are your own choices and apply in every organisation. They change how things are shown, never the figures or any tax or legal rule.')} />
      <form
        className="grid gap-4 px-5 pb-5 pt-4 sm:grid-cols-2 xl:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t('Language')}>
          {(p) => (
            <Select {...p} value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.nativeName === l.name ? l.name : `${l.nativeName} (${l.name})`}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('Number format')}>
          {(p) => (
            <Select {...p} value={numberFormat} onChange={(e) => setNumberFormat(e.target.value as NumberFormat)}>
              {NUMBER_FORMATS.map((f) => <option key={f.code} value={f.code}>{t(f.label)}{f.example ? `: ${f.example}` : ''}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('Date format')}>
          {(p) => (
            <Select {...p} value={dateFormat} onChange={(e) => setDateFormat(e.target.value as DisplayDateFormat)}>
              {DISPLAY_DATE_FORMATS.map((f) => <option key={f.code} value={f.code}>{t(f.label)}: {f.example}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('Time zone')}>
          {(p) => (
            <Select {...p} value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
              <option value="">{t("The organisation's ({zone})", { zone: org?.timeZone ?? 'Asia/Kolkata' })}</option>
              {zones(preferences.timeZone).map((z) => <option key={z} value={z}>{timeZoneLabel(z)}</option>)}
            </Select>
          )}
        </Field>
        <p className="text-sm text-fg-muted sm:col-span-2 xl:col-span-3" data-testid="preferences-preview">
          <span className="font-medium text-fg">{t('Preview')}:</span> <span className="num">{sample}</span>
        </p>
        <div className="flex items-center justify-end gap-3">
          {save.isSuccess && !changed ? <span role="status" className="text-sm text-positive">{t('Saved')}</span> : null}
          <Button type="submit" disabled={!changed} loading={save.isPending}>{t('Save')}</Button>
        </div>
        <div className="sm:col-span-2 xl:col-span-4">
          <ErrorAlert title={t('Not saved')} error={save.error} />
        </div>
      </form>
    </Card>
  );
}

/** The organisation's time zone; owners and admins change it. */
export function OrganisationTimeZoneCard() {
  const { t } = useI18n();
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [zone, setZone] = useState<string>(org?.timeZone ?? 'Asia/Kolkata');
  const save = useMutation({
    mutationFn: () => api<Org>(`/v1/orgs/${orgId}/time-zone`, { method: 'PUT', body: { timeZone: zone } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orgs'] }),
  });
  if (!org) return null;
  const manage = can(org.role, 'org.manage');
  return (
    <Card className="mb-6" aria-label={t('Organisation time zone')}>
      <CardHeader title={`${t('Organisation time zone')}: ${org.name}`} description={t('Times in this organisation are shown in this zone for everyone who has not chosen their own. Business dates such as today, due dates and periods follow the country rules, not this setting.')} />
      <div className="flex flex-wrap items-end gap-3 px-5 pb-5 pt-4">
        <Field label={t('Time zone')}>
          {(p) => (
            <Select {...p} className="w-80" value={zone} disabled={!manage} onChange={(e) => setZone(e.target.value)}>
              {zones(org.timeZone).map((z) => <option key={z} value={z}>{timeZoneLabel(z)}</option>)}
            </Select>
          )}
        </Field>
        {manage ? (
          <Button variant="secondary" disabled={zone === org.timeZone} loading={save.isPending} onClick={() => save.mutate()}>
            {t('Save')}
          </Button>
        ) : (
          <p className="pb-2 text-sm text-fg-muted">{t('Only owners and admins can change it.')}</p>
        )}
        <div className="w-full">
          <ErrorAlert title={t('Not saved')} error={save.error} />
        </div>
      </div>
    </Card>
  );
}
