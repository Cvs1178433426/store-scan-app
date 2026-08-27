"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingBootstrap, setCheckingBootstrap] = useState(true);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/auth/bootstrap/status`)
      .then((res) => (res.ok ? res.json() : { needsBootstrap: false }))
      .then((data: { needsBootstrap: boolean }) => setNeedsBootstrap(data.needsBootstrap))
      .catch(() => setNeedsBootstrap(false))
      .finally(() => setCheckingBootstrap(false));
  }, []);

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
      if (!res.ok) {
        setError("Incorrect email, employee number, or password.");
        return;
      }
      const data = await res.json();
      await login(data.token);
      router.push("/store-count");
    } catch {
      setError("Unable to connect to Store Scan. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleBootstrapSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/bootstrap/admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email: identifier, password }),
      });
      if (!res.ok) {
        if (res.status === 409) {
          setNeedsBootstrap(false);
          setError("An administrator account already exists. Please sign in.");
          return;
        }
        setError("Unable to create the administrator account.");
        return;
      }

      const loginRes = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
      if (!loginRes.ok) {
        setError("Account created, but sign-in failed. Please sign in again.");
        return;
      }
      const data = await loginRes.json();
      await login(data.token);
      router.push("/store-count");
    } catch {
      setError("Unable to connect to Store Scan. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (checkingBootstrap) {
    return <main className="container"><h1>Store Scan</h1><p>Connecting...</p></main>;
  }

  return (
    <main className="container">
      <h1>Store Scan</h1>
      <p>Fast, accurate store inventory counting.</p>
      {needsBootstrap ? (
        <>
          <h2>Create Administrator</h2>
          <p>Create the first administrator account for this Store Scan installation.</p>
          <form onSubmit={handleBootstrapSubmit} className="form">
            <input type="text" autoComplete="name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
            <input type="email" inputMode="email" autoComplete="email" placeholder="Email" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
            <input type="password" autoComplete="new-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <input type="password" autoComplete="new-password" placeholder="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
            <button type="submit" disabled={loading}>{loading ? "Creating account..." : "Create Administrator"}</button>
            {error && <p className="error-text">{error}</p>}
          </form>
        </>
      ) : (
        <>
          <h2>Sign In Now</h2>
          <p>Use your email address or Employee Number.</p>
          <form onSubmit={handleSubmit} className="form">
            <input type="text" autoCapitalize="none" autoComplete="username" placeholder="Email or Employee Number" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
            <input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
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
