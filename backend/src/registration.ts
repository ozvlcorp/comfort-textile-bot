import { prisma } from "./db.js";
import { createCounterparty, findCounterpartyByPhone, updateCounterpartyAttrs } from "./mosklad.js";

export type ContactRegistration = {
  telegramId: string;
  phoneNumber: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  language?: string;
};

// Saves a Telegram user's phone and links them to their MoySklad counterparty:
// the one found by phone (taken over from any other Telegram account that held
// it), or a newly created one. Same steps as the shop bot's contact handler,
// for registrations that come from the webapp instead of the chat.
export async function registerContact(c: ContactRegistration): Promise<{ counterpartyId: string; isNew: boolean }> {
  await prisma.user.upsert({
    where: { telegramId: c.telegramId },
    update: {
      phoneNumber: c.phoneNumber,
      ...(c.firstName ? { firstName: c.firstName } : {}),
      ...(c.lastName ? { lastName: c.lastName } : {}),
      ...(c.username ? { username: c.username } : {}),
      ...(c.language ? { language: c.language } : {})
    },
    create: {
      telegramId: c.telegramId,
      phoneNumber: c.phoneNumber,
      firstName: c.firstName || null,
      lastName: c.lastName || null,
      username: c.username || null,
      ...(c.language ? { language: c.language } : {})
    }
  });

  const existingId = await findCounterpartyByPhone(c.phoneNumber).catch(() => null);
  if (existingId) {
    await prisma.user.updateMany({
      where: { moskladCounterpartyId: existingId, NOT: { telegramId: c.telegramId } },
      data: { moskladCounterpartyId: null }
    });
    await prisma.user.update({
      where: { telegramId: c.telegramId },
      data: { moskladCounterpartyId: existingId, pendingState: null }
    });
    await updateCounterpartyAttrs(existingId, c.telegramId, c.username || undefined).catch(() => {});
    return { counterpartyId: existingId, isNew: false };
  }

  const counterpartyId = await createCounterparty(
    c.telegramId,
    c.phoneNumber,
    c.firstName || c.phoneNumber,
    c.username || undefined
  );
  await prisma.user.update({
    where: { telegramId: c.telegramId },
    data: { moskladCounterpartyId: counterpartyId }
  });
  return { counterpartyId, isNew: true };
}
