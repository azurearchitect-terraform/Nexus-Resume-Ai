export type AuthMode = 'login' | 'signup' | 'reset';

export const RESET_MESSAGE = 'If an account exists for this email, you’ll receive a password reset link. Check your inbox and spam folder.';

export function authErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  const message = typeof error === 'string' ? error :
    error instanceof Error ? error.message : '';
  return message.match(/auth\/[\w-]+/)?.[0] ?? '';
}

export function friendlyAuthError(error: unknown): string {
  const messages: Record<string, string> = {
    'auth/invalid-credential': 'The email or password is incorrect. Please try again.',
    'auth/user-not-found': 'The email or password is incorrect. Please try again.',
    'auth/wrong-password': 'The email or password is incorrect. Please try again.',
    'auth/invalid-login-credentials': 'The email or password is incorrect. Please try again.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/email-already-in-use': 'This email is already registered. Sign in or reset your password.',
    'auth/weak-password': 'Choose a stronger password with at least 8 characters.',
    'auth/password-does-not-meet-requirements': 'This password does not meet the account requirements. Try a longer password with mixed characters.',
    'auth/too-many-requests': 'Too many attempts. Please wait a little before trying again.',
    'auth/network-request-failed': 'We couldn’t connect. Check your internet connection and try again.',
    'auth/popup-closed-by-user': 'Google sign-in was cancelled. You can try again or use email.',
    'auth/cancelled-popup-request': 'Another sign-in is in progress. Please try again in a moment.',
    'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow popups or use email.',
    'auth/unauthorized-domain': 'Google sign-in is unavailable on this address. Please use email.',
    'auth/operation-not-allowed': 'This sign-in method is currently unavailable. Please try another method.',
    'auth/user-disabled': 'This account is unavailable. Please contact support.',
    'auth/account-exists-with-different-credential': 'Use the sign-in method you originally used for this email.',
  };
  const code = authErrorCode(error);
  if (messages[code]) return messages[code];
  // App callbacks sometimes replace Firebase codes with these messages.
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (message === 'Invalid email or password.') return messages['auth/invalid-credential'];
  if (message === 'Email already in use.') return messages['auth/email-already-in-use'];
  if (message === 'Password is too weak.') return messages['auth/weak-password'];
  if (message === 'Login cancelled: Popup was closed before completion.') return messages['auth/popup-closed-by-user'];
  if (message === 'Another login attempt is already in progress.') return messages['auth/cancelled-popup-request'];
  if (message === 'Domain not authorized. Please add this domain to your Firebase Authorized Domains list.') return messages['auth/unauthorized-domain'];
  return 'We couldn’t complete that request. Please try again.';
}

export function signupPasswordError(password: string, confirmation: string): string | null {
  if (password.length < 8) return 'Use at least 8 characters for your password.';
  if (password !== confirmation) return 'The passwords don’t match. Please enter them again.';
  return null;
}

export function passwordStrength(password: string): { level: number; label: string } {
  if (!password) return { level: 0, label: 'Use at least 8 characters' };
  if (password.length < 8) return { level: 1, label: 'Too short — use at least 8 characters' };
  const varieties = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter(pattern => pattern.test(password)).length;
  if (password.length >= 12 && varieties >= 3) return { level: 3, label: 'Strong length and variety' };
  if (varieties >= 2) return { level: 2, label: 'Good — more length makes it stronger' };
  return { level: 1, label: 'Minimum length met — add length and variety' };
}
