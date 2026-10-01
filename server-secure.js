"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const sharp = require("sharp");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const DB_PATH = process.env.NAXEL_DB_PATH || path.join(DATA, "naxel-care.sqlite");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 5001);
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ALLOW_DEMO_RESET = !IS_PRODUCTION && process.env.NAXEL_ALLOW_DEMO_RESET !== "false";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PHOTO_BYTES = 750 * 1024;
const MAX_SIGNATURE_BYTES = 250 * 1024;
const MAX_PHOTO_PIXELS = 40_000_000;
const MAX_SIGNATURE_PIXELS = 2_000_000;
const DEFAULT_ORG = "org_naxel";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const makeId = prefix => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const addDays = (date, days) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
};
const legacyHash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const tokenHash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function passwordMatches(password, stored) {
  if (String(stored).startsWith("scrypt$")) {
    const [, salt, expected] = String(stored).split("$");
    if (!salt || !expected) return false;
    const actual = crypto.scryptSync(String(password), Buffer.from(salt, "hex"), 64).toString("hex");
    return safeEqual(actual, expected);
  }
  return safeEqual(legacyHash(password), stored);
}

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column);
}

function addColumn(table, declaration) {
  const column = declaration.trim().split(/\s+/)[0];
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${declaration}`);
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'Ativa', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, company_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Administrador'
    );
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'Comercial', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS equipment (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
      serial TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
      last_service TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS service_orders (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id),
      equipment_id TEXT REFERENCES equipment(id), service TEXT NOT NULL,
      scheduled_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Agendado',
      technician TEXT NOT NULL DEFAULT '', value REAL NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '', checklist_json TEXT NOT NULL DEFAULT '[]',
      photos_json TEXT NOT NULL DEFAULT '[]', signature TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS warranties (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id),
      order_id TEXT NOT NULL REFERENCES service_orders(id), start_date TEXT NOT NULL,
      end_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Ativa'
    );
    CREATE TABLE IF NOT EXISTS maintenance_returns (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id),
      equipment_id TEXT REFERENCES equipment(id), service TEXT NOT NULL,
      due_date TEXT NOT NULL, estimated_value REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Próximo', source_order_id TEXT REFERENCES service_orders(id),
      last_contacted_at TEXT NOT NULL DEFAULT '', next_action_date TEXT NOT NULL DEFAULT '',
      converted_order_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS contact_attempts (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, return_id TEXT NOT NULL,
      user_id TEXT NOT NULL, outcome TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      follow_up_date TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES service_orders(id),
      created_at TEXT NOT NULL, summary TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  for (const table of ["users", "customers", "equipment", "service_orders", "warranties", "maintenance_returns", "reports"]) {
    addColumn(table, `organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORG}'`);
  }
  addColumn("users", "status TEXT NOT NULL DEFAULT 'Ativo'");
  addColumn("maintenance_returns", "last_contacted_at TEXT NOT NULL DEFAULT ''");
  addColumn("maintenance_returns", "next_action_date TEXT NOT NULL DEFAULT ''");
  addColumn("maintenance_returns", "converted_order_id TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_settings (
      organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      value TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT,
      action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}', ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
    CREATE INDEX IF NOT EXISTS idx_customers_org ON customers(organization_id, name);
    CREATE INDEX IF NOT EXISTS idx_equipment_org_customer ON equipment(organization_id, customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_org_date ON service_orders(organization_id, scheduled_date);
    CREATE INDEX IF NOT EXISTS idx_returns_org_due ON maintenance_returns(organization_id, status, due_date);
    CREATE INDEX IF NOT EXISTS idx_return_contacts_org_return ON contact_attempts(organization_id, return_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_warranties_org_end ON warranties(organization_id, status, end_date);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_org_date ON audit_logs(organization_id, created_at);
  `);
  db.prepare("INSERT OR IGNORE INTO organizations (id,name,slug,status,created_at) VALUES (?,?,?,?,?)")
    .run(DEFAULT_ORG, "Naxel Climatização", "naxel", "Ativa", now());
  const oldSettings = db.prepare("SELECT value FROM settings WHERE key='company'").get()?.value;
  db.prepare("INSERT OR IGNORE INTO organization_settings (organization_id,value,updated_at) VALUES (?,?,?)")
    .run(DEFAULT_ORG, oldSettings || JSON.stringify({ name: "Naxel Climatização", phone: "", city: "Salvador", warrantyDefault: 90 }), now());
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
}

function seed() {
  if (!db.prepare("SELECT COUNT(*) total FROM users WHERE organization_id=?").get(DEFAULT_ORG).total) {
    const configuredPassword = process.env.NAXEL_DEMO_PASSWORD;
    const demoPassword = configuredPassword || crypto.randomBytes(32).toString("base64url");
    db.prepare(`INSERT INTO users (id,name,email,password_hash,company_name,role,organization_id,status)
      VALUES (?,?,?,?,?,?,?,'Ativo')`).run("u_demo", "Plácido Junior", "admin@naxel.local", passwordHash(demoPassword), "Naxel Climatização", "Administrador", DEFAULT_ORG);
    if (!configuredPassword) {
      fs.writeFileSync(path.join(DATA, "naxel-demo-access.txt"), `Login local: admin@naxel.local\nSenha local: ${demoPassword}\n\nEste arquivo contém uma credencial local. Não compartilhe nem versione.\n`, { mode: 0o600 });
      console.log("Acesso local inicial criado. Consulte data/naxel-demo-access.txt e guarde a senha em local seguro.");
    }
  }
  if (db.prepare("SELECT COUNT(*) total FROM customers WHERE organization_id=?").get(DEFAULT_ORG).total) return;
  const insertCustomer = db.prepare(`INSERT INTO customers
    (id,name,phone,email,city,type,notes,created_at,organization_id) VALUES (?,?,?,?,?,?,?,?,?)`);
  [
    ["c_mare", "Restaurante Maré Alta", "71991234567", "operacao@marealta.com", "Salvador", "Comercial", "Atendimento preferencial pela manhã."],
    ["c_sorriso", "Clínica Sorriso", "71992345678", "adm@clinicasorriso.com", "Salvador", "Comercial", "Recepção funciona até 18h."],
    ["c_carla", "Carla Menezes", "71993456789", "", "Lauro de Freitas", "Residencial", ""],
    ["c_farol", "Academia Farol", "71994567890", "gerencia@academiafarol.com", "Salvador", "Comercial", ""],
    ["c_lima", "Escritório Lima", "71995678901", "contato@lima.adv.br", "Salvador", "Comercial", ""]
  ].forEach(row => insertCustomer.run(...row, now(), DEFAULT_ORG));
  const insertEquipment = db.prepare(`INSERT INTO equipment
    (id,customer_id,kind,brand,model,serial,location,last_service,created_at,organization_id) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  [
    ["e_daikin", "c_mare", "Split", "Daikin", "Eco 24K", "DK24098", "Salão", "2026-03-10"],
    ["e_lg", "c_mare", "Split", "LG", "Dual 18K", "LG18873", "Cozinha", "2026-03-10"],
    ["e_samsung", "c_sorriso", "Split", "Samsung", "WindFree 24K", "SWF2412", "Recepção", "2026-05-18"],
    ["e_elgin", "c_carla", "Split", "Elgin", "Eco Inverter 12K", "EL12012", "Quarto", "2026-06-12"],
    ["e_carrier", "c_farol", "Cassete", "Carrier", "Cassete 48K", "CR48119", "Musculação", "2026-07-02"]
  ].forEach(row => insertEquipment.run(...row, now(), DEFAULT_ORG));
  const insertOrder = db.prepare(`INSERT INTO service_orders
    (id,customer_id,equipment_id,service,scheduled_date,status,technician,value,notes,checklist_json,completed_at,created_at,organization_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  [
    ["os_1048", "c_farol", "e_carrier", "Manutenção preventiva", "2026-09-18", "Agendado", "Rafael", 680, ""],
    ["os_1047", "c_sorriso", "e_samsung", "Diagnóstico e reparo", "2026-09-15", "Concluído", "Júlio", 420, "Capacitor substituído e funcionamento validado."],
    ["os_1046", "c_carla", "e_elgin", "Higienização", "2026-09-13", "Concluído", "Rafael", 250, "Higienização completa e drenagem conferida."]
  ].forEach(row => insertOrder.run(...row, JSON.stringify(["Equipamento ligado", "Filtros verificados", "Drenagem testada"]), row[5] === "Concluído" ? `${row[4]}T17:00:00` : "", now(), DEFAULT_ORG));
  const warranty = db.prepare("INSERT INTO warranties (id,customer_id,order_id,start_date,end_date,status,organization_id) VALUES (?,?,?,?,?,?,?)");
  warranty.run("g_1047", "c_sorriso", "os_1047", "2026-09-15", "2026-12-14", "Ativa", DEFAULT_ORG);
  warranty.run("g_1046", "c_carla", "os_1046", "2026-09-13", "2026-10-13", "Ativa", DEFAULT_ORG);
  const ret = db.prepare(`INSERT INTO maintenance_returns
    (id,customer_id,equipment_id,service,due_date,estimated_value,status,source_order_id,organization_id) VALUES (?,?,?,?,?,?,?,?,?)`);
  ret.run("r_mare", "c_mare", "e_daikin", "Higienização de 4 equipamentos", "2026-07-10", 1280, "Vencido", null, DEFAULT_ORG);
  ret.run("r_sorriso", "c_sorriso", "e_samsung", "Preventiva Split 24.000 BTU", "2026-08-16", 420, "Vencido", null, DEFAULT_ORG);
  ret.run("r_carla", "c_carla", "e_elgin", "Higienização residencial", "2026-09-20", 250, "Próximo", null, DEFAULT_ORG);
  ret.run("r_lima", "c_lima", null, "Revisão preventiva", "2026-09-28", 380, "Próximo", null, DEFAULT_ORG);
  const report = db.prepare("INSERT INTO reports (id,order_id,created_at,summary,organization_id) VALUES (?,?,?,?,?)");
  report.run("la_1047", "os_1047", "2026-09-15", "Diagnóstico concluído. Capacitor substituído e testes de operação aprovados.", DEFAULT_ORG);
  report.run("la_1046", "os_1046", "2026-09-13", "Higienização completa, limpeza de filtros e verificação de drenagem.", DEFAULT_ORG);
}

migrate();
seed();

const loginAttempts = new Map();
function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (IS_PRODUCTION) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

function json(res, status, data, headers = {}) {
  securityHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(data));
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Solicitação muito grande."), { status: 413 }));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(Object.assign(new Error("Dados inválidos."), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function cookies(req) {
  const result = {};
  for (const item of (req.headers.cookie || "").split(";")) {
    if (!item.trim()) continue;
    const [key, ...rest] = item.trim().split("=");
    try { result[key] = decodeURIComponent(rest.join("=")); } catch { result[key] = ""; }
  }
  return result;
}

function sessionCookie(token, maxAge = 43200) {
  return `naxel_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${IS_PRODUCTION ? "; Secure" : ""}`;
}

function getSession(req) {
  const token = cookies(req).naxel_session;
  if (!token) return null;
  const row = db.prepare(`SELECT s.*,u.name,u.email,u.company_name,u.role,u.status,o.name organization_name,o.status organization_status
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN organizations o ON o.id=s.organization_id
    WHERE s.token_hash=? AND s.expires_at>?`).get(tokenHash(token), now());
  if (!row || row.status !== "Ativo" || row.organization_status !== "Ativa") return null;
  return { token, user: { id: row.user_id, name: row.name, email: row.email, company_name: row.company_name, role: row.role, organization_id: row.organization_id, organization_name: row.organization_name }, csrfToken: row.csrf_token };
}

function audit(req, session, action, entity, entityId = "", details = {}) {
  db.prepare(`INSERT INTO audit_logs (id,organization_id,user_id,action,entity,entity_id,detail_json,ip,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(makeId("aud"), session?.user?.organization_id || DEFAULT_ORG, session?.user?.id || null,
      action, entity, entityId, JSON.stringify(details), req.socket.remoteAddress || "", now());
}

function textValue(value, label, max = 160, required = false) {
  const result = String(value ?? "").trim();
  if (required && !result) throw Object.assign(new Error(`${label} é obrigatório.`), { status: 400 });
  if (result.length > max) throw Object.assign(new Error(`${label} excede ${max} caracteres.`), { status: 400 });
  return result;
}
function emailValue(value) {
  const email = textValue(value, "E-mail", 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error("E-mail inválido."), { status: 400 });
  return email;
}
function dateValue(value, label, required = true) {
  const date = textValue(value, label, 10, required);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error(`${label} inválida.`), { status: 400 });
  return date;
}
function numberValue(value, label, min = 0, max = 10000000) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < min || number > max) throw Object.assign(new Error(`${label} inválido.`), { status: 400 });
  return Math.round(number * 100) / 100;
}
function entityId(url, position = -1) {
  return textValue(url.pathname.split("/").at(position), "Identificador", 80, true);
}
function owned(table, id, org) {
  return db.prepare(`SELECT * FROM ${table} WHERE id=? AND organization_id=?`).get(id, org);
}
function assertRelated(table, id, org, label, optional = false) {
  if (!id && optional) return null;
  const record = owned(table, textValue(id, label, 80, !optional), org);
  if (!record) throw Object.assign(new Error(`${label} não encontrado.`), { status: 404 });
  return record;
}
function parseImageDataUrl(value, label, maxBytes, maxPixels, acceptedFormats) {
  const source = String(value || "");
  if (!source) return null;
  if (source.length > Math.ceil(maxBytes / 3) * 4 + 40) throw Object.assign(new Error(`${label} excede o limite permitido.`), { status: 413 });
  const match = source.match(/^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw Object.assign(new Error(`${label} inválida.`), { status: 400 });
  const file = Buffer.from(match[2], "base64");
  if (file.length > maxBytes) throw Object.assign(new Error(`${label} excede o limite permitido.`), { status: 413 });
  if (!file.length || file.toString("base64") !== match[2]) throw Object.assign(new Error(`${label} inválida.`), { status: 400 });
  return { file, declaredFormat: match[1], maxPixels, acceptedFormats };
}
async function normalizeImageDataUrl(value, label, maxBytes, maxPixels, maxDimension, outputFormat, acceptedFormats) {
  const parsed = parseImageDataUrl(value, label, maxBytes, maxPixels, acceptedFormats);
  if (!parsed) return "";
  const options = { failOn: "warning", limitInputPixels: parsed.maxPixels, limitInputChannels: 4, sequentialRead: true };
  try {
    const metadata = await sharp(parsed.file, options).metadata();
    if (!parsed.acceptedFormats.includes(metadata.format) || metadata.format !== parsed.declaredFormat || !metadata.width || !metadata.height || (metadata.pages || 1) > 1) {
      throw Object.assign(new Error(`${label} deve ser uma imagem estática válida.`), { status: 400 });
    }
    let pipeline = sharp(parsed.file, options).rotate().resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true });
    pipeline = outputFormat === "webp" ? pipeline.flatten({ background: "#ffffff" }).webp({ quality: 78, effort: 4 }) : pipeline.png({ compressionLevel: 9 });
    const output = await pipeline.toBuffer();
    if (output.length > maxBytes) throw Object.assign(new Error(`${label} excede o limite após otimização.`), { status: 413 });
    return `data:image/${outputFormat};base64,${output.toString("base64")}`;
  } catch (error) {
    if (Number(error.status)) throw error;
    throw Object.assign(new Error(`${label} não pôde ser validada como imagem.`), { status: 400 });
  }
}
function requireRole(session, roles) {
  if (!roles.includes(session.user.role)) throw Object.assign(new Error("Você não tem permissão para esta ação."), { status: 403 });
}

function listAll(org) {
  const parseOrder = row => {
    let checklist = [], photos = [];
    try { checklist = JSON.parse(row.checklist_json || "[]"); } catch {}
    try { photos = JSON.parse(row.photos_json || "[]"); } catch {}
    return { ...row, checklist, photos };
  };
  const settings = db.prepare("SELECT value FROM organization_settings WHERE organization_id=?").get(org)?.value || "{}";
  return {
    customers: db.prepare("SELECT * FROM customers WHERE organization_id=? ORDER BY name").all(org),
    equipment: db.prepare("SELECT * FROM equipment WHERE organization_id=? ORDER BY created_at DESC").all(org),
    orders: db.prepare("SELECT * FROM service_orders WHERE organization_id=? ORDER BY scheduled_date DESC,created_at DESC").all(org).map(parseOrder),
    warranties: db.prepare("SELECT * FROM warranties WHERE organization_id=? ORDER BY end_date").all(org),
    returns: db.prepare("SELECT * FROM maintenance_returns WHERE organization_id=? ORDER BY CASE status WHEN 'Vencido' THEN 0 WHEN 'Próximo' THEN 1 ELSE 2 END,due_date").all(org),
    contactAttempts: db.prepare("SELECT id,return_id,user_id,outcome,note,follow_up_date,created_at FROM contact_attempts WHERE organization_id=? ORDER BY created_at DESC").all(org),
    reports: db.prepare("SELECT * FROM reports WHERE organization_id=? ORDER BY created_at DESC").all(org),
    settings: JSON.parse(settings)
  };
}

function loginBlocked(key) {
  const state = loginAttempts.get(key);
  if (!state) return false;
  if (state.blockedUntil > Date.now()) return true;
  if (Date.now() - state.firstAt > 15 * 60 * 1000) loginAttempts.delete(key);
  return false;
}
function registerFailure(key) {
  const state = loginAttempts.get(key) || { count: 0, firstAt: Date.now(), blockedUntil: 0 };
  state.count += 1;
  if (state.count >= 5) state.blockedUntil = Date.now() + 15 * 60 * 1000;
  loginAttempts.set(key, state);
}

async function api(req, res, url) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method === "POST" && url.pathname === "/api/login") {
    const input = await requestBody(req);
    const email = emailValue(input.email).toLowerCase();
    const ipKey = `ip:${req.socket.remoteAddress || "local"}`;
    const accountKey = `account:${tokenHash(email).slice(0, 24)}`;
    if (loginBlocked(ipKey) || loginBlocked(accountKey)) return json(res, 429, { error: "Muitas tentativas. Aguarde 15 minutos." });
    const password = String(input.password || "");
    const user = db.prepare("SELECT * FROM users WHERE lower(email)=? AND status='Ativo'").get(email);
    if (!user || !passwordMatches(password, user.password_hash)) {
      registerFailure(ipKey);
      registerFailure(accountKey);
      audit(req, user ? { user: { id: user.id, organization_id: user.organization_id } } : null, "login_failed", "session");
      return json(res, 401, { error: "E-mail ou senha incorretos." });
    }
    loginAttempts.delete(ipKey);
    loginAttempts.delete(accountKey);
    if (!String(user.password_hash).startsWith("scrypt$")) db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(passwordHash(password), user.id);
    const token = crypto.randomBytes(32).toString("hex");
    const csrfToken = crypto.randomBytes(24).toString("hex");
    const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    db.prepare(`INSERT INTO sessions (token_hash,user_id,organization_id,csrf_token,created_at,expires_at,ip,user_agent)
      VALUES (?,?,?,?,?,?,?,?)`).run(tokenHash(token), user.id, user.organization_id, csrfToken, now(), expires,
      req.socket.remoteAddress || "", String(req.headers["user-agent"] || "").slice(0, 300));
    const safeUser = { id: user.id, name: user.name, email: user.email, company_name: user.company_name, role: user.role, organization_id: user.organization_id };
    audit(req, { user: safeUser }, "login", "session");
    return json(res, 200, { user: safeUser, csrfToken }, { "Set-Cookie": sessionCookie(token) });
  }

  const session = getSession(req);
  if (!session) return json(res, 401, { error: "Sessão necessária." });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !safeEqual(req.headers["x-csrf-token"] || "", session.csrfToken)) {
    return json(res, 403, { error: "Proteção de sessão inválida. Recarregue a página." });
  }
  const org = session.user.organization_id;

  if (req.method === "POST" && url.pathname === "/api/logout") {
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(session.token));
    audit(req, session, "logout", "session");
    return json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
  }
  if (req.method === "GET" && url.pathname === "/api/me") return json(res, 200, { user: session.user, csrfToken: session.csrfToken });
  if (req.method === "GET" && url.pathname === "/api/data") return json(res, 200, listAll(org));
  if (req.method === "GET" && url.pathname === "/api/backup") {
    requireRole(session, ["Administrador"]);
    audit(req, session, "export", "backup");
    return json(res, 200, { exportedAt: now(), version: 2, organization: { id: org, name: session.user.organization_name }, ...listAll(org) });
  }
  if (req.method === "GET" && url.pathname === "/api/audit") {
    requireRole(session, ["Administrador"]);
    return json(res, 200, { logs: db.prepare("SELECT * FROM audit_logs WHERE organization_id=? ORDER BY created_at DESC LIMIT 250").all(org) });
  }

  if (req.method === "POST" && url.pathname === "/api/customers") {
    requireRole(session, ["Administrador", "Gestor"]);
    const d = await requestBody(req);
    const record = { id: makeId("c"), name: textValue(d.name, "Nome", 160, true), phone: textValue(d.phone, "Telefone", 30), email: emailValue(d.email), city: textValue(d.city, "Cidade", 100), type: textValue(d.type || "Comercial", "Tipo", 40), notes: textValue(d.notes, "Observações", 2000), created_at: now(), organization_id: org };
    db.prepare(`INSERT INTO customers (id,name,phone,email,city,type,notes,created_at,organization_id) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(record.id, record.name, record.phone, record.email, record.city, record.type, record.notes, record.created_at, org);
    audit(req, session, "create", "customer", record.id);
    return json(res, 201, record);
  }
  if (req.method === "PUT" && /^\/api\/customers\/[\w-]+$/.test(url.pathname)) {
    requireRole(session, ["Administrador", "Gestor"]);
    const customerId = entityId(url);
    if (!owned("customers", customerId, org)) return json(res, 404, { error: "Cliente não encontrado." });
    const d = await requestBody(req);
    const data = [textValue(d.name, "Nome", 160, true), textValue(d.phone, "Telefone", 30), emailValue(d.email), textValue(d.city, "Cidade", 100), textValue(d.type, "Tipo", 40, true), textValue(d.notes, "Observações", 2000)];
    db.prepare("UPDATE customers SET name=?,phone=?,email=?,city=?,type=?,notes=? WHERE id=? AND organization_id=?").run(...data, customerId, org);
    audit(req, session, "update", "customer", customerId);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/equipment") {
    requireRole(session, ["Administrador", "Gestor", "Técnico"]);
    const d = await requestBody(req);
    const customer = assertRelated("customers", d.customer_id, org, "Cliente");
    const record = { id: makeId("e"), customer_id: customer.id, kind: textValue(d.kind, "Tipo", 80, true), brand: textValue(d.brand, "Marca", 80), model: textValue(d.model, "Modelo", 100), serial: textValue(d.serial, "Número de série", 100), location: textValue(d.location, "Local", 120), last_service: "", created_at: now(), organization_id: org };
    db.prepare(`INSERT INTO equipment (id,customer_id,kind,brand,model,serial,location,last_service,created_at,organization_id) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(record.id, record.customer_id, record.kind, record.brand, record.model, record.serial, record.location, "", record.created_at, org);
    audit(req, session, "create", "equipment", record.id);
    return json(res, 201, record);
  }
  if (req.method === "POST" && url.pathname === "/api/orders") {
    requireRole(session, ["Administrador", "Gestor"]);
    const d = await requestBody(req);
    const customer = assertRelated("customers", d.customer_id, org, "Cliente");
    const equipment = assertRelated("equipment", d.equipment_id, org, "Equipamento", true);
    if (equipment && equipment.customer_id !== customer.id) throw Object.assign(new Error("Equipamento não pertence ao cliente."), { status: 400 });
    const record = { id: makeId("os"), customer_id: customer.id, equipment_id: equipment?.id || null, service: textValue(d.service, "Serviço", 180, true), scheduled_date: dateValue(d.scheduled_date, "Data"), status: "Agendado", technician: textValue(d.technician, "Técnico", 120), value: numberValue(d.value, "Valor"), created_at: now(), organization_id: org };
    db.prepare(`INSERT INTO service_orders (id,customer_id,equipment_id,service,scheduled_date,status,technician,value,created_at,organization_id) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(record.id, record.customer_id, record.equipment_id, record.service, record.scheduled_date, record.status, record.technician, record.value, record.created_at, org);
    audit(req, session, "create", "order", record.id);
    return json(res, 201, record);
  }
  if (req.method === "POST" && /^\/api\/orders\/[\w-]+\/start$/.test(url.pathname)) {
    requireRole(session, ["Administrador", "Gestor", "Técnico"]);
    const orderId = entityId(url, -2);
    if (!owned("service_orders", orderId, org)) return json(res, 404, { error: "Atendimento não encontrado." });
    db.prepare("UPDATE service_orders SET status='Em campo' WHERE id=? AND organization_id=? AND status!='Concluído'").run(orderId, org);
    audit(req, session, "start", "order", orderId);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && /^\/api\/orders\/[\w-]+\/complete$/.test(url.pathname)) {
    requireRole(session, ["Administrador", "Gestor", "Técnico"]);
    const orderId = entityId(url, -2);
    const order = owned("service_orders", orderId, org);
    if (!order) return json(res, 404, { error: "Atendimento não encontrado." });
    if (order.status === "Concluído") return json(res, 409, { error: "Atendimento já concluído." });
    const d = await requestBody(req);
    const checklist = Array.isArray(d.checklist) ? d.checklist.slice(0, 30).map(item => textValue(item, "Checklist", 160)).filter(Boolean) : [];
    if (d.photos !== undefined && !Array.isArray(d.photos)) throw Object.assign(new Error("Lista de fotos inválida."), { status: 400 });
    if ((d.photos || []).length > 6) throw Object.assign(new Error("O limite é de 6 fotos por atendimento."), { status: 400 });
    const photos = [];
    for (const [index, photo] of (d.photos || []).entries()) photos.push(await normalizeImageDataUrl(photo, `Foto ${index + 1}`, MAX_PHOTO_BYTES, MAX_PHOTO_PIXELS, 1600, "webp", ["webp", "jpeg", "png"]));
    const signature = await normalizeImageDataUrl(d.signature, "Assinatura", MAX_SIGNATURE_BYTES, MAX_SIGNATURE_PIXELS, 1000, "png", ["png"]);
    const warrantyDays = numberValue(d.warranty_days, "Garantia", 0, 3650);
    const completed = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE service_orders SET status='Concluído',notes=?,checklist_json=?,photos_json=?,signature=?,completed_at=? WHERE id=? AND organization_id=?`)
        .run(textValue(d.notes, "Observações", 4000), JSON.stringify(checklist), JSON.stringify(photos), signature, completed, orderId, org);
      if (order.equipment_id) db.prepare("UPDATE equipment SET last_service=? WHERE id=? AND organization_id=?").run(order.scheduled_date, order.equipment_id, org);
      if (warrantyDays) db.prepare(`INSERT INTO warranties (id,customer_id,order_id,start_date,end_date,status,organization_id) VALUES (?,?,?,?,?,'Ativa',?)`)
        .run(makeId("g"), order.customer_id, orderId, order.scheduled_date, addDays(order.scheduled_date, warrantyDays), org);
      db.prepare("INSERT INTO reports (id,order_id,created_at,summary,organization_id) VALUES (?,?,?,?,?)")
        .run(makeId("la"), orderId, today(), textValue(d.notes, "Resumo", 4000) || "Serviço concluído e validado com o cliente.", org);
      if (d.next_date) db.prepare(`INSERT INTO maintenance_returns (id,customer_id,equipment_id,service,due_date,estimated_value,status,source_order_id,organization_id) VALUES (?,?,?,?,?,?,'Próximo',?,?)`)
        .run(makeId("r"), order.customer_id, order.equipment_id || null, textValue(d.next_service || "Manutenção preventiva", "Próximo serviço", 180), dateValue(d.next_date, "Próxima data"), numberValue(d.estimated_value || order.value, "Valor estimado"), orderId, org);
      if (d.return_id) db.prepare("UPDATE maintenance_returns SET status='Convertido' WHERE id=? AND organization_id=?").run(textValue(d.return_id, "Retorno", 80), org);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    audit(req, session, "complete", "order", orderId, { photos: photos.length, warrantyDays });
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/returns") {
    requireRole(session, ["Administrador", "Gestor"]);
    const d = await requestBody(req);
    const customer = assertRelated("customers", d.customer_id, org, "Cliente");
    const equipment = assertRelated("equipment", d.equipment_id, org, "Equipamento", true);
    const due = dateValue(d.due_date, "Data prevista");
    const record = { id: makeId("r"), customer_id: customer.id, equipment_id: equipment?.id || null, service: textValue(d.service, "Serviço", 180, true), due_date: due, estimated_value: numberValue(d.estimated_value, "Valor estimado"), status: due < today() ? "Vencido" : "Próximo", source_order_id: null, organization_id: org };
    db.prepare(`INSERT INTO maintenance_returns (id,customer_id,equipment_id,service,due_date,estimated_value,status,source_order_id,organization_id) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(record.id, record.customer_id, record.equipment_id, record.service, record.due_date, record.estimated_value, record.status, null, org);
    audit(req, session, "create", "return", record.id);
    return json(res, 201, record);
  }
  const contactMatch = url.pathname.match(/^\/api\/returns\/([\w-]+)\/contacts$/);
  if (req.method === "POST" && contactMatch) {
    requireRole(session, ["Administrador", "Gestor"]);
    const returnId = textValue(contactMatch[1], "Retorno", 80, true);
    const ret = owned("maintenance_returns", returnId, org);
    if (!ret) return json(res, 404, { error: "Retorno não encontrado." });
    if (["Convertido", "Cancelado", "Não contatar"].includes(ret.status)) return json(res, 409, { error: "Este retorno não aceita novos contatos." });
    const d = await requestBody(req);
    const allowed = ["Contatado", "Respondeu", "Sem interesse", "Número inválido", "Não contatar"];
    const outcome = textValue(d.outcome, "Resultado", 40, true);
    if (!allowed.includes(outcome)) throw Object.assign(new Error("Resultado de contato inválido."), { status: 400 });
    const followUp = d.follow_up_date ? dateValue(d.follow_up_date, "Próxima ação") : "";
    const note = textValue(d.note || "", "Observação", 500);
    const createdAt = now();
    const attempt = { id: makeId("ct"), organization_id: org, return_id: returnId, user_id: session.user.id, outcome, note, follow_up_date: followUp, created_at: createdAt };
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO contact_attempts (id,organization_id,return_id,user_id,outcome,note,follow_up_date,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(attempt.id, org, returnId, attempt.user_id, outcome, note, followUp, createdAt);
      db.prepare("UPDATE maintenance_returns SET status=?,last_contacted_at=?,next_action_date=? WHERE id=? AND organization_id=?")
        .run(outcome, createdAt, followUp, returnId, org);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    audit(req, session, "contact", "return", returnId, { outcome, followUp: Boolean(followUp) });
    return json(res, 201, attempt);
  }
  if (req.method === "POST" && /^\/api\/returns\/[\w-]+\/convert$/.test(url.pathname)) {
    requireRole(session, ["Administrador", "Gestor"]);
    const returnId = entityId(url, -2);
    const ret = owned("maintenance_returns", returnId, org);
    if (!ret) return json(res, 404, { error: "Retorno não encontrado." });
    if (["Convertido", "Cancelado", "Sem interesse", "Número inválido", "Não contatar"].includes(ret.status)) return json(res, 409, { error: "Este retorno não pode ser convertido em ordem." });
    const order = { id: makeId("os"), scheduled_date: today(), technician: "A definir" };
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO service_orders (id,customer_id,equipment_id,service,scheduled_date,status,technician,value,created_at,organization_id) VALUES (?,?,?,?,?,'Agendado',?,?,?,?)`)
        .run(order.id, ret.customer_id, ret.equipment_id, ret.service, order.scheduled_date, order.technician, ret.estimated_value, now(), org);
      db.prepare("UPDATE maintenance_returns SET status='Convertido',converted_order_id=? WHERE id=? AND organization_id=?").run(order.id, returnId, org);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    audit(req, session, "convert", "return", returnId, { orderId: order.id });
    return json(res, 201, order);
  }
  if (req.method === "PUT" && url.pathname === "/api/settings") {
    requireRole(session, ["Administrador"]);
    const d = await requestBody(req);
    const settings = { name: textValue(d.name, "Empresa", 160, true), phone: textValue(d.phone, "Telefone", 30), city: textValue(d.city, "Cidade", 100), warrantyDefault: numberValue(d.warrantyDefault, "Garantia padrão", 0, 3650) };
    db.prepare(`INSERT INTO organization_settings (organization_id,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(organization_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(org, JSON.stringify(settings), now());
    audit(req, session, "update", "settings", org);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/reset") {
    requireRole(session, ["Administrador"]);
    if (!ALLOW_DEMO_RESET) return json(res, 403, { error: "Restauração de demonstração desativada." });
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["reports", "maintenance_returns", "warranties", "service_orders", "equipment", "customers"]) db.prepare(`DELETE FROM ${table} WHERE organization_id=?`).run(org);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    seed();
    audit(req, session, "reset", "organization", org);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "Rota não encontrada." });
}

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
function staticFile(req, res, url) {
  let relative;
  try { relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)); }
  catch { return json(res, 400, { error: "Caminho inválido." }); }
  const file = path.resolve(PUBLIC, relative);
  const relation = path.relative(PUBLIC, file);
  if (relation.startsWith("..") || path.isAbsolute(relation) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    securityHeaders(res);
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    return res.end("Arquivo não encontrado");
  }
  securityHeaders(res);
  res.writeHead(200, { "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": path.extname(file) === ".html" ? "no-cache" : "public, max-age=3600" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`); }
  catch { return json(res, 400, { error: "URL inválida." }); }
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    return staticFile(req, res, url);
  } catch (error) {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error("[Naxel Care]", error);
    return json(res, status, { error: status >= 500 ? "Erro interno. Tente novamente." : error.message });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`Naxel Care disponível em http://${HOST}:${PORT}`));
}

function shutdown() {
  try { server.close(); } catch {}
  try { db.close(); } catch {}
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

module.exports = { server, db, passwordHash, passwordMatches };
