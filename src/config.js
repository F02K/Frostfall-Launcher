/**
 * Server & API configuration — developer-only.
 * These values are NOT exposed in the user-facing settings UI.
 *
 * Add more entries to `servers` to enable the in-launcher server selector.
 * The selector is only shown to the user when servers.length > 1.
 */
module.exports = {
  servers: [
    {
      name:       'Frostfall Roleplay',
      address:    '127.0.0.1',
      port:       7777,
      apiUrl:     'http://localhost:4000',
    },
  ],
}
