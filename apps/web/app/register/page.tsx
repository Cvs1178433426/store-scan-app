"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";

export default function RegisterPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [recoveryPin, setRecoveryPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) return setError("Passwords do not match.");
    if (!/^\d{6}$/.test(recoveryPin)) return setError("Recovery PIN must be exactly 6 digits.");
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, recoveryPin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Unable to create account.");
        return;
      }

      const loginRes = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: email, password }),
      });
      if (!loginRes.ok) {
        router.push("/login");
        return;
      }
      const loginData = await loginRes.json();
      await login(loginData.token);
      alert(`Account created. Your Employee Number is ${data.employeeNumber}. Save it with your 6-digit recovery PIN.`);
      router.push("/store-count");
    } catch {
      setError("Unable to connect to Store Scan. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>Create a New Account</h1>
      <p>Store Scan will automatically assign you a unique Employee Number.</p>
      <form onSubmit={submit} className="form">
        <input type="text" autoComplete="name" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input type="email" inputMode="email" autoComplete="email" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" autoComplete="new-password" placeholder="Password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
        <input type="password" autoComplete="new-password" placeholder="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={8} required />
        <input type="password" inputMode="numeric" autoComplete="off" placeholder="6-digit Recovery PIN" value={recoveryPin} onChange={(e) => setRecoveryPin(e.target.value.replace(/\D/g, "").slice(0, 6))} pattern="\d{6}" required />
        <p style={{ fontSize: 14 }}>Your Recovery PIN verifies you if you forget your Employee Number or password. Do not share it.</p>
        <button type="submit" disabled={loading}>{loading ? "Creating account..." : "Create Account"}</button>
        {error && <p className="error-text">{error}</p>}
      </form>
      <p style={{ marginTop: 18 }}><Link href="/login">Already have an account? Sign in now</Link></p>
    </main>
  );
}
