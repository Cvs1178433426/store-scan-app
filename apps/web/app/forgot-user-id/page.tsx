import Link from "next/link";
import { BrandLockup } from "../../components/BrandLockup";

export default function ForgotUserIdPage() {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="forgot-user-id-title">
        <BrandLockup />
        <h1 id="forgot-user-id-title">Forgot your sign-in ID?</h1>
        <p className="auth-intro">
          Use the registered email address for your account to sign in. You do not need an Employee Number.
        </p>
        <nav className="auth-links" aria-label="Account recovery options">
          <Link className="auth-primary-link" href="/login">Sign in with registered email</Link>
          <Link href="/forgot-password">Reset password with verification</Link>
          <Link href="/help">Need help?</Link>
        </nav>
      </section>
    </main>
  );
}
