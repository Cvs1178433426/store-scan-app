import { z } from "zod";

export const storeLocationInputSchema = z.object({
  code: z.string().trim().min(1).max(64).transform((value) => value.toUpperCase()),
  name: z.string().trim().max(200).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});
export type StoreLocationInput = z.infer<typeof storeLocationInputSchema>;

export const storeLocationUpdateSchema = storeLocationInputSchema.partial();
export type StoreLocationUpdate = z.infer<typeof storeLocationUpdateSchema>;
