import React, { useEffect, useRef } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

export const Toast = ({ message, type, onClose }: { message: string, type: 'success' | 'error' | 'info', onClose: () => void }) => {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const timer = setTimeout(() => closeRef.current(), 3000);
    return () => clearTimeout(timer);
  }, [message, type]);

  const bgColors = {
    success: 'bg-emerald-500',
    error: 'bg-red-500',
    info: 'bg-blue-500'
  };

  return (
    <div className={`fixed bottom-4 right-4 left-4 sm:left-auto sm:max-w-lg z-50 flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-white ${bgColors[type]}`}>
      <div role={type === 'error' ? 'alert' : 'status'} className="flex min-w-0 items-center gap-2">
        {type === 'success' && <CheckCircle2 aria-hidden="true" className="w-5 h-5 shrink-0" />}
        {type === 'error' && <AlertCircle aria-hidden="true" className="w-5 h-5 shrink-0" />}
        {type === 'info' && <Info aria-hidden="true" className="w-5 h-5 shrink-0" />}
        <span className="text-sm font-medium break-words">{message}</span>
      </div>
      <button type="button" onClick={onClose} aria-label="Close notification" title="Close notification"
        className="ml-auto shrink-0 rounded p-1 hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">
        <X aria-hidden="true" className="w-5 h-5" />
      </button>
    </div>
  );
};

export const ConfirmDialog = ({ message, onConfirm, onCancel, isDarkMode }: { message: string, onConfirm: () => void, onCancel: () => void, isDarkMode: boolean }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className={`p-6 rounded-xl shadow-2xl max-w-sm w-full mx-4 ${isDarkMode ? 'bg-[#141414] border border-white/10 text-white' : 'bg-white border border-black/5 text-black'}`}>
        <h3 className="text-lg font-bold mb-4">Confirm Action</h3>
        <p className="text-sm opacity-80 mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${isDarkMode ? 'hover:bg-white/10' : 'hover:bg-black/5'}`}>Cancel</button>
          <button onClick={onConfirm} className="px-4 py-2 rounded-lg text-sm font-bold bg-red-500 text-white hover:bg-red-600 transition-colors">Confirm</button>
        </div>
      </div>
    </div>
  );
};
