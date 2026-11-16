import type { SupabaseClient } from "@supabase/supabase-js";
export function start(opts: { supabase: SupabaseClient }): Promise<void>;
export function parseJsonLoose(text: string): unknown;
