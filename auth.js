// auth.js — Authentication module

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Initialize Supabase client
// Replace with your actual Supabase URL and anon key
export const supabase = createClient(
  window.SUPABASE_URL || 'https://YOUR_PROJECT.supabase.co',
  window.SUPABASE_ANON_KEY || 'YOUR_ANON_KEY',
  {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
    realtime: {
      params: { eventsPerSecond: 10 },
    },
  }
);

// ──────────────────────────────────────────
// Auth State
// ──────────────────────────────────────────
let _authCallbacks = [];

supabase.auth.onAuthStateChange((event, session) => {
  _authCallbacks.forEach(cb => cb(event, session));
});

export function onAuthChange(callback) {
  _authCallbacks.push(callback);
}

// ──────────────────────────────────────────
// Login / Register
// ──────────────────────────────────────────
export async function signUp(email, password, username) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { username },
    },
  });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}
