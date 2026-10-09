import React, { useId, useRef } from 'react';
import { Sparkles, X } from 'lucide-react';
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail,
  GoogleAuthProvider, signInWithPopup, browserPopupRedirectResolver,
} from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { AuthForm } from './auth/AuthForm';
import { useAuthDialog } from './auth/useAuthDialog';
import './auth/auth.css';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDarkMode: boolean;
  onSuccess: () => void;
}

export function AuthModal({ isOpen, onClose, isDarkMode, onSuccess }: AuthModalProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const title = useId();
  useAuthDialog(dialog, isOpen, onClose);

  async function finish(action: Promise<unknown>) {
    await action;
    onSuccess();
    onClose();
  }

  async function handleGoogleLogin() {
    const provider = new GoogleAuthProvider();
    provider.addScope('https://www.googleapis.com/auth/drive');
    const result = await signInWithPopup(auth, provider, browserPopupRedirectResolver);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken && auth.currentUser) {
      await setDoc(doc(db, 'users', auth.currentUser.uid), {
        driveAccessToken: credential.accessToken,
        settings: { isDriveConnected: true },
      }, { merge: true });
    }
    onSuccess();
    onClose();
  }

  if (!isOpen) return null;

  return (
    <div className="nexus-auth auth-modal-backdrop" data-auth-theme={isDarkMode ? 'dark' : 'light'}>
      <div className="auth-modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={title} tabIndex={-1}>
        <header className="auth-modal-header">
          <span id={title} className="auth-brand"><Sparkles size={22} aria-hidden="true" />Nexus AI account</span>
          <button className="auth-icon-button" type="button" aria-label="Close sign-in dialog" onClick={onClose}><X size={20} aria-hidden="true" /></button>
        </header>
        <AuthForm isDarkMode={isDarkMode} onGoogle={handleGoogleLogin}
          onEmailLogin={(email, password) => finish(signInWithEmailAndPassword(auth, email, password))}
          onEmailSignUp={(email, password) => finish(createUserWithEmailAndPassword(auth, email, password))}
          onPasswordReset={email => sendPasswordResetEmail(auth, email)} />
      </div>
    </div>
  );
}
