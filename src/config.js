/**
 * Launcher configuration — developer-only.
 *
 * apiUrl  – Base URL of the Frostfall backend.
 *           The available game servers are fetched from GET /api/servers
 *           at runtime so they never need a launcher rebuild to update.
 */
module.exports = {
  apiUrl: 'http://localhost:4000',
}
