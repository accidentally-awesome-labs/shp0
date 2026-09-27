/**
 * Test helper (not a test file): run code against a throwaway schema of the
 * shared test database, as if it were a database of its own.
 *
 * With search_path pinned to that schema for every connection, every
 * unqualified CREATE, REFERENCES and query resolves inside it and nothing in
 * `public` is visible. (A throwaway database would need CREATEDB, which the
 * test roles deliberately lack.)
 */

/** The platform connection string the suites use. */
export const BASE_URL =
  process.env.PLATFORM_DATABASE_URL ??
  "postgresql:///shp0_test?user=cloud_admin";

/**
 * `base` with `-c search_path=<schemaName>` added to its startup `options`.
 * Appends rather than replaces, so options already in the URL (for example a
 * hosted provider's `endpoint=...` routing option) are kept.
 */
export function urlWithSearchPath(base: string, schemaName: string): string {
  const url = new URL(base);
  const searchPath = `-c search_path=${schemaName}`;
  const existing = url.searchParams.get("options");
  url.searchParams.set(
    "options",
    existing ? `${existing} ${searchPath}` : searchPath,
  );
  return url.toString();
}
