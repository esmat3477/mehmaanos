'use strict';
(() => {
  const $ = id => document.getElementById(id);
  $('host').textContent = location.host + '/r/';
  let touched = false, timer;
  const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  async function check() {
    const slug = $('slug').value.trim().toLowerCase();
    if (!slug) { $('slugMsg').textContent = ''; return; }
    try {
      const r = await MOS.api('GET', '/api/signup/check?slug=' + encodeURIComponent(slug));
      $('slugMsg').textContent = r.available ? `✓ ${location.host}/r/${slug} is free` : '✗ Not available. Use 3–40 lowercase letters, numbers or dashes, or try another name.';
      $('slugMsg').style.color = r.available ? 'var(--ok)' : 'var(--bad)';
      $('codeRow').classList.toggle('hidden', !r.inviteRequired);
    } catch {}
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(check, 300); };
  $('name').addEventListener('input', () => { if (!touched) { $('slug').value = slugify($('name').value); later(); } });
  $('slug').addEventListener('input', () => { touched = true; later(); });
  check();
  $('f').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('msg'); msg.textContent = '';
    if ($('pin').value !== $('pin2').value) { msg.textContent = 'The two PINs are different.'; return; }
    $('go').disabled = true; $('go').textContent = 'Creating…';
    try {
      const r = await MOS.api('POST', '/api/signup', {
        restaurantName: $('name').value, slug: $('slug').value.trim().toLowerCase(), country: $('country').value,
        ownerName: $('owner').value, contact: $('contact').value, pin: $('pin').value,
        demoMenu: $('demo').checked, code: $('code').value, terms: $('terms').checked
      });
      location.href = r.url + '#welcome';
    } catch (err) { msg.textContent = err.message; $('go').disabled = false; $('go').textContent = 'Create my restaurant'; }
  });
})();
