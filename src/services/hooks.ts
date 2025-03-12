require("dotenv").config();
import { ForceReply, InlineKeyboardMarkup, ReplyKeyboardMarkup, ReplyKeyboardRemove, User } from "grammy/types";
import { MyContext } from "../bot";
import { CHANNEL_ID, LOG_GROUP_ID } from "../schema/constants";

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
  return `[${escapeMetaCharacters(user.first_name.length ? (user.first_name + " " + (user.last_name ?? "")) : user.username?.length ? `@${user.username}` : user.id ? user.id.toString() : "").trim()}](tg://user?id\\=${user.id})`
}
export const getGrammyLink = (user: User) => {
  return `tg://user?id=${user.id}`
}

export const getGrammyName = (user: User) => {
  return `${user.first_name.length ? (user.first_name + " " + (user.last_name ?? "")) : user.username?.length ? `@${user.username}` : user.id ? user.id.toString() : ""}`
}

export const replytoMsg = async ({ ctx, message, replyMarkup, msgID }: { ctx: MyContext, message: string, replyMarkup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply, msgID?: number }) => {

  return await ctx.reply(message, { reply_markup: replyMarkup, reply_parameters: { message_id: msgID ?? ctx.msgId ?? 0 } })
}
export const replyMsg = async ({ ctx, message, replyMarkup, msgID }: { ctx: MyContext, message: string, replyMarkup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply, msgID?: number }) => {

  return await ctx.reply(message, { reply_markup: replyMarkup })
}

export const replytoMsgMarkdownV2 = async ({ ctx, message, replyMarkup }: { ctx: MyContext, message: string, replyMarkup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply; }) => {

  return await ctx.reply(message, { reply_markup: replyMarkup, parse_mode: "MarkdownV2", reply_parameters: { message_id: ctx.msgId ?? 0 } })
}

export const replyMarkdownV2 = async ({ ctx, message, replyMarkup }: { ctx: MyContext, message: string, replyMarkup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply; }) => {

  return await ctx.reply(message, { reply_markup: replyMarkup, parse_mode: "MarkdownV2" })
}

export const logGroup = async (ctx: MyContext) => {
  if (ctx.from && !ctx.session.config.isLogged) {
    ctx.session.config.isLogged = true
    const chatInfo = await ctx.api.getChat(ctx.chatId ?? 0)
    ctx.api.sendMessage(LOG_GROUP_ID, [
      `Group Name\\: ${escapeMetaCharacters(chatInfo.title ?? '')}`,
      `Group ID\\: ${escapeMetaCharacters((chatInfo.id ?? 0).toString())}`,
      `Group Type\\: ${escapeMetaCharacters((chatInfo.type ?? 0).toString())}`,
      `Group Username\\: ${escapeMetaCharacters(('@' + (chatInfo.username ?? '')).toString())}`,
      `Group Link\\: ${escapeMetaCharacters((chatInfo).invite_link ?? '')}`,
      `Group join by request\\: ${escapeMetaCharacters((chatInfo.join_by_request ?? '').toString())}`,
    ].join('\n'), {
      parse_mode: "MarkdownV2"
    }).catch()

  }
}

export const linkChecker = (text: string) => {
  return text.toLowerCase().includes('t.me') ||
    text.toLowerCase().includes('http') ||
    text.toLowerCase().includes('www')
}

export const getRemainingTime = (time1: number, time2: number) => {
  var diff = Math.abs(time1 - time2); // this is a time in milliseconds
  var diff_as_date = new Date(diff);
  diff_as_date.getHours(); // hours
  diff_as_date.getMinutes(); // minutes
  diff_as_date.getSeconds()
  return diff_as_date.getHours() + ' hours ' + diff_as_date.getMinutes() + ' mins'
}