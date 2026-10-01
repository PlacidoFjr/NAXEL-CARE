import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { randomUUID, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/*" };

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PHOTO_LIMIT = 750 * 1024;
const SIGNATURE_LIMIT = 250 * 1024;
const PHOTO_PIXELS = 40_000_000;
const SIGNATURE_PIXELS = 2_000_000;
const PHOTO_BUCKET = "service-evidence";
const COOKIE_NAMES = ["naxel_access", "naxel_refresh", "naxel_csrf"];

function json(status, data, headers = {}) {
  const responseHeaders = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  if (headers instanceof Headers) {
    for (const [name, value] of headers) if (name.toLowerCase() !== "set-cookie") responseHeaders.set(name, value);
    for (const value of headers.getSetCookie?.() || []) responseHeaders.append("Set-Cookie", value);
  } else {
    for (const [name, value] of Object.entries(headers)) responseHeaders.set(name, value);
  }
  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders,
  });
}

function parseCookies(header = "") {
  return Object.fromEntries(String(header || "").split(";").map(part => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    try { return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]; }
    catch { return [part.slice(0, index).trim(), ""]; }
  }).filter(([key]) => key));
}

function cookie(name, value, maxAge) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function sessionHeaders(session, csrf = "") {
  const headers = new Headers();
  if (session?.access_token && session?.refresh_token) {
    headers.append("Set-Cookie", cookie("naxel_access", session.access_token, 3600));
    headers.append("Set-Cookie", cookie("naxel_refresh", session.refresh_token, 60 * 60 * 24 * 30));
  }
  if (csrf) headers.append("Set-Cookie", cookie("naxel_csrf", csrf, 60 * 60 * 24 * 30));
  return headers;
}

function clearSessionHeaders() {
  const headers = new Headers();
  for (const name of COOKIE_NAMES) headers.append("Set-Cookie", cookie(name, "", 0));
  return headers;
}

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) throw httpError(413, "Solicitação muito grande.");
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) throw httpError(413, "Solicitação muito grande.");
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw httpError(400, "Dados inválidos."); }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function text(value, label, max = 160, required = false) {
  const result = String(value ?? "").trim();
  if (required && !result) throw httpError(400, `${label} é obrigatório.`);
  if (result.length > max) throw httpError(400, `${label} excede o limite permitido.`);
  return result;
}

function email(value) {
  const result = text(value, "E-mail", 254).toLowerCase();
  if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw httpError(400, "E-mail inválido.");
  return result;
}

function dateValue(value, label, required = true) {
  const result = text(value, label, 10, required);
  if (result && !/^\d{4}-\d{2}-\d{2}$/.test(result)) throw httpError(400, `${label} inválida.`);
  return result || null;
}

function numberValue(value, label, max = 10_000_000) {
  const result = Number(value || 0);
  if (!Number.isFinite(result) || result < 0 || result > max) throw httpError(400, `${label} inválido.`);
  return Math.round(result * 100) / 100;
}

function userClient(accessToken = "") {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw httpError(503, "A conexão segura com o banco ainda não foi configurada.");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {},
  });
}

async function membership(client, userId) {
  const { data, error } = await client.from("org_members")
    .select("organization_id, role, status")
    .eq("user_id", userId).eq("status", "Ativo");
  if (error) throw httpError(503, "Não foi possível validar o acesso à empresa.");
  if (data.length !== 1) throw httpError(403, "Conta sem vínculo ativo ou com mais de uma empresa. Peça ao administrador para revisar o acesso.");
  return data[0];
}

async function sessionContext(request) {
  const cookies = parseCookies(request.headers.get("cookie"));
  if (!cookies.naxel_access && !cookies.naxel_refresh) throw httpError(401, "Sessão necessária.");
  const client = userClient(cookies.naxel_access);
  let accessToken = cookies.naxel_access;
  let refreshToken = cookies.naxel_refresh;
  let rotated = null;
  let { data: result, error } = await client.auth.getUser(accessToken || undefined);
  if (error && refreshToken) {
    const refreshClient = userClient();
    const refreshed = await refreshClient.auth.refreshSession({ refresh_token: refreshToken });
    if (!refreshed.error && refreshed.data.session) {
      rotated = refreshed.data.session;
      accessToken = rotated.access_token;
      refreshToken = rotated.refresh_token;
      result = await refreshClient.auth.getUser(accessToken);
      error = result.error;
      result = result.data;
    }
  }
  if (error || !result?.user) throw httpError(401, "Sessão necessária.");
  const authenticated = userClient(accessToken);
  const { data: profile, error: profileError } = await authenticated.from("profiles")
    .select("id,name,email,status").eq("id", result.user.id).maybeSingle();
  if (profileError || !profile || profile.status !== "Ativo") throw httpError(401, "Conta inativa ou não configurada.");
  const member = await membership(authenticated, result.user.id);
  const { data: org, error: orgError } = await authenticated.from("organizations")
    .select("id,name,status").eq("id", member.organization_id).maybeSingle();
  if (orgError || !org || org.status !== "Ativa") throw httpError(403, "Empresa inativa ou não configurada.");
  return {
    client: authenticated,
    user: { id: profile.id, name: profile.name, email: profile.email, company_name: org.name, role: member.role, organization_id: org.id, organization_name: org.name },
    csrf: cookies.naxel_csrf,
    rotated,
    accessToken,
    refreshToken,
  };
}

function requireRole(user, roles) {
  if (!roles.includes(user.role)) throw httpError(403, "Você não tem permissão para esta ação.");
}

function requireSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw httpError(403, "Origem da solicitação não permitida.");
}

function requireCsrf(request, context) {
  requireSameOrigin(request);
  if (!equalSecret(request.headers.get("x-csrf-token"), context.csrf)) throw httpError(403, "Proteção de sessão inválida. Recarregue a página.");
}

function safeError(error, requestId) {
  const status = Number(error.status) || 500;
  if (status >= 500) console.error(JSON.stringify({ event: "api.failure", requestId, code: error.code || `http_${status}`, type: error.name || "Error" }));
  return json(status, { error: status >= 500 && status !== 503 ? "Não foi possível concluir a operação." : error.message });
}

async function getUserView(client, authUser, member) {
  const [{ data: profile }, { data: org }] = await Promise.all([
    client.from("profiles").select("name,email,status").eq("id", authUser.id).maybeSingle(),
    client.from("organizations").select("name,status").eq("id", member.organization_id).maybeSingle(),
  ]);
  if (!profile || profile.status !== "Ativo" || !org || org.status !== "Ativa") throw httpError(403, "Conta ou empresa inativa.");
  return { id: authUser.id, name: profile.name, email: profile.email, company_name: org.name, role: member.role, organization_id: member.organization_id, organization_name: org.name };
}

async function signObject(client, path) {
  if (!path) return "";
  const { data, error } = await client.storage.from(PHOTO_BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) throw httpError(503, "Não foi possível acessar uma evidência do atendimento.");
  return data.signedUrl;
}

async function listAll(client, orgId) {
  const tables = ["customers", "equipment", "service_orders", "warranties", "maintenance_returns", "reports", "contact_attempts"];
  const results = await Promise.all(tables.map(table => client.from(table).select("*").eq("organization_id", orgId)));
  const failure = results.find(result => result.error);
  if (failure) throw httpError(503, "Não foi possível carregar os dados da empresa.");
  const [customers, equipment, rawOrders, warranties, returns, reports, contactAttempts] = results.map(result => result.data || []);
  const orders = await Promise.all(rawOrders.map(async row => ({
    ...row,
    checklist: row.checklist_json || [],
    photos: await Promise.all((row.photos_json || []).map(async path => ({ path, url: await signObject(client, path) }))),
    signature: await signObject(client, row.signature_path),
  })));
  const { data: setting } = await client.from("organization_settings").select("value").eq("organization_id", orgId).maybeSingle();
  return { customers, equipment, orders, warranties, returns, contactAttempts, reports, settings: setting?.value || {} };
}

async function normalizedImage(dataUrl, label, maxBytes, maxPixels, maxDimension, outputFormat, accepted) {
  const match = String(dataUrl || "").match(/^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw httpError(400, `${label} inválida.`);
  const input = Buffer.from(match[2], "base64");
  if (!input.length || input.length > maxBytes || input.toString("base64") !== match[2]) throw httpError(input.length > maxBytes ? 413 : 400, `${label} inválida ou acima do limite.`);
  try {
    const options = { failOn: "warning", limitInputPixels: maxPixels, animated: false };
    const metadata = await sharp(input, options).metadata();
    if (!accepted.includes(metadata.format) || metadata.format !== match[1] || !metadata.width || !metadata.height || (metadata.pages || 1) > 1) throw httpError(400, `${label} não é uma imagem estática válida.`);
    let pipeline = sharp(input, options).rotate().resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true });
    pipeline = outputFormat === "webp" ? pipeline.flatten({ background: "#fff" }).webp({ quality: 78, effort: 4 }) : pipeline.png({ compressionLevel: 9 });
    const output = await pipeline.toBuffer();
    if (output.length > maxBytes) throw httpError(413, `${label} excede o limite após otimização.`);
    return output;
  } catch (error) {
    if (error.status) throw error;
    throw httpError(400, `${label} não pôde ser validada como imagem.`);
  }
}

async function uploadObject(client, orgId, orderId, buffer, kind) {
  const extension = kind === "signature" ? "png" : "webp";
  const path = `${orgId}/${orderId}/${kind}-${randomUUID()}.${extension}`;
  const { error } = await client.storage.from(PHOTO_BUCKET).upload(path, buffer, {
    contentType: kind === "signature" ? "image/png" : "image/webp", upsert: false,
  });
  if (error) throw httpError(503, "Não foi possível salvar a evidência. Verifique a conexão e tente novamente.");
  return path;
}

async function login(request) {
  const body = await readJson(request, 32 * 1024);
  const address = email(body.email);
  const password = String(body.password || "");
  if (!address || password.length < 1 || password.length > 1024) throw httpError(400, "Informe e-mail e senha.");
  const client = userClient();
  const { data, error } = await client.auth.signInWithPassword({ email: address, password });
  if (error || !data.user || !data.session) throw httpError(401, "E-mail ou senha incorretos.");
  const member = await membership(client, data.user.id);
  const user = await getUserView(client, data.user, member);
  const csrf = randomUUID();
  return json(200, { user, csrfToken: csrf }, sessionHeaders(data.session, csrf));
}

async function authenticatedRequest(request, pathname) {
  const ctx = await sessionContext(request);
  const { client, user } = ctx;
  if (request.method === "GET" && pathname === "/api/me") return json(200, { user, csrfToken: ctx.csrf }, sessionHeaders(ctx.rotated));
  if (!(["GET", "HEAD", "OPTIONS"].includes(request.method))) requireCsrf(request, ctx);
  if (request.method === "POST" && pathname === "/api/logout") {
    await client.auth.setSession({ access_token: ctx.accessToken, refresh_token: ctx.refreshToken });
    await client.auth.signOut({ scope: "local" });
    return json(200, { ok: true }, clearSessionHeaders());
  }
  if (request.method === "GET" && pathname === "/api/data") return json(200, await listAll(client, user.organization_id), sessionHeaders(ctx.rotated));
  if (request.method === "GET" && pathname === "/api/backup") {
    requireRole(user, ["Administrador"]);
    return json(200, { exportedAt: new Date().toISOString(), version: 3, organization: { id: user.organization_id, name: user.organization_name }, ...await listAll(client, user.organization_id) }, sessionHeaders(ctx.rotated));
  }
  if (request.method === "GET" && pathname === "/api/audit") {
    requireRole(user, ["Administrador"]);
    const { data, error } = await client.from("audit_logs").select("*").eq("organization_id", user.organization_id).order("created_at", { ascending: false }).limit(250);
    if (error) throw httpError(503, "Não foi possível carregar o histórico de auditoria.");
    return json(200, { logs: data }, sessionHeaders(ctx.rotated));
  }
  const response = await mutateRequest(request, pathname, ctx);
  if (ctx.rotated) {
    response.headers.append("Set-Cookie", cookie("naxel_access", ctx.rotated.access_token, 3600));
    response.headers.append("Set-Cookie", cookie("naxel_refresh", ctx.rotated.refresh_token, 60 * 60 * 24 * 30));
  }
  return response;
}

async function insertRecord(client, table, record) {
  const { data, error } = await client.from(table).insert(record).select("*").single();
  if (error) throw httpError(error.code === "42501" ? 403 : 400, error.code === "42501" ? "Você não tem permissão para esta ação." : "Não foi possível salvar os dados informados.");
  return data;
}

async function mutateRequest(request, pathname, ctx) {
  const { client, user } = ctx;
  const org = user.organization_id;
  if (request.method === "POST" && pathname === "/api/customers") {
    requireRole(user, ["Administrador", "Gestor"]);
    const d = await readJson(request);
    return json(201, await insertRecord(client, "customers", { id: `c_${randomUUID().replaceAll("-", "")}`, organization_id: org, name: text(d.name, "Nome", 160, true), phone: text(d.phone, "Telefone", 30), email: email(d.email), city: text(d.city, "Cidade", 100), type: text(d.type || "Comercial", "Tipo", 40), notes: text(d.notes, "Observações", 2000) }));
  }
  const customerMatch = pathname.match(/^\/api\/customers\/([\w-]+)$/);
  if (request.method === "PUT" && customerMatch) return updateCustomer(request, customerMatch[1], ctx);
  if (request.method === "POST" && pathname === "/api/equipment") return createEquipment(request, ctx);
  if (request.method === "POST" && pathname === "/api/orders") return createOrder(request, ctx);
  const startMatch = pathname.match(/^\/api\/orders\/([\w-]+)\/start$/);
  if (request.method === "POST" && startMatch) return startOrder(startMatch[1], ctx);
  const uploadMatch = pathname.match(/^\/api\/orders\/([\w-]+)\/photos$/);
  if (request.method === "POST" && uploadMatch) return uploadPhoto(request, uploadMatch[1], ctx);
  const completeMatch = pathname.match(/^\/api\/orders\/([\w-]+)\/complete$/);
  if (request.method === "POST" && completeMatch) return completeOrder(request, completeMatch[1], ctx);
  if (request.method === "POST" && pathname === "/api/returns") return createReturn(request, ctx);
  const contactMatch = pathname.match(/^\/api\/returns\/([\w-]+)\/contacts$/);
  if (request.method === "POST" && contactMatch) return recordReturnContact(request, contactMatch[1], ctx);
  const convertMatch = pathname.match(/^\/api\/returns\/([\w-]+)\/convert$/);
  if (request.method === "POST" && convertMatch) return convertReturn(convertMatch[1], ctx);
  if (request.method === "PUT" && pathname === "/api/settings") return updateSettings(request, ctx);
  return json(404, { error: "Rota não encontrada." });
}

async function updateCustomer(request, id, ctx) {
  requireRole(ctx.user, ["Administrador", "Gestor"]);
  const d = await readJson(request);
  const changes = { name: text(d.name, "Nome", 160, true), phone: text(d.phone, "Telefone", 30), email: email(d.email), city: text(d.city, "Cidade", 100), type: text(d.type, "Tipo", 40, true), notes: text(d.notes, "Observações", 2000) };
  const { data, error } = await ctx.client.from("customers").update(changes).eq("organization_id", ctx.user.organization_id).eq("id", id).select("id");
  if (error) throw httpError(error.code === "42501" ? 403 : 400, "Não foi possível atualizar o cliente.");
  if (!data.length) throw httpError(404, "Cliente não encontrado.");
  return json(200, { ok: true });
}

async function createEquipment(request, ctx) {
  requireRole(ctx.user, ["Administrador", "Gestor", "Técnico"]);
  const d = await readJson(request);
  const customerId = text(d.customer_id, "Cliente", 80, true);
  const { data: customer, error } = await ctx.client.from("customers").select("id").eq("organization_id", ctx.user.organization_id).eq("id", customerId).maybeSingle();
  if (error || !customer) throw httpError(404, "Cliente não encontrado.");
  const record = { id: `e_${randomUUID().replaceAll("-", "")}`, organization_id: ctx.user.organization_id, customer_id: customerId, kind: text(d.kind, "Tipo", 80, true), brand: text(d.brand, "Marca", 80), model: text(d.model, "Modelo", 100), serial: text(d.serial, "Número de série", 100), location: text(d.location, "Local", 120) };
  return json(201, await insertRecord(ctx.client, "equipment", record));
}

async function createOrder(request, ctx) {
  requireRole(ctx.user, ["Administrador", "Gestor"]);
  const d = await readJson(request);
  const customerId = text(d.customer_id, "Cliente", 80, true);
  const equipmentId = text(d.equipment_id, "Equipamento", 80);
  const { data: customer } = await ctx.client.from("customers").select("id").eq("organization_id", ctx.user.organization_id).eq("id", customerId).maybeSingle();
  if (!customer) throw httpError(404, "Cliente não encontrado.");
  if (equipmentId) {
    const { data: equipment } = await ctx.client.from("equipment").select("id").eq("organization_id", ctx.user.organization_id).eq("id", equipmentId).eq("customer_id", customerId).maybeSingle();
    if (!equipment) throw httpError(400, "Equipamento não pertence ao cliente.");
  }
  const record = { id: `os_${randomUUID().replaceAll("-", "")}`, organization_id: ctx.user.organization_id, customer_id: customerId, equipment_id: equipmentId || null, service: text(d.service, "Serviço", 180, true), scheduled_date: dateValue(d.scheduled_date, "Data"), status: "Agendado", technician: text(d.technician, "Técnico", 120), value: numberValue(d.value, "Valor") };
  return json(201, await insertRecord(ctx.client, "service_orders", record));
}

async function startOrder(id, ctx) {
  requireRole(ctx.user, ["Administrador", "Gestor", "Técnico"]);
  const { data: order } = await ctx.client.from("service_orders").select("status").eq("organization_id", ctx.user.organization_id).eq("id", id).maybeSingle();
  if (!order) throw httpError(404, "Atendimento não encontrado.");
  if (order.status === "Concluído") throw httpError(409, "Atendimento já concluído.");
  const { error } = await ctx.client.from("service_orders").update({ status: "Em campo" }).eq("organization_id", ctx.user.organization_id).eq("id", id);
  if (error) throw httpError(400, "Não foi possível iniciar o atendimento.");
  return json(200, { ok: true });
}

async function ownedOrder(ctx, id) {
  const { data, error } = await ctx.client.from("service_orders").select("*").eq("organization_id", ctx.user.organization_id).eq("id", id).maybeSingle();
  if (error || !data) throw httpError(404, "Atendimento não encontrado.");
  return data;
}

async function uploadPhoto(request, id, ctx) {
  requireRole(ctx.user, ["Administrador", "Gestor", "Técnico"]);
  const order = await ownedOrder(ctx, id);
  if (order.status === "Concluído") throw httpError(409, "Atendimento já concluído.");
  const body = await readJson(request, 1_100_000);
  const image = await normalizedImage(body.dataUrl, "Foto", PHOTO_LIMIT, PHOTO_PIXELS, 1600, "webp", ["webp", "jpeg", "png"]);
  const path = await uploadObject(ctx.client, ctx.user.organization_id, id, image, "photo");
  const url = await signObject(ctx.client, path);
  return json(201, { path, url });
}

async function completeOrder(request, id, ctx) {
  requireRole(ctx.user, ["Administrador", "Gestor", "Técnico"]);
  const order = await ownedOrder(ctx, id);
  if (order.status === "Concluído") throw httpError(409, "Atendimento já concluído.");
  const d = await readJson(request, 1_200_000);
  const photos = Array.isArray(d.photos) ? d.photos : [];
  if (photos.length > 6 || (d.photos !== undefined && !Array.isArray(d.photos))) throw httpError(400, "Lista de fotos inválida.");
  const photoPaths = photos.map(item => {
    const path = typeof item === "string" ? item : item?.path;
    if (typeof path !== "string" || !path.startsWith(`${ctx.user.organization_id}/${id}/photo-`) || path.length > 500) throw httpError(400, "Uma evidência não corresponde a esta ordem de serviço.");
    return path;
  });
  const checklist = Array.isArray(d.checklist) ? d.checklist.slice(0, 30).map(item => text(item, "Checklist", 160)).filter(Boolean) : [];
  let signaturePath = "";
  if (d.signature) {
    const signatureBytes = await normalizedImage(d.signature, "Assinatura", SIGNATURE_LIMIT, SIGNATURE_PIXELS, 1000, "png", ["png"]);
    signaturePath = await uploadObject(ctx.client, ctx.user.organization_id, id, signatureBytes, "signature");
  }
  const params = {
    p_organization_id: ctx.user.organization_id, p_order_id: id,
    p_notes: text(d.notes, "Observações", 4000), p_checklist: checklist,
    p_photos: photoPaths, p_signature_path: signaturePath,
    p_warranty_days: Math.min(3650, Math.floor(numberValue(d.warranty_days, "Garantia", 3650))),
    p_next_date: dateValue(d.next_date, "Próxima data", false),
    p_next_service: text(d.next_service || "Manutenção preventiva", "Próximo serviço", 180),
    p_estimated_value: numberValue(d.estimated_value || order.value, "Valor estimado"),
    p_return_id: text(d.return_id, "Retorno", 80) || null,
  };
  const { error } = await ctx.client.rpc("complete_service_order", params);
  if (error) {
    await ctx.client.storage.from(PHOTO_BUCKET).remove([signaturePath]);
    throw httpError(error.code === "42501" ? 403 : error.code === "23505" ? 409 : 400, "Não foi possível concluir o atendimento. Confira os dados e tente novamente.");
  }
  return json(200, { ok: true });
}

async function createReturn(request, ctx) {
  requireRole(ctx.user, ["Administrador", "Gestor"]);
  const d = await readJson(request);
  const customerId = text(d.customer_id, "Cliente", 80, true);
  const equipmentId = text(d.equipment_id, "Equipamento", 80);
  const dueDate = dateValue(d.due_date, "Data prevista");
  const { data: customer } = await ctx.client.from("customers").select("id").eq("organization_id", ctx.user.organization_id).eq("id", customerId).maybeSingle();
  if (!customer) throw httpError(404, "Cliente não encontrado.");
  if (equipmentId) {
    const { data: equipment } = await ctx.client.from("equipment").select("id").eq("organization_id", ctx.user.organization_id).eq("id", equipmentId).eq("customer_id", customerId).maybeSingle();
    if (!equipment) throw httpError(400, "Equipamento não pertence ao cliente.");
  }
  const record = { id: `r_${randomUUID().replaceAll("-", "")}`, organization_id: ctx.user.organization_id, customer_id: customerId, equipment_id: equipmentId || null, service: text(d.service, "Serviço", 180, true), due_date: dueDate, estimated_value: numberValue(d.estimated_value, "Valor estimado"), status: dueDate < new Date().toISOString().slice(0, 10) ? "Vencido" : "Próximo" };
  return json(201, await insertRecord(ctx.client, "maintenance_returns", record));
}

async function convertReturn(id, ctx) {
  requireRole(ctx.user, ["Administrador", "Gestor"]);
  const { data, error } = await ctx.client.rpc("convert_maintenance_return", { p_organization_id: ctx.user.organization_id, p_return_id: id });
  if (error || !data?.length) throw httpError(error?.code === "23505" ? 409 : error?.code === "P0002" ? 404 : 400, "Não foi possível converter este retorno em ordem de serviço.");
  return json(201, data[0]);
}

async function recordReturnContact(request, id, ctx) {
  requireRole(ctx.user, ["Administrador", "Gestor"]);
  const d = await readJson(request);
  const outcome = text(d.outcome, "Resultado", 40, true);
  const allowed = ["Contatado", "Respondeu", "Sem interesse", "Número inválido", "Não contatar"];
  if (!allowed.includes(outcome)) throw httpError(400, "Resultado de contato inválido.");
  const followUpDate = d.follow_up_date ? dateValue(d.follow_up_date, "Próxima ação") : "";
  const note = text(d.note || "", "Observação", 500);
  const { data, error } = await ctx.client.rpc("record_maintenance_return_contact", {
    p_organization_id: ctx.user.organization_id,
    p_return_id: id,
    p_outcome: outcome,
    p_note: note,
    p_follow_up_date: followUpDate || null,
  });
  if (error || !data?.length) {
    const status = error?.code === "P0002" ? 404 : error?.code === "42501" ? 403 : error?.code === "23514" ? 409 : 400;
    throw httpError(status, status === 404 ? "Retorno não encontrado." : status === 409 ? "Este retorno não aceita novos contatos." : "Não foi possível registrar o contato.");
  }
  return json(201, data[0]);
}

async function updateSettings(request, ctx) {
  requireRole(ctx.user, ["Administrador"]);
  const d = await readJson(request);
  const value = { name: text(d.name, "Empresa", 160, true), phone: text(d.phone, "Telefone", 30), city: text(d.city, "Cidade", 100), warrantyDefault: numberValue(d.warrantyDefault, "Garantia padrão", 3650) };
  const { error } = await ctx.client.from("organization_settings").upsert({ organization_id: ctx.user.organization_id, value, updated_at: new Date().toISOString() }, { onConflict: "organization_id" });
  if (error) throw httpError(error.code === "42501" ? 403 : 400, "Não foi possível salvar as configurações.");
  return json(200, { ok: true });
}

export default async function handler(request) {
  const requestId = randomUUID();
  try {
    const pathname = new URL(request.url).pathname;
    if (request.method === "POST" && pathname === "/api/login") {
      requireSameOrigin(request);
      return await login(request);
    }
    if (pathname.startsWith("/api/")) return await authenticatedRequest(request, pathname);
    return json(404, { error: "Rota não encontrada." });
  } catch (error) {
    return safeError(error, requestId);
  }
}
