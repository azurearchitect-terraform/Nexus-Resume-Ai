import React from 'react';
import { FileCheck2, Moon, Sparkles, Sun, Target, TextQuote } from 'lucide-react';
import { AuthForm } from './auth/AuthForm';
import './auth/auth.css';

interface ProfessionalWelcomePageProps {
  onLogin: () => void;
  onEmailLogin: (email: string, pass: string) => Promise<void>;
  onEmailSignUp: (email: string, pass: string) => Promise<void>;
  onPasswordReset: (email: string) => Promise<void>;
  externalError?: string | null;
  isDarkMode: boolean;
  setIsDarkMode: (value: boolean) => void;
}

export function ProfessionalWelcomePage({
  onLogin, onEmailLogin, onEmailSignUp, onPasswordReset,
  externalError, isDarkMode, setIsDarkMode,
}: ProfessionalWelcomePageProps) {
  return (
    <div className="nexus-auth auth-page" data-auth-theme={isDarkMode ? 'dark' : 'light'}>
      <div className="auth-page-inner">
        <header className="auth-header">
          <a className="auth-brand" href="#auth-sign-in" aria-label="Nexus AI — go to sign in">
            <span className="auth-brand-mark"><Sparkles size={23} aria-hidden="true" /></span>
            <span>Nexus AI<span className="auth-brand-caption">RESUME WORKSPACE</span></span>
          </a>
          <button className="auth-icon-button" onClick={() => setIsDarkMode(!isDarkMode)}
            aria-label={`Switch to ${isDarkMode ? 'light' : 'dark'} theme`}>
            {isDarkMode ? <Sun size={20} aria-hidden="true" /> : <Moon size={20} aria-hidden="true" />}
          </button>
        </header>
        <main className="auth-split">
          <section className="auth-story" aria-labelledby="auth-story-title">
            <span className="auth-eyebrow"><span /> YOUR EXPERIENCE. YOUR NEXT CHAPTER.</span>
            <h1 id="auth-story-title">A resume that<br />speaks to the<br /><em>right audience.</em></h1>
            <p className="auth-story-intro">Turn the work you’ve done into a clear, tailored story for the role you want. Keep the facts. Find the focus.</p>
            <ul className="auth-value-list">
              <li><span className="auth-feature-icon"><Target aria-hidden="true" size={21} /></span><div><h2>Choose your AI audience</h2><p>AI reads the job description and picks the audience, from cloud architect to engineering director, with the JD evidence behind each pick.</p></div></li>
              <li><span className="auth-feature-icon"><TextQuote aria-hidden="true" size={21} /></span><div><h2>Evidence before embellishment</h2><p>Guide AI with bullet rules grounded in your experience. Review every claim before applying.</p></div></li>
              <li><span className="auth-feature-icon"><FileCheck2 aria-hidden="true" size={21} /></span><div><h2>Export for your application</h2><p>Export ATS-safe PDF and Word files, checked for Greenhouse and Workday parsing. Always check the final document and uploaded fields.</p></div></li>
            </ul>
            <div className="auth-story-note"><span className="auth-note-line" /> Built around your experience, not invented achievements.</div>
          </section>
          <section className="auth-entry" id="auth-sign-in" aria-label="Account access">
            <div className="auth-card">
              <AuthForm onGoogle={onLogin} onEmailLogin={onEmailLogin}
                onEmailSignUp={onEmailSignUp} onPasswordReset={onPasswordReset}
                externalError={externalError} isDarkMode={isDarkMode} />
            </div>
            <p className="auth-entry-note">Your next application starts with what you already know.</p>
          </section>
        </main>
        <footer className="auth-footer"><span>Nexus AI · Resume builder</span><span>AI assists. You stay in control.</span></footer>
      </div>
    </div>
  );
}
