import Link from "next/link";

export default function HelpPage() {
  return (
    <main className="container">
      <h1>Need Help?</h1>
      <p>Use the option that matches what you need.</p>
      <div style={{ display: "grid", gap: 14, marginTop: 22 }}>
        <Link href="/register"><strong>Create a New Account</strong></Link>
        <Link href="/forgot-user-id">Recover Employee Number</Link>
        <Link href="/forgot-password">Reset Password</Link>
        <Link href="/login">Return to Sign In</Link>
      </div>
      <hr style={{ margin: "28px 0" }} />
      <h2>Account verification</h2>
      <p>New accounts use a private 6-digit Recovery PIN. The PIN is stored as a secure hash and is required for self-service Employee Number or password recovery.</p>
      <p>If you have an older account that was created before Recovery PINs were introduced, use a newly created account for the pilot or ask an administrator to reset that older account.</p>
    </main>
  );
}
