import { queue } from "@trigger.dev/sdk";

/** One active agent turn per `concurrencyKey` (chatId) when triggering. */
export const agentTurnsQueue = queue({
  name: "agent-turns",
  concurrencyLimit: 1,
});

export const magicaQueue = queue({
  name: "magica",
  concurrencyLimit: 8,
});

export const e2bQueue = queue({
  name: "e2b-sandbox",
  concurrencyLimit: 4,
});

export const exaQueue = queue({
  name: "exa",
  concurrencyLimit: 8,
});
