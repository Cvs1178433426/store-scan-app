"use client";

import { useEffect, useId, useState, type ClipboardEvent, type FormEvent, type ReactNode } from "react";
import {
  LOCKOUT_MESSAGE,
  normalizeVerificationCode,
  remainingSeconds,
  type VerificationMethod,
} from "../lib/authFlow";

type VerificationCodeFormProps = {
  method?: VerificationMethod;
  maskedDestination?: string | null;
  resendAvailableAt?: number | null;
  lockedUntil?: number | null;
  busy?: boolean;
  error?: string | null;
  submitLabel?: string;
  onSubmit: (code: string) => Promise<void> | void;
  onResend?: () => Promise<void> | void;
  onRestart?: () => void;
  onSelectMethod?: (method: Exclude<VerificationMethod, "SMS">) => Promise<void> | void;
  children?: ReactNode;
};

const METHOD_COPY: Record<VerificationMethod, { label: string; help: string }> = {
  SMS: {
    label: "6-digit text message code",
    help: "Enter the 6-digit code from the text message.",
  },
  TOTP: {
    label: "6-digit authenticator code",
    help: "Enter the current 6-digit code from your authenticator app.",
  },
  RECOVERY_CODE: {
    label: "Recovery code",
    help: "Enter one of the recovery codes you saved when you set up your authenticator.",
  },
};

export function VerificationCodeForm({
  method = "SMS",
  maskedDestination = null,
  resendAvailableAt = null,
  lockedUntil = null,
  busy = false,
  error = null,
  submitLabel = "Verify code",
  onSubmit,
  onResend,
  onRestart,
  onSelectMethod,
  children,
}: VerificationCodeFormProps) {
  const [code, setCode] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const inputId = useId();
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const resendSeconds = remainingSeconds(resendAvailableAt, now);
  const lockSeconds = remainingSeconds(lockedUntil, now);
  const locked = lockedUntil !== null && lockSeconds > 0;
  const requiredLength = method === "RECOVERY_CODE" ? 10 : 6;

  useEffect(() => {
    setCode("");
  }, [method]);

  useEffect(() => {
    if (resendSeconds === 0 && lockSeconds === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [lockSeconds, resendSeconds]);

  function updateCode(value: string) {
    setCode(normalizeVerificationCode(value, method));
  }

  function pasteCode(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    updateCode(event.clipboardData.getData("text"));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (code.length !== requiredLength || locked || busy) return;
    await onSubmit(code);
  }

  return (
    <form className="form auth-code-form" onSubmit={submit} noValidate>
      <div className="auth-field">
        <label htmlFor={inputId}>{METHOD_COPY[method].label}</label>
        <input
          id={inputId}
          autoFocus
          type="text"
          inputMode={method === "RECOVERY_CODE" ? "text" : "numeric"}
          autoComplete="one-time-code"
          pattern={method === "RECOVERY_CODE" ? "[A-Fa-f0-9]{10}" : "[0-9]{6}"}
          maxLength={requiredLength}
          value={code}
          onChange={(event) => updateCode(event.target.value)}
          onPaste={pasteCode}
          aria-describedby={`${helpId}${error || locked ? ` ${errorId}` : ""}`}
          aria-invalid={Boolean(error || locked)}
          disabled={busy || locked}
          required
        />
        <p className="auth-help" id={helpId}>
          {method === "SMS" && maskedDestination
            ? `We sent a code to ${maskedDestination}. `
            : ""}
          {METHOD_COPY[method].help}
        </p>
      </div>

      {children}

      <button type="submit" disabled={busy || locked || code.length !== requiredLength}>
        {busy ? "Checking code..." : submitLabel}
      </button>

      {(error || locked) && (
        <p className="error-text auth-message" id={errorId} role="alert" aria-live="polite">
          {locked ? LOCKOUT_MESSAGE : error}
        </p>
      )}

      {method === "SMS" && onResend && (
        <button
          type="button"
          className="auth-text-button"
          disabled={busy || locked || resendSeconds > 0}
          onClick={() => void onResend()}
        >
          {resendSeconds > 0 ? `Send another code in ${resendSeconds}s` : "Send another code"}
        </button>
      )}

      {onSelectMethod && (
        <div className="auth-backup-actions" aria-label="Other verification options">
          {method !== "TOTP" && (
            <button type="button" className="auth-text-button" disabled={busy || locked} onClick={() => void onSelectMethod("TOTP")}>
              Use authenticator app
            </button>
          )}
          {method !== "RECOVERY_CODE" && (
            <button type="button" className="auth-text-button" disabled={busy || locked} onClick={() => void onSelectMethod("RECOVERY_CODE")}>
              Use a recovery code
            </button>
          )}
        </div>
      )}

      {onRestart && (
        <button type="button" className="auth-text-button" disabled={busy} onClick={onRestart}>
          Start again
        </button>
      )}
    </form>
  );
}
