import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import rateLimit from "@fastify/rate-limit";
import { registerHealthRoute } from "./routes/health.js";
import { registerApiRoutes } from "./routes/api.js";
import { createBot } from "./bot.js";
import { startReminderWorker, stopReminderWorker } from "./reminders.js";
import { startReportScheduler, stopReportScheduler } from "./reports.js";
import { prisma } from "./db.js";

const port = Number(process.env.PORT || 4000);
const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
  },
  requestTimeout: 30000,
  connectionTimeout: 30000,
  // Behind Traefik (Dokploy) every connection comes from the proxy, so without
  // this request.ip was Traefik's address for every visitor and the per-IP rate
  // limit below was one bucket shared by all customers. 1 = trust exactly one
  // proxy hop: the client is the address Traefik puts in X-Forwarded-For.
  trustProxy: 1,
});

let bot: any = null;
let isShuttingDown = false;

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  server.log.info(`${signal} received, starting graceful shutdown...`);

  try {
    // Stop accepting new connections
    await server.close();
    server.log.info("HTTP server closed");

    // Stop reminder worker
    stopReminderWorker();
    server.log.info("Reminder worker stopped");

    // Stop report scheduler
    stopReportScheduler();
    server.log.info("Report scheduler stopped");

    // Stop Telegram bot
    if (bot) {
      await bot.stop(signal);
      server.log.info("Telegram bot stopped");
    }

    // Close database connections
    await prisma.$disconnect();
    server.log.info("Database connections closed");

    server.log.info("Graceful shutdown completed");
    process.exit(0);
  } catch (err) {
    server.log.error({ err }, "Error during shutdown:");
    process.exit(1);
  }
}

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  server.log.error({ err }, "Uncaught Exception:");
  gracefulShutdown("UNCAUGHT_EXCEPTION");
});

process.on("unhandledRejection", (reason, promise) => {
  // Log but do NOT crash — a single async error shouldn't kill the whole bot.
  // Each Telegraf handler is independent; crashing restarts the process and
  // causes all pending Telegram messages to flood in at once on restart.
  server.log.error({ promise, reason }, "Unhandled Rejection (not crashing):");
});

// Graceful shutdown signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// PM2 graceful shutdown
process.on("message", (msg) => {
  if (msg === "shutdown") {
    gracefulShutdown("PM2_SHUTDOWN");
  }
});

// Register plugins
await server.register(cors, {
  origin: [
    process.env.WEBAPP_URL || "https://twa-ct-shopbot.oymoysklad.com",
    "https://api.moysklad.ru",
  ],
  credentials: true,
});
await server.register(compress, { global: true, threshold: 1024 });
await server.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
  cache: 10000,
});

// Register routes
registerHealthRoute(server);
registerApiRoutes(server);

// Start HTTP server
try {
  await server.listen({ port, host: "0.0.0.0" });
  server.log.info(`Server listening on http://0.0.0.0:${port}`);

  // Signal PM2 that app is ready
  if (process.send) {
    process.send("ready");
  }
} catch (err) {
  server.log.error({ err }, "Failed to start server:");
  process.exit(1);
}

// Start Telegram bot after HTTP server is up to avoid blocking health checks
const botToken = process.env.BOT_TOKEN;
// SHOP_BOT_MODE=shared: BOT_TOKEN belongs to the main bot (@Comfort_txt_bot),
// whose own process already receives its updates — Telegram allows only one
// receiver per bot. The shop then only sends through it (order notices, admin
// alerts); updates, reminders and reports stay with the main bot, and customers
// register from the webapp (POST /api/register-contact).
const sharedMainBot = process.env.SHOP_BOT_MODE === "shared";
if (botToken && sharedMainBot) {
  server.log.info("Telegram: shared main bot — sending only (no polling, reminders or reports)");
} else if (botToken) {
  (async () => {
    try {
      bot = createBot(botToken);
      bot.launch().catch((err: unknown) => {
        // 409: another process already receives this bot's updates (e.g. the main
        // bot with the same token). A restart can't fix that, and exiting would
        // put the whole shop API into a restart loop — keep serving without the bot.
        const e = err as { response?: { error_code?: number }; message?: string };
        if (e?.response?.error_code === 409 || /\b409\b|Conflict/.test(String(e?.message))) {
          stopReminderWorker();
          stopReportScheduler();
          server.log.error(
            { err },
            "Telegram bot disabled: this token is already polled by another process. If it is the main bot's token, set SHOP_BOT_MODE=shared."
          );
          return;
        }
        // Fatal polling failure — exit so PM2 can do a clean restart.
        server.log.error({ err }, "Telegram bot polling crashed fatally — exiting for PM2 restart");
        if (!isShuttingDown) process.exit(1);
      });
      server.log.info("Telegram bot started");
      startReminderWorker(bot);
      startReportScheduler(bot);

      // Register bot commands
      await bot.telegram.setMyCommands([
        { command: "start", description: "Botni ishga tushirish / Запустить бота" },
      ]).catch(() => {});

      // TODO: Re-enable webapp menu button when webapp is back online
      // const webappUrl = process.env.WEBAPP_URL || "http://localhost:5173";
      // await bot.telegram
      //   .setChatMenuButton({
      //     menuButton: {
      //       type: "web_app",
      //       text: "Shop",
      //       web_app: { url: webappUrl },
      //     },
      //   })
      //   .catch(() => {});
    } catch (err) {
      server.log.error({ err }, "Failed to start Telegram bot:");
    }
  })();
} else {
  server.log.warn("BOT_TOKEN is not set; bot will not start");
}
