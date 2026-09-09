import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiJson: vi.fn(),
  login: vi.fn(),
  push: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, apiJson: mocks.apiJson };
});

vi.mock("./auth-context", () => ({
  useAuth: () => ({ login: mocks.login }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement("a", { href }, children),
}));

import LoginPage from "../app/login/page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function enter(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("SMS-first login contract", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(React.createElement(LoginPage)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("continues password login with SMS and never starts QR enrollment", async () => {
    mocks.apiJson.mockResolvedValueOnce({
      mfaRequired: true,
      method: "SMS",
      maskedDestination: "(***) ***-3355",
    });

    const identifier = container.querySelector<HTMLInputElement>("#login-identifier");
    const password = container.querySelector<HTMLInputElement>("#login-password");
    const form = container.querySelector<HTMLFormElement>("form");
    expect(identifier).not.toBeNull();
    expect(password).not.toBeNull();
    expect(form).not.toBeNull();

    await act(async () => {
      enter(identifier!, "employee@example.test");
      enter(password!, "Example1!pass");
    });
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.apiJson).toHaveBeenCalledTimes(1);
    expect(mocks.apiJson).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({ method: "POST" }));
    expect(container.textContent).toContain("Check your text messages");
    expect(container.textContent).toContain("(***) ***-3355");
    expect(container.querySelector('img[alt*="MFA QR"]')).toBeNull();
    expect(mocks.apiJson.mock.calls.some(([url]) => url === "/api/auth/mfa/setup")).toBe(false);
  });
});
