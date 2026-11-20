const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Use verified TLS for every remote PostgreSQL connection.
 * Only local development instances may use a plaintext loopback connection.
 * Production must verify certificates even when a local hostname is configured.
 */
export function databaseSslOptions(connectionString, { nodeEnv = process.env.NODE_ENV } = {}) {
  if (!connectionString) return undefined;

  let hostname;
  try {
    hostname = new URL(connectionString).hostname.toLowerCase();
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }
  } catch {
    throw new Error("DATABASE_URL_MUST_BE_A_VALID_POSTGRES_URL");
  }

  if (LOOPBACK_HOSTS.has(hostname) && nodeEnv !== "production") {
    return false;
  }

  return { rejectUnauthorized: true };
}
