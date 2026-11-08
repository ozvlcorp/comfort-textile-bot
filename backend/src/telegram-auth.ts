import { createHmac, timingSafeEqual } from "node:crypto";

// Verifies data that Telegram signed for a Mini App with the bot's token: the
// launch data (WebApp.initData) or the result of WebApp.requestContact. Both are
// query strings ending in `hash`, checked as Telegram documents for Mini Apps:
//   secret = HMAC_SHA256(key = "WebAppData", data = bot token)
//   hash   = hex(HMAC_SHA256(key = secret, data = all other fields as "k=v",
//                            sorted by key, joined with "\n"))
// Returns the parsed fields if the signature matches and auth_date is not older
// than maxAgeSec, otherwise null.
export function verifyTelegramSignedData(
  raw: string,
  botToken: string,
  maxAgeSec: number,
  now: number = Date.now()
): URLSearchParams | null {
  if (!raw || !botToken) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get("hash") || "";
  if (!/^[0-9a-f]{64}$/i.test(hash)) return null;

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key !== "hash") pairs.push(`${key}=${value}`);
  });
  pairs.sort();

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(pairs.join("\n")).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSec) return null;
  return params;
}
