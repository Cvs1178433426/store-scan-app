import Link from "next/link";

export default function HelpPage() {
  return (
    <main className="container">
      <h1>Need Help?</h1>
      <p>Use the option that matches what you need.</p>
      <div style={{ display: "grid", gap: 14, marginTop: 22 }}>
        <Link href="/register"><strong>Create a New Account</strong></Link>
        <Link href="/forgot-user-id">Sign-in ID help</Link>
        <Link href="/forgot-password">Reset Password</Link>
        <Link href="/login">Return to Sign In</Link>
      </div>
      <hr style={{ margin: "28px 0" }} />
      <h2>Account verification</h2>
      <p>Use your registered email to sign in. If you reset your password, we will verify you by texting a one-time code to your verified phone.</p>
      <p>If your phone is unavailable, use an existing authenticator or single-use recovery code. Contact security support if none of your verified methods are available.</p>
    </main>
  );
}
