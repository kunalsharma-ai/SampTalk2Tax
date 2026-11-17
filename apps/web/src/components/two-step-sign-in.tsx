'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input } from '@talk2tax/ui';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';

interface MfaStatus {
  enabled: boolean;
  pending: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}
interface Setup {
  secret: string;
  otpauthUri: string;
  issuer: string;
  account: string;
}
interface WithCodes {
  recoveryCodes: string[];
  status: MfaStatus;
}

/** The secret in groups of four, easier to type into an app by hand. */
const grouped = (s: string) => s.match(/.{1,4}/g)?.join(' ') ?? s;

function QrImage({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 1, width: 360 }).then((u) => live && setSrc(u));
    return () => {
      live = false;
    };
  }, [value]);
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} alt="QR code for your authenticator app" width={180} height={180} className="rounded border border-line bg-white p-1" /> : <div className="h-[180px] w-[180px] rounded border border-line" />;
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `Talk2Tax recovery codes\nEach code works once, in place of a code from your app.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'talk2tax-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="warning" title="Save your recovery codes now">
        If you lose your phone, each of these codes signs you in once. They are shown only this once: keep them somewhere safe, such as a password manager.
      </Alert>
      <ol aria-label="Recovery codes" className="grid max-w-md grid-cols-2 gap-2 font-mono text-sm">
        {codes.map((c) => (
          <li key={c} className="rounded border border-line px-2 py-1">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true))}>
          {copied ? 'Copied' : 'Copy codes'}
        </Button>
        <Button size="sm" variant="secondary" onClick={download}>
          Download as text
        </Button>
        <Button size="sm" onClick={onDone}>
          I have saved them
        </Button>
      </div>
    </div>
  );
}

/**
 * Two-step sign-in (SEC-005) on the account page: turn it on with an authenticator app, see how
 * many recovery codes are left, replace them, or turn it off.
 */
export function TwoStepSignInCard() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['auth-mfa'], queryFn: () => api<MfaStatus>('/v1/auth/mfa') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['auth-mfa'] });
  // Organisations that require two-step sign-in open once it is on: only after the recovery
  // codes were saved, or this card (shown in their place) would go before the codes are seen.
  const reopenOrgs = () => qc.invalidateQueries({ queryKey: ['orgs'] });
  const [mode, setMode] = useState<'idle' | 'password' | 'scan' | 'codes' | 'replace' | 'disable'>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const reset = () => {
    setPassword('');
    setCode('');
  };

  const start = useMutation({
    mutationFn: () => api<Setup>('/v1/auth/mfa/setup', { method: 'POST', body: { password } }),
    onSuccess: (s) => {
      setSetup(s);
      reset();
      setMode('scan');
    },
  });
  const confirm = useMutation({
    mutationFn: () => api<WithCodes>('/v1/auth/mfa/confirm', { method: 'POST', body: { code } }),
    onSuccess: (r) => {
      setCodes(r.recoveryCodes);
      setSetup(null);
      reset();
      setMode('codes');
      refresh();
    },
  });
  const replace = useMutation({
    mutationFn: () => api<WithCodes>('/v1/auth/mfa/recovery-codes', { method: 'POST', body: { code } }),
    onSuccess: (r) => {
      setCodes(r.recoveryCodes);
      reset();
      setMode('codes');
      refresh();
    },
  });
  const disable = useMutation({
    mutationFn: () => api<MfaStatus>('/v1/auth/mfa/disable', { method: 'POST', body: { password, code } }),
    onSuccess: () => {
      reset();
      setMode('idle');
      refresh();
      void reopenOrgs();
    },
  });
  const error = start.error ?? confirm.error ?? replace.error ?? disable.error;
  const s = status.data;
  const cancel = () => {
    reset();
    setMode('idle');
    [start, confirm, replace, disable].forEach((m) => m.reset());
  };

  return (
    <Card className="mb-6">
      <CardHeader
        title="Two-step sign-in"
        description="After your password, Talk2Tax also asks for a 6-digit code from an authenticator app on your phone, so a stolen password alone cannot open your books."
        actions={s ? s.enabled ? <Badge tone="positive">On</Badge> : <Badge>Off</Badge> : null}
      />
      <div className="flex flex-col gap-4 px-5 pb-5 pt-2">
        {error ? <Alert title="That did not work">{error.message}</Alert> : null}
        {disable.isSuccess && mode === 'idle' ? <Alert tone="positive" title="Two-step sign-in is off">Your password alone signs you in now.</Alert> : null}

        {mode === 'codes' && codes ? <RecoveryCodes codes={codes} onDone={() => { setCodes(null); setMode('idle'); void reopenOrgs(); }} /> : null}

        {mode === 'idle' && s && !s.enabled ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-muted">Use any authenticator app: Google Authenticator, Microsoft Authenticator, 1Password, Authy or another that supports time-based codes.</p>
            <div>
              <Button onClick={() => setMode('password')}>Turn on two-step sign-in</Button>
            </div>
          </div>
        ) : null}

        {mode === 'idle' && s?.enabled ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              On since {s.enabledAt ? dateTime(s.enabledAt) : '—'}. <span className={s.recoveryCodesLeft <= 3 ? 'font-medium text-negative' : 'text-fg-muted'}>{s.recoveryCodesLeft} of 10 recovery codes left.</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setMode('replace')}>
                Get new recovery codes
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode('disable')}>
                Turn off
              </Button>
            </div>
          </div>
        ) : null}

        {mode === 'password' ? (
          <form className="flex max-w-md flex-col gap-3" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
            <Field label="Your password" hint="Needed to set up two-step sign-in.">
              {(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
            <div className="flex gap-2">
              <Button type="submit" loading={start.isPending} disabled={!password}>Continue</Button>
              <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
            </div>
          </form>
        ) : null}

        {mode === 'scan' && setup ? (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); confirm.mutate(); }}>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>In your authenticator app, add an account and scan this QR code.</li>
              <li>Or type the key by hand: account {setup.account}, time-based.</li>
              <li>Type the 6-digit code the app now shows for Talk2Tax.</li>
            </ol>
            <div className="flex flex-wrap items-start gap-6">
              <QrImage value={setup.otpauthUri} />
              <div className="text-sm">
                <div className="text-fg-muted">Key</div>
                <code data-testid="mfa-secret" className="mt-1 block break-all font-mono text-base tracking-wider">{grouped(setup.secret)}</code>
              </div>
            </div>
            <div className="flex max-w-md flex-col gap-3">
              <Field label="Code from the app">
                {(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />}
              </Field>
              <div className="flex gap-2">
                <Button type="submit" loading={confirm.isPending} disabled={code.replace(/\s/g, '').length !== 6}>Turn on</Button>
                <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
              </div>
            </div>
          </form>
        ) : null}

        {mode === 'replace' ? (
          <form className="flex max-w-md flex-col gap-3" onSubmit={(e) => { e.preventDefault(); replace.mutate(); }}>
            <p className="text-sm text-fg-muted">New codes replace all the old ones, used or not.</p>
            <Field label="Code from the app">
              {(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />}
            </Field>
            <div className="flex gap-2">
              <Button type="submit" loading={replace.isPending} disabled={code.replace(/\s/g, '').length !== 6}>Get new codes</Button>
              <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
            </div>
          </form>
        ) : null}

        {mode === 'disable' ? (
          <form className="flex max-w-md flex-col gap-3" onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
            <p className="text-sm text-fg-muted">Your password alone will sign you in again. Your recovery codes stop working.</p>
            <Field label="Your password">
              {(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
            <Field label="Code from the app or a recovery code">
              {(p) => <Input {...p} autoComplete="one-time-code" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />}
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="danger" loading={disable.isPending} disabled={!password || code.trim().length < 6}>Turn off two-step sign-in</Button>
              <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
