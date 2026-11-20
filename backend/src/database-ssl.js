const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Remote PostgreSQL endpoints always use certificate verification.
 * Plaintext is permitted only for loopback development or the explicitly
 * isolated Docker Compose database service (which has no published port).
 */
export function databaseSslOptions(connectionString, {
  nodeEnv = process.env.NODE_ENV,
  sslMode = process.env.DATABASE_SSL_MODE,
  trustedLocalDb = process.env.KINGBOT_TRUSTED_LOCAL_DB
} = {}) {
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

  // The Compose file places the database on a private bridge network and
  // deliberately does not publish its port. Both opt-in flags are required.
  if (hostname === "postgres" && sslMode === "disable" && trustedLocalDb === "1") {
    return false;
  }

  return { rejectUnauthorized: true };
}
