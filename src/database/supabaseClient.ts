import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://peirtaggezamposvrwih.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlaXJ0YWdnZXphbXBvc3Zyd2loIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMjgxMDQsImV4cCI6MjA5OTcwNDEwNH0.5uq04cu4Ts8QtCS-HhHaQPvx4dAjJH3mkjDjRfQzQW8";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
