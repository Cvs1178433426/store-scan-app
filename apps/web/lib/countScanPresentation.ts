export type CountScanPresentationInput = {
  barcodeValue: string;
  quantityAdded: number;
  currentQuantity: number;
  productName: string | null;
  locationCode: string;
  locationName: string | null;
};

export type CountScanPresentation = {
  title: string;
  upc: string;
  location: string;
  added: number;
  current: number;
  known: boolean;
};

export function buildCountScanPresentation(input: CountScanPresentationInput): CountScanPresentation {
  const location = input.locationName?.trim()
    ? `${input.locationCode} — ${input.locationName.trim()}`
    : input.locationCode;

  return {
    title: input.productName?.trim() || "Unknown product",
    upc: input.barcodeValue,
    location,
    added: input.quantityAdded,
    current: input.currentQuantity,
    known: Boolean(input.productName?.trim()),
  };
}
