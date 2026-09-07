"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";
import { ApiError, apiJson } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import { OneTimeSecrets } from "./OneTimeSecrets";
import { TurnstileWidget } from "./TurnstileWidget";
import { VerificationCodeForm } from "./VerificationCodeForm";
import { formatWaitTime, RESEND_COOLDOWN_SECONDS } from "../lib/authFlow";

type TotpSetup = { qrDataUrl: string; manualKey: string; account: string };
type RemovalStart = { maskedDestination: string };
type PhoneEnrollmentResult = { token: string; backupCodes: string[] };
const CONSENT_VERSION = process.env.NEXT_PUBLIC_SMS_CONSENT_VERSION ?? "2026-09-01";
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

type Props = { initiallyEnabled: boolean; initiallyPhoneVerified: boolean; phoneLast4?: string | null };

export function SecurityFactors({ initiallyEnabled, initiallyPhoneVerified, phoneLast4 }: Props) {
  const { login } = useAuth();
  const [enabled, setEnabled] = useState(initiallyEnabled);
  const [phoneVerified, setPhoneVerified] = useState(initiallyPhoneVerified);
  const [phone, setPhone] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [phoneChallenge, setPhoneChallenge] = useState<{ maskedDestination: string } | null>(null);
  const [phoneResendAvailableAt, setPhoneResendAvailableAt] = useState<number | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [removing, setRemoving] = useState<RemovalStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetHumanCheck() {
    setTurnstileToken("");
    setTurnstileResetKey((value) => value + 1);
  }

  async function startPhoneEnrollment(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!smsConsent) return setError("Please agree to receive security text messages.");
    if (!turnstileToken) return setError("Complete the security check before continuing.");
    setBusy(true);
    try {
      const result = await apiJson<{ maskedDestination: string }>("/api/auth/mfa/phone/enroll/start", {
        method: "POST",
        body: JSON.stringify({ phone, smsConsent: true, consentVersion: CONSENT_VERSION, turnstileToken }),
      });
      setPhoneChallenge(result);
      setPhoneResendAvailableAt(Date.now() + RESEND_COOLDOWN_SECONDS * 1_000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Phone enrollment could not be started.");
      resetHumanCheck();
    } finally {
      setBusy(false);
    }
  }

  async function finishPhoneEnrollment(code: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await apiJson<PhoneEnrollmentResult>("/api/auth/mfa/phone/enroll/check", {
        method: "POST", body: JSON.stringify({ code }),
      });
      await login(result.token);
      setPhoneVerified(true);
      setPhoneChallenge(null);
      setPhoneResendAvailableAt(null);
      setRecoveryCodes(result.backupCodes);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "fresh_challenge_required") {
        setPhoneChallenge(null);
        resetHumanCheck();
      }
      setError(caught instanceof Error ? caught.message : "That text message code is not correct.");
    } finally {
      setBusy(false);
    }
  }

  async function resendPhoneEnrollmentCode() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiJson<{ maskedDestination: string }>("/api/auth/mfa/resend", { method: "POST" });
      setPhoneChallenge(result);
      setPhoneResendAvailableAt(Date.now() + RESEND_COOLDOWN_SECONDS * 1_000);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        const retryAfter = caught.retryAfterSeconds ?? 900;
        setPhoneResendAvailableAt(Date.now() + retryAfter * 1_000);
        setError(`Another code cannot be sent yet. Try again in ${formatWaitTime(retryAfter)}.`);
      } else if (caught instanceof ApiError && caught.status === 401) {
        setPhoneChallenge(null);
        setPhoneResendAvailableAt(null);
        resetHumanCheck();
        setError("Your verification session expired. Start phone verification again.");
      } else {
        setError("A new text message could not be sent. Please try again later.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function startEnrollment() {
    setBusy(true); setError(null);
    try { setSetup(await apiJson<TotpSetup>("/api/auth/mfa/totp/enroll", { method: "POST" })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Authenticator setup could not be started."); }
    finally { setBusy(false); }
  }

  async function finishEnrollment(code: string) {
    setBusy(true); setError(null);
    try {
      await apiJson("/api/auth/mfa/totp/enroll", { method: "POST", body: JSON.stringify({ code }) });
      setEnabled(true); setSetup(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "That authenticator code is not correct."); }
    finally { setBusy(false); }
  }

  async function startRemoval() {
    setBusy(true); setError(null);
    try { setRemoving(await apiJson<RemovalStart>("/api/auth/mfa/totp/remove", { method: "POST" })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Authenticator removal could not be started."); }
    finally { setBusy(false); }
  }

  async function finishRemoval(code: string) {
    setBusy(true); setError(null);
    try {
      await apiJson("/api/auth/mfa/totp/remove", { method: "POST", body: JSON.stringify({ code }) });
      setEnabled(false); setRemoving(null);
    } catch (caught) { setError(caught instanceof ApiError ? caught.message : "That text message code is not correct."); }
    finally { setBusy(false); }
  }

  if (recoveryCodes.length > 0) {
    return <OneTimeSecrets title="Save your recovery codes" hint="Each code works once if you cannot receive a text message. They will not be shown again." secrets={recoveryCodes.map((value, index) => ({ label: `Recovery code ${index + 1}`, value }))} downloadFilename="continuixai-recovery-codes.txt" onClose={() => setRecoveryCodes([])} />;
  }

  if (!phoneVerified) {
    if (phoneChallenge) {
      return <div className="form-stack"><h3>Check your text messages</h3><VerificationCodeForm method="SMS" maskedDestination={phoneChallenge.maskedDestination} resendAvailableAt={phoneResendAvailableAt} busy={busy} error={error} submitLabel="Verify primary phone" onSubmit={finishPhoneEnrollment} onResend={resendPhoneEnrollmentCode} onRestart={() => { setPhoneChallenge(null); setPhoneResendAvailableAt(null); resetHumanCheck(); }} /></div>;
    }
    return (
      <form className="form-stack" onSubmit={startPhoneEnrollment}>
        <h3>Add primary text-message sign-in</h3>
        <p>Verify the mobile number you control. This replaces the same-phone QR requirement.</p>
        <div className="auth-field"><label htmlFor="settings-phone">Mobile number</label><input id="settings-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="(555) 123-4567" value={phone} onChange={(event) => setPhone(event.target.value)} required /></div>
        <label className="auth-checkbox auth-consent"><input type="checkbox" checked={smsConsent} onChange={(event) => setSmsConsent(event.target.checked)} required />I agree to receive security text messages for sign-in and account recovery. Message and data rates may apply.</label>
        <TurnstileWidget resetKey={turnstileResetKey} siteKey={TURNSTILE_SITE_KEY} action="sms_phone_enrollment" onToken={setTurnstileToken} onError={() => { setError("Security check unavailable. Please refresh and try again."); resetHumanCheck(); }} />
        {!TURNSTILE_SITE_KEY && <p className="error-text auth-message" role="alert">Phone verification security check is not configured.</p>}
        <button type="submit" disabled={busy || !turnstileToken}>{busy ? "Sending code…" : "Text me a code"}</button>
        {error && <p className="error-text auth-message" role="alert">{error}</p>}
      </form>
    );
  }

  if (removing) {
    return <div className="form-stack"><p>Confirm removal with the code sent to {removing.maskedDestination}. SMS sign-in will remain enabled.</p><VerificationCodeForm method="SMS" maskedDestination={removing.maskedDestination} busy={busy} error={error} submitLabel="Remove authenticator backup" onSubmit={finishRemoval} onRestart={() => setRemoving(null)} /></div>;
  }

  if (setup) {
    return <div className="form-stack"><p>Optional backup only. Scan this in an authenticator app on another device, or enter the setup key manually on this phone.</p><Image src={setup.qrDataUrl} alt="Authenticator setup QR code" width={240} height={240} unoptimized /><div className="auth-field"><label htmlFor="totp-manual-key">Manual setup key</label><input id="totp-manual-key" readOnly value={setup.manualKey} onFocus={(event) => event.currentTarget.select()} /></div><VerificationCodeForm method="TOTP" busy={busy} error={error} submitLabel="Enable authenticator backup" onSubmit={finishEnrollment} onRestart={() => setSetup(null)} /></div>;
  }

  return <div className="form-stack"><p><strong>Text message sign-in is your primary security method{phoneLast4 ? ` ending in ${phoneLast4}` : ""}.</strong></p><p>Authenticator app backup: {enabled ? "Enabled" : "Not enabled"}</p><button type="button" className="secondary" disabled={busy} onClick={() => void (enabled ? startRemoval() : startEnrollment())}>{busy ? "Please wait…" : enabled ? "Remove authenticator backup" : "Add authenticator backup (optional)"}</button>{error && <p className="error-text auth-message" role="alert">{error}</p>}</div>;
}
