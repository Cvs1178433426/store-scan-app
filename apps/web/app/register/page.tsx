"use client";

import Link from "next/link";
import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { BrandLockup } from "../../components/BrandLockup";
import { VerificationCodeForm } from "../../components/VerificationCodeForm";
import { ApiError, apiJson } from "../../lib/api";
import { createAuthFlow, formatWaitTime, reduceAuthFlow } from "../../lib/authFlow";
import { useAuth } from "../../lib/auth-context";

const SPECIALS = "!@#$%^&*";
const CONSENT_VERSION = process.env.NEXT_PUBLIC_SMS_CONSENT_VERSION ?? "2026-09-01";
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

type TurnstileApi = {
  render: (element: HTMLElement, options: { sitekey: string; action: string; size: "flexible"; callback: (token: string) => void; "expired-callback": () => void; "error-callback": () => void }) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

type RegistrationResult = { token: string };
type RegistrationStartResult = { maskedDestination: string };

function passwordError(password: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters.";
  if (/^\d/.test(password)) return "Password must not start with a number.";
  if (!/[A-Z]/.test(password)) return "Password must include at least one uppercase letter.";
  if (!/[a-z]/.test(password)) return "Password must include at least one lowercase letter.";
  if (!/\d/.test(password)) return "Password must include at least one number.";
  if (!/[!@#$%^&*]/.test(password)) return `Password must include at least one special character: ${SPECIALS.split("").join(" ")}.`;
  return null;
}

function apiMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}

export default function RegisterPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [flow, dispatch] = useReducer(reduceAuthFlow, "phone", createAuthFlow);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const firstInvalidRef = useRef<HTMLInputElement>(null);
  const turnstileContainerRef = useRef<HTMLDivElement>(null);
  const turnstileWidgetRef = useRef<string | null>(null);

  useEffect(() => {
    if (flow.step !== "entry" || !TURNSTILE_SITE_KEY || !turnstileContainerRef.current) return;
    let cancelled = false;
    let attempts = 0;

    function renderWidget() {
      if (cancelled || turnstileWidgetRef.current || !turnstileContainerRef.current) return;
      if (!window.turnstile) {
        attempts += 1;
        if (attempts < 50) window.setTimeout(renderWidget, 100);
        return;
      }
      turnstileWidgetRef.current = window.turnstile.render(turnstileContainerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        action: "sms_registration",
        size: "flexible",
        callback: setTurnstileToken,
        "expired-callback": () => setTurnstileToken(""),
        "error-callback": () => {
          setTurnstileToken("");
          setError("Security check unavailable. Please refresh and try again.");
        },
      });
    }

    const scriptId = "continuixai-turnstile";
    let script = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = scriptId;
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.addEventListener("load", renderWidget, { once: true });
      document.head.appendChild(script);
    } else {
      renderWidget();
    }

    return () => {
      cancelled = true;
      if (turnstileWidgetRef.current && window.turnstile) window.turnstile.remove(turnstileWidgetRef.current);
      turnstileWidgetRef.current = null;
    };
  }, [flow.step]);

  function resetTurnstile() {
    setTurnstileToken("");
    if (turnstileWidgetRef.current && window.turnstile) window.turnstile.reset(turnstileWidgetRef.current);
  }

  async function submitDetails(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const ruleError = passwordError(password);
    if (ruleError) {
      setError(ruleError);
      firstInvalidRef.current?.focus();
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      firstInvalidRef.current?.focus();
      return;
    }
    if (!smsConsent) return setError("Please agree to receive security text messages.");
    if (!turnstileToken) return setError("Complete the security check before continuing.");

    setLoading(true);
    try {
      const result = await apiJson<RegistrationStartResult>("/api/auth/register/start", {
        method: "POST",
        body: JSON.stringify({ name, email, phone, password, smsConsent: true, consentVersion: CONSENT_VERSION, turnstileToken }),
      });
      dispatch({ type: "CODE_SENT", maskedDestination: result.maskedDestination, now: Date.now() });
      setPassword("");
      setConfirmPassword("");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        setError(caught.retryAfterSeconds ? `Too many requests. Try again in ${formatWaitTime(caught.retryAfterSeconds)}.` : caught.message);
      } else if (caught instanceof ApiError && caught.status === 503) {
        dispatch({ type: "PROVIDER_OUTAGE" });
        setError("Text message verification is temporarily unavailable. Please try again later.");
      } else if (caught instanceof ApiError && caught.status === 400) {
        setError("Check your name, work email, mobile number, and password, then try again.");
      } else {
        setError(apiMessage(caught, "We could not start registration. Check your information and try again."));
      }
      resetTurnstile();
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(code: string) {
    setError(null);
    setLoading(true);
    try {
      const result = await apiJson<RegistrationResult>("/api/auth/register/check", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      await login(result.token);
      dispatch({ type: "VERIFIED" });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        dispatch({ type: "LOCKED", retryAfterSeconds: caught.retryAfterSeconds ?? 900, now: Date.now() });
      } else if (caught instanceof ApiError && /session expired/i.test(caught.message)) {
        dispatch({ type: "CHALLENGE_EXPIRED" });
        setError("Your verification session expired. Start again to get a new code.");
      } else if (caught instanceof ApiError && caught.status === 503) {
        dispatch({ type: "PROVIDER_OUTAGE" });
        setError("Text message verification is temporarily unavailable. Please try again later.");
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
      const result = await apiJson<RegistrationStartResult>("/api/auth/register/resend", {
        method: "POST",
        body: JSON.stringify({}),
      });
      dispatch({ type: "CODE_SENT", maskedDestination: result.maskedDestination, now: Date.now() });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        const wait = caught.retryAfterSeconds ?? 30;
        dispatch({ type: "RETRY_AFTER", retryAfterSeconds: wait, now: Date.now() });
        setError(`Please wait ${formatWaitTime(wait)} before requesting another code.`);
      } else if (caught instanceof ApiError && caught.status === 401) {
        dispatch({ type: "CHALLENGE_EXPIRED" });
        setError("Your verification session expired. Start again to get a new code.");
      } else {
        dispatch({ type: "PROVIDER_OUTAGE" });
        setError("Text message verification is temporarily unavailable. Please try again later.");
      }
    } finally {
      setLoading(false);
    }
  }

  function restart() {
    dispatch({ type: "RESTART" });
    setError(null);
    setTurnstileToken("");
  }

  if (flow.step === "complete") {
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="registration-complete-title">
          <BrandLockup />
          <h1 id="registration-complete-title">Your account is ready</h1>
          <p>Your phone number is verified and you are signed in.</p>
          <button type="button" onClick={() => router.push("/")}>Continue</button>
        </section>
      </main>
    );
  }

  if (flow.step === "verification") {
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="registration-code-title">
          <BrandLockup />
          <h1 id="registration-code-title">Check your text messages</h1>
          <p className="auth-intro">Keep this screen open while you enter the code. We never ask you to scan a QR code during registration.</p>
          <VerificationCodeForm
            method="SMS"
            maskedDestination={flow.maskedDestination}
            resendAvailableAt={flow.resendAvailableAt}
            lockedUntil={flow.lockedUntil}
            busy={loading}
            error={error}
            submitLabel="Verify and create account"
            onSubmit={verifyCode}
            onResend={resendCode}
            onRestart={restart}
          />
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="registration-title">
        <BrandLockup />
        <h1 id="registration-title">Create your account</h1>
        <p className="auth-intro">Use a mobile number you control. We will text a code to verify it.</p>
        <form className="form" onSubmit={submitDetails}>
          <div className="auth-field">
            <label htmlFor="register-name">Full name</label>
            <input id="register-name" type="text" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="auth-field">
            <label htmlFor="register-email">Work email</label>
            <input id="register-email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </div>
          <div className="auth-field">
            <label htmlFor="register-phone">Mobile number</label>
            <input id="register-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="(555) 123-4567" value={phone} onChange={(event) => setPhone(event.target.value)} required />
            <p className="auth-help">United States mobile numbers only during the pilot.</p>
          </div>
          <details className="auth-details">
            <summary>Password requirements</summary>
            <p>Use at least 10 characters. Do not start with a number. Include uppercase, lowercase, a number, and one of: ! @ # $ % ^ &amp; *</p>
          </details>
          <div className="auth-field">
            <label htmlFor="register-password">Password</label>
            <input ref={firstInvalidRef} id="register-password" type={showPasswords ? "text" : "password"} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} required />
          </div>
          <div className="auth-field">
            <label htmlFor="register-confirm-password">Confirm password</label>
            <input id="register-confirm-password" type={showPasswords ? "text" : "password"} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={10} required />
          </div>
          <label className="auth-checkbox"><input type="checkbox" checked={showPasswords} onChange={(event) => setShowPasswords(event.target.checked)} /> Show password</label>
          <label className="auth-checkbox auth-consent"><input type="checkbox" checked={smsConsent} onChange={(event) => setSmsConsent(event.target.checked)} required /> I agree to receive security text messages for sign-in and account recovery. Message and data rates may apply.</label>
          <div ref={turnstileContainerRef} className="auth-turnstile" aria-label="Security check" />
          {!TURNSTILE_SITE_KEY && <p className="error-text auth-message" role="alert">Registration security check is not configured.</p>}
          <button type="submit" disabled={loading || !turnstileToken}>{loading ? "Sending code..." : "Text me a code"}</button>
          {error && <p className="error-text auth-message" role="alert" aria-live="polite">{error}</p>}
        </form>
        <p className="auth-footer"><Link href="/login">Already have an account? Sign in</Link></p>
      </section>
    </main>
  );
}
