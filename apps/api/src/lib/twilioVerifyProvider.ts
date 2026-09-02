import {
  VerificationAmbiguousError,
  VerificationProviderError,
  type VerificationChannel,
  type VerificationCheckResult,
  type VerificationProvider,
  type VerificationStartResult,
} from "./verificationProvider.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type TwilioConfig = {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  serviceSid: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

export class TwilioVerifyProvider implements VerificationProvider {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(config: TwilioConfig) {
    this.baseUrl = `https://verify.twilio.com/v2/Services/${encodeURIComponent(config.serviceSid)}`;
    this.authorization = `Basic ${Buffer.from(`${config.apiKeySid}:${config.apiKeySecret}`).toString("base64")}`;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 8_000;
  }

  private async post(path: string, body: URLSearchParams): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: this.authorization,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch {
      throw new VerificationProviderError();
    } finally {
      clearTimeout(timer);
    }
  }

  async start(destination: string, channel: VerificationChannel): Promise<VerificationStartResult> {
    const response = await this.post("/Verifications", new URLSearchParams({ To: destination, Channel: channel }));
    if (!response.ok) throw new VerificationProviderError();
    const data = await response.json().catch(() => null) as { sid?: unknown } | null;
    if (typeof data?.sid !== "string" || !data.sid) throw new VerificationProviderError();
    return { providerRef: data.sid };
  }

  async check(providerRef: string, _destination: string, code: string): Promise<VerificationCheckResult> {
    const response = await this.post("/VerificationCheck", new URLSearchParams({ VerificationSid: providerRef, Code: code }));
    if (response.status === 404) throw new VerificationAmbiguousError();
    if (!response.ok) throw new VerificationProviderError();
    const data = await response.json().catch(() => null) as { status?: unknown } | null;
    if (typeof data?.status !== "string") throw new VerificationProviderError();
    return { matched: data.status === "approved" };
  }
}
