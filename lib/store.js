'use strict';
// JSON-file persistence with atomic writes. Fine for a single-venue pilot.
// Swap for PostgreSQL before multi-venue or high volume.
const fs = require('fs');
const path = require('path');
const { seed } = require('./seed');

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'mehmaanos.json');
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } else {
      this.data = seed();
      this.saveNow();
    }
    this.timer = null;
  }
  saveNow() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; try { this.saveNow(); } catch (e) { console.error('save failed', e); } }, 50);
  }
  audit(actor, action, detail) {
    this.data.audit.push({ at: new Date().toISOString(), actor, action, detail });
    if (this.data.audit.length > 5000) this.data.audit.splice(0, this.data.audit.length - 5000);
  }
}

module.exports = { Store };
