import assert from 'node:assert/strict';
import test from 'node:test';
import { authErrorCode, friendlyAuthError, passwordStrength, RESET_MESSAGE, signupPasswordError } from './authHelpers';

test('authentication failures are friendly and never expose raw backend details', () => {
  assert.match(friendlyAuthError({ code: 'auth/popup-blocked' }), /Allow popups/);
  assert.match(friendlyAuthError(new Error('Firebase: Error (auth/network-request-failed).')), /internet/);
  assert.match(friendlyAuthError('Invalid email or password.'), /incorrect/);
  assert.equal(friendlyAuthError({ code: 'auth/user-not-found' }), friendlyAuthError({ code: 'auth/wrong-password' }));
  assert.equal(friendlyAuthError(new Error('secret internal stack')), 'We couldn’t complete that request. Please try again.');
  assert.match(friendlyAuthError({ code: 'auth/email-already-in-use' }), /reset/);
  assert.equal(authErrorCode(null), '');
});

test('signup requires matching passwords of at least eight characters', () => {
  assert.match(signupPasswordError('short', 'short')!, /8 characters/);
  assert.match(signupPasswordError('longEnough', 'different')!, /don’t match/);
  assert.equal(signupPasswordError('longEnough', 'longEnough'), null);
});

test('strength distinguishes length and variety without adding mandatory complexity rules', () => {
  assert.equal(passwordStrength('').level, 0);
  assert.match(passwordStrength('aA1!').label, /Too short/);
  assert.equal(passwordStrength('abcdefgh').level, 1);
  assert.equal(passwordStrength('abcdefgh1').level, 2);
  assert.equal(passwordStrength('LongPassword123!').level, 3);
});

test('reset confirmation does not disclose account existence', () => {
  assert.match(RESET_MESSAGE, /^If an account exists/);
  assert.doesNotMatch(RESET_MESSAGE, /email sent|user found/i);
});
