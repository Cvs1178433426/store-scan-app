"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";

type Stage = "password" | "setup" | "verify" | "backup";

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingBootstrap, setCheckingBootstrap] = useState(true);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [stage, setStage] = useState<Stage>("password");
  const [challengeToken, setChallengeToken] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [manualSecret, setManualSecret] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [pendingToken, setPendingToken] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/api/auth/bootstrap/status`)
      .then((res) => (res.ok ? res.json() : { needsBootstrap: false }))
      .then((data: { needsBootstrap: boolean }) => setNeedsBootstrap(data.needsBootstrap))
      .catch(() => setNeedsBootstrap(false))
      .finally(() => setCheckingBootstrap(false));
  }, []);

  async function beginMfa(data: { challengeToken: string; enrollmentRequired: boolean }) {
    setChallengeToken(data.challengeToken);
    setError(null);
    if (data.enrollmentRequired) {
      const setupRes = await fetch(`${API_URL}/api/auth/mfa/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken: data.challengeToken }),
      });
      const setup = await setupRes.json();
      if (!setupRes.ok) throw new Error(setup.error || "Unable to start MFA setup.");
      setQrDataUrl(setup.qrDataUrl);
      setManualSecret(setup.secret);
      setStage("setup");
    } else {
      setStage("verify");
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
      if (!res.ok) { setError("Incorrect email, employee number, or password."); return; }
      await beginMfa(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to connect to Store Scan. Please try again.");
    } finally { setLoading(false); }
  }

  async function handleBootstrapSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) { setError("Passwords do not match."); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/bootstrap/admin`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email: identifier, password }),
      });
      if (!res.ok) {
        if (res.status === 409) { setNeedsBootstrap(false); setError("An administrator account already exists. Please sign in."); return; }
        setError("Unable to create the administrator account."); return;
      }
      setNeedsBootstrap(false);
      const loginRes = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier, password }),
      });
      if (!loginRes.ok) { setError("Account created, but sign-in failed. Please sign in again."); return; }
      await beginMfa(await loginRes.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to connect to Store Scan. Please try again.");
    } finally { setLoading(false); }
  }

  async function confirmEnrollment(e: FormEvent) {
    e.preventDefault();
    setError(null); setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/mfa/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challengeToken, code: mfaCode }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "That verification code is not correct."); return; }
      setBackupCodes(data.backupCodes || []);
      setPendingToken(data.token);
      setStage("backup");
    } catch { setError("Unable to verify MFA. Please try again."); }
    finally { setLoading(false); }
  }

  async function verifyMfa(e: FormEvent) {
    e.preventDefault();
    setError(null); setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/mfa/verify`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challengeToken, code: mfaCode }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "That verification code is not correct."); return; }
      await login(data.token);
      router.push("/store-count");
    } catch { setError("Unable to verify MFA. Please try again."); }
    finally { setLoading(false); }
  }

  async function finishEnrollment() {
    await login(pendingToken);
    router.push("/store-count");
  }

  if (checkingBootstrap) return <main className="container"><h1>Store Scan</h1><p>Connecting...</p></main>;

  if (stage === "setup") return (
    <main className="container">
      <h1>Secure Your Account</h1>
      <p>Store Scan requires multi-factor authentication. Open Google Authenticator, Microsoft Authenticator, Authy, or another authenticator app and scan this QR code.</p>
      {qrDataUrl && <img src={qrDataUrl} alt="Store Scan MFA QR code" style={{ width: 240, maxWidth: "100%", background: "white", padding: 8, borderRadius: 8 }} />}
      <p><strong>Can’t scan it?</strong> Enter this setup key manually:</p>
      <code style={{ wordBreak: "break-all" }}>{manualSecret}</code>
      <form onSubmit={confirmEnrollment} className="form" style={{ marginTop: 18 }}>
        <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} placeholder="6-digit verification code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))} required />
        <button type="submit" disabled={loading || mfaCode.length !== 6}>{loading ? "Verifying..." : "Verify and Enable MFA"}</button>
        {error && <p className="error-text">{error}</p>}
      </form>
    </main>
  );

  if (stage === "verify") return (
    <main className="container">
      <h1>Multi-Factor Verification</h1>
      <p>Enter the 6-digit code from your authenticator app. You may also enter one of your backup codes.</p>
      <form onSubmit={verifyMfa} className="form">
        <input autoFocus autoComplete="one-time-code" placeholder="6-digit code or backup code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value.toUpperCase())} required />
        <button type="submit" disabled={loading}>{loading ? "Verifying..." : "Verify & Sign In"}</button>
        {error && <p className="error-text">{error}</p>}
      </form>
      <button type="button" onClick={() => { setStage("password"); setMfaCode(""); setPassword(""); }} style={{ marginTop: 12 }}>Back to Sign In</button>
    </main>
  );

  if (stage === "backup") return (
    <main className="container">
      <h1>MFA Is Enabled</h1>
      <p><strong>Save these backup codes now.</strong> Each code can be used once if you lose access to your authenticator app.</p>
      <div style={{ display: "grid", gap: 8, margin: "18px 0" }}>{backupCodes.map((code) => <code key={code} style={{ fontSize: 18 }}>{code}</code>)}</div>
      <p>Store them somewhere secure and separate from your phone.</p>
      <button type="button" onClick={finishEnrollment}>I Saved My Backup Codes — Continue</button>
    </main>
  );

  return (
    <main className="container">
      <h1>Store Scan</h1>
      <p>Fast, accurate store inventory counting.</p>
      {needsBootstrap ? (
        <>
          <h2>Create Administrator</h2>
          <p>Create the first administrator account. Multi-factor authentication will be required immediately after setup.</p>
          <form onSubmit={handleBootstrapSubmit} className="form">
            <input type="text" autoComplete="name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
            <input type="email" inputMode="email" autoComplete="email" placeholder="Email" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
            <input type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <input type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} />Show password</label>
            <button type="submit" disabled={loading}>{loading ? "Creating account..." : "Create Administrator"}</button>
            {error && <p className="error-text">{error}</p>}
          </form>
        </>
      ) : (
        <>
          <h2>Sign In Now</h2>
          <p>Use your email address or Employee Number. A second verification step is required.</p>
          <form onSubmit={handleSubmit} className="form">
            <input type="text" autoCapitalize="none" autoComplete="username" placeholder="Email or Employee Number" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
            <input type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} />Show password</label>
            <button type="submit" disabled={loading}>{loading ? "Signing in..." : "Sign In"}</button>
            {error && <p className="error-text">{error}</p>}
          </form>
          <div style={{ marginTop: 22, display: "grid", gap: 10 }}>
            <Link href="/register"><strong>Create a New Account</strong></Link>
            <Link href="/forgot-user-id">Forgot User ID / Employee Number?</Link>
            <Link href="/forgot-password">Forgot Password?</Link>
            <Link href="/help">Need Help?</Link>
          </div>
        </>
      )}
    </main>
  );
}
