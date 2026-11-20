'use strict';
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('msg');
  msg.textContent = '';
  try {
    const { role } = await MOS.api('POST', '/api/login', { pin: document.getElementById('pin').value });
    const next = new URLSearchParams(location.search).get('next');
    const safe = next && /^\/(staff|kitchen|admin)$/.test(next) ? next : (role === 'kitchen' ? '/kitchen' : role === 'admin' ? '/admin' : '/staff');
    location.href = safe;
  } catch (err) { msg.textContent = err.message; }
});
