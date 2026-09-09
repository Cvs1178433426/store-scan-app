import { describe, expect, it } from "vitest";
import { registrationDeliveryHelp } from "./registrationCopy";

describe("registration delivery guidance", () => {
  it("does not claim an SMS was sent when the response is intentionally generic", () => {
    const message = registrationDeliveryHelp("(***) ***-3355");

    expect(message).toBe("If your registration can continue, a 6-digit code will arrive at (***) ***-3355. Delivery may take up to a minute.");
    expect(message).not.toMatch(/we sent|was sent/i);
  });
});
