'use strict';
document.getElementById('print').onclick = () => window.print();
const box = document.getElementById('slips');
for (let i = 0; i < 3; i++) {
  const s = document.createElement('div'); s.className = 'slip';
  s.innerHTML = '<div class="row between"><b>MehmaanOS · paper order</b><span>Slip no. ______</span></div>' +
    '<div class="grid4" style="margin:8px 0"><div>Table: ______</div><div>Time: ______</div><div>Waiter: ______________</div></div>' +
    '<div class="grid4 small muted"><div>Dish</div><div>Qty</div><div>Spice / note</div></div>' +
    Array.from({ length: 6 }, () => '<div class="grid4"><div class="line"></div><div class="line"></div><div class="line"></div></div>').join('') +
    '<div class="row between small" style="margin-top:8px"><span>☐ Kitchen started ☐ Ready ☐ Served</span><span>☐ Paid ☐ Entered in system later</span></div>';
  box.append(s);
}
