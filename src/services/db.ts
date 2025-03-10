import { supabaseAdapter } from "@grammyjs/storage-supabase";
import { createClient } from '@supabase/supabase-js';
import { Config, UserData } from "../schema/interfaces";

const TableName1 = 'session'

const TableName2 = 'config'

const TableName3 = 'others'

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

//create storage
export const othersStorage = supabaseAdapter<any>({
  supabase,
  table: TableName3, // the defined table name you want to use to store your session
});
