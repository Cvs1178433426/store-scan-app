"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, phoneRecoveryApi } from "../lib/api";
import { formatWaitTime } from "../lib/authFlow";
import { BrandLockup } from "./BrandLockup";
import { TurnstileWidget } from "./TurnstileWidget";
import { VerificationCodeForm } from "./VerificationCodeForm";

const CONSENT_VERSION = process.env.NEXT_PUBLIC_SMS_CONSENT_VERSION ?? "2026-09-01";
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
type Step = "loading" | "identify" | "email" | "phone" | "sms" | "complete";

function maskedPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? `(***) ***-${digits.slice(-4)}` : "your replacement phone";
}

export function PhoneRecoveryWizard() {
  const [step, setStep] = useState<Step>("loading");
  const [email, setEmail] = useState("");
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [caseReference, setCaseReference] = useState("");
  const [phone, setPhone] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [destination, setDestination] = useState("your replacement phone");
  const [resendAvailableAt, setResendAvailableAt] = useState<number | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [notificationWarning, setNotificationWarning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;

    void phoneRecoveryApi.status().then((status) => {
      if (!active) return;
      if (status.stage === "sms") setDestination(status.maskedDestination);
      setStep(status.stage);
    }).catch((caught: unknown) => {
      if (!active) return;
      setStep("identify");
      if (!(caught instanceof ApiError && caught.status === 401)) {
        setError("We could not restore your recovery session. Enter your recovery information to continue.");
      }
    });

    return () => {
      active = false;
    };
  }, []);

  function restart() {
    setStep("identify");
    setEmail("");
    setEmployeeNumber("");
    setCaseReference("");
    setPhone("");
    setSmsConsent(false);
    setTurnstileToken("");
    setTurnstileResetKey((value) => value + 1);
    setDestination("your replacement phone");
    setResendAvailableAt(null);
    setLockedUntil(null);
    setNotificationWarning(false);
    setNotice(null);
    setError(null);
  }

  function handleFailure(caught: unknown, fallback: string) {
    if (caught instanceof ApiError && caught.status === 401) {
      restart();
      setError("Your recovery session expired. Start again.");
      return;
    }
    if (caught instanceof ApiError && caught.status === 429) {
      const wait = caught.retryAfterSeconds ?? 900;
      setLockedUntil(Date.now() + wait * 1_000);
      setError(`Too many attempts. Try again in ${formatWaitTime(wait)}.`);
      return;
    }
    setError(caught instanceof ApiError && caught.status === 503
      ? "Recovery is temporarily unavailable. Please try again later."
      : fallback);
  }

  async function identify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await phoneRecoveryApi.startEmailProof({ email, employeeNumber, caseReference });
      setCaseReference("");
      setStep("email");
      setResendAvailableAt(Date.now() + 30_000);
    } catch (caught) {
      handleFailure(caught, "We could not continue this recovery request. Check the information and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function checkEmail(code: string) {
    setBusy(true);
    setError(null);
    try {
      await phoneRecoveryApi.checkEmailCode(code);
      setStep("phone");
      setLockedUntil(null);
    } catch (caught) {
      handleFailure(caught, "That email code is not correct or has expired.");
    } finally {
      setBusy(false);
    }
  }

  async function startPhone(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!smsConsent) return setError("Please agree to receive security text messages.");
    if (!turnstileToken) return setError("Complete the security check before continuing.");
    setBusy(true);
    try {
      await phoneRecoveryApi.startPhoneProof({ phone, smsConsent: true, consentVersion: CONSENT_VERSION, turnstileToken });
      setDestination(maskedPhone(phone));
      setPhone("");
      setTurnstileToken("");
      setStep("sms");
      setResendAvailableAt(Date.now() + 30_000);
    } catch (caught) {
      handleFailure(caught, "We could not verify that replacement number. Check it and try again.");
      setTurnstileToken("");
      setTurnstileResetKey((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await phoneRecoveryApi.resend();
      if (result.maskedDestination) setDestination(result.maskedDestination);
      setResendAvailableAt(Date.now() + 30_000);
      setLockedUntil(null);
      setNotice("A new code was requested. Use the newest code when it arrives.");
    } catch (caught) {
      handleFailure(caught, "We could not request another code. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function checkPhone(code: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await phoneRecoveryApi.checkPhoneCode(code);
      setNotificationWarning(result.notificationWarning);
      setDestination("your replacement phone");
      setStep("complete");
      setLockedUntil(null);
    } catch (caught) {
      handleFailure(caught, "That text-message code is not correct or has expired.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="phone-recovery-title">
        <BrandLockup />

        {step === "loading" && <>
          <h1 id="phone-recovery-title">Checking recovery status</h1>
          <p className="auth-intro" role="status">Restoring your secure recovery session…</p>
        </>}

        {step === "identify" && <>
          <h1 id="phone-recovery-title">Find your recovery request</h1>
          <p className="auth-intro">Your manager must start recovery first. Enter the registered account details and the recovery reference they gave you.</p>
          <form className="form" onSubmit={identify}>
            <div className="auth-field">
              <label htmlFor="recovery-email">Registered email</label>
              <input id="recovery-email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" value={email} onChange={(event) => setEmail(event.target.value)} aria-describedby="recovery-email-help" required />
              <p className="auth-help" id="recovery-email-help">Use the email already registered to your account.</p>
            </div>
            <div className="auth-field">
              <label htmlFor="recovery-employee">Employee number (if assigned)</label>
              <input id="recovery-employee" autoComplete="username" value={employeeNumber} onChange={(event) => setEmployeeNumber(event.target.value)} aria-describedby="recovery-employee-help" />
              <p className="auth-help" id="recovery-employee-help">Leave this blank if your account was created before employee numbers were assigned.</p>
            </div>
            <div className="auth-field">
              <label htmlFor="recovery-reference">Recovery reference</label>
              <input id="recovery-reference" autoComplete="off" value={caseReference} onChange={(event) => setCaseReference(event.target.value)} aria-describedby="recovery-reference-help" required />
              <p className="auth-help" id="recovery-reference-help">Ask the manager who started your recovery for this reference.</p>
            </div>
            <button type="submit" disabled={busy}>{busy ? "Checking request…" : "Continue"}</button>
          </form>
        </>}

        {step === "email" && <>
          <h1 id="phone-recovery-title">Check your registered email</h1>
          <p className="auth-intro">Your request was accepted. If the information matched an active recovery request, an 8-digit code will arrive at your registered email.</p>
          <VerificationCodeForm method="SMS" codeLength={8} codeLabel="8-digit email code" codeHelp="Enter the 8-digit code from your registered email." resendAvailableAt={resendAvailableAt} busy={busy} error={error} lockedUntil={lockedUntil} submitLabel="Verify registered email" onSubmit={checkEmail} onResend={resendCode} onRestart={restart} />
        </>}

        {step === "phone" && <>
          <h1 id="phone-recovery-title">Enter your replacement phone</h1>
          <p className="auth-intro">Use a United States mobile number you control. It will become your verified sign-in number after you confirm it.</p>
          <form className="form" onSubmit={startPhone}>
            <div className="auth-field">
              <label htmlFor="replacement-phone">Replacement mobile number</label>
              <input id="replacement-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} aria-describedby="replacement-phone-help" required />
              <p className="auth-help" id="replacement-phone-help">United States mobile numbers only during the pilot.</p>
            </div>
            <label className="auth-checkbox auth-consent"><input type="checkbox" checked={smsConsent} onChange={(event) => setSmsConsent(event.target.checked)} required /> I agree to receive security text messages for sign-in and account recovery. Message and data rates may apply.</label>
            <TurnstileWidget resetKey={turnstileResetKey} siteKey={TURNSTILE_SITE_KEY} action="phone_recovery" onToken={setTurnstileToken} onError={() => setError("Security check unavailable. Please refresh and try again.")} />
            {!TURNSTILE_SITE_KEY && <p className="error-text auth-message" role="alert">Recovery security check is not configured.</p>}
            <button type="submit" disabled={busy || !turnstileToken}>{busy ? "Requesting code…" : "Text me a code"}</button>
            <button type="button" className="auth-text-button" onClick={restart}>Start again</button>
          </form>
        </>}

        {step === "sms" && <>
          <h1 id="phone-recovery-title">Check your text messages</h1>
          <p className="auth-intro">Your request was accepted. A 6-digit code may take up to a minute to arrive at {destination}.</p>
          <VerificationCodeForm method="SMS" maskedDestination={destination} resendAvailableAt={resendAvailableAt} busy={busy} error={error} lockedUntil={lockedUntil} submitLabel="Verify and replace phone" onSubmit={checkPhone} onResend={resendCode} onRestart={restart} />
        </>}

        {step === "complete" && <>
          <h1 id="phone-recovery-title">Recovery complete</h1>
          <p className="auth-intro">Your old sessions were closed. Sign in with your new phone to continue.</p>
          {notificationWarning && <p className="error-text auth-message" role="alert">Your phone was replaced, but one security notice could not be delivered. Contact your manager if this was unexpected.</p>}
          <Link className="auth-primary-link" href="/login">Sign in with your new phone</Link>
        </>}

        {error && step !== "email" && step !== "sms" && <p className="error-text auth-message" role="alert" aria-live="polite">{error}</p>}
        {notice && <p className="auth-message" role="status" aria-live="polite">{notice}</p>}
        <p className="auth-footer"><Link href="/help">Contact your manager or get help</Link></p>
      </section>
    </main>
  );
}
