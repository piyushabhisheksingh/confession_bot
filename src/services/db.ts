import { supabaseAdapter } from "@grammyjs/storage-supabase";
import { createClient } from '@supabase/supabase-js';
import { Config, UserData } from "../schema/interfaces";

const TableName1 = 'session'

const TableName2 = 'config'


// supabase instance
const supabase = createClient(String(process.env.DB_URL), String(process.env.DB_KEY));

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

export const readChatIDAll = async () => {
  const { data, error } = await supabase.from(TableName2).select('id');
  if (error || !data) {
    return undefined
  }
  return data.map(item => JSON.parse(item.id)) as Array<number>
}