// bot.ts
require("dotenv").config();
import { Bot, BotError, Context, GrammyError, HttpError, NextFunction, session, SessionFlavor, webhookCallback } from "grammy";
import http from 'http';
import { run, sequentialize } from "@grammyjs/runner";
import { autoRetry } from "@grammyjs/auto-retry";
import { limit } from "@grammyjs/ratelimiter";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import Bottleneck from 'bottleneck';
import { escapeMetaCharacters, getGrammyLink, getGrammyName, getGrammyNameLink, getRemainingTime, linkChecker, logGroup, replyMarkdownV2, replyMsg, replytoMsg, channelPostLink } from "./services/hooks";
import { Menu } from "@grammyjs/menu";
import { BACKUP_ID, CHANNEL_ID, CHAT_ID, ConfessionLimitResetMs, Encryption, LOG_GROUP_ID, msgArr, REVIEW_ID, startBotMsg, startGroupMsg } from "./schema/constants";
import { SessionData } from "./schema/interfaces";
import { confessionStorage, readChatIDAll, readID, settingsStorage, writeID, readConfig, writeConfig, deleteChatID, startChatIdsBackgroundRefresh, getDbCacheStats, resetDbCacheStats, findUserIdByPostId, mapPostToUser, getUserByPostMap } from "./services/db";

// Helper: send to groups/chats, handling forums (topics) and channels gracefully
const POST_USER_TTL = 24 * 60 * 60 * 1000; // 24h
const postUserCache = new Map<number, { uid: number; ts: number }>();
const rememberPostUser = (postId: number, uid: number) => {
  if (!postId || !uid) return;
  postUserCache.set(postId, { uid, ts: Date.now() });
};
const getPostUser = (postId: number): number | undefined => {
  const e = postUserCache.get(postId);
  if (!e) return undefined;
  if (Date.now() - e.ts > POST_USER_TTL) {
    postUserCache.delete(postId);
    return undefined;
  }
  return e.uid;
};
const topicCache = new Map<number, number | undefined>();
async function safeBroadcastToChat(api: any, chatId: number, text: string) {
  try {
    let threadId = topicCache.get(chatId);
    if (threadId === undefined) {
      const cfg = await readConfig(chatId);
      threadId = cfg?.threadId;
      topicCache.set(chatId, threadId);
    }
    if (threadId && threadId > 0) {
      await api.sendMessage(chatId, text, { message_thread_id: threadId });
    } else {
      await api.sendMessage(chatId, text);
    }
    metrics.broadcasts++;
  } catch (e: any) {
    const desc = e?.description || e?.message || '';
    // Remove stale chats when Telegram says chat not found
    if (typeof desc === 'string' && desc.toLowerCase().includes('chat not found')) {
      try {
        await deleteChatID(chatId);
        topicCache.delete(chatId);
        console.warn('Removed stale chat from DB:', chatId);
        return;
      } catch (err) {
        console.error('Failed to remove stale chat from DB', chatId, err);
        return; // do not rethrow; treat as handled
      }
    }
    // If chat has topics enabled, a message_thread_id may be required. Try General topic (1).
    if (typeof desc === 'string' && desc.toLowerCase().includes('topic must be specified')) {
      try {
        const chat = await api.getChat(chatId);
        if (chat?.type === 'supergroup' && (chat as any).is_forum) {
          await api.sendMessage(chatId, text, { message_thread_id: 1 });
          metrics.broadcasts++;
          return;
        }
      } catch {
        // ignore and rethrow original
      }
    }
    // Skip channels or other unsupported chats by rethrowing; callers already log
    throw e;
  }
}

// Helper: pin messages with light retry to avoid Bottleneck drops
async function safePin(api: any, chatId: number, messageId: number, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      await api.pinChatMessage(chatId, messageId);
      metrics.pins++;
      return;
    } catch (err: any) {
      const msg = String(err?.description || err?.message || "");
      const dropped = msg.toLowerCase().includes('dropped by bottleneck');
      if (dropped && i < tries - 1) {
        metrics.retries++;
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

// Create the bot.
export type MyContext = Context & SessionFlavor<SessionData>;
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing in environment");
}
const bot = new Bot<MyContext>(BOT_TOKEN); // <-- put your bot token between the ""

const USE_WEBHOOK = String(process.env.USE_WEBHOOK || '').toLowerCase() === 'true';
if (!USE_WEBHOOK) {
  // Ensure no webhook is set when using long polling locally
  bot.api.deleteWebhook({ drop_pending_updates: false }).catch((err) => {
    console.warn('deleteWebhook failed (non-fatal):', err?.description ?? err?.message ?? err);
  });
}


// session for a user
function getUserSessionKey(ctx: Context): string | undefined {
  return ctx.from?.id.toString();
}
// session for a group
function getChatSessionKey(ctx: Context): string | undefined {
  return ctx.chat?.id.toString();
}

function boundaryHandler(err: BotError, next: NextFunction) {
  console.error("Error in Q, X, Y, or Z!", err);
  /*
   * You could call `next` if you want to run
   * the middleware at C in case of an error:
   */
  // await next()
}



//session handler
bot.use(session({
  type: 'multi',
  userdata: {
    initial: () => ({
      confessionTime: 0,
      confessions: [],
      isBanned: false,
      freeConfessions: 0,
      refby: 0
    }),
    getSessionKey: getUserSessionKey,
    storage: confessionStorage
  },
  config: {
    initial: () => { return { isLogged: false } },
    getSessionKey: getChatSessionKey,
    storage: settingsStorage
  },
}));


// Env-driven throttler tuning
const envInt = (key: string, def: number) => {
  const v = process.env[key];
  const n = v != null ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
};

const globalConfig = {
  maxConcurrent: 2,
  minTime: envInt('THROTTLE_GLOBAL_MIN_TIME', 200),
  highWater: envInt('THROTTLE_GLOBAL_HIGH_WATER', 100),
  strategy: Bottleneck.strategy.BLOCK,
  reservoir: envInt('THROTTLE_GLOBAL_RESERVOIR', 100),
  penalty: 3000,
  reservoirRefreshAmount: envInt('THROTTLE_GLOBAL_REFRESH_AMOUNT', 100),
  reservoirRefreshInterval: envInt('THROTTLE_GLOBAL_REFRESH_INTERVAL', 2000),
};

// Outgoing Group Throttler
const groupConfig = {
  maxConcurrent: envInt('THROTTLE_GROUP_MAX_CONCURRENT', 2),
  minTime: envInt('THROTTLE_GROUP_MIN_TIME', 0),
  highWater: envInt('THROTTLE_GROUP_HIGH_WATER', 100),
  strategy: Bottleneck.strategy.BLOCK,
  reservoir: envInt('THROTTLE_GROUP_RESERVOIR', 100),
  penalty: 3000,
  reservoirRefreshAmount: envInt('THROTTLE_GROUP_REFRESH_AMOUNT', 100),
  reservoirRefreshInterval: envInt('THROTTLE_GROUP_REFRESH_INTERVAL', 2000),
};

// Outgoing Private Throttler
const outConfig = {
  maxConcurrent: envInt('THROTTLE_OUT_MAX_CONCURRENT', 2),
  minTime: envInt('THROTTLE_OUT_MIN_TIME', 200),
  highWater: envInt('THROTTLE_OUT_HIGH_WATER', 100),
  strategy: Bottleneck.strategy.BLOCK,
  reservoir: envInt('THROTTLE_OUT_RESERVOIR', 120),
  penalty: 3000,
  reservoirRefreshAmount: envInt('THROTTLE_OUT_REFRESH_AMOUNT', 120),
  reservoirRefreshInterval: envInt('THROTTLE_OUT_REFRESH_INTERVAL', 2000)
};

const throttler = apiThrottler({
  global: globalConfig,
  group: groupConfig,
  out: outConfig
});
bot.api.config.use(throttler);

// Lightweight metrics
const metrics = {
  apiCalls: 0,
  apiErrors429: 0,
  broadcasts: 0,
  pins: 0,
  retries: 0,
};

// API transformer to count calls and 429s
bot.api.config.use((prev, method, payload, signal) => {
  metrics.apiCalls++;
  return prev(method, payload, signal).catch((err: any) => {
    if (err instanceof GrammyError && String(err.description || err.message).includes('Too Many Requests')) {
      metrics.apiErrors429++;
    }
    throw err;
  });
});

const METRICS_INTERVAL_MS = Number(process.env.METRICS_INTERVAL_MS || 60000);
setInterval(() => {
  const dbStats = getDbCacheStats();
  const snapshot = { ts: Date.now(), ...metrics, dbCache: dbStats };
  console.log(JSON.stringify({ type: 'metrics', data: snapshot }));
  // reset counters
  metrics.apiCalls = 0;
  metrics.apiErrors429 = 0;
  metrics.broadcasts = 0;
  metrics.pins = 0;
  metrics.retries = 0;
  resetDbCacheStats();
}, METRICS_INTERVAL_MS).unref();

// Limits message handling to a message per second for each user.
bot.use(limit({
  // Allow only 2 messages to be handled every 2 seconds.
  timeFrame: 2000,
  limit: 2,

  // This is called when the limit is exceeded.
  onLimitExceeded: async (ctx) => {
  },
  // Note that the key should be a number in string format such as "123456789".
  keyGenerator: (ctx) => {
    const id = ctx.from?.id ?? ctx.chat?.id ?? ctx.update?.update_id;
    return String(id ?? Date.now());
  },
}));

// // race conditions: chat and user
const constraints = (ctx: Context) => [ctx.chat?.id, ctx.from?.id]
  .filter((v): v is number => typeof v === "number")
  .map(String)
// const constraints = (ctx: Context) => String(ctx.from?.id)?? Date.now().toString()

bot.use(sequentialize(constraints))

bot.errorBoundary(boundaryHandler)


// auto retry bot commands 
bot.api.config.use(autoRetry(
  {
    maxRetryAttempts: 5,
    maxDelaySeconds: 2,
    rethrowInternalServerErrors: true,
    rethrowHttpErrors: true,
  }
));



const startGroupMenu = new Menu<MyContext>("dynamic-group");
startGroupMenu
  .url("Confess", "https://t.me/tg_confession_bot").row()
  .url("Advice", channelPostLink()).row()

bot.use(startGroupMenu)

const startBotMenu = new Menu<MyContext>("dynamic-bot");
startBotMenu
  .url("Advice", (ctx) => ctx.session.userdata.confessions[0]?.id && (Date.now() - ctx.session.userdata.confessionTime < ConfessionLimitResetMs) ? channelPostLink(ctx.session.userdata.confessions[0]?.id) : channelPostLink()).row()

bot.use(startBotMenu)


const reviewBotMenu = new Menu<MyContext>("review-bot");
reviewBotMenu.text("Approve", async (ctx) => {
  if (ctx.msg?.caption) {
    const msg = ctx.msg?.caption ?? ""
    const media = ctx.msg?.photo
    const audio = ctx.msg.audio;
    const voice = ctx.msg.voice;
    if (audio) {
      const message = msg.split("\n").slice(1).join('\n')
      const userID = parseInt(msg.split("\n")[0], Encryption)
      if (Number.isNaN(userID)) return;
      if (Number.isNaN(userID)) return;
      const postLink = await ctx.api.sendAudio(CHANNEL_ID, audio.file_id, { caption: msg })
      const postLinkEdited = await ctx.api.editMessageCaption(CHANNEL_ID, postLink.message_id, { caption: `Confession-${userID.toString(Encryption)}-${postLink.message_id}\n` + message })
      const userData = await readID(userID.toString())
      if (userData == undefined) return;
      await writeID(userID.toString(), { ...userData, confessions: [{ id: postLink.message_id }, ...userData?.confessions] })
      rememberPostUser(postLink.message_id, userID);
      mapPostToUser(postLink.message_id, userID).catch(() => {});
      const messageConfirm = await ctx.api.sendMessage(userID, `Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${userID.toString(Encryption)}-${postLink.message_id}`)}](${channelPostLink(postLink.message_id)})\\!`, { parse_mode: "MarkdownV2" });
      // Skip pinning in private chats
      try { await (ctx.menu.close as any)(); } catch (err) { console.error('menu.close failed', err); }
      ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
      return
    } else if (voice) {
      const message = msg.split("\n").slice(1).join('\n')
      const userID = parseInt(msg.split("\n")[0], Encryption)
      if (Number.isNaN(userID)) return;
      const postLink = await ctx.api.sendVoice(CHANNEL_ID, voice.file_id, { caption: msg })
      const postLinkEdited = await ctx.api.editMessageCaption(CHANNEL_ID, postLink.message_id, { caption: `Confession-${userID.toString(Encryption)}-${postLink.message_id}\n` + message })
      const userData = await readID(userID.toString())
      if (userData == undefined) return;
      await writeID(userID.toString(), { ...userData, confessions: [{ id: postLink.message_id }, ...userData?.confessions] })
      rememberPostUser(postLink.message_id, userID);
      mapPostToUser(postLink.message_id, userID).catch(() => {});
      const messageConfirm = await ctx.api.sendMessage(userID, `Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${userID.toString(Encryption)}-${postLink.message_id}`)}](${channelPostLink(postLink.message_id)})\\!`, { parse_mode: "MarkdownV2" });
      // Skip pinning in private chats
      try { await (ctx.menu.close as any)(); } catch (err) { console.error('menu.close failed', err); }
      ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
      return
    } else {
      const message = msg.split("\n").slice(1).join('\n')
      if (media == undefined) return;
      const userID = parseInt(msg.split("\n")[0], Encryption)
      if (Number.isNaN(userID)) return;
      const postLink = await ctx.api.sendPhoto(CHANNEL_ID, media[0].file_id, { caption: msg })
      const postLinkEdited = await ctx.api.editMessageCaption(CHANNEL_ID, postLink.message_id, { caption: `Confession-${userID.toString(Encryption)}-${postLink.message_id}\n` + message })
      const userData = await readID(userID.toString())
      if (userData == undefined) return;
      await writeID(userID.toString(), { ...userData, confessions: [{ id: postLink.message_id }, ...userData?.confessions] })
      rememberPostUser(postLink.message_id, userID);
      mapPostToUser(postLink.message_id, userID).catch(() => {});
      rememberPostUser(postLink.message_id, userID);
      mapPostToUser(postLink.message_id, userID).catch(() => {});
      rememberPostUser(postLink.message_id, userID);
      mapPostToUser(postLink.message_id, userID).catch(() => {});
      const messageConfirm = await ctx.api.sendMessage(userID, `Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${userID.toString(Encryption)}-${postLink.message_id}`)}](${channelPostLink(postLink.message_id)})\\!`, { parse_mode: "MarkdownV2" });
      // Skip pinning in private chats
      try { await (ctx.menu.close as any)(); } catch (err) { console.error('menu.close failed', err); }
      ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
      return
    }
  } else {
    const msg = ctx.msg?.text ?? ""
    const userID = parseInt(msg.split("\n")[0], Encryption)
    if (Number.isNaN(userID)) return;
    const message = msg.split("\n").slice(1).join('\n')
    const postLink = await ctx.api.sendMessage(CHANNEL_ID, message)
    const postLinkEdited = await ctx.api.editMessageText(CHANNEL_ID, postLink.message_id, `Confession-${userID.toString(Encryption)}-${postLink.message_id}\n` + message)
    const userData = await readID(userID.toString())
    if (userData == undefined) return;
    await writeID(userID.toString(), { ...userData, confessions: [{ id: postLink.message_id }, ...userData?.confessions] })
    rememberPostUser(postLink.message_id, userID);
    mapPostToUser(postLink.message_id, userID).catch(() => {});
    const messageConfirm = await ctx.api.sendMessage(userID, `Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${userID.toString(Encryption)}-${postLink.message_id}`)}](${channelPostLink(postLink.message_id)})\\!`, { parse_mode: "MarkdownV2" });
    // Skip pinning in private chats
    try { await (ctx.menu.close as any)(); } catch (err) { console.error('menu.close failed', err); }
    ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
  }
}).row()
reviewBotMenu.text("Broadcast", async (ctx) => {
  if (ctx.msg?.caption) {
    const msg = ctx.msg?.caption ?? ""
    const message = msg.split("\n").slice(1).join('\n')
    const media = ctx.msg?.photo
    const audio = ctx.msg?.audio
    const voice = ctx.msg?.voice
    if (audio) {
      const userID = parseInt(msg.split("\n")[0], Encryption)
      const postLink = await ctx.api.sendAudio(CHANNEL_ID, audio.file_id, { caption: msg })
      const postLinkEdited = await ctx.api.editMessageCaption(CHANNEL_ID, postLink.message_id, { caption: `Confession-${userID.toString(Encryption)}-${postLink.message_id}\n` + message })
      const userData = await readID(userID.toString())
      if (userData == undefined) return;
      await writeID(userID.toString(), { ...userData, confessions: [{ id: postLink.message_id }, ...userData?.confessions] })
      const messageConfirm = await ctx.api.sendMessage(userID, `Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${userID.toString(Encryption)}-${postLink.message_id}`)}](${channelPostLink(postLink.message_id)})\\!`, { parse_mode: "MarkdownV2" });
      // Skip pinning in private chats
      try { await (ctx.menu.close as any)(); } catch (err) { console.error('menu.close failed', err); }
      ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
      const groups = await readChatIDAll()
      if (groups) {
        const linkToComment = channelPostLink(postLink.message_id ?? 0)
        safePin(ctx.api, CHANNEL_ID, postLink?.message_id ?? 0).catch((err) => { console.error('pinChatMessage failed', err); })
        groups.filter((id) => id < 0).forEach(async (gID) => {
          if (gID == CHANNEL_ID || gID == LOG_GROUP_ID || gID == CHAT_ID || gID == REVIEW_ID || gID == BACKUP_ID) {
            return
          }
          safeBroadcastToChat(ctx.api, gID, linkToComment).catch((err) => { console.error('sendMessage to group failed', gID, err); })
        })
      }
      return

    } else if (voice) {
      const userID = parseInt(msg.split("\n")[0], Encryption)
      if (Number.isNaN(userID)) return;
      const postLink = await ctx.api.sendVoice(CHANNEL_ID, voice.file_id, { caption: msg })
      const postLinkEdited = await ctx.api.editMessageCaption(CHANNEL_ID, postLink.message_id, { caption: `Confession-${userID.toString(Encryption)}-${postLink.message_id}\n` + message })
      const userData = await readID(userID.toString())
      if (userData == undefined) return;
      await writeID(userID.toString(), { ...userData, confessions: [{ id: postLink.message_id }, ...userData?.confessions] })
      const messageConfirm = await ctx.api.sendMessage(userID, `Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${userID.toString(Encryption)}-${postLink.message_id}`)}](${channelPostLink(postLink.message_id)})\\!`, { parse_mode: "MarkdownV2" });
      // Skip pinning in private chats
      try { await (ctx.menu.close as any)(); } catch (err) { console.error('menu.close failed', err); }
      ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
      const groups = await readChatIDAll()
      if (groups) {
        const linkToComment = channelPostLink(postLink.message_id ?? 0)
        safePin(ctx.api, CHANNEL_ID, postLink?.message_id ?? 0).catch((err) => { console.error('pinChatMessage failed', err); })
        groups.filter((id) => id < 0).forEach(async (gID) => {
          if (gID == CHANNEL_ID || gID == LOG_GROUP_ID || gID == CHAT_ID || gID == REVIEW_ID || gID == BACKUP_ID) {
            return
          }
          safeBroadcastToChat(ctx.api, gID, linkToComment).catch((err) => { console.error('sendMessage to group failed', gID, err); })
        })
      }
      return

    } else {
      if (media == undefined) return;
      const userID = parseInt(msg.split("\n")[0], Encryption)
      const postLink = await ctx.api.sendPhoto(CHANNEL_ID, media[0].file_id, { caption: msg })
      const postLinkEdited = await ctx.api.editMessageCaption(CHANNEL_ID, postLink.message_id, { caption: `Confession-${userID.toString(Encryption)}-${postLink.message_id}\n` + message })
      const userData = await readID(userID.toString())
      if (userData == undefined) return;
      await writeID(userID.toString(), { ...userData, confessions: [{ id: postLink.message_id }, ...userData?.confessions] })
      const messageConfirm = await ctx.api.sendMessage(userID, `Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${userID.toString(Encryption)}-${postLink.message_id}`)}](${channelPostLink(postLink.message_id)})\\!`, { parse_mode: "MarkdownV2" });
      // Skip pinning in private chats
      try { await (ctx.menu.close as any)(); } catch (err) { console.error('menu.close failed', err); }
      ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
      const groups = await readChatIDAll()
      if (groups) {
        const linkToComment = channelPostLink(postLink.message_id ?? 0)
        safePin(ctx.api, CHANNEL_ID, postLink?.message_id ?? 0).catch((err) => { console.error('pinChatMessage failed', err); })
        groups.filter((id) => id < 0).forEach(async (gID) => {
          if (gID == CHANNEL_ID || gID == LOG_GROUP_ID || gID == CHAT_ID || gID == REVIEW_ID || gID == BACKUP_ID) {
            return
          }
          safeBroadcastToChat(ctx.api, gID, linkToComment).catch((err) => { console.error('sendMessage to group failed', gID, err); })
        })
      }
      return

    }
  } else {
    const msg = ctx.msg?.text ?? ""
    const userID = parseInt(msg.split("\n")[0], Encryption)
    if (Number.isNaN(userID)) return;
    const message = msg.split("\n").slice(1).join('\n')
    const postLink = await ctx.api.sendMessage(CHANNEL_ID, message)
    await ctx.api.editMessageText(CHANNEL_ID, postLink.message_id, `Confession-${userID.toString(Encryption)}-${postLink.message_id}\n` + message)
    const userData = await readID(userID.toString())
    if (userData == undefined) return;
    await writeID(userID.toString(), { ...userData, confessions: [{ id: postLink.message_id }, ...userData?.confessions] })
    rememberPostUser(postLink.message_id, userID);
    await ctx.api.sendMessage(userID, `Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${userID.toString(Encryption)}-${postLink.message_id}`)}](${channelPostLink(postLink.message_id)})\\!`, { parse_mode: "MarkdownV2" }).catch((err) => { console.error('notify user failed', userID, err); })
    try { await (ctx.menu.close as any)(); } catch (err) { console.error('menu.close failed', err); }
    ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
    const groups = await readChatIDAll()
    if (groups) {
      const linkToComment = channelPostLink(postLink.message_id ?? 0)
      ctx.api.pinChatMessage(CHANNEL_ID, postLink?.message_id ?? 0).catch((err) => { console.error('pinChatMessage failed', err); })
      groups.filter((id) => id < 0).forEach(async (gID) => {
        if (gID == CHANNEL_ID || gID == LOG_GROUP_ID || gID == CHAT_ID || gID == REVIEW_ID || gID == BACKUP_ID) {
          return
        }
        safeBroadcastToChat(ctx.api, gID, linkToComment).catch((err) => { console.error('sendMessage to group failed', gID, err); })
      })
    }

  }

}).row()
reviewBotMenu.text("Discard", async (ctx) => {
  if (ctx.msg?.caption) {
    const msg = ctx.msg?.caption ?? ""
    const media = ctx.msg?.photo ?? ""
    const userID = parseInt(msg.split("\n")[0], Encryption)
    const messageConfirm = await ctx.api.sendMessage(userID, `Content discarded by the bot due to suspected activities`, { parse_mode: "MarkdownV2" });
    try { await (ctx.menu.close as any)(); } catch (err) { console.error('menu.close failed', err); }
    return
  } else {
    const msg = ctx.msg?.text ?? ""
    const userID = parseInt(msg.split("\n")[0], Encryption)
    const message = msg.split("\n").slice(1).join('\n')
    const messageConfirm = await ctx.api.sendMessage(userID, `Content discarded by the bot as it did not passed the review`, { parse_mode: "MarkdownV2" });
    try { await (ctx.menu.close as any)(); } catch (err) { console.error('menu.close failed', err); }
  }

}).row()

reviewBotMenu.text("Ban", async (ctx) => {
  if (ctx.msg?.caption) {
    const msg = ctx.msg?.caption ?? ""
    const media = ctx.msg?.photo
    const audio = ctx.msg?.audio
    if (audio) {
      const userID = parseInt(msg.split("\n")[0], Encryption)
      const userdata = await readID(userID.toString())
      if (!userdata) {
        return;
      }
      await writeID(userID.toString(), { ...userdata, isBanned: true })
      await ctx.api.sendAudio(ctx.chat?.id ?? 0, audio.file_id, { caption: `${userID} banned` + '\n' + msg })
      const messageConfirm = await ctx.api.sendMessage(userID, `Content discarded by the bot due to suspected activities`, { parse_mode: "MarkdownV2" });
      try { await (ctx.menu.close as any)(); } catch (err) { console.error('menu.close failed', err); }
      return
    } else {
      if (media == undefined) return;
      const userID = parseInt(msg.split("\n")[0], Encryption)
      const userdata = await readID(userID.toString())
      if (!userdata) {
        return;
      }
      await writeID(userID.toString(), { ...userdata, isBanned: true })
    await ctx.api.sendPhoto(ctx.chat?.id ?? 0, media[0].file_id, { caption: `${userID} banned` + '\n' + msg })
      const messageConfirm = await ctx.api.sendMessage(userID, `Content discarded by the bot due to suspected activities`, { parse_mode: "MarkdownV2" });
      try { await (ctx.menu.close as any)(); } catch (err) { console.error('menu.close failed', err); }
      return
    }

  } else {
    const msg = ctx.msg?.text ?? ""

    const userID = parseInt(msg.split("\n")[0], Encryption)
    const message = msg.split("\n").slice(1).join('\n')
    const userdata = await readID(userID.toString())
    if (!userdata) {
      return;
    }
    await writeID(userID.toString(), { ...userdata, isBanned: true })
    await ctx.reply(`${userID} banned` + '\n' + message)

    const messageConfirm = await ctx.api.sendMessage(userID, `Content discarded by the bot due to suspected activities`, { parse_mode: "MarkdownV2" });
    try { await (ctx.menu.close as any)(); } catch (err) { console.error('menu.close failed', err); }
  }

}).row()

bot.use(reviewBotMenu)

bot.command(["start"], (ctx) => {
  replytoMsg({
    ctx,
    message: ctx.chatId == ctx.from?.id ? startBotMsg.join("\n") : startGroupMsg.join("\n"),
    replyMarkup: ctx.chatId == ctx.from?.id ? startBotMenu : startGroupMenu
  })
})
bot.filter(ctx => ctx.chatId == REVIEW_ID).command(["unban"], async (ctx) => {
  const userID = Number(ctx.match.trim());
  if (!Number.isNaN(userID)) {
    const userdata = await readID(userID.toString())
    if (!userdata) {
      return;
    }
    await writeID(userID.toString(), { ...userdata, isBanned: false })
    ctx.reply("User unbanned")
  }
})
bot.command(["reply"], async (ctx) => {
  if (ctx.from && ctx.session.userdata.isBanned) {
    const message = ctx.match.trim();
    const messageConfirm = await ctx.api.sendMessage(ctx.from.id, `Content discarded by the bot due to suspected activities`, { parse_mode: "MarkdownV2" });
    await ctx.api.sendMessage(REVIEW_ID, getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + message)
    await ctx.api.sendMessage(BACKUP_ID, getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + message)
    return;
  }
  if (ctx.chatId != ctx.from?.id) {

    replytoMsg({
      ctx,
      message: "Reply command works only in bot DM to protect your anonymity."
    })
    return ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
  };
  // Extract message text robustly (ctx.match can be undefined)
  const rawText = ctx.message?.text ?? '';
  const message = rawText.replace(/^\/reply(?:@\w+)?\s*/i, '').trim();
  if (linkChecker(message)) {
    ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
    return ctx.reply("Do not post link. Try again.");
  }
  if (message.length == 0) {
    ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
    return ctx.reply("Reply message can't be empty");
  }
  const repliedMsg = ctx.message?.reply_to_message;
  if (!repliedMsg) {
    return ctx.reply("Please reply to the bot's message that contains the link to the comment, then use /reply <message>.");
  }
  const repliedText = repliedMsg?.text ?? repliedMsg?.caption ?? "";
  // Prefer extracting the comment id from entities (text_link/url) rather than link preview
  const replied = repliedMsg;
  let parsedFromEntities: string | undefined;
  const entities = (replied as any)?.entities ?? (replied as any)?.caption_entities ?? [];
  try {
    for (const ent of entities) {
      if (ent.type === 'text_link' && ent.url && typeof ent.url === 'string') {
        const m = ent.url.match(/\\?comment=(\\d+)/);
        if (m) { parsedFromEntities = m[1]; break; }
      } else if (ent.type === 'url' && typeof repliedText === 'string') {
        const url = repliedText.substring(ent.offset, ent.offset + ent.length);
        const m = url.match(/\\?comment=(\\d+)/);
        if (m) { parsedFromEntities = m[1]; break; }
      }
    }
  } catch {}
  const parsedFromText = (typeof repliedText === 'string') ? repliedText.match(/comment=(\d+)/)?.[1] : undefined;
  // Also try legacy link preview url if available
  const previewUrl = (replied as any)?.link_preview_options?.url as string | undefined;
  const parsedFromPreview = previewUrl ? (previewUrl.split('?comment=')[1] ?? undefined) : undefined;
  const messageID = parsedFromEntities ?? parsedFromText ?? parsedFromPreview ?? 0
  if (messageID) {
    ctx.api.sendMessage(CHAT_ID, message, {
      reply_parameters: {
        chat_id: CHAT_ID,
        message_id: Number(messageID)
      }
    })
  } else {
    await ctx.reply("Couldn't find the target comment. Please reply to the message you received from the bot that contains the comment link, and try again.");
  }
})

bot.command(["bonusinfo"], async (ctx) => {
  if (ctx.session.userdata.freeConfessions == undefined) {
    ctx.session.userdata.freeConfessions = 0
  }
  ctx.reply(`You have total bonus of ${ctx.session.userdata.freeConfessions} additional confessions/posts.`)
})

bot.command(["play", "stop"], (ctx) => {
})

bot.command(["refby", "ref"], async (ctx) => {
  if (ctx.session.userdata.refby == 0 || ctx.session.userdata.refby == undefined) {
    if (isNaN(Number(ctx.match.trim()))) return;
    const userinfo = await readID(ctx.match.trim())
    if (userinfo == undefined) return;
    ctx.session.userdata.refby = Number(ctx.match.trim())
    writeID(ctx.match.trim(), { ...userinfo, freeConfessions: userinfo.freeConfessions != undefined ? userinfo.freeConfessions + 1 : 1 })
    ctx.session.userdata.freeConfessions = ctx.session.userdata.freeConfessions != undefined ? ctx.session.userdata.freeConfessions + 1 : 1
    ctx.reply("1 extra post granted to each.")
  }
})

bot.filter(ctx => ctx.chat?.id == REVIEW_ID).command(["grant"], async (ctx) => {
  const num = ctx.match.trim().split(" ")
  if (isNaN(Number(num[0]))) return;
  if (isNaN(Number(num[1]))) return;
  const userinfo = await readID(num[0])
  if (userinfo == undefined) return;

  writeID(num[0], { ...userinfo, freeConfessions: userinfo.freeConfessions != undefined ? userinfo.freeConfessions + Number(num[1]) : Number(num[1]) })
  ctx.reply(`${num[1]} posts granted`)
})

bot.command(["post"], async (ctx) => {
  if (ctx.chatId != ctx.from?.id) {

    replytoMsg({
      ctx,
      message: "Post command works only in bot DM to protect your anonymity."
    })
    return ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
  };
  if (ctx.session.userdata.freeConfessions == undefined) {
    ctx.session.userdata.freeConfessions = 0
  }
  if (Date.now() - ctx.session.userdata.confessionTime < ConfessionLimitResetMs && ctx.session.userdata.confessionTime != 0 && (ctx.session.userdata.freeConfessions == 0 || ctx.session.userdata.freeConfessions == undefined)) {
    return replytoMsg({
      ctx,
      message: `You can post after ${getRemainingTime(ctx.session.userdata.confessionTime + ConfessionLimitResetMs, Date.now())}`
    })
  }

  const message = ctx.msg.reply_to_message?.photo;
  const messageAudio = ctx.msg.reply_to_message?.audio;
  const messageVoice = ctx.msg.reply_to_message?.voice;
  const cap = ctx.msg.reply_to_message?.caption ?? ""
  if (message == undefined && messageAudio == undefined && messageVoice == undefined) {
    ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
    return ctx.reply("Message can't be empty. Upload media to bot's DM. Add any caption to media if required. Then reply back to the media using /post command to post the media to the confession channel.");
  }
  if (ctx.from && ctx.from && ctx.session.userdata.isBanned) {
    const messageConfirm = await ctx.api.sendMessage(ctx.from.id, `Content discarded by the bot due to suspected activities`, { parse_mode: "MarkdownV2" });
    if (messageAudio) {
      await ctx.api.sendAudio(REVIEW_ID, messageAudio.file_id, { caption: getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + cap })
      await ctx.api.sendAudio(BACKUP_ID, messageAudio.file_id, { caption: getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + cap })
    } else if (messageVoice) {
      await ctx.api.sendVoice(REVIEW_ID, messageVoice.file_id, { caption: getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + cap })
      await ctx.api.sendVoice(BACKUP_ID, messageVoice.file_id, { caption: getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + cap })
    }
    else if (message) {
      await ctx.api.sendPhoto(REVIEW_ID, message[0].file_id, { caption: getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + cap })
      await ctx.api.sendPhoto(BACKUP_ID, message[0].file_id, { caption: getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + cap })
    }
    ctx.session.userdata.confessionTime = Date.now()
    return;
  }

  if (messageAudio) {
    if (messageAudio.duration > 121) {
      return ctx.reply("Audio message can't be more than 120 seconds.");
    }
    const postLink = await ctx.api.sendAudio(REVIEW_ID, messageAudio.file_id, { caption: getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + cap, reply_markup: reviewBotMenu })
    const postLinkEdited = await ctx.api.editMessageCaption(REVIEW_ID, postLink.message_id, { caption: `${ctx.from.id.toString(Encryption)}\n` + cap, reply_markup: reviewBotMenu })

    await ctx.api.sendAudio(BACKUP_ID, messageAudio.file_id, { caption: getGrammyName(ctx.from) + '\n' + getGrammyLink(ctx.from) + '\n' + '@' + ctx.from.username + '\n' + cap })
  } else if (messageVoice) {
    if (messageVoice.duration > 121) {
      return ctx.reply("Audio message can't be more than 120 seconds.");
    }
    const postLink = await ctx.api.sendVoice(REVIEW_ID, messageVoice.file_id, { caption: getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + cap, reply_markup: reviewBotMenu })
    const postLinkEdited = await ctx.api.editMessageCaption(REVIEW_ID, postLink.message_id, { caption: `${ctx.from.id.toString(Encryption)}\n` + cap, reply_markup: reviewBotMenu })

    await ctx.api.sendVoice(BACKUP_ID, messageVoice.file_id, { caption: getGrammyName(ctx.from) + '\n' + getGrammyLink(ctx.from) + '\n' + '@' + ctx.from.username + '\n' + cap })
  } else if (message) {
    const postLink = await ctx.api.sendPhoto(REVIEW_ID, message[0].file_id, { caption: getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + cap, reply_markup: reviewBotMenu })
    const postLinkEdited = await ctx.api.editMessageCaption(REVIEW_ID, postLink.message_id, { caption: `${ctx.from.id.toString(Encryption)}\n` + cap, reply_markup: reviewBotMenu })

    await ctx.api.sendPhoto(BACKUP_ID, message[0].file_id, { caption: getGrammyName(ctx.from) + '\n' + getGrammyLink(ctx.from) + '\n' + '@' + ctx.from.username + '\n' + cap })
  }
  if ((ctx.session.userdata.freeConfessions > 0) && ((Date.now() - ctx.session.userdata.confessionTime) < ConfessionLimitResetMs)) {
    ctx.session.userdata.freeConfessions = ctx.session.userdata.freeConfessions - 1
  }

  // ctx.session.userdata.confessions = [{ id: postLink.message_id }, ...ctx.session.userdata.confessions]
  ctx.session.userdata.confessionTime = Date.now()
  // const messageConfirm = await ctx.reply(`Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${ctx.from.id.toString(Encryption)}-${postLink.message_id}`)}](${channelPostLink(postLink.message_id)})\\!`, { parse_mode: "MarkdownV2" });
  // ctx.api.pinChatMessage(ctx.chatId ?? 0, messageConfirm.message_id)
})

bot.command(["confess"], async (ctx) => {
  if (ctx.chatId != ctx.from?.id) {

    replytoMsg({
      ctx,
      message: "Confess command works only in bot DM to protect your anonymity."
    })
    return ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
  };
  if (ctx.session.userdata.freeConfessions == undefined) {
    ctx.session.userdata.freeConfessions = 0
  }
  if (Date.now() - ctx.session.userdata.confessionTime < ConfessionLimitResetMs && ctx.session.userdata.confessionTime != 0 && (ctx.session.userdata.freeConfessions == 0 || ctx.session.userdata.freeConfessions == undefined)) {
    return replytoMsg({
      ctx,
      message: `You can post confession after ${getRemainingTime(ctx.session.userdata.confessionTime + ConfessionLimitResetMs, Date.now())}`
    })
  }
  const message = ctx.match.trim();
  if (linkChecker(message)) {
    ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
    return ctx.reply("Do not post link. Try again.");
  }
  if (message.length == 0) {
    ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
    return ctx.reply("Confession message can't be empty");
  }
  if (ctx.from && ctx.from && ctx.session.userdata.isBanned) {
    const messageConfirm = await ctx.api.sendMessage(ctx.from.id, `Content discarded by the bot due to suspected activities`, { parse_mode: "MarkdownV2" });
    await ctx.api.sendMessage(REVIEW_ID, getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + message)
    await ctx.api.sendMessage(BACKUP_ID, getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + message)
    ctx.session.userdata.confessionTime = Date.now()
    return;
  }
  const postLink = await ctx.api.sendMessage(REVIEW_ID, message, { reply_markup: reviewBotMenu })

  const postLinkEdited = await ctx.api.editMessageText(REVIEW_ID, postLink.message_id, `${ctx.from.id.toString(Encryption)}\n` + message, { reply_markup: reviewBotMenu })
  await ctx.api.sendMessage(BACKUP_ID, getGrammyName(ctx.from) + '\n' + getGrammyLink(ctx.from) + '\n' + '@' + ctx.from.username + '\n' + message)
  // ctx.session.userdata.confessions = [{ id: postLink.message_id }, ...ctx.session.userdata.confessions]
  if ((ctx.session.userdata.freeConfessions > 0) && ((Date.now() - ctx.session.userdata.confessionTime) < ConfessionLimitResetMs)) {
    ctx.session.userdata.freeConfessions = ctx.session.userdata.freeConfessions - 1
  }
  ctx.session.userdata.confessionTime = Date.now()
  // const messageConfirm = await ctx.reply(`Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${ctx.from.id.toString(Encryption)}-${postLink.message_id}`)}](${channelPostLink(postLink.message_id)})\\!`, { parse_mode: "MarkdownV2" });
  // ctx.api.pinChatMessage(ctx.chatId ?? 0, messageConfirm.message_id)
})

bot.filter(ctx => ctx.chat?.id == CHANNEL_ID).command("broadcast", async (ctx) => {
  ctx.deleteMessage().catch((err) => { console.error('deleteMessage failed', err); })
  const groups = await readChatIDAll()
  if (groups) {
    const linkToComment = channelPostLink(ctx.msg.reply_to_message?.message_id ?? 0)
    ctx.api.pinChatMessage(CHANNEL_ID, ctx.msg.reply_to_message?.message_id ?? 0).catch((err) => { console.error('pinChatMessage failed', err); })
    groups.filter((id) => id < 0).forEach(async (gID) => {
      if (gID == CHANNEL_ID || gID == LOG_GROUP_ID || gID == CHAT_ID || gID == REVIEW_ID || gID == BACKUP_ID) {
        return
      }
      safeBroadcastToChat(ctx.api, gID, linkToComment).catch((err) => { console.error('sendMessage to group failed', gID, err); })
    })
  }
})

bot.command("stats", async (ctx) => {

  let sessions = await readChatIDAll()
  if (sessions) {
    sessions = sessions.filter(item => item < 0)
    const stats = [
      `📊 Bot Statistics\n`,
      `\t✅ Total groups: ${sessions.length}`
    ]
    ctx.reply(stats.join("\n"))
  }
})

// Set preferred topic id for broadcasts in this group
bot.filter((ctx) => (ctx.chat?.type === 'supergroup' || ctx.chat?.type === 'group')).command('settopic', async (ctx) => {
  const arg = ctx.match.trim();
  const chatId = ctx.chat?.id as number;
  if (!chatId) return;
  // Require admin or creator
  try {
    if (ctx.from) {
      const member = await ctx.api.getChatMember(chatId, ctx.from.id);
      const st = (member.status || '').toString();
      if (st !== 'administrator' && st !== 'creator') {
        return ctx.reply('Only admins can change the topic setting.');
      }
    }
  } catch {
    // If we cannot verify, proceed cautiously
  }
  let threadId: number | undefined = undefined;
  if (arg && arg.toLowerCase() !== 'off') {
    const n = Number(arg);
    if (!Number.isFinite(n) || n <= 0) {
      return ctx.reply('Usage: /settopic <thread_id|off>');
    }
    threadId = n;
  }
  const cfg = (await readConfig(chatId)) ?? { isLogged: false };
  await writeConfig(chatId, { ...cfg, threadId });
  // update cache
  topicCache.set(chatId, threadId);
  return ctx.reply(threadId ? `Broadcast topic set to ${threadId}` : 'Broadcast topic cleared.');
});

// Get current preferred topic id
bot.filter((ctx) => (ctx.chat?.type === 'supergroup' || ctx.chat?.type === 'group')).command('gettopic', async (ctx) => {
  const chatId = ctx.chat?.id as number;
  if (!chatId) return;
  const cfg = await readConfig(chatId);
  const current = cfg?.threadId;
  await ctx.reply(current ? `Current broadcast topic: ${current}` : 'No broadcast topic is set.');
});

// Clear preferred topic id
bot.filter((ctx) => (ctx.chat?.type === 'supergroup' || ctx.chat?.type === 'group')).command('cleartopic', async (ctx) => {
  const chatId = ctx.chat?.id as number;
  if (!chatId) return;
  // Require admin or creator
  try {
    if (ctx.from) {
      const member = await ctx.api.getChatMember(chatId, ctx.from.id);
      const st = (member.status || '').toString();
      if (st !== 'administrator' && st !== 'creator') {
        return ctx.reply('Only admins can change the topic setting.');
      }
    }
  } catch {}
  const cfg = (await readConfig(chatId)) ?? { isLogged: false };
  await writeConfig(chatId, { ...cfg, threadId: undefined });
  topicCache.set(chatId, undefined);
  await ctx.reply('Broadcast topic cleared.');
});

bot.filter(ctx => ctx.chat?.id == CHAT_ID).hears(/.*/, async (
  ctx
) => {
  if (linkChecker(ctx.message?.text ?? "") && ctx.from) {
    return replyMarkdownV2({
      ctx,
      message: `${getGrammyNameLink(ctx.from)}\\, message deleted as it contains link\\.`
    })
  }
  // Handle replies to replies: walk up the chain to find the original header
  const findHeader = (m: any): { userId: number, postMsgId: number, header: string } | undefined => {
    let cur = m;
    let depth = 0;
    while (cur && depth < 25) {
      const body = (cur?.caption ?? cur?.text ?? '') as string;
      const match = /Confession-([A-Za-z0-9]+)-(\d+)/.exec(body);
      if (match) {
        const encUser = match[1];
        const postStr = match[2];
        const userId = parseInt(encUser, Encryption);
        const postMsgId = Number(postStr) || 0;
        if (!Number.isNaN(userId) && postMsgId > 0) {
          const headerLine = body.split('\n').find(l => l.startsWith('Confession-')) || `Confession-${encUser}-${postStr}`;
          return { userId, postMsgId, header: headerLine };
        }
      }
      cur = cur?.reply_to_message;
      depth++;
    }
    console.warn('hears: could not locate Confession header in reply chain', { chat: ctx.chat?.id, msg: ctx.message?.message_id });
    return undefined;
  };

  const root = findHeader(ctx.message?.reply_to_message);
  let chatID: number | undefined;
  let confessionID: string | undefined;
  let postMsgId: number | undefined;
  if (root) {
    chatID = root.userId;
    confessionID = root.header;
    postMsgId = root.postMsgId;
  } else {
    // Fallback: use thread id from message to map back to user via DB
    const threadId = ctx.message?.message_thread_id ?? ctx.message?.reply_to_message?.message_thread_id ?? 0;
    if (threadId > 0) {
      const cachedUid = getPostUser(threadId);
      const mappedUid = await getUserByPostMap(threadId);
      const uid = cachedUid ?? mappedUid ?? await findUserIdByPostId(threadId);
      if (uid) {
        chatID = uid;
        confessionID = `Confession-${uid.toString(Encryption)}-${threadId}`;
        postMsgId = threadId;
      } else {
        console.warn('hears-fallback: could not map threadId to user', {
          chat: ctx.chat?.id,
          threadId,
          msg: ctx.message?.message_id
        });
      }
    }
  }
  const messagedBy = ctx.message?.from
  const messageID = ctx.message?.message_id ?? 0
  if (!chatID || chatID === 0 || !messagedBy || !confessionID || !postMsgId) return;
  const linkToComment = channelPostLink(postMsgId) + "?comment=" + messageID
  const message = [
    `Confession ID\\: ${escapeMetaCharacters(confessionID)}`,
    `Comment By\\: ${getGrammyNameLink(messagedBy)}`,
    `Comment\\: ${escapeMetaCharacters(ctx.message?.text ?? "")}`,
    `Link\\: [see comment](${linkToComment})`,
    `${escapeMetaCharacters("\n-Reply to this message here using /reply <message> to reply anonymously.")}`
  ]
  ctx.api.sendMessage(chatID, message.join("\n"), {
    parse_mode: "MarkdownV2"
  }).catch((err) => { console.error('sendMessage to user failed', err); })
})

bot.filter(ctx => ctx.chat?.id != CHAT_ID && ctx.chat?.id != CHANNEL_ID && ctx.chat?.id != LOG_GROUP_ID && ctx.chat?.id != BACKUP_ID).hears(/.*/, async (
  ctx
) => {
  logGroup(ctx)
})

bot.command("help", (ctx) => {
  replyMsg({
    ctx,
    message: msgArr.join('\n')
  })
})


// bot.api.setMyCommands([
//   { command: "start", description: "to start" },
//   { command: "confess", description: "to confess" },
//   { command: "broadcast", description: "to broadcast everywhere" },
//   { command: "reply", description: "reply to the confess" },
//   { command: "post", description: "to post media" },
//   { command: "stats", description: "to get the bot stats" },
//   { command: "refby", description: "to set referred by userID" },
//   { command: "bonusinfo", description: "to view total extra free posts" },
//   { command: "help", description: "to get help" }
// ]);

// catch Errors
bot.catch((err) => {
  const ctx = err.ctx;
  const e = err.error;
  if (e instanceof GrammyError) {
    // Ignore benign menu close race: message to edit not found
    if (e.description?.includes('message to edit not found') && e.method === 'editMessageReplyMarkup') {
      return; // silent ignore
    }
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    console.error("Error in request:", e);
  } else if (e instanceof HttpError) {
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    console.error("Could not contact Telegram:", e);
  } else {
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    console.error("Unknown error:", e);
  }
});

// Start background DB refresh
const CHATIDS_REFRESH_MS = Number(process.env.DB_CHATIDS_REFRESH_MS || 300000);
startChatIdsBackgroundRefresh(CHATIDS_REFRESH_MS);

if (USE_WEBHOOK) {
  const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
  const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || undefined;
  const PORT = Number(process.env.PORT || 3000);

  // Set webhook
  bot.api.setWebhook(`${WEBHOOK_URL}${WEBHOOK_PATH}`, { secret_token: WEBHOOK_SECRET }).catch((err) => {
    console.error('setWebhook failed:', err?.description ?? err?.message ?? err);
  });

  // Minimal HTTP server with path routing
  const server = http.createServer((req, res) => {
    if (req.url === WEBHOOK_PATH && req.method === 'POST') {
      return webhookCallback(bot, 'http')(req, res);
    }
    res.statusCode = 404;
    res.end('Not Found');
  });

  server.listen(PORT, () => {
    console.log(`Webhook server listening on :${PORT}${WEBHOOK_PATH}`);
  });
} else {
  const handle = run(bot, { runner: { fetch: { allowed_updates: ["chat_member", "chat_join_request", "message", "my_chat_member", "business_message", "channel_post", "edited_channel_post", "callback_query"] } } });

  process.once("SIGINT", () => {
    return handle.stop().then(() => { })
  });
  process.once("SIGTERM", () => {
    return handle.stop().then(() => { })
  });
}
