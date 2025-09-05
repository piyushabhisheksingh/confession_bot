import { supabaseAdapter } from "@grammyjs/storage-supabase";
import { createClient } from '@supabase/supabase-js';
import { Config, UserData } from "../schema/interfaces";

const TableName1 = 'session'

const TableName2 = 'config'


// supabase instance
const { DB_URL, DB_KEY } = process.env as { DB_URL?: string; DB_KEY?: string };
if (!DB_URL || !DB_KEY) {
  throw new Error('Missing DB_URL or DB_KEY in environment');
}
const supabase = createClient(DB_URL, DB_KEY);

//create storage
export const confessionStorage = supabaseAdapter<UserData>({
  supabase,
  table: TableName1, // the defined table name you want to use to store your session
});

//create storage
export const settingsStorage = supabaseAdapter<Config>({
  supabase,
  table: TableName2, // the defined table name you want to use to store your session
});

// --- lightweight caches to reduce Supabase calls ---
const USER_TTL_MS = 30_000; // 30s
const CHATIDS_TTL_MS = 60_000; // 60s

const userCache = new Map<string, { value: UserData; ts: number }>();
let chatIdsCache: { value: number[]; ts: number } | null = null;

// Basic cache metrics
const cacheStats = {
  userHits: 0,
  userMisses: 0,
  chatHits: 0,
  chatMisses: 0,
  chatRefreshes: 0,
};

export const invalidateUserCache = (id?: string) => {
  if (id) userCache.delete(id);
  else userCache.clear();
}

export const invalidateChatIdsCache = () => {
  chatIdsCache = null;
}

export const readChatIDAll = async (forceRefresh = false) => {
  const now = Date.now();
  if (!forceRefresh && chatIdsCache && now - chatIdsCache.ts < CHATIDS_TTL_MS) {
    cacheStats.chatHits++;
    return chatIdsCache.value;
  }
  cacheStats.chatMisses++;
  const { data, error } = await supabase.from(TableName2).select('id');
  if (error || !data) {
    return undefined;
  }
  const ids = data
    .map((item: any) => {
      const raw = item?.id;
      if (typeof raw === 'number') return raw;
      const asNum = Number(raw);
      if (!Number.isNaN(asNum)) return asNum;
      try {
        const parsed = JSON.parse(raw);
        const asNum2 = Number(parsed);
        return Number.isNaN(asNum2) ? undefined : asNum2;
      } catch {
        return undefined;
      }
    })
    .filter((v: unknown): v is number => typeof v === 'number');
  chatIdsCache = { value: ids as number[], ts: now };
  cacheStats.chatRefreshes++;
  return chatIdsCache.value;
}

export const readConfig = async (id: number) => {
  const { data, error } = await supabase.from(TableName2).select(TableName2).eq('id', id).single();
  if (error || !data) {
    return undefined;
  }
  try {
    return JSON.parse((data as any).config) as Config;
  } catch {
    return undefined;
  }
}

export const writeConfig = async (id: number, value: Config) => {
  const input = { id: Number(id), config: JSON.stringify(value) } as any;
  await supabase.from(TableName2).upsert(input);
}

export const readID = async (id: string) => {
  const now = Date.now();
  const cached = userCache.get(id);
  if (cached && now - cached.ts < USER_TTL_MS) {
    cacheStats.userHits++;
    return cached.value;
  }
  cacheStats.userMisses++;
  const { data, error } = await supabase.from(TableName1).select(TableName1).eq('id', Number(id)).single();
  if (error || !data) {
    return undefined
  }
  const parsed = JSON.parse(data.session) as UserData;
  userCache.set(id, { value: parsed, ts: now });
  return parsed;
}

export const writeID = async (id: string, value: UserData) => {
  const input = { id: Number(id), session: JSON.stringify(value) };
  await supabase.from(TableName1).upsert(input);
  userCache.set(id, { value, ts: Date.now() });
}

export const deleteChatID = async (id: number) => {
  await supabase.from(TableName2).delete().eq('id', id);
  invalidateChatIdsCache();
}

// --- Simple in-memory cache for postId -> userId mapping ---
const POSTID_TTL_MS = 10 * 60 * 1000; // 10 minutes
const postIdCache = new Map<number, { userId: number; ts: number }>();

export const invalidatePostIdCache = (postId?: number) => {
  if (postId != null) postIdCache.delete(postId);
  else postIdCache.clear();
}

// Find a user id (session id) that has a confession with given post id.
export const findUserIdByPostId = async (postId: number): Promise<number | undefined> => {
  const now = Date.now();
  const cached = postIdCache.get(postId);
  if (cached && now - cached.ts < POSTID_TTL_MS) {
    return cached.userId;
  }

  // Fast path: query by text match to avoid fetching all rows.
  // JSON.stringify writes without spaces after colon, so we search for '"id":<postId>'
  const pattern = `%"id":${postId}%`;
  const { data, error } = await supabase
    .from(TableName1)
    .select('id, session')
    .like('session', pattern)
    .limit(10);
  if (error || !data) return undefined;
  for (const row of data as any[]) {
    try {
      const s = JSON.parse(row.session) as UserData;
      if (Array.isArray(s.confessions) && s.confessions.some(c => c && c.id === postId)) {
        const uid = Number(row.id);
        postIdCache.set(postId, { userId: uid, ts: now });
        return uid;
      }
    } catch {}
  }
  return undefined;
}

// Persistent post->user mapping table helpers
export const mapPostToUser = async (postId: number, userId: number) => {
  if (!postId || !userId) return;
  await supabase.from('post_user_map').upsert({ post_id: postId, user_id: userId });
}

export const getUserByPostMap = async (postId: number): Promise<number | undefined> => {
  const { data, error } = await supabase.from('post_user_map').select('user_id').eq('post_id', postId).single();
  if (error || !data) return undefined;
  return Number((data as any).user_id);
}

// Background refresh logic for chat IDs
export const refreshChatIdsCache = async () => {
  await readChatIDAll(true);
}

let refreshTimer: NodeJS.Timeout | null = null;
export const startChatIdsBackgroundRefresh = (intervalMs: number) => {
  if (refreshTimer) refreshTimer.unref();
  if (intervalMs <= 0) return;
  refreshTimer = setInterval(() => {
    refreshChatIdsCache().catch(() => { /* ignore */ });
  }, intervalMs);
  refreshTimer.unref();
}

export const getDbCacheStats = () => ({ ...cacheStats });
export const resetDbCacheStats = () => {
  cacheStats.userHits = 0;
  cacheStats.userMisses = 0;
  cacheStats.chatHits = 0;
  cacheStats.chatMisses = 0;
  cacheStats.chatRefreshes = 0;
}
