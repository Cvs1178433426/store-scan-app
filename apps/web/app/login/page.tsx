"use client";

import Link from "next/link";
import { useReducer, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { BrandLockup } from "../../components/BrandLockup";
import { VerificationCodeForm } from "../../components/VerificationCodeForm";
import { ApiError, apiJson } from "../../lib/api";
import { createAuthFlow, formatWaitTime, reduceAuthFlow, type VerificationMethod } from "../../lib/authFlow";
import { useAuth } from "../../lib/auth-context";

type LoginStartResult = {
  mfaRequired: true;
  method: "SMS" | "TOTP";
  maskedDestination?: string;
  phoneEnrollmentRequired?: boolean;
};

type LoginCompleteResult = { token: string; phoneEnrollmentRequired?: boolean };

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [flow, dispatch] = useReducer(reduceAuthFlow, "password", createAuthFlow);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [phoneEnrollmentRequired, setPhoneEnrollmentRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function startLogin(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await apiJson<LoginStartResult>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ identifier, password }),
      });
      setPhoneEnrollmentRequired(Boolean(result.phoneEnrollmentRequired));
      dispatch({ type: "CODE_SENT", method: result.method, maskedDestination: result.maskedDestination, now: Date.now() });
      setPassword("");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        setError(caught.retryAfterSeconds
          ? `Too many requests. Try again in ${formatWaitTime(caught.retryAfterSeconds)}.`
          : "Too many requests. Please try again later.");
      } else if (caught instanceof ApiError && caught.status === 503) {
        dispatch({ type: "PROVIDER_OUTAGE" });
        setError("Text message verification is temporarily unavailable. Please try again later.");
      } else if (caught instanceof ApiError && caught.code === "security_support_required") {
        setError("This account does not have a working security factor. Contact security support before continuing.");
      } else {
        setError("Incorrect email, employee number, or password.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(code: string) {
    setError(null);
    setLoading(true);
    try {
      const result = await apiJson<LoginCompleteResult>("/api/auth/mfa/check", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      await login(result.token);
      dispatch({ type: "VERIFIED" });
      if (phoneEnrollmentRequired || result.phoneEnrollmentRequired) router.push("/settings?enrollPhone=1");
      else router.push("/");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        dispatch({ type: "LOCKED", retryAfterSeconds: caught.retryAfterSeconds ?? 900, now: Date.now() });
      } else if (caught instanceof ApiError && /session expired/i.test(caught.message)) {
        dispatch({ type: "CHALLENGE_EXPIRED" });
        setError("Your verification session expired. Start again to sign in.");
      } else if (caught instanceof ApiError && caught.status === 503) {
        dispatch({ type: "PROVIDER_OUTAGE" });
        setError("Verification is temporarily unavailable. Please try again later.");
      } else {
        dispatch({ type: "CODE_REJECTED" });
        setError("That verification code is not correct or has expired.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function resendCode() {
    setError(null);
    setLoading(true);
    try {
      const result = await apiJson<{ method: "SMS"; maskedDestination: string }>("/api/auth/mfa/resend", {
        method: "POST",
      });
      dispatch({ type: "CODE_SENT", method: result.method, maskedDestination: result.maskedDestination, now: Date.now() });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        const retryAfter = caught.retryAfterSeconds ?? 900;
        dispatch({ type: "RETRY_AFTER", retryAfterSeconds: retryAfter, now: Date.now() });
        setError(`Another code cannot be sent yet. Try again in ${formatWaitTime(retryAfter)}.`);
      } else if (caught instanceof ApiError && caught.status === 401) {
        dispatch({ type: "CHALLENGE_EXPIRED" });
        setError("Your verification session expired. Start again to sign in.");
      } else {
        dispatch({ type: "PROVIDER_OUTAGE" });
        setError("A new text message could not be sent. Please try again later.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function selectMethod(method: Exclude<VerificationMethod, "SMS">) {
    setError(null);
    setLoading(true);
    try {
      await apiJson<{ method: VerificationMethod }>("/api/auth/mfa/method", {
        method: "POST",
        body: JSON.stringify({ method }),
      });
      dispatch({ type: "METHOD_SELECTED", method });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        dispatch({ type: "CHALLENGE_EXPIRED" });
        setError("Your verification session expired. Start again to sign in.");
      } else {
        setError(caught instanceof ApiError ? caught.message : "That backup method is not available.");
      }
    } finally {
      setLoading(false);
    }
  }

  function restart() {
    dispatch({ type: "RESTART" });
    setPhoneEnrollmentRequired(false);
    setError(null);
  }

  if (flow.step === "verification") {
    const heading = flow.method === "SMS"
      ? "Check your text messages"
      : flow.method === "TOTP"
        ? "Use your authenticator"
        : "Use a recovery code";
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="login-code-title">
          <BrandLockup />
          <h1 id="login-code-title">{heading}</h1>
          <p className="auth-intro">Verification keeps your account secure. SMS is the standard sign-in method.</p>
          <VerificationCodeForm
            key={flow.method}
            method={flow.method}
            maskedDestination={flow.maskedDestination}
            resendAvailableAt={flow.resendAvailableAt}
            lockedUntil={flow.lockedUntil}
            busy={loading}
            error={error}
            submitLabel="Verify and sign in"
            onSubmit={verifyCode}
            onResend={flow.method === "SMS" ? resendCode : undefined}
            onRestart={restart}
            onSelectMethod={selectMethod}
          />
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <BrandLockup />
        <h1 id="login-title">Sign in</h1>
        <p className="auth-intro">Enter your account details. We will text your verification code next.</p>
        <form className="form" onSubmit={startLogin}>
          <div className="auth-field">
            <label htmlFor="login-identifier">Work email or Employee Number</label>
            <input
              id="login-identifier"
              type="text"
              autoCapitalize="none"
              autoComplete="username"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              required
            />
          </div>
          <div className="auth-field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <label className="auth-checkbox">
            <input type="checkbox" checked={showPassword} onChange={(event) => setShowPassword(event.target.checked)} />
            Show password
          </label>
          <button type="submit" disabled={loading}>{loading ? "Sending code..." : "Continue"}</button>
          {error && <p className="error-text auth-message" role="alert" aria-live="polite">{error}</p>}
        </form>
        <nav className="auth-links" aria-label="Account help">
          <Link href="/register"><strong>Create a new account</strong></Link>
          <Link href="/forgot-password">Forgot password?</Link>
          <Link href="/help">Need help?</Link>
        </nav>
      </section>
    </main>
  );
}
