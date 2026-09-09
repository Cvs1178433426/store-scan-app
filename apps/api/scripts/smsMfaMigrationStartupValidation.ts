import { assertSmsMfaMigrationState } from "../src/lib/smsMfaMigrationState.js";
import { prisma } from "../src/lib/prisma.js";

try {
  await assertSmsMfaMigrationState({ NODE_ENV: "production", SMS_MFA_ENABLED: "true" });
  console.log("SMS MFA production migration startup gate passed.");
} finally {
  await prisma.$disconnect();
}
