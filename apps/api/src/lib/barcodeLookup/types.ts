export interface ProductLookupResult {
  found: boolean;
  name?: string;
  brand?: string;
  description?: string;
  size?: string;
  category?: string;
  imageUrl?: string;
  provider: string;
  raw?: unknown;
}

export interface ProductLookupProvider {
  name: string;
  lookup(barcodeValue: string): Promise<ProductLookupResult | null>;
}
