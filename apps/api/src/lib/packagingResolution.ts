export type PackagingQuantity = {
  unitsOfEach: number;
};

export type CompositionComponent = {
  productId: string;
  quantityPerParent: number;
};

export type ExpandedComponent = {
  productId: string;
  eachQuantity: number;
};

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export function resolvePackagingQuantity(packaging: PackagingQuantity, requestedQuantity: number) {
  assertPositiveInteger(packaging.unitsOfEach, "Pack quantity");
  assertPositiveInteger(requestedQuantity, "Requested quantity");
  return packaging.unitsOfEach * requestedQuantity;
}

export function expandComposition(
  components: CompositionComponent[],
  requestedQuantity: number,
): ExpandedComponent[] {
  assertPositiveInteger(requestedQuantity, "Requested quantity");
  if (components.length === 0) throw new Error("Composition must contain at least one component");

  for (const component of components) {
    if (!component.productId.trim()) throw new Error("Component productId is required");
    assertPositiveInteger(component.quantityPerParent, "Component quantity");
  }

  return components.map((component) => ({
    productId: component.productId,
    eachQuantity: component.quantityPerParent * requestedQuantity,
  }));
}
