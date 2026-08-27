import { z } from "zod";

const emailSchema = z.string().trim().email().transform((value) => value.toLowerCase());
const recoveryPinSchema = z.string().regex(/^\d{6}$/, "Recovery PIN must be exactly 6 digits.");

export const bootstrapAdminSchema = z.object({
  name: z.string().trim().min(1),
  email: emailSchema,
  password: z.string().min(8),
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1).optional(),
  email: emailSchema.optional(),
  password: z.string().min(1),
}).refine((value) => !!(value.identifier || value.email), {
  message: "Email or employee number is required.",
});

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  password: z.string().min(8),
  recoveryPin: recoveryPinSchema,
});

export const recoverUserIdSchema = z.object({
  email: emailSchema,
  recoveryPin: recoveryPinSchema,
});

export const recoverPasswordSchema = z.object({
  identifier: z.string().trim().min(1),
  recoveryPin: recoveryPinSchema,
  newPassword: z.string().min(8),
});

export const createUserSchema = z.object({
  name: z.string().min(1),
  email: emailSchema,
  password: z.string().min(8),
  role: z.enum(["ADMIN", "GENERAL"]).default("GENERAL"),
});

export const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  email: emailSchema.optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8).optional(),
});

export type BootstrapAdminInput = z.infer<typeof bootstrapAdminSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type RecoverUserIdInput = z.infer<typeof recoverUserIdSchema>;
export type RecoverPasswordInput = z.infer<typeof recoverPasswordSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
