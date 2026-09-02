type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type TurnstileOptions = {
  secret: string;
  expectedHostname: string;
  expectedAction?: string;
  fetchImpl?: FetchLike;
};

export async function verifyHuman(token: string, remoteIp: string, options: TurnstileOptions): Promise<boolean> {
  if (!token || !options.secret || !options.expectedHostname) return false;
  try {
    const response = await (options.fetchImpl ?? fetch)("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: options.secret, response: token, remoteip: remoteIp }).toString(),
    });
    if (!response.ok) return false;
    const data = await response.json() as { success?: unknown; hostname?: unknown; action?: unknown };
    return data.success === true
      && data.hostname === options.expectedHostname
      && data.action === (options.expectedAction ?? "sms_registration");
  } catch {
    return false;
  }
}
