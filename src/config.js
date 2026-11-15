/*
 * Ruchi app settings — edit these, then run `npm run sync`.
 *
 * aiEndpoint: the URL of your Ask Ruchi server (see server/README.md).
 *             Leave it empty and Ask Ruchi uses the built-in offline planner.
 * aiKey:      optional shared key your server checks (stops random people using it).
 * supabaseUrl / supabaseAnonKey: your Supabase project (Project Settings -> API).
 *             Set both = shared cloud database for every phone. Empty = data stays on the phone.
 *             The anon key is public by design; security comes from the database rules.
 * cartoKey:   optional free CARTO basemaps key (carto.com/basemaps/apikey). Empty = Esri light-grey map.
 */
window.RUCHI_CONFIG = {
  aiEndpoint: '',
  aiKey: '',
  cartoKey: '',
  supabaseUrl: '',
  supabaseAnonKey: ''
};
