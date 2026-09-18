const BASE = 'http://127.0.0.1:3001';
const DEVICE_USER = process.env.DEVICE_USER;

async function rest(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 200) }; }
  return { status: r.status, json: j };
}

const g = await rest('/api/auth/guest', { method: 'POST', body: { username: 'TestPal' } });
const pal = g.json.data;
console.log(`test friend: ${pal.user.username}  id=${pal.user.id}`);
console.log(`token saved for later steps`);

const sent = await rest('/api/friends/requests', {
  method: 'POST', token: pal.token, body: { userId: DEVICE_USER },
});
console.log(`friend request -> HTTP ${sent.status} ${JSON.stringify(sent.json).slice(0, 200)}`);
console.log(`\nTESTPAL_TOKEN=${pal.token}`);
