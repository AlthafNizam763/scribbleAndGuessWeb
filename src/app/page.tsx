/**
 * The only page this project serves.
 *
 * Brief sections 62 and 63 are explicit: no game UI, no lobby, no dashboard,
 * no admin panel. Next needs a root route to boot, so this is a plain status
 * page — enough to confirm the server is up when someone opens the origin in a
 * browser, and nothing more.
 *
 * The game itself lives in the Flutter app.
 */
export default function StatusPage() {
  return (
    <main
      style={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        padding: '3rem 1.5rem',
        maxWidth: '46rem',
        margin: '0 auto',
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ fontSize: '1.25rem', margin: 0 }}>Scribble &amp; Guess — backend</h1>
      <p style={{ color: '#555' }}>
        REST API and Socket.IO realtime server. There is no web version of the game here; the
        client is the Flutter app.
      </p>
      <ul style={{ color: '#555' }}>
        <li>
          Health: <a href="/api/health">/api/health</a>
        </li>
        <li>Socket.IO: same origin, default path (/socket.io)</li>
        <li>API docs: see README.md in this project</li>
      </ul>
    </main>
  );
}
