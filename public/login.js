'use strict';
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('msg');
  msg.textContent = '';
  try {
    const { role } = await MOS.api('POST', '/api/login', { pin: document.getElementById('pin').value });
    const next = new URLSearchParams(location.search).get('next');
    const page = next && /^(staff|kitchen|admin)$/.test(next) ? next : (role === 'kitchen' ? 'kitchen' : role === 'admin' ? 'admin' : 'staff');
    location.href = MOS.base + '/' + page;
  } catch (err) { msg.textContent = err.message; }
});
MOS.api('GET', '/api/me').catch(e => {
  if (e.status === 404) document.getElementById('msg').textContent = 'Restaurant not found. Check the web address.';
});
