import { PrismaClient } from "@prisma/client";

// Append statement_timeout so hung DB queries fail after 20s instead of waiting forever.
// Prisma silently drops unknown URL params (a bare `statement_timeout=` is ignored),
// so it must go through `options`, which Postgres applies at connection start.
function buildDbUrl(): string {
  const url = process.env.DATABASE_URL || "";
  if (!url || url.includes("statement_timeout") || url.includes("options=")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}options=${encodeURIComponent("-c statement_timeout=20000")}`;
}

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['error'] : ['query', 'error', 'warn'],
  datasources: {
    db: {
      url: buildDbUrl()
    }
  }
});
