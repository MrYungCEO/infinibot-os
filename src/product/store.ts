/**
 * Products plugin seam.
 *
 * The strategy portfolio is owned by the manifest-v2 `products` plugin. Core
 * business surfaces still resolve product links and the generic
 * `business_objects` tool still has a product vocabulary, so they depend on
 * this tiny provider seam instead of importing the plugin or opening its DB.
 *
 * When the plugin is off the inert provider returns no rows and rejects
 * writes. That makes Dashboard/Business HQ, relations, clients and invoices
 * degrade to an empty optional capability without recreating plugin data.
 */

import type {
  Product,
  ProductCreateParams,
  ProductSearchParams,
  ProductUpdateParams,
} from "./types.js";

export interface ProductStoreProvider {
  list(params?: ProductSearchParams): Product[];
  get(id: string): Product | null;
  create(params: ProductCreateParams): Product;
  update(params: ProductUpdateParams): Product | null;
  delete(id: string): boolean;
}

export type ProductStoreFactory = (stateDir?: string) => ProductStoreProvider;

const PRODUCT_STORE_PROVIDER = Symbol.for("infinibot.products.storeProvider");
type GlobalWithProductStore = typeof globalThis & {
  [PRODUCT_STORE_PROVIDER]?: ProductStoreFactory;
};

const unavailableStore: ProductStoreProvider = {
  list: () => [],
  get: () => null,
  create: () => {
    throw new Error('Products plugin is turned off. Enable "Products" in Setup > Plugins.');
  },
  update: () => null,
  delete: () => false,
};

/** Called by the Products plugin when it is loaded. */
export function registerProductStoreProvider(factory: ProductStoreFactory): () => void {
  const target = globalThis as GlobalWithProductStore;
  target[PRODUCT_STORE_PROVIDER] = factory;
  return () => {
    if (target[PRODUCT_STORE_PROVIDER] === factory) delete target[PRODUCT_STORE_PROVIDER];
  };
}

export function isProductStoreAvailable(): boolean {
  return Boolean((globalThis as GlobalWithProductStore)[PRODUCT_STORE_PROVIDER]);
}

/**
 * Compatibility accessor for core consumers. It never opens a database. The
 * real provider and storage implementation live in `extensions/products`.
 */
export function getProductStore(stateDir?: string): ProductStoreProvider {
  const factory = (globalThis as GlobalWithProductStore)[PRODUCT_STORE_PROVIDER];
  return factory ? factory(stateDir) : unavailableStore;
}
