// ============================================================================
// HRS Server — config.example.js
//
// Copy this file to `config.js` and fill in your own project's values, OR
// just edit `config.js` directly if it already has your real values (the
// Supabase URL and publishable/anon key are DESIGNED to be public — they
// are meaningless without Row Level Security behind them).
//
// NEVER put a service-role key, a database password, or any
// `postgresql://...` connection string in this file. Those never belong
// in frontend code, committed or not.
// ============================================================================

window.HRS_CONFIG = {
  SUPABASE_URL: "YOUR_SUPABASE_PROJECT_URL",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_PUBLISHABLE_ANON_KEY",
  ADMIN_USERS_FUNCTION: "admin-users",
};
