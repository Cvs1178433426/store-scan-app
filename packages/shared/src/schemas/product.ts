import { z } from "zod";

export const productInputSchema = z.object({
  barcodeValue: z.string().trim().min(1).max(64).nullable().optional(),
  name: z.string().trim().min(1).max(300),
  manufacturer: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  packageSize: z.string().trim().max(120).nullable().optional(),
  imageUrl: z.string().trim().max(2000).nullable().optional(),
  categoryId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});
export type ProductInput = z.infer<typeof productInputSchema>;

export const productUpdateSchema = productInputSchema.partial();
export type ProductUpdate = z.infer<typeof productUpdateSchema>;
