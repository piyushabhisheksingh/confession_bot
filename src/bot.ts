// bot.ts
require("dotenv").config();
import { Bot, BotError, Context, GrammyError, HttpError, NextFunction, session, SessionFlavor } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { autoRetry } from "@grammyjs/auto-retry";
import { limit } from "@grammyjs/ratelimiter";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { Bottleneck } from "@grammyjs/transformer-throttler/dist/deps.node";
import { escapeMetaCharacters, getGrammyLink, getGrammyName, getGrammyNameLink, getRemainingTime, linkChecker, logGroup, replyMarkdownV2, replyMsg, replytoMsg } from "./services/hooks";
import { Menu } from "@grammyjs/menu";
import { BACKUP_ID, CHANNEL_ID, CHAT_ID, ConfessionLimitResetTime, Encryption, LOG_GROUP_ID, msgArr, REVIEW_ID, startBotMsg, startGroupMsg } from "./schema/constants";
import { SessionData } from "./schema/interfaces";
import { confessionStorage, readChatIDAll, readID, settingsStorage, writeID } from "./services/db";

// Create the bot.
export type MyContext = Context & SessionFlavor<SessionData>;
const bot = new Bot<MyContext>(String(process.env.BOT_TOKEN)); // <-- put your bot token between the ""


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
      isBanned: false
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


const globalConfig = {
  maxConcurrent: 2,
  minTime: 200,
  highWater: 58,
  strategy: Bottleneck.strategy.LEAK,
  reservoir: 58,
  penalty: 3000,
  reservoirRefreshAmount: 58,
  reservoirRefreshInterval: 5000,
};

// Outgoing Group Throttler
const groupConfig = {
  maxConcurrent: 2,
  minTime: 0,
  highWater: 28,
  strategy: Bottleneck.strategy.LEAK,
  reservoir: 28,
  penalty: 3000,
  reservoirRefreshAmount: 28,
  reservoirRefreshInterval: 2000,
};

// Outgoing Private Throttler
const outConfig = {
  maxConcurrent: 2,
  minTime: 200,
  highWater: 28,
  strategy: Bottleneck.strategy.LEAK,
  reservoir: 58,
  penalty: 3000,
  reservoirRefreshAmount: 28,
  reservoirRefreshInterval: 2000
};

const throttler = apiThrottler({
  global: globalConfig,
  group: groupConfig,
  out: outConfig
});
bot.api.config.use(throttler);

// Limits message handling to a message per second for each user.
bot.use(limit({
  // Allow only 5 messages to be handled every 2 seconds.
  timeFrame: 2000,
  limit: 5,

  // This is called when the limit is exceeded.
  onLimitExceeded: async (ctx) => {
  },
  // Note that the key should be a number in string format such as "123456789".
  keyGenerator: (ctx) => {
    return ctx.from?.id.toString();
  },
}));

// // race conditions: chat and user
const constraints = (ctx: Context) => [String(ctx.chat?.id), String(ctx.from?.id)]
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
  .url("Advice", "https://t.me/tg_confession_channel").row()

bot.use(startGroupMenu)

const startBotMenu = new Menu<MyContext>("dynamic-bot");
startBotMenu
  .url("Advice", (ctx) => ctx.session.userdata.confessions[0] && (Date.now() - ctx.session.userdata.confessionTime < ConfessionLimitResetTime) ? `https://t.me/tg_confession_channel/${ctx.session.userdata.confessions[0]}` : `https://t.me/tg_confession_channel`).row()

bot.use(startBotMenu)


const reviewBotMenu = new Menu<MyContext>("review-bot");
reviewBotMenu.text("Approve", async (ctx) => {
  if (ctx.msg?.caption) {
    const msg = ctx.msg?.caption ?? ""
    const media = ctx.msg?.photo
    const message = msg.split("\n").slice(1).join('\n')
    if (media == undefined) return;
    const userID = parseInt(msg.split("\n")[0], Encryption)
    const postLink = await ctx.api.sendPhoto(CHANNEL_ID, media[0].file_id, { caption: msg })
    const postLinkEdited = await ctx.api.editMessageCaption(CHANNEL_ID, postLink.message_id, { caption: `Confession-${userID.toString(Encryption)}-${postLink.message_id}\n` + message })
    const userData = await readID(userID.toString())
    if (userData == undefined) return;
    writeID(userID.toString(), { ...userData, confessions: [{ id: postLink.message_id }, ...userData?.confessions] })
    const messageConfirm = await ctx.api.sendMessage(userID, `Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${userID.toString(Encryption)}-${postLink.message_id}`)}](${"https://t.me/tg_confession_channel/" + postLink.message_id})\\!`, { parse_mode: "MarkdownV2" });
    ctx.api.pinChatMessage(userID ?? 0, messageConfirm.message_id)
    ctx.deleteMessage().catch(() => { })
    ctx.menu.close()
    return
  }
  const msg = ctx.msg?.text ?? ""
  const userID = parseInt(msg.split("\n")[0], Encryption)
  const message = msg.split("\n").slice(1).join('\n')
  const postLink = await ctx.api.sendMessage(CHANNEL_ID, message)
  const postLinkEdited = await ctx.api.editMessageText(CHANNEL_ID, postLink.message_id, `Confession-${userID.toString(Encryption)}-${postLink.message_id}\n` + message)
  const userData = await readID(userID.toString())
  if (userData == undefined) return;
  writeID(userID.toString(), { ...userData, confessions: [{ id: postLink.message_id }, ...userData?.confessions] })
  const messageConfirm = await ctx.api.sendMessage(userID, `Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${userID.toString(Encryption)}-${postLink.message_id}`)}](${"https://t.me/tg_confession_channel/" + postLink.message_id})\\!`, { parse_mode: "MarkdownV2" });
  ctx.api.pinChatMessage(userID ?? 0, messageConfirm.message_id)
  ctx.deleteMessage().catch(() => { })
  ctx.menu.close()
}).row()
reviewBotMenu.text("Broadcast", async (ctx) => {
  if (ctx.msg?.caption) {
    const msg = ctx.msg?.caption ?? ""
    const message = msg.split("\n").slice(1).join('\n')
    const media = ctx.msg?.photo
    if (media == undefined) return;
    const userID = parseInt(msg.split("\n")[0], Encryption)
    const postLink = await ctx.api.sendPhoto(CHANNEL_ID, media[0].file_id, { caption: msg })
    const postLinkEdited = await ctx.api.editMessageCaption(CHANNEL_ID, postLink.message_id, { caption: `Confession-${userID.toString(Encryption)}-${postLink.message_id}\n` + message })
    const userData = await readID(userID.toString())
    if (userData == undefined) return;
    writeID(userID.toString(), { ...userData, confessions: [{ id: postLink.message_id }, ...userData?.confessions] })
    const messageConfirm = await ctx.api.sendMessage(userID, `Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${userID.toString(Encryption)}-${postLink.message_id}`)}](${"https://t.me/tg_confession_channel/" + postLink.message_id})\\!`, { parse_mode: "MarkdownV2" });
    ctx.api.pinChatMessage(userID ?? 0, messageConfirm.message_id)
    ctx.deleteMessage().catch(() => { })
    ctx.menu.close()
    const groups = await readChatIDAll()
    if (groups) {
      const linkToComment = "https://t.me/tg_confession_channel/" + (postLink.message_id ?? "0")
      ctx.api.pinChatMessage(CHANNEL_ID, postLink?.message_id ?? 0).catch(() => { })
      groups.filter((id) => id < 0).forEach(async (gID) => {
        if (gID == CHANNEL_ID || gID == LOG_GROUP_ID || gID == CHAT_ID || gID == REVIEW_ID || gID == BACKUP_ID) {
          return
        }
        ctx.api.sendMessage(gID, linkToComment).catch(() => { })
      })
    }
    return
  }
  const msg = ctx.msg?.text ?? ""
  const userID = parseInt(msg.split("\n")[0], Encryption)
  const message = msg.split("\n").slice(1).join('\n')
  const postLink = await ctx.api.sendMessage(CHANNEL_ID, message)
  const postLinkEdited = await ctx.api.editMessageText(CHANNEL_ID, postLink.message_id, `Confession-${userID.toString(Encryption)}-${postLink.message_id}\n` + message)
  const userData = await readID(userID.toString())
  if (userData == undefined) return;
  writeID(userID.toString(), { ...userData, confessions: [{ id: postLink.message_id }, ...userData?.confessions] })
  const messageConfirm = await ctx.api.sendMessage(userID, `Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${userID.toString(Encryption)}-${postLink.message_id}`)}](${"https://t.me/tg_confession_channel/" + postLink.message_id})\\!`, { parse_mode: "MarkdownV2" });
  ctx.api.pinChatMessage(userID ?? 0, messageConfirm.message_id)
  ctx.deleteMessage().catch(() => { })
  ctx.menu.close()
  const groups = await readChatIDAll()
  if (groups) {
    const linkToComment = "https://t.me/tg_confession_channel/" + (postLink.message_id ?? "0")
    ctx.api.pinChatMessage(CHANNEL_ID, postLink?.message_id ?? 0).catch(() => { })
    groups.filter((id) => id < 0).forEach(async (gID) => {
      if (gID == CHANNEL_ID || gID == LOG_GROUP_ID || gID == CHAT_ID || gID == REVIEW_ID || gID == BACKUP_ID) {
        return
      }
      ctx.api.sendMessage(gID, linkToComment).catch(() => { })
    })
  }
}).row()
reviewBotMenu.text("Discard", async (ctx) => {
  if (ctx.msg?.caption) {
    const msg = ctx.msg?.caption ?? ""
    const media = ctx.msg?.photo ?? ""
    const userID = parseInt(msg.split("\n")[0], Encryption)
    const messageConfirm = await ctx.api.sendMessage(userID, `Content discarded by the bot due to suspected activities`, { parse_mode: "MarkdownV2" });
    ctx.menu.close()
    return
  }
  const msg = ctx.msg?.text ?? ""
  const userID = parseInt(msg.split("\n")[0], Encryption)
  const message = msg.split("\n").slice(1).join('\n')
  const messageConfirm = await ctx.api.sendMessage(userID, `Content discarded by the bot as it did not passed the review`, { parse_mode: "MarkdownV2" });
  ctx.menu.close()
}).row()

reviewBotMenu.text("Ban", async (ctx) => {
  if (ctx.msg?.caption) {
    const msg = ctx.msg?.caption ?? ""
    const media = ctx.msg?.photo
    if (media == undefined) return;
    const userID = parseInt(msg.split("\n")[0], Encryption)
    const userdata = await readID(userID.toString())
    if (!userdata) {
      return;
    }
    await writeID(userID.toString(), { ...userdata, isBanned: true })
    await ctx.replyWithPhoto(media[0].file_id, { caption: `${userID} banned` + '\n' + msg })
    const messageConfirm = await ctx.api.sendMessage(userID, `Content discarded by the bot due to suspected activities`, { parse_mode: "MarkdownV2" });
    ctx.menu.close()
    return
  }
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
  ctx.menu.close()
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
      message: "Reply command works only in bot DM to protect your anonimousity."
    })
    return ctx.deleteMessage().catch(() => { })
  };
  const message = ctx.match.trim();
  if (linkChecker(message)) {
    ctx.deleteMessage().catch(() => { })
    return ctx.reply("Do not post link. Try again.");
  }
  if (message.length == 0) {
    ctx.deleteMessage().catch(() => { })
    return ctx.reply("Reply message can't be empty");
  }

  const messageID = ctx.message?.reply_to_message?.link_preview_options?.url?.split("?comment=")[1] ?? 0
  if (messageID) {
    ctx.api.sendMessage(CHAT_ID, ctx.match.trim(), {
      reply_parameters: {
        chat_id: CHAT_ID,
        message_id: Number(messageID)
      }
    })
  }
})

bot.command(["post"], async (ctx) => {
  if (ctx.chatId != ctx.from?.id) {
    
   replytoMsg({
      ctx,
      message: "Post command works only in bot DM to protect your anonimousity."
    })
    return ctx.deleteMessage().catch(() => { })
  };
  if (Date.now() - ctx.session.userdata.confessionTime < ConfessionLimitResetTime && ctx.session.userdata.confessionTime != 0) {
    return replytoMsg({
      ctx,
      message: `You can post after ${getRemainingTime(ctx.session.userdata.confessionTime + ConfessionLimitResetTime, Date.now())}`
    })
  }
  const message = ctx.msg.reply_to_message?.photo;
  const cap = ctx.msg.reply_to_message?.caption
  if (message == undefined) {
    ctx.deleteMessage().catch(() => { })
    return ctx.reply("Message can't be empty. Upload photo to bot's DM. Add any caption to photo if required. Then reply back tp the photo using /post command to post the photo to the confession channel.");
  }
  if (ctx.from && ctx.from && ctx.session.userdata.isBanned) {
    const messageConfirm = await ctx.api.sendMessage(ctx.from.id, `Content discarded by the bot due to suspected activities`, { parse_mode: "MarkdownV2" });
    await ctx.api.sendPhoto(REVIEW_ID, message[0].file_id, { caption: getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + cap })
    await ctx.api.sendPhoto(BACKUP_ID, message[0].file_id, { caption: getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + cap })
    ctx.session.userdata.confessionTime = Date.now()
    return;
  }

  const postLink = await ctx.api.sendPhoto(REVIEW_ID, message[0].file_id, { caption: getGrammyName(ctx.from) + '\n' + ctx.from.id + '\n' + '@' + ctx.from.username + '\n' + cap, reply_markup: reviewBotMenu })
  const postLinkEdited = await ctx.api.editMessageCaption(REVIEW_ID, postLink.message_id, { caption: `${ctx.from.id.toString(Encryption)}\n` + cap, reply_markup: reviewBotMenu })

  await ctx.api.sendPhoto(BACKUP_ID, message[0].file_id, { caption: getGrammyName(ctx.from) + '\n' + getGrammyLink(ctx.from) + '\n' + '@' + ctx.from.username + '\n' + cap })
  // ctx.session.userdata.confessions = [{ id: postLink.message_id }, ...ctx.session.userdata.confessions]
  ctx.session.userdata.confessionTime = Date.now()
  // const messageConfirm = await ctx.reply(`Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${ctx.from.id.toString(Encryption)}-${postLink.message_id}`)}](${"https://t.me/tg_confession_channel/" + postLink.message_id})\\!`, { parse_mode: "MarkdownV2" });
  // ctx.api.pinChatMessage(ctx.chatId ?? 0, messageConfirm.message_id)
})

bot.command(["confess"], async (ctx) => {
  if (ctx.chatId != ctx.from?.id) {
    
     replytoMsg({
      ctx,
      message: "Confess command works only in bot DM to protect your anonimousity."
    })
    return ctx.deleteMessage().catch(() => { })
  };
  if (Date.now() - ctx.session.userdata.confessionTime < ConfessionLimitResetTime && ctx.session.userdata.confessionTime != 0) {
    return replytoMsg({
      ctx,
      message: `You can post confession after ${getRemainingTime(ctx.session.userdata.confessionTime + ConfessionLimitResetTime, Date.now())}`
    })
  }
  const message = ctx.match.trim();
  if (linkChecker(message)) {
    ctx.deleteMessage().catch(() => { })
    return ctx.reply("Do not post link. Try again.");
  }
  if (message.length == 0) {
    ctx.deleteMessage().catch(() => { })
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
  ctx.session.userdata.confessionTime = Date.now()
  // const messageConfirm = await ctx.reply(`Confession broadcasted\\. You can see your confession here\\. [${escapeMetaCharacters(`Confession-${ctx.from.id.toString(Encryption)}-${postLink.message_id}`)}](${"https://t.me/tg_confession_channel/" + postLink.message_id})\\!`, { parse_mode: "MarkdownV2" });
  // ctx.api.pinChatMessage(ctx.chatId ?? 0, messageConfirm.message_id)
})

bot.filter(ctx => ctx.chat?.id == CHANNEL_ID).command("broadcast", async (ctx) => {
  ctx.deleteMessage().catch(() => { })
  const groups = await readChatIDAll()
  if (groups) {
    const linkToComment = "https://t.me/tg_confession_channel/" + (ctx.msg.reply_to_message?.message_id ?? "0")
    ctx.api.pinChatMessage(CHANNEL_ID, ctx.msg.reply_to_message?.message_id ?? 0).catch(() => { })
    groups.filter((id) => id < 0).forEach(async (gID) => {
      if (gID == CHANNEL_ID || gID == LOG_GROUP_ID || gID == CHAT_ID || gID == REVIEW_ID || gID == BACKUP_ID) {
        return
      }
      ctx.api.sendMessage(gID, linkToComment).catch(() => { })
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

bot.filter(ctx => ctx.chat?.id == CHAT_ID).hears(/.*/, async (
  ctx
) => {
  if (linkChecker(ctx.message?.text ?? "") && ctx.from) {
    return replyMarkdownV2({
      ctx,
      message: `${getGrammyNameLink(ctx.from)}\\, message deleted as it contains link\\.`
    })
  }
  const forward_origin = ctx.message?.reply_to_story?.id
  const chatID = ctx.message?.reply_to_message?.caption?.split("\n")[0] ? parseInt(ctx.message?.reply_to_message?.caption?.split("\n")[0].split('-')[1] ?? "0", Encryption): parseInt(ctx.message?.reply_to_message?.text?.split("\n")[0].split('-')[1] ?? "0", Encryption)
  const confessionID = ctx.message?.reply_to_message?.caption?.split("\n")[0] ?? ctx.message?.reply_to_message?.text?.split("\n")[0] 
  const messagedBy = ctx.message?.from
  const messageID = ctx.message?.message_id ?? 0
  if (chatID == 0 || messagedBy == undefined || confessionID == undefined) return;
  const linkToComment = "https://t.me/tg_confession_channel/" + (forward_origin ?? "0") + "?comment=" + ctx.message?.message_id
  const message = [
    `Confession ID\\: ${escapeMetaCharacters(confessionID)}`,
    `Comment By\\: ${getGrammyNameLink(messagedBy)}`,
    `Comment\\: ${escapeMetaCharacters(ctx.message?.text ?? "")}`,
    `Link\\: [see comment](${linkToComment})`,
    `${escapeMetaCharacters("\n-Reply to this message here using /reply <message> to reply anonymously.")}`
  ]
  ctx.api.sendMessage(chatID, message.join("\n"), {
    parse_mode: "MarkdownV2"
  }).catch(() => { })
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


bot.api.setMyCommands([
  { command: "start", description: "to start" },
  { command: "confess", description: "to confess" },
  { command: "broadcast", description: "to broadcast everywhere" },
  { command: "reply", description: "reply to the confess" },
  { command: "post", description: "to post photo" },
  { command: "stats", description: "to get the bot stats" },
  { command: "help", description: "to get help" }
]);

// catch Errors
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    // oopsError(ctx)
    console.error("Error in request:", e.description);
  } else if (e instanceof HttpError) {
    // oopsError(ctx)
    console.error("Could not contact Telegram:", e);
  } else {
    console.error("Unknown error:", e);
  }
});

const handle = run(bot, { runner: { fetch: { allowed_updates: ["chat_member", "chat_join_request", "message", "my_chat_member", "business_message", "channel_post", "edited_channel_post", "callback_query"] } } });

process.once("SIGINT", () => {
  return handle.stop().then(() => {
  })
});
process.once("SIGTERM", () => {
  return handle.stop().then(() => {
  })
});

