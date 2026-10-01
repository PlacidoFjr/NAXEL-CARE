"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const sharp = require("sharp");

const project = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "naxel-care-test-"));
const database = path.join(temporary, "test.sqlite");
const port = 54000 + Math.floor(Math.random() * 9000);
const base = `http://127.0.0.1:${port}`;
const testDemoPassword = crypto.randomBytes(32).toString("base64url");
let child;
let childOutput = "";

function request(url, options = {}) {
  return fetch(`${base}${url}`, options);
}

async function waitUntilReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await request("/");
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Servidor de teste não iniciou. ${childOutput}`);
}

test.before(async () => {
  child = spawn(process.execPath, ["server-secure.js"], {
    cwd: project,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NAXEL_DB_PATH: database, NODE_ENV: "test", NAXEL_ALLOW_DEMO_RESET: "false", NAXEL_DEMO_PASSWORD: testDemoPassword },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => childOutput += chunk.toString());
  child.stderr.on("data", chunk => childOutput += chunk.toString());
  await waitUntilReady();
});

test.after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 150));
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("aplica cabeçalhos de segurança e exige autenticação", async () => {
  const page = await request("/");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(page.headers.get("content-security-policy"), /img-src 'self' data: blob:/);
  const data = await request("/api/data");
  assert.equal(data.status, 401);
});

test("login, sessão persistente e CSRF protegem mutações", async () => {
  const denied = await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@naxel.local", password: "errada" }) });
  assert.equal(denied.status, 401);

  const login = await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@naxel.local", password: testDemoPassword }) });
  assert.equal(login.status, 200);
  const payload = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.ok(payload.csrfToken);

  const me = await request("/api/me", { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);

  const withoutCsrf = await request("/api/customers", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Cliente teste" }) });
  assert.equal(withoutCsrf.status, 403);

  const created = await request("/api/customers", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": payload.csrfToken }, body: JSON.stringify({ name: "Cliente teste", city: "Salvador" }) });
  assert.equal(created.status, 201);

  const backup = await request("/api/backup", { headers: { Cookie: cookie } });
  assert.equal(backup.status, 200);
  const backupData = await backup.json();
  assert.equal(backupData.version, 2);
  assert.ok(backupData.customers.some(customer => customer.name === "Cliente teste"));
});

test("isola empresas e aplica permissão por função", async () => {
  const sql = new DatabaseSync(database);
  const createdAt = new Date().toISOString();
  const hash = crypto.createHash("sha256").update("teste123").digest("hex");
  sql.prepare("INSERT INTO organizations (id,name,slug,status,created_at) VALUES (?,?,?,?,?)").run("org_test", "Outra Empresa", "outra", "Ativa", createdAt);
  sql.prepare("INSERT INTO users (id,name,email,password_hash,company_name,role,organization_id,status) VALUES (?,?,?,?,?,?,?,'Ativo')")
    .run("u_test", "Técnico Teste", "tecnico@teste.local", hash, "Outra Empresa", "Técnico", "org_test");
  sql.prepare("INSERT INTO organization_settings (organization_id,value,updated_at) VALUES (?,?,?)").run("org_test", "{}", createdAt);
  sql.close();

  const login = await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "tecnico@teste.local", password: "teste123" }) });
  assert.equal(login.status, 200);
  const payload = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const data = await request("/api/data", { headers: { Cookie: cookie } });
  const isolated = await data.json();
  assert.equal(isolated.customers.length, 0);

  const forbidden = await request("/api/customers", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": payload.csrfToken }, body: JSON.stringify({ name: "Não permitido" }) });
  assert.equal(forbidden.status, 403);
  const backup = await request("/api/backup", { headers: { Cookie: cookie } });
  assert.equal(backup.status, 403);
});

test("valida, normaliza e limita fotos no servidor", async () => {
  const login = await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@naxel.local", password: testDemoPassword }) });
  const auth = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const headers = { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": auth.csrfToken };
  const complete = photos => request("/api/orders/os_1048/complete", { method: "POST", headers, body: JSON.stringify({ notes: "Teste isolado de evidências", photos, signature: "", warranty_days: 0 }) });

  assert.equal((await complete(["data:image/png;base64,iVBORw0KGgo="])).status, 400);
  assert.equal((await complete(["data:image/svg+xml;base64,PHN2Zy8+"])).status, 400);
  assert.equal((await complete(Array(7).fill("data:image/png;base64,iVBORw0KGgo="))).status, 400);
  const oversized = Buffer.alloc(750 * 1024 + 1);
  Buffer.from("89504e470d0a1a0a", "hex").copy(oversized);
  assert.equal((await complete([`data:image/png;base64,${oversized.toString("base64")}`])).status, 413);

  const validPng = await sharp({ create: { width: 12, height: 9, channels: 4, background: { r: 40, g: 90, b: 140, alpha: 1 } } }).png().toBuffer();
  const saved = await complete([`data:image/png;base64,${validPng.toString("base64")}`]);
  assert.equal(saved.status, 200);
  const state = await request("/api/data", { headers: { Cookie: cookie } }).then(response => response.json());
  const stored = state.orders.find(item => item.id === "os_1048").photos[0];
  assert.match(stored, /^data:image\/webp;base64,/);
  assert.equal((await sharp(Buffer.from(stored.split(",")[1], "base64")).metadata()).format, "webp");
});

test("Central de Retorno registra tentativas, respeita bloqueios e vincula a OS", async () => {
  const login = await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@naxel.local", password: testDemoPassword }) });
  assert.equal(login.status, 200);
  const auth = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const headers = { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": auth.csrfToken };
  const createReturn = async () => {
    const response = await request("/api/returns", { method: "POST", headers, body: JSON.stringify({ customer_id: "c_mare", equipment_id: "e_daikin", service: "Manutenção preventiva de teste", due_date: "2099-01-10", estimated_value: 500 }) });
    assert.equal(response.status, 201);
    return response.json();
  };

  const first = await createReturn();
  const noCsrf = await request(`/api/returns/${first.id}/contacts`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ outcome: "Contatado" }) });
  assert.equal(noCsrf.status, 403);
  const invalidOutcome = await request(`/api/returns/${first.id}/contacts`, { method: "POST", headers, body: JSON.stringify({ outcome: "Disparado automaticamente" }) });
  assert.equal(invalidOutcome.status, 400);

  const contact = await request(`/api/returns/${first.id}/contacts`, { method: "POST", headers, body: JSON.stringify({ outcome: "Contatado", note: "Pediu retorno em janeiro", follow_up_date: "2099-01-12" }) });
  assert.equal(contact.status, 201);
  const contactData = await contact.json();
  assert.equal(contactData.outcome, "Contatado");
  const afterContact = await request("/api/data", { headers: { Cookie: cookie } }).then(response => response.json());
  const savedReturn = afterContact.returns.find(item => item.id === first.id);
  assert.equal(savedReturn.status, "Contatado");
  assert.equal(savedReturn.next_action_date, "2099-01-12");
  assert.equal(afterContact.contactAttempts.filter(item => item.return_id === first.id).length, 1);

  const suppressed = await request(`/api/returns/${first.id}/contacts`, { method: "POST", headers, body: JSON.stringify({ outcome: "Não contatar" }) });
  assert.equal(suppressed.status, 201);
  const blockedContact = await request(`/api/returns/${first.id}/contacts`, { method: "POST", headers, body: JSON.stringify({ outcome: "Contatado" }) });
  assert.equal(blockedContact.status, 409);
  const blockedConversion = await request(`/api/returns/${first.id}/convert`, { method: "POST", headers, body: "{}" });
  assert.equal(blockedConversion.status, 409);

  const second = await createReturn();
  const converted = await request(`/api/returns/${second.id}/convert`, { method: "POST", headers, body: "{}" });
  assert.equal(converted.status, 201);
  const order = await converted.json();
  const afterConvert = await request("/api/data", { headers: { Cookie: cookie } }).then(response => response.json());
  assert.equal(afterConvert.returns.find(item => item.id === second.id).converted_order_id, order.id);
  assert.equal((await request(`/api/returns/${second.id}/convert`, { method: "POST", headers, body: "{}" })).status, 409);

  const sql = new DatabaseSync(database);
  const createdAt = new Date().toISOString();
  const hash = crypto.createHash("sha256").update("teste123").digest("hex");
  sql.prepare("INSERT INTO organizations (id,name,slug,status,created_at) VALUES (?,?,?,?,?)").run("org_central", "Outra Empresa", "central-outra", "Ativa", createdAt);
  sql.prepare("INSERT INTO users (id,name,email,password_hash,company_name,role,organization_id,status) VALUES (?,?,?,?,?,?,?,'Ativo')")
    .run("u_central", "Gestor Teste", "gestor-central@teste.local", hash, "Outra Empresa", "Gestor", "org_central");
  sql.prepare("INSERT INTO organization_settings (organization_id,value,updated_at) VALUES (?,?,?)").run("org_central", "{}", createdAt);
  sql.close();
  const otherLogin = await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "gestor-central@teste.local", password: "teste123" }) });
  assert.equal(otherLogin.status, 200);
  const otherAuth = await otherLogin.json();
  const otherCookie = otherLogin.headers.get("set-cookie").split(";")[0];
  const crossTenantContact = await request(`/api/returns/${first.id}/contacts`, {
    method: "POST",
    headers: { Cookie: otherCookie, "Content-Type": "application/json", "X-CSRF-Token": otherAuth.csrfToken },
    body: JSON.stringify({ outcome: "Contatado" }),
  });
  assert.equal(crossTenantContact.status, 404);
});
