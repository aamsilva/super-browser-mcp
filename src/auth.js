// AuthService — modelo de estado de autenticação único (§5/§7).
// Estados: VERIFIED | CACHED | UNKNOWN | EXPIRED | UNAUTHENTICATED | BLOCKED.
// Única fonte de verdade para auth_check / auth_status / auth_audit.
// Nunca fabrica VERIFIED sem evidência de navegação (§37).
const STATES = {
  VERIFIED: "VERIFIED",         // navegação fresca confirma sessão
  CACHED: "CACHED",             // verificação anterior dentro do TTL
  UNKNOWN: "UNKNOWN",           // sem evidência
  EXPIRED: "EXPIRED",           // era VERIFIED/CACHED; probe anterior detectou logout
  UNAUTHENTICATED: "UNAUTHENTICATED",
  BLOCKED: "BLOCKED",
};
const TTL_MS = 30 * 60 * 1000;

class AuthService {
  constructor() { this.cache = new Map(); }

  classify(url, bodyText = "") {
    const u = String(url || "");
    if (/AccessDenied|denied\.aspx|access denied|solicitou acesso|requested access/i.test(u + " " + bodyText))
      return { state: STATES.BLOCKED, evidenceKind: "access_denied" };
    let host = "";
    try { host = new URL(u).hostname.toLowerCase(); } catch {}
    if (host === "login.microsoftonline.com" || host === "login.rdkcentral.com" || host === "accounts.google.com" && /signin|ServiceLogin/.test(u))
      return { state: STATES.UNAUTHENTICATED, evidenceKind: "on_login_host" };
    if (/(login\.rdkcentral|login\.microsoftonline|\/(login|accounts\/login|signin))(\?|\/|$)/i.test(u))
      return { state: STATES.UNAUTHENTICATED, evidenceKind: "redirected_to_login" };
    if (u.length === 0) return { state: STATES.UNKNOWN, evidenceKind: "no_url" };
    return { state: STATES.VERIFIED, evidenceKind: "loaded_authenticated_page" };
  }

  store(site, url, evidence, ok) {
    const entry = { verifiedAt: Date.now(), url, evidence: (evidence || "").slice(0, 120) };
    this.cache.set(site, entry);
    if (!ok && evidence === "expired_or_logout") entry.state = STATES.EXPIRED;
    return entry;
  }

  get(site) { return this.cache.get(site) || null; }

  invalidate(site) { this.cache.delete(site); }

  // Estado a partir do cache (nunca VERIFIED sem verificação):
  cachedState(site) {
    const e = this.cache.get(site);
    if (!e) return { site, state: STATES.UNKNOWN, verified: false, checkedAt: null };
    // UM probe ÚNICO. Se o probe anterior classificou BLOCKED/UNAUTHENTICATED/EXPIRED
    // mantém esse estado; VERIFIED fica CACHED passados TTL ou mantém VERIFIED
    // com verified:false e cachedAt se ainda fresco?
    // Decisão: dentro de TTL → CACHED (verified:false); fora → UNKNOWN (para
    // nunca afirmar sem prova). BLOCKED/UNAUTHENTICATED permanecem.
    const fresh = Date.now() - e.verifiedAt < TTL_MS;
    if (e.state && e.state !== STATES.VERIFIED) {
      const st = fresh ? e.state : (e.state === STATES.BLOCKED ? STATES.BLOCKED : STATES.EXPIRED);
      return { site, state: st, verified: false, cachedAt: new Date(e.verifiedAt).toISOString(), evidence: e.evidence };
    }
    return { site, state: fresh ? STATES.CACHED : STATES.UNKNOWN, verified: false, cachedAt: new Date(e.verifiedAt).toISOString(), evidence: e.evidence };
  }

  // Resultado de verificação nova
  verifiedState(site, url, bodyText) {
    const c = this.classify(url, bodyText);
    const rec = { site, state: c.state, verified: c.state === STATES.VERIFIED || c.state === STATES.BLOCKED || c.state === STATES.UNAUTHENTICATED, checkedAt: new Date().toISOString(), evidence: { url: String(url || "").slice(0, 120), probe: c.evidenceKind } };
    this.cache.set(site, { verifiedAt: Date.now(), url, evidence: c.evidenceKind, state: c.state });
    return rec;
  }
}

module.exports = { AuthService, STATES };
