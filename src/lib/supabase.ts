import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Public client (browser / client components)
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Server-only admin client — bypasses RLS for trusted server-side operations
// (webhook, cron, etc.) Never expose this to the browser.
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const supabaseAdmin = supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey, {
          auth: { persistSession: false },
      })
    : supabase; // fallback to anon if key not set
