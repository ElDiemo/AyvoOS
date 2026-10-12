/**
 * The warehouse a warehouse-scoped request acts on (doc 022): the default warehouse of the
 * session's active site, resolved and authorized by the global access guard on every request —
 * never taken from the URL, query, body, cookies or headers.
 */
export interface WarehouseContext {
  siteId: string;
  siteCode: string;
  locationId: string;
  locationCode: string;
}

/** The active site a site-scoped request acts at (authorized by the guard, doc 022). */
export interface SiteContext {
  siteId: string;
  siteCode: string;
}
