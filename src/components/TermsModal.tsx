import React, { useId, useRef } from 'react';
import { motion } from 'motion/react';
import { AlertCircle, FileText, Check, X } from 'lucide-react';
import { doc, updateDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { signOut } from 'firebase/auth';
import { useAuthDialog } from './auth/useAuthDialog';
import './auth/auth.css';

interface TermsModalProps {
  isOpen: boolean;
  onAccept: () => void;
  isDarkMode: boolean;
  readOnly?: boolean;
  onClose?: () => void;
}

export function TermsModal({ isOpen, onAccept, isDarkMode, readOnly = false, onClose }: TermsModalProps) {
  const preview = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useAuthDialog(preview, isOpen && readOnly, onClose ?? onAccept);
  if (!isOpen) return null;

  const handleAccept = async () => {
    if (auth.currentUser) {
      await updateDoc(doc(db, 'users', auth.currentUser.uid), {
        hasAcceptedTerms: true
      });
    }
    onAccept();
  };

  const handleDecline = async () => {
    await signOut(auth);
  };

  if (readOnly) {
    return (
      <div className="nexus-auth auth-terms-dialog" data-auth-theme={isDarkMode ? 'dark' : 'light'}>
        <div ref={preview} className="auth-terms-preview" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
          <header><h2 id={titleId}>Terms & Conditions</h2>
            <button type="button" className="auth-icon-button" aria-label="Close terms" onClick={onClose ?? onAccept}><X size={20} aria-hidden="true" /></button>
          </header>
          <div className="auth-terms-copy" tabIndex={0}><TermsContent preview /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className={`w-full max-w-2xl max-h-[90vh] flex flex-col rounded-3xl shadow-2xl overflow-hidden border ${
          isDarkMode ? 'bg-[#141414] border-white/10 text-white' : 'bg-white border-black/5 text-black'
        }`}
      >
        <div className="p-6 border-b border-black/5 dark:border-white/5 flex items-center gap-3 shrink-0">
          <div className="p-2 rounded-lg bg-red-500/10">
            <FileText className="w-5 h-5 text-red-500" />
          </div>
          <div>
            <h3 className="font-bold text-lg">Terms & Conditions</h3>
            <p className="text-xs opacity-60">Please read and accept before continuing</p>
          </div>
        </div>

        <div className="p-6 overflow-y-auto w-full custom-scrollbar text-sm space-y-6">
          <TermsContent />
        </div>

        <div className="p-6 border-t border-black/5 dark:border-white/5 flex flex-col sm:flex-row gap-3 shrink-0 bg-black/5 dark:bg-white/5">
          <button
            onClick={handleDecline}
            className="flex-1 px-4 py-3 rounded-xl border border-black/10 dark:border-white/10 font-bold hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center justify-center gap-2"
          >
            <X className="w-4 h-4" />
            Decline & Sign Out
          </button>
          <button
            onClick={handleAccept}
            className="flex-1 px-4 py-3 rounded-xl bg-emerald-500 text-white font-bold hover:bg-emerald-600 shadow-lg shadow-emerald-500/20 transition-colors flex items-center justify-center gap-2"
          >
            <Check className="w-4 h-4" />
            I Accept the Terms
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function TermsContent({ preview = false }: { preview?: boolean }) {
  const Heading = preview ? 'h3' : 'h4';
  return <>
    <div className={preview ? undefined : 'p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 font-bold flex items-start gap-3'}>
      {!preview && <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />}
      <p>This application is currently in the development phase. The developer assumes no responsibility for any inaccuracies, omissions, or errors that may occur during the automated resume generation process. Please review all generated content carefully.</p>
    </div>
    <div className={preview ? undefined : 'space-y-4 opacity-80'}>
      <Heading className="font-bold text-lg opacity-100">1. Acceptance of Terms</Heading>
      <p>By accessing and using this application, you accept and agree to be bound by the terms and provision of this agreement.</p>
      <Heading className="font-bold text-lg opacity-100 mt-6">2. Privacy & Data</Heading>
      <p>We use Firebase for authentication and database storage. We do not sell your personal information. Your resumes, job history, and related data are stored securely and associated only with your account. You can export or request deletion of your data at any time.</p>
      <Heading className="font-bold text-lg opacity-100 mt-6">3. Use of AI</Heading>
      <p>This service utilizes artificial intelligence (AI) to generate and optimize resume content. AI-generated text may occasionally be inaccurate or inappropriate for your specific use case. You are solely responsible for reviewing and verifying any information before using it in professional applications.</p>
      <Heading className="font-bold text-lg opacity-100 mt-6">4. Contact Information</Heading>
      <p>If you have any questions about these Terms, please contact us at: param_jariwala@yahoo.com</p>
      <p className={preview ? 'font-mono' : 'font-mono bg-black/5 dark:bg-white/5 px-3 py-2 rounded-lg inline-block'}>param_jariwala@yahoo.com</p>
    </div>
  </>;
}
