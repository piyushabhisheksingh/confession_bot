require("dotenv").config();
import { ForceReply, InlineKeyboardMarkup, ReplyKeyboardMarkup, ReplyKeyboardRemove, User } from "grammy/types";
import type { MyContext } from "../bot";
import { CHANNEL_ID, LOG_GROUP_ID, CHANNEL_USERNAME } from "../schema/constants";

export const escapeMetaCharacters = (inputString: string) => {
  const metaCharacters = ["^", "$", "{", "}", "[", "]", "(", ")", ".", "*", "+", "?", "|", "<", ">", "-", "&", "%", "=", "!", "_", "#", "@", "~"];
  let modString = inputString;
  modString = modString.split("").map((item) => {
    let itm = item;
    if (metaCharacters.includes(item)) {
      itm = itm.replace(item, "\\" + item);
    }
    return itm
  }).join("")
  return modString;
}

export const getGrammyNameLink = (user: User) => {
  const display = escapeMetaCharacters(
    (user.first_name.length
      ? (user.first_name + " " + (user.last_name ?? ""))
      : user.username?.length
        ? `@${user.username}`
        : user.id
          ? user.id.toString()
          : ""
    ).trim()
  );
  // Do not escape URL punctuation inside the link target
  return `[${display}](tg://user?id=${user.id})`
}
export const getGrammyLink = (user: User) => {
  return `tg://user?id=${user.id}`
}

export const getGrammyName = (user: User) => {
  return `${user.first_name.length ? (user.first_name + " " + (user.last_name ?? "")) : user.username?.length ? `@${user.username}` : user.id ? user.id.toString() : ""}`
}

export const replytoMsg = async ({ ctx, message, replyMarkup, msgID }: { ctx: MyContext, message: string, replyMarkup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply, msgID?: number }) => {
  const replyId = msgID ?? ctx.message?.message_id;
  const opts: any = { reply_markup: replyMarkup };
  if (replyId && replyId > 0) {
    opts.reply_parameters = { message_id: replyId };
  }
  return await ctx.reply(message, opts)
}
export const replyMsg = async ({ ctx, message, replyMarkup, msgID }: { ctx: MyContext, message: string, replyMarkup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply, msgID?: number }) => {

  return await ctx.reply(message, { reply_markup: replyMarkup })
}

export const replytoMsgMarkdownV2 = async ({ ctx, message, replyMarkup }: { ctx: MyContext, message: string, replyMarkup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply; }) => {
  const replyId = ctx.message?.message_id;
  const opts: any = { reply_markup: replyMarkup, parse_mode: "MarkdownV2" };
  if (replyId && replyId > 0) {
    opts.reply_parameters = { message_id: replyId };
  }
  return await ctx.reply(message, opts)
}

export const replyMarkdownV2 = async ({ ctx, message, replyMarkup }: { ctx: MyContext, message: string, replyMarkup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply; }) => {

  return await ctx.reply(message, { reply_markup: replyMarkup, parse_mode: "MarkdownV2" })
}

export const logGroup = async (ctx: MyContext) => {
  if (!ctx.from) return;
  if (ctx.session.config.isLogged) return;
  if (ctx.chatId == null || ctx.chatId >= 0) return;
  const now = Date.now();
  if (ctx.session.config.nextLogTryAt && now < ctx.session.config.nextLogTryAt) {
    return; // cooldown because of recent 429/failed attempt
  }

  try {
    const chatInfo = await ctx.api.getChat(ctx.chatId);
    const payload = [
      `Group Name\\: ${escapeMetaCharacters(chatInfo.title ?? '')}`,
      `Group ID\\: ${escapeMetaCharacters((chatInfo.id ?? 0).toString())}`,
      `Group Type\\: ${escapeMetaCharacters((chatInfo.type ?? 0).toString())}`,
      `Group Username\\: ${escapeMetaCharacters(('@' + (chatInfo.username ?? '')).toString())}`,
      `Group Link\\: ${escapeMetaCharacters((chatInfo).invite_link ?? '')}`,
      `Group join by request\\: ${escapeMetaCharacters((chatInfo.join_by_request ?? '').toString())}`,
    ].join('\n');

    await ctx.api.sendMessage(LOG_GROUP_ID, payload, { parse_mode: 'MarkdownV2' });
    // Mark as logged only after successful send
    ctx.session.config.isLogged = true;
    ctx.session.config.nextLogTryAt = undefined;
  } catch (err: any) {
    // Respect Telegram 429 backoff if provided
    const desc = String(err?.description || err?.message || '');
    const retryAfter = (err?.parameters && typeof err.parameters.retry_after === 'number')
      ? err.parameters.retry_after
      : (desc.includes('Too Many Requests') ? 15 : 0);
    if (retryAfter > 0) {
      ctx.session.config.nextLogTryAt = Date.now() + retryAfter * 1000;
      console.warn('logGroup 429, cooling down', { chat: ctx.chatId, retryAfter });
    }
    console.error('Failed to send logGroup message', err);
  }
}

export const linkChecker = (text: string) => {
  return text.toLowerCase().includes('t.me') ||
    text.toLowerCase().includes('http') ||
    text.toLowerCase().includes('www')
}

export const getRemainingTime = (time1: number, time2: number) => {
  const diff = Math.max(0, Math.abs(time1 - time2));
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  return `${hours} hours ${minutes} mins`;
}

export const channelPostLink = (postId?: number) => {
  if (postId && postId > 0) return `https://t.me/${CHANNEL_USERNAME}/${postId}`;
  return `https://t.me/${CHANNEL_USERNAME}`;
}
