import { SupabaseClient, createClient } from '@supabase/supabase-js';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);
export const supabaseConfigError = isSupabaseConfigured
  ? null
  : 'VITE_SUPABASE_URL 또는 VITE_SUPABASE_ANON_KEY가 비어 있습니다.';

const missingClient = new Proxy(
  {},
  {
    get() {
      throw new Error(supabaseConfigError ?? 'Supabase 설정이 필요합니다.');
    },
  },
) as SupabaseClient;

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : missingClient;
