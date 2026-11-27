'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// API keys are stored hashed (sha256). The full key is shown once, at creation.
class KeyStore {
  constructor(file) {
    this.file = file;
    this.keys = [];
    try { this.keys = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new store */ }
  }
  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.keys, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  static hash(k) { return crypto.createHash('sha256').update(k).digest('hex'); }
  create(name) {
    const secret = 'sk-codex-' + crypto.randomBytes(24).toString('base64url');
    const rec = {
      id: crypto.randomUUID(), name: String(name || 'unnamed').slice(0, 80),
      hash: KeyStore.hash(secret), prefix: secret.slice(0, 14) + '…',
      created: Date.now(), lastUsed: null, requests: 0, revoked: false,
    };
    this.keys.push(rec);
    this._save();
    return { ...this.publicView(rec), key: secret };
  }
  publicView(r) { const { hash, ...rest } = r; return rest; }
  list() { return this.keys.map((r) => this.publicView(r)); }
  revoke(id) {
    const r = this.keys.find((k) => k.id === id);
    if (!r) return false;
    r.revoked = true; this._save(); return true;
  }
  remove(id) {
    const n = this.keys.length;
    this.keys = this.keys.filter((k) => k.id !== id);
    if (this.keys.length !== n) this._save();
    return this.keys.length !== n;
  }
  // Returns the key record if valid, else null. Records usage.
  verify(secret) {
    if (!secret) return null;
    const h = Buffer.from(KeyStore.hash(secret));
    for (const r of this.keys) {
      if (r.revoked) continue;
      const b = Buffer.from(r.hash);
      if (b.length === h.length && crypto.timingSafeEqual(b, h)) {
        r.lastUsed = Date.now(); r.requests++;
        this._save();
        return r;
      }
    }
    return null;
  }
}
module.exports = { KeyStore };
