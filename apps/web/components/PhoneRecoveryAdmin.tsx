"use client";

import { useEffect, useState } from "react";
import { ApiError, phoneRecoveryApi, type AdminPhoneRecoveryStatus, type PhoneRecoveryCase } from "../lib/api";

type Props = { userId: string; userName: string };

export function recoveryEventLabel(event: { eventType: string; outcome: string }): string {
  if (event.eventType.endsWith("_notification") || event.eventType === "phone_recovery_notice_failed") {
    return event.outcome === "accepted" ? "Notification accepted" : "Notification failed";
  }
  const labels: Record<string, string> = {
    phone_recovery_initiated: "Recovery started",
    phone_recovery_cancelled: "Recovery cancelled",
    phone_recovery_expired: "Recovery expired",
    phone_recovery_completed: "Recovery completed",
    phone_recovery_email_denied: "Email code rejected",
    phone_recovery_email_locked: "Email verification locked",
    phone_recovery_sms_denied: "Text code rejected",
    phone_recovery_sms_locked: "Text verification locked",
  };
  return labels[event.eventType] ?? "Recovery updated";
}

export function PhoneRecoveryAdmin({ userId, userName }: Props) {
  const [recovery, setRecovery] = useState<PhoneRecoveryCase | null>(null);
  const [status, setStatus] = useState<AdminPhoneRecoveryStatus>({ cases: [], events: [] });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const activeCase = status.cases.find(({ status: caseStatus }) =>
    ["NOTICE_PENDING", "EMAIL_PENDING", "EMAIL_VERIFIED", "PHONE_PENDING"].includes(caseStatus));

  async function refreshStatus() {
    setStatus(await phoneRecoveryApi.adminStatus(userId));
  }

  useEffect(() => {
    let active = true;
    phoneRecoveryApi.adminStatus(userId)
      .then((result) => { if (active) setStatus(result); })
      .catch(() => { if (active) setMessage("Recovery status is temporarily unavailable."); });
    return () => { active = false; };
  }, [userId]);

  async function initiate() {
    setBusy(true);
    setMessage(null);
    try {
      setRecovery(await phoneRecoveryApi.initiate(userId));
      await refreshStatus();
    } catch (caught) {
      setMessage(caught instanceof ApiError && caught.status === 403
        ? "Sign in again with MFA before starting recovery."
        : "Phone recovery could not be started.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    const caseId = recovery?.caseId ?? activeCase?.caseId;
    if (!caseId) return;
    setBusy(true);
    setMessage(null);
    try {
      await phoneRecoveryApi.cancel(userId, caseId);
      setRecovery(null);
      await refreshStatus();
      setMessage("Recovery cancelled.");
    } catch {
      setMessage("Recovery could not be cancelled. It may already be complete or expired.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="recovery-admin" aria-label={`Phone recovery for ${userName}`}>
      {!recovery && !activeCase ? (
        <button type="button" className="secondary" disabled={busy} onClick={() => void initiate()}>
          {busy ? "Starting…" : "Start phone recovery"}
        </button>
      ) : (
        <div className="recovery-admin-result">
          {recovery && <p><strong>Recovery reference:</strong> <code>{recovery.caseReference}</code></p>}
          {recovery && <p>Give this reference privately to {userName}. It expires {new Date(recovery.expiresAt).toLocaleString()}.</p>}
          {activeCase && <p><strong>Recovery status:</strong> {activeCase.status.replaceAll("_", " ").toLowerCase()} · expires {new Date(activeCase.expiresAt).toLocaleString()}</p>}
          <button type="button" className="secondary" disabled={busy} onClick={() => void cancel()}>
            {busy ? "Cancelling…" : "Cancel recovery"}
          </button>
        </div>
      )}
      {status.cases.length > 0 && (
        <details>
          <summary>Recovery history</summary>
          <ul className="manager-history">
            {status.cases.map((entry) => (
              <li key={entry.caseId}>{entry.status.replaceAll("_", " ").toLowerCase()} · started {new Date(entry.startedAt).toLocaleString()}</li>
            ))}
            {status.events.map((event, index) => (
              <li key={`${event.occurredAt}-${index}`}>
                {recoveryEventLabel(event)} · {new Date(event.occurredAt).toLocaleString()}
              </li>
            ))}
          </ul>
        </details>
      )}
      {message && <p className="error-text auth-message" role="alert" aria-live="polite">{message}</p>}
    </section>
  );
}
