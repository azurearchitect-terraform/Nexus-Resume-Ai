import React, { useId, useRef, useState } from 'react';
import { ArrowRight, Eye, EyeOff, Loader2 } from 'lucide-react';
import { TermsModal } from '../TermsModal';
import { AuthMode, authErrorCode, friendlyAuthError, passwordStrength, RESET_MESSAGE, signupPasswordError } from './authHelpers';
import './auth.css';

interface AuthFormProps {
  onGoogle: () => void | Promise<void>;
  onEmailLogin: (email: string, password: string) => Promise<void>;
  onEmailSignUp: (email: string, password: string) => Promise<void>;
  onPasswordReset: (email: string) => Promise<void>;
  externalError?: string | null;
  isDarkMode: boolean;
}

function GoogleMark() {
  return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285f4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
    <path fill="#34a853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
    <path fill="#fbbc05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
    <path fill="#ea4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
  </svg>;
}

export function AuthForm({ onGoogle, onEmailLogin, onEmailSignUp, onPasswordReset, externalError, isDarkMode }: AuthFormProps) {
  const id = useId();
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [loading, setLoading] = useState<'email' | 'google' | null>(null);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [ignoredExternal, setIgnoredExternal] = useState<string | null | undefined>(undefined);
  const [termsOpen, setTermsOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const strength = passwordStrength(password);
  const displayError = error || (externalError && externalError !== ignoredExternal ? friendlyAuthError(externalError) : null);
  const title = mode === 'login' ? 'Welcome back.' : mode === 'signup' ? 'Start your next chapter.' : 'Reset your password.';

  function changeMode(next: AuthMode) {
    setMode(next);
    setError(null);
    setMessage(null);
    setIgnoredExternal(externalError);
    setPassword('');
    setConfirmation('');
    setRevealed(false);
    setCapsLock(false);
    heading.current?.focus();
  }

  async function run(kind: 'email' | 'google') {
    if (busy.current) return;
    setError(null);
    setMessage(null);
    setIgnoredExternal(externalError);
    if (kind === 'email' && mode === 'signup') {
      const validation = signupPasswordError(password, confirmation);
      if (validation) { setError(validation); return; }
    }
    busy.current = true;
    setLoading(kind);
    try {
      if (kind === 'google') {
        // Await the runtime promise even when the legacy callback is typed void.
        await onGoogle();
      } else if (mode === 'login') {
        await onEmailLogin(email.trim(), password);
      } else if (mode === 'signup') {
        await onEmailSignUp(email.trim(), password);
      } else {
        await onPasswordReset(email.trim());
        setMessage(RESET_MESSAGE);
      }
    } catch (err: unknown) {
      if (kind === 'email' && mode === 'reset' && authErrorCode(err) === 'auth/user-not-found') {
        setMessage(RESET_MESSAGE);
      } else {
        setError(friendlyAuthError(err));
      }
    } finally {
      busy.current = false;
      setLoading(null);
      // Legacy Google handlers report failures through externalError, even identical retries.
      if (kind === 'google') setIgnoredExternal(undefined);
    }
  }

  function trackCaps(event: React.KeyboardEvent<HTMLInputElement>) {
    setCapsLock(event.getModifierState('CapsLock'));
  }

  return (
    <div className="auth-form-content">
      <span className="auth-eyebrow">YOUR NEXUS WORKSPACE</span>
      <h2 className="auth-form-title" ref={heading} tabIndex={-1}>{title}</h2>
      <p className="auth-form-description">{mode === 'login' ? 'Sign in to keep building your story.' : mode === 'signup' ? 'Create an account to save your resume workspace.' : 'Enter your email to request a reset link.'}</p>
      {displayError && <div className="auth-alert" role="alert">{displayError}</div>}
      {message && <div className="auth-success" role="status">{message}</div>}
      {mode !== 'reset' && <>
        <button className="auth-button auth-google" type="button" disabled={!!loading} onClick={() => void run('google')}>
          {loading === 'google' ? <Loader2 className="auth-spinner" size={20} aria-hidden="true" /> : <GoogleMark />}
          {loading === 'google' ? 'Connecting to Google…' : 'Continue with Google'}
        </button>
        <div className="auth-divider"><span />or use email<span /></div>
      </>}
      <form onSubmit={event => { event.preventDefault(); void run('email'); }} aria-busy={!!loading}>
        <fieldset disabled={!!loading} className="auth-fields">
          <div className="auth-field">
            <label htmlFor={`${id}-email`}>Email address</label>
            <input id={`${id}-email`} type="email" name="email" autoComplete="email" required
              value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com"
              autoCapitalize="none" spellCheck={false} />
          </div>
          {mode !== 'reset' && <div className="auth-field">
            <div className="auth-label-row"><label htmlFor={`${id}-password`}>Password</label>
              {mode === 'login' && <button className="auth-link" type="button" onClick={() => changeMode('reset')}>Forgot password?</button>}
            </div>
            <div className="auth-password">
              <input id={`${id}-password`} type={revealed ? 'text' : 'password'} name="password" required
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={mode === 'signup' ? 8 : undefined}
                value={password} onChange={event => setPassword(event.target.value)}
                onKeyDown={trackCaps} onKeyUp={trackCaps} onBlur={() => setCapsLock(false)}
                aria-describedby={`${id}-password-help`} />
              <button type="button" className="auth-reveal" aria-label={revealed ? 'Hide password' : 'Show password'}
                aria-pressed={revealed} aria-controls={`${id}-password`} onClick={() => setRevealed(!revealed)}>
                {revealed ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}
              </button>
            </div>
            <div id={`${id}-password-help`} className="auth-password-help">
              {mode === 'signup' && <><div className="auth-strength" aria-hidden="true">{[1, 2, 3].map(level => <span key={level} data-filled={level <= strength.level} />)}</div><p>{strength.label}</p></>}
              <span role="status">{capsLock ? 'Caps Lock is on.' : ''}</span>
            </div>
          </div>}
          {mode === 'signup' && <div className="auth-field">
            <label htmlFor={`${id}-confirm`}>Confirm password</label>
            <input id={`${id}-confirm`} type={revealed ? 'text' : 'password'} name="confirmPassword"
              autoComplete="new-password" required minLength={8} value={confirmation}
              onChange={event => setConfirmation(event.target.value)} onKeyDown={trackCaps} onKeyUp={trackCaps}
              onBlur={() => setCapsLock(false)} aria-describedby={`${id}-password-help`} />
          </div>}
          <button className="auth-button auth-primary" type="submit">
            {loading === 'email' ? <><Loader2 className="auth-spinner" size={19} aria-hidden="true" />Please wait…</> :
              <>{mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}<ArrowRight size={18} aria-hidden="true" /></>}
          </button>
        </fieldset>
      </form>
      <p className="auth-switch">{mode === 'login' ? 'New to Nexus AI?' : mode === 'signup' ? 'Already have an account?' : 'Remember your password?'}{' '}
        <button type="button" className="auth-link" disabled={!!loading} onClick={() => changeMode(mode === 'login' ? 'signup' : 'login')}>
          {mode === 'login' ? 'Create an account' : 'Sign in'}
        </button>
      </p>
      <p className="auth-terms-note">Review our <button className="auth-link" type="button" onClick={() => setTermsOpen(true)}>Terms & Conditions</button>. You’ll be asked to accept them before using the workspace.</p>
      <TermsModal isOpen={termsOpen} onAccept={() => setTermsOpen(false)} onClose={() => setTermsOpen(false)} isDarkMode={isDarkMode} readOnly />
    </div>
  );
}
