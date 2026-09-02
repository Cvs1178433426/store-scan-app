"use client";

import Link from "next/link";
import { useReducer, useRef, useState, type FormEvent } from "react";
import { BrandLockup } from "../../components/BrandLockup";
import { VerificationCodeForm } from "../../components/VerificationCodeForm";
import { ApiError, apiJson } from "../../lib/api";
import { createAuthFlow, formatWaitTime, reduceAuthFlow, type VerificationMethod } from "../../lib/authFlow";

const SPECIALS = "!@#$%^&*";

function passwordError(password: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters.";
  if (/^\d/.test(password)) return "Password must not start with a number.";
  if (!/[A-Z]/.test(password)) return "Password must include at least one uppercase letter.";
  if (!/[a-z]/.test(password)) return "Password must include at least one lowercase letter.";
  if (!/\d/.test(password)) return "Password must include at least one number.";
  if (!/[!@#$%^&*]/.test(password)) return `Password must include at least one special character: ${SPECIALS.split("").join(" ")}.`;
  return null;
}

export default function ForgotPasswordPage() {
  const [flow, dispatch] = useReducer(reduceAuthFlow, "email", createAuthFlow);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function requestRecovery(method: VerificationMethod) {
    await apiJson<{ ok: true }>("/api/auth/password-recovery/start", {
      method: "POST",
      body: JSON.stringify({ email, method }),
    });
  }

  async function startRecovery(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await requestRecovery("SMS");
      dispatch({ type: "CODE_SENT", now: Date.now() });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        setError(caught.retryAfterSeconds
          ? `Too many requests. Try again in ${formatWaitTime(caught.retryAfterSeconds)}.`
          : "Too many requests. Please try again later.");
      } else {
        setError("We could not start password recovery. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function resendCode() {
    setError(null);
    setLoading(true);
    try {
      await requestRecovery("SMS");
      dispatch({ type: "CODE_SENT", now: Date.now() });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        const wait = caught.retryAfterSeconds ?? 30;
        dispatch({ type: "RETRY_AFTER", retryAfterSeconds: wait, now: Date.now() });
        setError(`Please wait ${formatWaitTime(wait)} before requesting another code.`);
      } else {
        setError("We could not send another code. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function selectMethod(method: Exclude<VerificationMethod, "SMS">) {
    setError(null);
    setLoading(true);
    try {
      await requestRecovery(method);
      dispatch({ type: "METHOD_SELECTED", method });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        setError(caught.retryAfterSeconds
          ? `Too many requests. Try again in ${formatWaitTime(caught.retryAfterSeconds)}.`
          : caught.message);
      } else {
        setError("That backup method could not be started. You can start again and use SMS.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function completeRecovery(code: string) {
    setError(null);
    const ruleError = passwordError(password);
    if (ruleError) {
      setError(ruleError);
      passwordRef.current?.focus();
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      passwordRef.current?.focus();
      return;
    }

    setLoading(true);
    try {
      await apiJson<{ ok: true }>("/api/auth/password-recovery/complete", {
        method: "POST",
        body: JSON.stringify({ code, newPassword: password }),
      });
      setPassword("");
      setConfirmPassword("");
      dispatch({ type: "VERIFIED" });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        dispatch({ type: "LOCKED", retryAfterSeconds: caught.retryAfterSeconds ?? 900, now: Date.now() });
      } else if (caught instanceof ApiError && caught.status === 503) {
        dispatch({ type: "PROVIDER_OUTAGE" });
        setError("Verification is temporarily unavailable. Your password was not changed.");
      } else {
        dispatch({ type: "CODE_REJECTED" });
        setError("That verification code is not correct or has expired. Your password was not changed.");
      }
    } finally {
      setLoading(false);
    }
  }

  function restart() {
    dispatch({ type: "RESTART" });
    setPassword("");
    setConfirmPassword("");
    setError(null);
  }

  if (flow.step === "complete") {
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="recovery-complete-title">
          <BrandLockup />
          <h1 id="recovery-complete-title">Password changed</h1>
          <p>Your old sessions have ended. Sign in again with your new password.</p>
          <Link className="auth-primary-link" href="/login">Back to sign in</Link>
        </section>
      </main>
    );
  }

  if (flow.step === "verification") {
    const heading = flow.method === "SMS"
      ? "Check your text messages"
      : flow.method === "TOTP"
        ? "Use your authenticator"
        : "Use a recovery code";
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="recovery-code-title">
          <BrandLockup />
          <h1 id="recovery-code-title">{heading}</h1>
          <p className="auth-intro">
            {flow.method === "SMS"
              ? "If that email belongs to an active account, we sent a code to its verified phone."
              : "Enter your backup verification and choose a new password."}
          </p>
          <VerificationCodeForm
            key={flow.method}
            method={flow.method}
            resendAvailableAt={flow.resendAvailableAt}
            lockedUntil={flow.lockedUntil}
            busy={loading}
            error={error}
            submitLabel="Verify and change password"
            onSubmit={completeRecovery}
            onResend={flow.method === "SMS" ? resendCode : undefined}
            onRestart={restart}
            onSelectMethod={selectMethod}
          >
            <details className="auth-details">
              <summary>New password requirements</summary>
              <p>Use at least 10 characters. Do not start with a number. Include uppercase, lowercase, a number, and one of: ! @ # $ % ^ &amp; *</p>
            </details>
            <div className="auth-field">
              <label htmlFor="recovery-password">New password</label>
              <input ref={passwordRef} id="recovery-password" type={showPasswords ? "text" : "password"} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} required />
            </div>
            <div className="auth-field">
              <label htmlFor="recovery-confirm-password">Confirm new password</label>
              <input id="recovery-confirm-password" type={showPasswords ? "text" : "password"} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={10} required />
            </div>
            <label className="auth-checkbox">
              <input type="checkbox" checked={showPasswords} onChange={(event) => setShowPasswords(event.target.checked)} />
              Show password
            </label>
          </VerificationCodeForm>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="recovery-title">
        <BrandLockup />
        <h1 id="recovery-title">Reset your password</h1>
        <p className="auth-intro">Enter your work email. If it matches an active account, we will text its verified phone.</p>
        <form className="form" onSubmit={startRecovery}>
          <div className="auth-field">
            <label htmlFor="recovery-email">Work email</label>
            <input id="recovery-email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </div>
          <button type="submit" disabled={loading}>{loading ? "Sending code..." : "Text me a recovery code"}</button>
          {error && <p className="error-text auth-message" role="alert" aria-live="polite">{error}</p>}
        </form>
        <p className="auth-footer"><Link href="/login">Back to sign in</Link> · <Link href="/help">Need help?</Link></p>
      </section>
    </main>
  );
}
