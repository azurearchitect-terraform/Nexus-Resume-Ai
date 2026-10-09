# Account access UI

`AuthForm` is shared by `ProfessionalWelcomePage` and `AuthModal`. The page's existing callback contracts and the modal's Firebase sign-in, Drive scope/token persistence, success, and close handlers remain intact. Google callbacks are awaited at runtime, including those typed `() => void`; busy state always clears in `finally`.

The form supports email sign-in, signup with matching passwords of at least eight characters, and a generic reset confirmation. Strength guidance is advisory, not an added Firebase password policy. Firebase errors are mapped to safe copy; unknown backend messages are not displayed.

Styles are scoped to `.nexus-auth`, use explicit theme tokens, and provide a viewport scroll container independent of the application's hidden body overflow. Mobile puts account access first; larger screens use a split layout. Reduced-motion preferences disable the loading animation.

Terms can be previewed before authentication using the existing `TermsModal` with optional `readOnly` and `onClose` props. Previewing never accepts terms or signs the user out. Existing required acceptance behavior remains unchanged.

Focused checks: `node --import tsx --test src/components/auth/authHelpers.test.ts`.
