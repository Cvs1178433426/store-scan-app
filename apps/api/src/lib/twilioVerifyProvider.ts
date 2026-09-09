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

  private async post<T>(
    path: string,
    body: URLSearchParams,
    consume: (response: Response) => Promise<T>,
    ambiguousOnTransportFailure = false,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: this.authorization,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal: controller.signal,
      });
      return await consume(response);
    } catch (error) {
      if (error instanceof VerificationProviderError) throw error;
      if (ambiguousOnTransportFailure) throw new VerificationAmbiguousError();
      throw new VerificationProviderError();
    } finally {
      clearTimeout(timer);
    }
  }

  async start(destination: string, channel: VerificationChannel): Promise<VerificationStartResult> {
    return this.post(
      "/Verifications",
      new URLSearchParams({ To: destination, Channel: channel }),
      async (response) => {
        if (!response.ok) throw new VerificationProviderError();
        const data = await response.json() as { sid?: unknown };
        if (typeof data?.sid !== "string" || !data.sid) throw new VerificationProviderError();
        return { providerRef: data.sid };
      },
    );
  }

  async check(providerRef: string, _destination: string, code: string): Promise<VerificationCheckResult> {
    return this.post(
      "/VerificationCheck",
      new URLSearchParams({ VerificationSid: providerRef, Code: code }),
      async (response) => {
        if (response.status === 404) throw new VerificationAmbiguousError();
        if (!response.ok) throw new VerificationProviderError();
        const data = await response.json() as { status?: unknown };
        if (typeof data?.status !== "string") throw new VerificationAmbiguousError();
        return { matched: data.status === "approved" };
      },
      true,
    );
  }
}
