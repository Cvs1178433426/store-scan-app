import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const recoveryMocks = vi.hoisted(() => ({
  status: vi.fn(),
  resend: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    phoneRecoveryApi: {
      ...actual.phoneRecoveryApi,
      status: recoveryMocks.status,
      resend: recoveryMocks.resend,
    },
  };
});

// Isolate this component behavior from Next's router context. The production
// link itself is covered by the Next build; this test is about recovery state.
vi.mock("next/link", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

import { PhoneRecoveryWizard } from "../components/PhoneRecoveryWizard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PhoneRecoveryWizard recovery-session resume", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    container = undefined;
    root = undefined;
    recoveryMocks.status.mockReset();
    recoveryMocks.resend.mockReset();
  });

  it("restores a live text-verification stage from the secure recovery cookie", async () => {
    recoveryMocks.status.mockResolvedValue({
      stage: "sms",
      maskedDestination: "(***) ***-3355",
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(PhoneRecoveryWizard));
    });

    expect(container.textContent).toContain("Check your text messages");
    expect(container.textContent).toContain("(***) ***-3355");
    expect(container.textContent).not.toContain("Find your recovery request");
  });

  it("requests a replacement SMS code and starts the visible cooldown", async () => {
    recoveryMocks.status.mockResolvedValue({
      stage: "sms",
      maskedDestination: "(***) ***-3355",
    });
    recoveryMocks.resend.mockResolvedValue({
      status: "verification_pending",
      maskedDestination: "(***) ***-3355",
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(PhoneRecoveryWizard));
    });

    const button = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Send another code");
    expect(button).toBeDefined();
    await act(async () => button?.click());

    expect(container.textContent).toContain("Send another code in 30s");
    expect(container.textContent).toContain("A new code was requested");
  });

  it("lets a restored email-verification step request a replacement code", async () => {
    recoveryMocks.status.mockResolvedValue({ stage: "email" });
    recoveryMocks.resend.mockResolvedValue({ status: "verification_pending" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(PhoneRecoveryWizard));
    });

    const button = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Send another code");
    expect(button).toBeDefined();
    await act(async () => button?.click());

    expect(container.textContent).toContain("Send another code in 30s");
    expect(container.textContent).toContain("A new code was requested");
  });
});
