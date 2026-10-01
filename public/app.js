const NAV = [
  ["dashboard", "Visão geral", "⌂", "OPERAÇÃO"],
  ["orders", "Ordens de serviço", "▣", "EXECUÇÃO"],
  ["customers", "Clientes", "◎", "RELACIONAMENTO"],
  ["equipment", "Equipamentos", "◇", "PATRIMÔNIO"],
  ["returns", "Central de Retorno", "↻", "RECORRÊNCIA"],
  ["warranties", "Garantias", "◈", "PÓS-SERVIÇO"],
  ["reports", "Relatórios", "▤", "DOCUMENTOS"],
  ["settings", "Configurações", "⚙", "PREFERÊNCIAS"]
];
const PLATFORM_NAV = [["platform", "Empresas e acessos", "⌘", "ADMINISTRAÇÃO"]];
const CHECKS = ["Equipamento identificado", "Condição inicial registrada", "Filtros verificados", "Drenagem testada", "Temperatura conferida", "Área limpa", "Funcionamento validado", "Cliente orientado"];
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
const esc = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const money = value => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const date = value => value ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR") : "—";
const today = () => new Date().toISOString().slice(0, 10);

let state = { customers: [], equipment: [], orders: [], warranties: [], returns: [], contactAttempts: [], reports: [], settings: {} };
let me = null;
let csrfToken = "";
let route = location.hash.replace("#", "") || "dashboard";
let pendingPhotos = [];
let signatureDirty = false;
let focusBeforeModal = null;

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login") showLogin();
    throw new Error(data.error || "Não foi possível concluir a operação.");
  }
  return data;
}
async function refresh() {
  state = me?.is_platform_admin ? await api("/api/platform/summary") : await api("/api/data");
  render();
}
function customer(id) { return state.customers.find(item => item.id === id) || { name: "Cliente não encontrado", phone: "" }; }
function equipment(id) { return state.equipment.find(item => item.id === id) || {}; }
function order(id) { return state.orders.find(item => item.id === id); }
function badge(status) {
  const tone = /Vencido|Cancelado/.test(status) ? "red" : /Concluído|Ativa|Convertido/.test(status) ? "green" : /Agendado|Próximo/.test(status) ? "gold" : "";
  return `<span class="tag ${tone}">${esc(status)}</span>`;
}
function options(items, label, selected = "") {
  return `<option value="">${label}</option>${items.map(item => `<option value="${item.id}" ${item.id === selected ? "selected" : ""}>${esc(item.name || `${item.kind} · ${item.brand} ${item.model}`)}</option>`).join("")}`;
}
function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  $("#toastRoot").append(el);
  setTimeout(() => el.remove(), 3300);
}
function showLogin() {
  $("#app").hidden = true;
  $("#loginView").hidden = false;
  $("#sidebar").classList.remove("open");
  $(".main-area").inert = false;
  $("#menuButton").setAttribute("aria-expanded", "false");
  $("#sidebarBackdrop").hidden = true;
  document.body.classList.remove("menu-open");
}
function showApp() {
  $("#loginView").hidden = true;
  $("#app").hidden = false;
  const initials = (me.name || me.email || "NC").split(/[\s@.]+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  $("#userInitials").textContent = initials;
  $("#userName").textContent = me.name;
  $(".topbar-actions").hidden = Boolean(me.is_platform_admin);
  $(".sidebar-card").innerHTML = me.is_platform_admin
    ? '<span class="step-label">CONSOLE DA PLATAFORMA</span><strong>Controle os acessos das empresas Naxel Care</strong><div class="flow-line"><i></i><i></i><i></i><i></i></div>'
    : '<span class="step-label">FLUXO ESSENCIAL</span><strong>Do chamado ao próximo serviço</strong><div class="flow-line"><i></i><i></i><i></i><i></i></div>';
}
function renderNav() {
  const items = me?.is_platform_admin ? PLATFORM_NAV : NAV;
  $("#nav").innerHTML = items.map(([id, label, icon]) => `<button class="nav-button ${route === id ? "active" : ""}" data-route="${id}" ${route === id ? 'aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</button>`).join("");
}
function intro(title, text, action = "") {
  return `<div class="page-intro"><div><h2>${title}</h2><p>${text}</p></div>${action}</div>`;
}
function render() {
  renderNav();
  const items = me?.is_platform_admin ? PLATFORM_NAV : NAV;
  const info = items.find(item => item[0] === route) || items[0];
  $("#pageTitle").textContent = info[1];
  $("#contextLabel").textContent = me?.is_platform_admin ? "ADMINISTRAÇÃO DA PLATAFORMA" : info[3];
  const page = me?.is_platform_admin ? platformPage : ({ dashboard, orders: ordersPage, customers: customersPage, equipment: equipmentPage, returns: returnsPage, warranties: warrantiesPage, reports: reportsPage, settings: settingsPage }[route] || dashboard);
  page();
  $("#content").focus({ preventScroll: true });
}

function platformPage() {
  const organizations = state.organizations || [];
  const members = state.members || [];
  const activeOrganizations = organizations.filter(item => item.status === "Ativa").length;
  const activeMembers = members.filter(item => item.status === "Ativo" && item.profile_status === "Ativo").length;
  const pending = members.filter(item => item.invitation_pending).length;
  const rows = members.map(item => `
    <tr>
      <td><strong>${esc(item.name)}</strong><span class="platform-cell-sub">${esc(item.email)}</span></td>
      <td>${esc(item.organization_name)}</td>
      <td>${esc(item.role)}</td>
      <td>${item.invitation_pending ? '<span class="tag gold">Convite pendente</span>' : badge(item.status === "Ativo" && item.profile_status === "Ativo" ? "Ativo" : "Suspenso")}</td>
    </tr>`).join("");
  const orgOptions = organizations.filter(item => item.status === "Ativa").map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
  $("#content").innerHTML = `
    <section class="platform-welcome">
      <div><span class="platform-overline">NAXEL CARE · ACESSO GLOBAL</span><h2>Empresas e acessos</h2><p>Convide os responsáveis de cada empresa e controle quem pode entrar na operação.</p></div>
      <span class="platform-seal" aria-hidden="true">N</span>
    </section>
    <section class="platform-metrics" aria-label="Resumo da plataforma">
      <div><span>Empresas ativas</span><strong>${activeOrganizations}</strong></div>
      <div><span>Usuários vinculados</span><strong>${activeMembers}</strong></div>
      <div><span>Convites aguardando aceite</span><strong>${pending}</strong></div>
    </section>
    <div class="platform-layout">
      <section class="panel platform-invite-panel">
        <div class="panel-head"><div><span class="panel-kicker">NOVO ACESSO</span><h3>Convidar pessoa</h3></div></div>
        <p class="platform-help">Enviaremos um convite para a pessoa definir a própria senha. Nenhuma senha é criada ou compartilhada por aqui.</p>
        <form id="platformInviteForm" class="form-grid">
          <div class="field full"><label for="platformName">Nome da pessoa</label><input id="platformName" name="name" maxlength="160" autocomplete="name" required></div>
          <div class="field full"><label for="platformEmail">E-mail de acesso</label><input id="platformEmail" name="email" type="email" maxlength="254" autocomplete="email" required></div>
          <div class="field full"><label for="platformOrganization">Empresa</label><select id="platformOrganization" name="organization_id"><option value="">Cadastrar nova empresa</option>${orgOptions}</select></div>
          <div id="newOrganizationField" class="field full"><label for="platformOrganizationName">Nome da nova empresa</label><input id="platformOrganizationName" name="organization_name" maxlength="160" required></div>
          <div id="platformRoleField" class="field full" hidden><label for="platformRole">Perfil na empresa</label><select id="platformRole" name="role"><option>Administrador</option><option>Gestor</option><option>Técnico</option></select></div>
          <div class="form-actions full"><button class="button primary">Enviar convite</button></div>
        </form>
      </section>
      <section class="panel platform-directory">
        <div class="panel-head"><div><span class="panel-kicker">ACESSO À OPERAÇÃO</span><h3>Contas cadastradas</h3></div><span class="platform-count">${members.length}</span></div>
        ${members.length ? `<div class="platform-table-wrap"><table class="platform-table"><thead><tr><th>Pessoa</th><th>Empresa</th><th>Perfil</th><th>Situação</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><strong>Primeira empresa começa aqui</strong><span>Cadastre o responsável para criar a empresa e enviar o convite inicial.</span></div>`}
      </section>
    </div>`;
}
function setSidebarOpen(open) {
  const sidebar = $("#sidebar");
  const button = $("#menuButton");
  const backdrop = $("#sidebarBackdrop");
  sidebar.classList.toggle("open", open);
  $(".main-area").inert = open;
  button.setAttribute("aria-expanded", String(open));
  backdrop.hidden = !open;
  document.body.classList.toggle("menu-open", open);
  if (open) sidebar.querySelector("[data-route]")?.focus();
  else button.focus({ preventScroll: true });
}

function dashboard() {
  const openReturns = state.returns.filter(isActionableReturn);
  const overdue = openReturns.filter(item => item.status === "Vencido");
  const activeOrders = state.orders.filter(item => item.status !== "Concluído");
  const activeWarranties = state.warranties.filter(item => item.status === "Ativa");
  const priorities = [...overdue, ...openReturns.filter(item => item.status !== "Vencido")]
    .sort((a, b) => String(a.due_date || "").localeCompare(String(b.due_date || "")))
    .slice(0, 5);
  $("#content").innerHTML = `
    <section class="hero-band dashboard-hero">
      <div><span class="eyebrow">VISÃO DA OPERAÇÃO</span><h2>O que precisa de atenção agora?</h2><p>Ordens, retornos e garantias no mesmo lugar. Escolha uma ação e siga o atendimento.</p>
        <div class="dashboard-hero-actions"><button class="button gold" data-action="new-order">Criar ordem de serviço</button><button class="hero-text-button" data-route="returns">Abrir Central de Retorno</button></div>
      </div>
      <aside class="hero-summary" aria-label="Resumo operacional"><span>Atendimentos abertos</span><strong>${activeOrders.length}</strong><small>${overdue.length ? `${overdue.length} retorno${overdue.length === 1 ? " vencido" : "s vencidos"} para acompanhar` : "Nenhum retorno vencido"}</small></aside>
    </section>
    <div class="kpi-grid">
      ${kpi("Ordens abertas", activeOrders.length, "Agendadas ou em campo", "▣")}
      ${kpi("Retornos vencidos", overdue.length, "Precisam de acompanhamento", "↻")}
      ${kpi("Garantias ativas", activeWarranties.length, "Ligadas aos atendimentos", "◈")}
      ${kpi("Laudos emitidos", state.reports.length, "Registros de serviços concluídos", "▤")}
    </div>
    <div class="dashboard-grid">
      <section class="panel attention-panel"><div class="panel-head"><div><span class="panel-kicker">PRÓXIMA AÇÃO</span><h3>Retornos para acompanhar</h3></div><button class="link-button" data-route="returns">Abrir lista</button></div>
        ${priorities.map(item => `<article class="opportunity ${item.status === "Vencido" ? "is-overdue" : ""}"><i class="opportunity-marker" aria-hidden="true"></i><div><strong>${esc(customer(item.customer_id).name)}</strong><span>${esc(item.service)} · ${date(item.due_date)}</span></div><div class="amount"><strong>${money(item.estimated_value)}</strong>${badge(item.status)}</div></article>`).join("") || `<div class="empty-state compact-empty"><strong>Nenhum retorno pendente</strong><span>Novas recomendações aparecem aqui para você não depender da memória.</span><button class="button ghost" data-action="new-return">Registrar retorno</button></div>`}
      </section>
      <section class="panel shortcuts-panel"><div class="panel-head"><div><span class="panel-kicker">ACESSO RÁPIDO</span><h3>Continue de onde parou</h3></div></div>
        <button class="shortcut-row" data-route="orders"><span class="shortcut-icon" aria-hidden="true">▣</span><span><strong>Ordens de serviço</strong><small>Agende ou continue uma execução</small></span><span class="shortcut-count">${activeOrders.length}</span></button>
        <button class="shortcut-row" data-route="warranties"><span class="shortcut-icon" aria-hidden="true">◈</span><span><strong>Garantias</strong><small>Consulte cobertura e vencimentos</small></span><span class="shortcut-count">${activeWarranties.length}</span></button>
        <button class="shortcut-row" data-route="reports"><span class="shortcut-icon" aria-hidden="true">▤</span><span><strong>Relatórios</strong><small>Abra laudos já emitidos</small></span><span class="shortcut-count">${state.reports.length}</span></button>
      </section>
    </div>`;
}
function kpi(label, value, note, icon) { return `<article class="kpi-card"><div class="kpi-top"><span>${label}</span><i class="kpi-icon">${icon}</i></div><div class="kpi-value">${value}</div><div class="kpi-note">${note}</div></article>`; }

function customersPage() {
  $("#content").innerHTML = `${intro("Clientes com contexto, não apenas contatos", "Histórico, equipamentos e atendimentos permanecem ligados ao mesmo cadastro.", `<button class="button primary" data-action="new-customer">Novo cliente ＋</button>`)}
    <div class="toolbar"><label class="search-wrap"><input id="customerSearch" class="search-input" aria-label="Buscar clientes por nome, cidade ou telefone" placeholder="Buscar cliente por nome, cidade ou telefone…"></label><span id="customerCount" aria-live="polite">${state.customers.length} clientes</span></div><div id="customerList" class="cards customer-list"></div>`;
  drawCustomers("");
}
function drawCustomers(query) {
  const q = query.toLowerCase();
  const rows = state.customers.filter(item => [item.name, item.city, item.phone].join(" ").toLowerCase().includes(q));
  $("#customerCount").textContent = `${rows.length} ${rows.length === 1 ? "cliente" : "clientes"}`;
  $("#customerList").innerHTML = rows.map(item => `<article class="record-card"><div class="card-head"><div><span class="metric-note">${esc(item.type)}</span><h3>${esc(item.name)}</h3><div class="meta">${esc(item.city || "Cidade não informada")}<br>${esc(item.phone || "Sem telefone")}</div></div><span class="tag">${state.equipment.filter(eq => eq.customer_id === item.id).length} equip.</span></div><div class="record-actions"><button class="button ghost" data-action="view-customer" data-id="${item.id}">Ver histórico</button><button class="button primary" data-action="new-order" data-customer="${item.id}">Nova OS</button></div></article>`).join("") || empty("Nenhum cliente encontrado", "Altere a busca ou cadastre um novo cliente.");
}

function equipmentPage() {
  $("#content").innerHTML = `${intro("Cada equipamento guarda sua própria história", "Marca, modelo, número de série, local instalado e serviços realizados.", `<button class="button primary" data-action="new-equipment">Novo equipamento ＋</button>`)}
    <div class="table-shell"><table class="data-table"><thead><tr><th>Cliente</th><th>Equipamento</th><th>Local</th><th>Último serviço</th><th></th></tr></thead><tbody>${state.equipment.map(item => `<tr><td><strong>${esc(customer(item.customer_id).name)}</strong></td><td>${esc(item.kind)} · ${esc(item.brand)} ${esc(item.model)}<div class="meta">Série ${esc(item.serial || "não informada")}</div></td><td>${esc(item.location)}</td><td>${date(item.last_service)}</td><td><button class="button ghost" data-action="view-equipment" data-id="${item.id}">Abrir</button></td></tr>`).join("")}</tbody></table></div>`;
}

function ordersPage() {
  $("#content").innerHTML = `${intro("A operação técnica em um fluxo só", "Agende, execute, registre evidências e conclua com assinatura e laudo.", `<button class="button primary" data-action="new-order">Nova OS ＋</button>`)}
    <div class="toolbar"><label class="search-wrap"><input id="orderSearch" class="search-input" aria-label="Buscar ordens por cliente, serviço ou técnico" placeholder="Buscar cliente, serviço ou técnico"></label><label class="visually-hidden" for="orderFilter">Filtrar ordens por status</label><select id="orderFilter" class="filter-select"><option>Todos</option><option>Agendado</option><option>Em campo</option><option>Concluído</option></select></div><div id="orderList" class="cards"></div>`;
  drawOrders("Todos", "");
}
function drawOrders(filter, query) {
  const q = query.toLowerCase();
  const rows = state.orders.filter(item => (filter === "Todos" || item.status === filter) && [customer(item.customer_id).name, item.service, item.technician, item.id].join(" ").toLowerCase().includes(q));
  $("#orderList").innerHTML = rows.map(item => `<article class="record-card"><div class="card-head"><div><span class="metric-note">${esc(item.id.toUpperCase())}</span><h3>${esc(customer(item.customer_id).name)}</h3><div class="meta">${esc(item.service)}<br>${date(item.scheduled_date)} · ${esc(item.technician || "A definir")}</div></div>${badge(item.status)}</div><div class="split-line"><span class="meta">${esc(equipment(item.equipment_id).brand || "Sem equipamento")}</span><strong>${money(item.value)}</strong></div><div class="record-actions"><button class="button ${item.status === "Concluído" ? "ghost" : "primary"}" data-action="field-mode" data-id="${item.id}">${item.status === "Concluído" ? "Ver registro" : item.status === "Em campo" ? "Continuar atendimento" : "Iniciar atendimento"}</button></div></article>`).join("") || empty("Nenhuma OS encontrada", "Crie uma ordem ou altere os filtros.");
}

function returnsPage() {
  const open = state.returns.filter(isActionableReturn);
  const overdue = open.filter(item => item.status === "Vencido").length;
  const contacted = open.filter(item => ["Contatado", "Respondeu", "Agendado"].includes(item.status)).length;
  const scheduled = state.returns.filter(item => item.status === "Convertido").length;
  const potential = open.reduce((sum, item) => sum + Number(item.estimated_value || 0), 0);
  const attempts = state.contactAttempts || [];
  const todayAttempts = attempts.filter(item => String(item.created_at || "").slice(0, 10) === today()).length;
  $("#content").innerHTML = `
    <section class="return-hero">
      <div class="return-hero-copy"><span class="eyebrow">PÓS-SERVIÇO · RELACIONAMENTO</span><h2>Quem da sua carteira está pronto para voltar?</h2><p>Organize os retornos, faça o contato e acompanhe cada oportunidade até virar uma ordem de serviço.</p></div>
      <div class="return-hero-total"><span>Potencial em aberto</span><strong>${money(potential)}</strong><small>Estimativa das oportunidades acionáveis</small></div>
    </section>
    <section class="return-metrics" aria-label="Resumo da Central de Retorno">
      ${returnMetric("Retornos vencidos", overdue, overdue ? "Prioridade de contato" : "Carteira em dia", "overdue")}
      ${returnMetric("Em acompanhamento", contacted, `${todayAttempts} tentativa${todayAttempts === 1 ? "" : "s"} registrada${todayAttempts === 1 ? "" : "s"} hoje`, "contacted")}
      ${returnMetric("Ordens geradas", scheduled, "Retornos convertidos em OS", "scheduled")}
      ${returnMetric("Oportunidades abertas", open.length, "Com ação comercial pendente", "open")}
    </section>
    <section class="return-flow" aria-label="Etapas do retorno"><div><span>Carteira organizada</span><strong>${state.returns.length}</strong></div><i aria-hidden="true"></i><div><span>Contato registrado</span><strong>${contacted}</strong></div><i aria-hidden="true"></i><div><span>Virou ordem de serviço</span><strong>${scheduled}</strong></div></section>
    <div class="return-toolbar"><label class="search-wrap"><input id="returnSearch" class="search-input" aria-label="Buscar retorno por cliente, serviço ou equipamento" placeholder="Buscar cliente, serviço ou equipamento…"></label><label class="visually-hidden" for="returnFilter">Filtrar Central de Retorno</label><select id="returnFilter" class="filter-select"><option value="Acionáveis">Ação pendente</option><option value="Todos">Todos os retornos</option><option>Vencido</option><option>Próximo</option><option>Contatado</option><option>Respondeu</option><option>Agendado</option><option>Convertido</option><option>Sem interesse</option><option>Número inválido</option><option>Não contatar</option></select><button class="button primary" data-action="new-return">Adicionar retorno ＋</button></div>
    <div id="returnCount" class="return-count" aria-live="polite"></div><div id="returnList" class="return-list"></div>`;
  drawReturns("Acionáveis", "");
}
function isActionableReturn(item) { return !["Convertido", "Cancelado", "Sem interesse", "Número inválido", "Não contatar"].includes(item.status); }
function returnMetric(label, value, note, kind) { return `<article class="return-metric ${kind}"><div><span>${label}</span><small>${note}</small></div><strong>${value}</strong></article>`; }
function returnAttempts(id) { return (state.contactAttempts || []).filter(item => item.return_id === id).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))); }
function latestReturnAttempt(id) { return returnAttempts(id)[0]; }
function drawReturns(filter, query = "") {
  const term = String(query).trim().toLocaleLowerCase("pt-BR");
  const rows = state.returns.filter(item => (filter === "Todos" || (filter === "Acionáveis" ? isActionableReturn(item) : item.status === filter)) &&
    [customer(item.customer_id).name, item.service, equipment(item.equipment_id).brand, equipment(item.equipment_id).model].join(" ").toLocaleLowerCase("pt-BR").includes(term));
  const count = $("#returnCount");
  if (count) count.textContent = `${rows.length} ${rows.length === 1 ? "retorno" : "retornos"} ${filter === "Acionáveis" ? "precisam de uma próxima ação" : "nesta visualização"}`;
  $("#returnList").innerHTML = rows.map(item => {
    const c = customer(item.customer_id);
    const eq = equipment(item.equipment_id);
    const phone = String(c.phone || "").replace(/\D/g, "");
    const nationalPhone = phone.startsWith("55") ? phone.slice(2) : phone;
    const whatsappPhone = `55${nationalPhone}`;
    const text = encodeURIComponent(`Olá, ${c.name}! Tudo bem? Aqui é da ${state.settings.name || "nossa equipe"}. Está no período recomendado para ${item.service.toLowerCase()}${eq.brand ? ` no equipamento ${eq.brand} ${eq.model || ""}` : ""}. Quer que eu verifique um horário para você?`);
    const attempt = latestReturnAttempt(item.id);
    const history = returnAttempts(item.id);
    const canContact = isActionableReturn(item) && /^\d{10,11}$/.test(nationalPhone);
    const closed = !isActionableReturn(item);
    const dueTone = item.status === "Vencido" ? "late" : item.status === "Próximo" ? "soon" : "";
    return `<article class="return-row ${dueTone}"><div class="return-row-main"><div class="return-customer-mark" aria-hidden="true">${esc((c.name || "?").trim().slice(0, 1).toUpperCase())}</div><div class="return-customer-info"><div class="return-row-title"><h3>${esc(c.name)}</h3>${badge(item.status)}</div><p>${esc(item.service)}${eq.brand ? ` <span>·</span> ${esc(eq.brand)} ${esc(eq.model || "")}` : ""}</p><div class="return-meta"><span>${item.status === "Vencido" ? "Vencido em" : "Data recomendada"} ${date(item.due_date)}</span>${item.last_contacted_at ? `<span>Último contato ${date(item.last_contacted_at)}</span>` : ""}${item.next_action_date ? `<span>Retomar em ${date(item.next_action_date)}</span>` : ""}</div>${attempt ? `<div class="return-last-note"><span>Último resultado</span><strong>${esc(attempt.outcome)}</strong>${attempt.note ? `<span> · ${esc(attempt.note)}</span>` : ""}</div>` : ""}${history.length ? `<details class="return-history"><summary>Histórico de contatos (${history.length})</summary><ol>${history.map(entry => `<li><span>${date(entry.created_at)}</span><strong>${esc(entry.outcome)}</strong>${entry.note ? `<small>${esc(entry.note)}</small>` : ""}${entry.follow_up_date ? `<small>Retomar em ${date(entry.follow_up_date)}</small>` : ""}</li>`).join("")}</ol></details>` : ""}</div></div><div class="return-value"><span>${closed ? "Valor estimado" : "Potencial estimado"}</span><strong>${money(item.estimated_value)}</strong></div><div class="return-actions">${canContact ? `<a class="button ghost return-whatsapp" href="https://wa.me/${esc(whatsappPhone)}?text=${text}" target="_blank" rel="noopener noreferrer">Abrir WhatsApp</a><button class="button primary" data-action="log-return-contact" data-id="${esc(item.id)}">Registrar contato</button>` : !closed && !canContact ? `<button class="button ghost" data-action="log-return-contact" data-id="${esc(item.id)}">Registrar tentativa</button>` : ""}${!closed ? `<button class="return-more-action" data-action="convert-return" data-id="${esc(item.id)}">Gerar OS</button>` : item.status === "Convertido" ? `<span class="return-complete-label">OS criada${item.converted_order_id ? ` · ${esc(item.converted_order_id.toUpperCase())}` : ""}</span>` : ""}${!closed ? `<button class="return-more-action muted-action" data-action="log-return-contact" data-id="${esc(item.id)}" data-outcome="Não contatar">Não contatar</button>` : ""}</div></article>`;
  }).join("") || `<div class="return-empty"><span class="return-empty-mark">↻</span><strong>${filter === "Acionáveis" && !term ? "A fila está em dia." : "Nenhum retorno encontrado."}</strong><p>${filter === "Acionáveis" && !term ? "Novas oportunidades aparecem aqui quando uma manutenção se aproxima ou vence." : "Tente mudar a busca ou escolha outro filtro."}</p><button class="button ghost" data-action="new-return">Adicionar retorno</button></div>`;
}

function warrantiesPage() {
  $("#content").innerHTML = `${intro("Garantias que não dependem da memória", "O período fica ligado ao atendimento e pode ser consultado antes de qualquer decisão.")}
    <section class="panel"><div class="timeline">${state.warranties.map(item => `<article class="timeline-item"><div class="card-head"><div><span class="metric-note">${esc(item.order_id.toUpperCase())}</span><h3>${esc(customer(item.customer_id).name)}</h3><div class="meta">${date(item.start_date)} até ${date(item.end_date)}</div></div>${badge(item.status)}</div></article>`).join("") || empty("Nenhuma garantia registrada", "As garantias são criadas na conclusão da OS.")}</div></section>`;
}

function reportsPage() {
  $("#content").innerHTML = `${intro("Relatórios que comprovam o serviço", "Checklist, diagnóstico, evidências, assinatura e garantia em um documento profissional.")}
    <div class="cards">${state.reports.map(report => { const item = order(report.order_id) || {}; return `<article class="record-card"><span class="metric-note">LAUDO ${esc(report.id.toUpperCase())}</span><h3>${esc(customer(item.customer_id).name)}</h3><div class="meta">Emitido em ${date(report.created_at)}<br>${esc(report.summary)}</div><div class="record-actions"><button class="button primary" data-action="view-report" data-id="${report.id}">Visualizar laudo</button></div></article>`; }).join("") || empty("Nenhum laudo emitido", "Conclua uma ordem de serviço para gerar o primeiro.")}</div>`;
}

function settingsPage() {
  const s = state.settings || {};
  const isAdmin = me?.role === "Administrador";
  $("#content").innerHTML = `${intro("Ajustes do ambiente", "Identidade da operação, política de garantia e segurança dos dados.")}
    <div class="dashboard-grid"><form id="settingsForm" class="panel form-grid"><div class="field full"><label>Nome da empresa</label><input name="name" value="${esc(s.name || "")}" required ${isAdmin ? "" : "disabled"}></div><div class="field"><label>WhatsApp</label><input name="phone" value="${esc(s.phone || "")}" ${isAdmin ? "" : "disabled"}></div><div class="field"><label>Cidade</label><input name="city" value="${esc(s.city || "")}" ${isAdmin ? "" : "disabled"}></div><div class="field full"><label>Garantia padrão em dias</label><input name="warrantyDefault" type="number" min="0" value="${Number(s.warrantyDefault || 90)}" ${isAdmin ? "" : "disabled"}></div><div class="form-actions full">${isAdmin ? '<button class="button primary">Salvar configurações</button>' : '<span class="meta">Somente administradores podem alterar estes dados.</span>'}</div></form>
      <div class="panel"><div class="panel-head"><h3>Dados e segurança</h3></div><p class="meta">Os dados da operação são separados por empresa e o acesso é definido pelo perfil de cada usuário. Exporte uma cópia antes de mudanças importantes.</p>${isAdmin ? '<div class="record-actions"><button class="button primary" data-action="export-data">Exportar backup</button></div>' : '<p class="meta">A exportação é restrita ao administrador.</p>'}</div></div>`;
}
function empty(title, text) { return `<div class="empty-state"><strong>${title}</strong><span>${text}</span></div>`; }

function openModal(title, body, wide = false) {
  focusBeforeModal = document.activeElement;
  $("#modalRoot").innerHTML = `<div class="modal-backdrop"><section class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modalTitle" tabindex="-1"><header class="modal-head"><h2 id="modalTitle">${esc(title)}</h2><button type="button" data-action="close-modal" aria-label="Fechar">×</button></header><div class="modal-body">${body}</div></section></div>`;
  $("#modalRoot").querySelectorAll(".field").forEach((field, index) => {
    const label = field.querySelector("label");
    const control = field.querySelector("input, select, textarea");
    if (label && control) {
      const id = control.id || `modal-field-${index + 1}`;
      control.id = id;
      label.htmlFor = id;
    }
  });
  setTimeout(() => {
    const firstFocusable = $(".modal input:not([type=hidden]), .modal select, .modal textarea, .modal button");
    (firstFocusable || $(".modal"))?.focus();
  }, 0);
}
function closeModal() {
  $("#modalRoot").innerHTML = ""; pendingPhotos = []; signatureDirty = false;
  if (focusBeforeModal?.isConnected) focusBeforeModal.focus();
  focusBeforeModal = null;
}
function newCustomer() {
  openModal("Novo cliente", `<form id="customerForm" class="form-grid"><div class="field full"><label>Nome ou razão social</label><input name="name" required></div><div class="field"><label>WhatsApp</label><input name="phone"></div><div class="field"><label>E-mail</label><input name="email" type="email"></div><div class="field"><label>Cidade</label><input name="city" value="Salvador"></div><div class="field"><label>Perfil</label><select name="type"><option>Comercial</option><option>Residencial</option></select></div><div class="field full"><label>Observações</label><textarea name="notes"></textarea></div><div class="form-actions full"><button type="button" class="button ghost" data-action="close-modal">Cancelar</button><button class="button primary">Salvar cliente</button></div></form>`);
}
function newEquipment(customerId = "") {
  openModal("Novo equipamento", `<form id="equipmentForm" class="form-grid"><div class="field full"><label>Cliente</label><select name="customer_id" required>${options(state.customers, "Selecione o cliente", customerId)}</select></div><div class="field"><label>Tipo</label><input name="kind" value="Split" required></div><div class="field"><label>Marca</label><input name="brand" required></div><div class="field"><label>Modelo / capacidade</label><input name="model"></div><div class="field"><label>Número de série</label><input name="serial"></div><div class="field full"><label>Local instalado</label><input name="location" required></div><div class="form-actions full"><button type="button" class="button ghost" data-action="close-modal">Cancelar</button><button class="button primary">Cadastrar equipamento</button></div></form>`);
}
function newOrder(customerId = "", returnId = "") {
  const ret = state.returns.find(item => item.id === returnId);
  const selectedCustomer = customerId || ret?.customer_id || "";
  openModal("Nova ordem de serviço", `<form id="orderForm" class="form-grid" data-return="${esc(returnId)}"><div class="field full"><label>Cliente</label><select name="customer_id" id="orderCustomer" required>${options(state.customers, "Selecione o cliente", selectedCustomer)}</select></div><div class="field full"><label>Equipamento</label><select name="equipment_id" id="orderEquipment"></select></div><div class="field full"><label>Serviço</label><input name="service" value="${esc(ret?.service || "Manutenção preventiva")}" required></div><div class="field"><label>Data</label><input name="scheduled_date" type="date" value="${today()}" required></div><div class="field"><label>Técnico</label><input name="technician" value="Rafael"></div><div class="field full"><label>Valor previsto</label><input name="value" type="number" min="0" step="0.01" value="${Number(ret?.estimated_value || 350)}"></div><div class="form-actions full"><button type="button" class="button ghost" data-action="close-modal">Cancelar</button><button class="button primary">Criar ordem</button></div></form>`);
  fillEquipment(selectedCustomer, ret?.equipment_id || "");
}
function fillEquipment(customerId, selected = "") {
  const el = $("#orderEquipment");
  if (el) el.innerHTML = options(state.equipment.filter(item => item.customer_id === customerId), "Sem equipamento", selected);
}
function newReturn() {
  openModal("Novo serviço recomendado", `<form id="returnForm" class="form-grid"><div class="field full"><label>Cliente</label><select name="customer_id" id="returnCustomer" required>${options(state.customers, "Selecione o cliente")}</select></div><div class="field full"><label>Equipamento</label><select name="equipment_id" id="returnEquipment"><option value="">Selecione o cliente primeiro</option></select></div><div class="field full"><label>Serviço recomendado</label><input name="service" required></div><div class="field"><label>Data prevista</label><input name="due_date" type="date" required></div><div class="field"><label>Valor estimado</label><input name="estimated_value" type="number" min="0" value="300"></div><div class="form-actions full"><button type="button" class="button ghost" data-action="close-modal">Cancelar</button><button class="button primary">Salvar recomendação</button></div></form>`);
}
function logReturnContact(returnId, outcome = "") {
  const item = state.returns.find(entry => entry.id === returnId);
  if (!item) return;
  const choices = ["Contatado", "Respondeu", "Sem interesse", "Número inválido", "Não contatar"];
  const selected = choices.includes(outcome) ? outcome : "Contatado";
  openModal("Registrar contato", `<p class="contact-modal-copy">Registre o que aconteceu com ${esc(customer(item.customer_id).name)}. A preferência de não contato será respeitada nos próximos retornos.</p><form id="returnContactForm" class="form-grid" data-id="${esc(item.id)}"><div class="field full"><label>Resultado do contato</label><select name="outcome" required>${choices.map(choice => `<option ${choice === selected ? "selected" : ""}>${choice}</option>`).join("")}</select></div><div class="field full"><label>Observação (opcional)</label><textarea name="note" maxlength="500" placeholder="Ex.: pediu para chamar depois do dia 15"></textarea></div><div class="field full"><label>Próxima data de acompanhamento</label><input name="follow_up_date" type="date" min="${today()}"></div><div class="form-actions full"><button type="button" class="button ghost" data-action="close-modal">Cancelar</button><button class="button primary">Salvar resultado</button></div></form>`, false);
}
function viewCustomer(id) {
  const c = customer(id), equipments = state.equipment.filter(item => item.customer_id === id), orders = state.orders.filter(item => item.customer_id === id);
  openModal(c.name, `<section class="hero-band"><div><span class="eyebrow">${esc(c.type)}</span><h2>${esc(c.city)}</h2><p>${esc(c.phone)}${c.email ? ` · ${esc(c.email)}` : ""}<br>${esc(c.notes)}</p></div><button class="button gold" data-action="new-order" data-customer="${c.id}">Nova OS</button></section><div class="panel-head"><h3>Equipamentos</h3><button class="link-button" data-action="new-equipment" data-customer="${c.id}">Adicionar equipamento →</button></div>${equipments.map(item => `<div class="panel"><strong>${esc(item.kind)} · ${esc(item.brand)} ${esc(item.model)}</strong><div class="meta">${esc(item.location)} · Série ${esc(item.serial || "não informada")}</div></div>`).join("") || `<p class="meta">Nenhum equipamento cadastrado.</p>`}<h3 class="field-section">Histórico</h3>${orders.map(item => `<div class="panel split-line"><div><strong>${esc(item.service)}</strong><div class="meta">${date(item.scheduled_date)} · ${esc(item.technician)}</div></div>${badge(item.status)}</div>`).join("") || `<p class="meta">Nenhum atendimento.</p>`}`, true);
}
function viewEquipment(id) {
  const item = equipment(id), orders = state.orders.filter(os => os.equipment_id === id);
  openModal(`${item.kind} · ${item.brand}`, `<section class="panel"><span class="metric-note">${esc(customer(item.customer_id).name)}</span><h3>${esc(item.model)}</h3><div class="meta">Local: ${esc(item.location)}<br>Série: ${esc(item.serial || "não informada")}<br>Último serviço: ${date(item.last_service)}</div></section><h3 class="field-section">Histórico técnico</h3>${orders.map(os => `<div class="panel split-line"><div><strong>${esc(os.service)}</strong><div class="meta">${date(os.scheduled_date)} · ${esc(os.technician)}</div></div>${badge(os.status)}</div>`).join("") || `<p class="meta">Nenhum atendimento registrado.</p>`}`);
}
async function fieldMode(id) {
  const item = order(id);
  if (!item) return;
  if (item.status === "Agendado") { await api(`/api/orders/${id}/start`, { method: "POST", body: "{}" }); item.status = "Em campo"; }
  const done = item.status === "Concluído";
  pendingPhotos = item.photos || [];
  openModal(`Atendimento ${item.id.toUpperCase()}`, `<div class="steps"><i class="on"></i><i class="on"></i><i class="${item.status === "Concluído" ? "on" : ""}"></i><i class="${item.status === "Concluído" ? "on" : ""}"></i></div><section class="hero-band"><div><span class="eyebrow">${esc(item.status)}</span><h2>${esc(customer(item.customer_id).name)}</h2><p>${esc(item.service)} · ${esc(equipment(item.equipment_id).location || "Equipamento não informado")}</p></div><div class="hero-number">${money(item.value)}</div></section>
    <form id="fieldForm" data-id="${item.id}"><h3 class="field-section">Checklist técnico</h3><div class="check-grid">${CHECKS.map(label => `<label class="check-card"><input type="checkbox" name="check" value="${esc(label)}" ${(item.checklist || []).includes(label) ? "checked" : ""} ${done ? "disabled" : ""}>${label}</label>`).join("")}</div>
    <h3 class="field-section">Evidências do serviço</h3><label class="photo-zone"><strong>${done ? "Fotos registradas" : "Adicionar fotos do antes e depois"}</strong><span>${done ? "As evidências fazem parte deste atendimento." : "Até 6 imagens JPG, PNG ou WebP; otimizadas antes de salvar."}</span><input id="photoInput" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden ${done ? "disabled" : ""}><div id="photoPreview" class="photo-preview">${pendingPhotos.map(photo => `<img src="${photo.url}" alt="Evidência do serviço">`).join("")}</div></label>
    <div class="field full" style="margin-top:24px"><label>Diagnóstico e serviço realizado</label><textarea name="notes" required ${done ? "disabled" : ""}>${esc(item.notes || "")}</textarea></div>
    <div class="form-grid" style="margin-top:18px"><div class="field"><label>Garantia em dias</label><input name="warranty_days" type="number" min="0" value="${Number(state.settings.warrantyDefault || 90)}" ${done ? "disabled" : ""}></div><div class="field"><label>Próxima manutenção</label><input name="next_date" type="date" ${done ? "disabled" : ""}></div><div class="field full"><label>Serviço futuro</label><input name="next_service" value="Manutenção preventiva" ${done ? "disabled" : ""}></div><div class="field full"><label>Valor futuro estimado</label><input name="estimated_value" type="number" value="${Number(item.value || 0)}" ${done ? "disabled" : ""}></div></div>
    <h3 class="field-section">Assinatura do cliente</h3><div class="signature-wrap"><canvas id="signature" class="signature"></canvas><div class="signature-tools"><button type="button" data-action="clear-signature" ${done ? "disabled" : ""}>Limpar assinatura</button></div></div>
    <div class="form-actions"><button type="button" class="button ghost" data-action="close-modal">Voltar</button><button class="button primary" ${done ? "disabled" : ""}>${done ? "Atendimento concluído" : "Concluir e gerar laudo"}</button></div></form>`, true);
  setupSignature(item.signature, done);
}
function setupSignature(existing, locked) {
  const canvas = $("#signature"); if (!canvas) return;
  const ratio = window.devicePixelRatio || 1, rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(300, rect.width * ratio); canvas.height = 170 * ratio;
  const ctx = canvas.getContext("2d"); ctx.scale(ratio, ratio); ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.strokeStyle = "#071a2f";
  if (existing) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, rect.width, 170); img.src = existing; }
  if (locked) return;
  let drawing = false;
  const point = event => { const box = canvas.getBoundingClientRect(); return [event.clientX - box.left, event.clientY - box.top]; };
  canvas.addEventListener("pointerdown", event => { drawing = true; signatureDirty = true; canvas.setPointerCapture(event.pointerId); ctx.beginPath(); ctx.moveTo(...point(event)); });
  canvas.addEventListener("pointermove", event => { if (!drawing) return; ctx.lineTo(...point(event)); ctx.stroke(); });
  canvas.addEventListener("pointerup", () => drawing = false);
}
function clearSignature() { const canvas = $("#signature"); if (!canvas) return; canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height); signatureDirty = false; }

const PHOTO_MAX_DIMENSION = 1600;
const PHOTO_TARGET_DATA_URL_LENGTH = 900000;
const PHOTO_MAX_INPUT_BYTES = 20 * 1024 * 1024;

async function compressPhoto(file) {
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type)) throw new Error(`${file.name}: use uma foto JPG, PNG ou WebP.`);
  if (file.size > PHOTO_MAX_INPUT_BYTES) throw new Error(`${file.name}: a foto original deve ter até 20 MB.`);
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const source = new Image();
      source.onload = () => resolve(source);
      source.onerror = () => reject(new Error(`Não foi possível processar ${file.name}.`));
      source.src = objectUrl;
    });
    const largestSide = Math.max(image.naturalWidth, image.naturalHeight);
    const scale = Math.min(1, PHOTO_MAX_DIMENSION / largestSide);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    let mime = "image/webp";
    let quality = .78;
    let result = canvas.toDataURL(mime, quality);
    if (!result.startsWith("data:image/webp")) {
      mime = "image/jpeg";
      quality = .82;
      result = canvas.toDataURL(mime, quality);
    }
    while (result.length > PHOTO_TARGET_DATA_URL_LENGTH && quality > .54) {
      quality -= .08;
      result = canvas.toDataURL(mime, quality);
    }
    return result;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function filesToData(files) {
  const incoming = [...files];
  const available = Math.max(0, 6 - pendingPhotos.length);
  const selected = incoming.slice(0, available);
  let failed = 0;
  for (const file of selected) {
    try {
      const dataUrl = await compressPhoto(file);
      const uploaded = await api(`/api/orders/${$("#fieldForm")?.dataset.id}/photos`, { method: "POST", body: JSON.stringify({ dataUrl }) });
      pendingPhotos.push(uploaded);
    }
    catch { failed += 1; }
  }
  $("#photoPreview").innerHTML = pendingPhotos.map(photo => `<img src="${photo.url}" alt="Evidência selecionada">`).join("");
  if (incoming.length > available) toast("Limite de 6 fotos por atendimento.");
  else if (failed) toast(`${selected.length - failed} foto(s) preparada(s); ${failed} não pôde/puderam ser processada(s). Confira o formato e o tamanho.`);
  else if (selected.length) toast(`${selected.length} ${selected.length === 1 ? "imagem otimizada" : "imagens otimizadas"} para economizar armazenamento.`);
}
function viewReport(reportId) {
  const report = state.reports.find(item => item.id === reportId), item = order(report?.order_id);
  if (!report || !item) return;
  const c = customer(item.customer_id), eq = equipment(item.equipment_id), warranty = state.warranties.find(g => g.order_id === item.id);
  openModal("Laudo de atendimento", `<article class="report-sheet"><header class="report-brand"><div><span class="eyebrow">NAXEL CARE · RELATÓRIO TÉCNICO</span><h2>${esc(state.settings.name || "Naxel Care")}</h2></div><img src="assets/naxel-mark.png" width="44" height="52" alt=""></header><div class="report-grid"><div class="report-box"><span>Cliente</span><strong>${esc(c.name)}</strong></div><div class="report-box"><span>Ordem de serviço</span><strong>${esc(item.id.toUpperCase())}</strong></div><div class="report-box"><span>Serviço</span><strong>${esc(item.service)}</strong></div><div class="report-box"><span>Data e técnico</span><strong>${date(item.scheduled_date)} · ${esc(item.technician)}</strong></div><div class="report-box"><span>Equipamento</span><strong>${esc(eq.kind || "—")} · ${esc(eq.brand || "")} ${esc(eq.model || "")}</strong></div><div class="report-box"><span>Garantia</span><strong>${warranty ? `até ${date(warranty.end_date)}` : "Não registrada"}</strong></div></div><h3>Resumo técnico</h3><p>${esc(report.summary)}</p><h3>Checklist concluído</h3><p>${(item.checklist || []).map(label => `✓ ${esc(label)}`).join(" · ") || "Sem checklist registrado."}</p>${item.photos?.length ? `<h3>Evidências</h3><div class="report-photos">${item.photos.map(photo => `<img src="${photo.url}" alt="Evidência do serviço">`).join("")}</div>` : ""}${item.signature ? `<h3>Assinatura do cliente</h3><img src="${item.signature}" alt="Assinatura do cliente" style="max-width:300px;max-height:120px">` : ""}</article><div class="form-actions report-actions"><button class="button ghost" data-action="print-report">Imprimir / salvar PDF</button><button class="button primary" data-action="share-report" data-id="${report.id}">Enviar pelo WhatsApp</button></div>`, true);
}

document.addEventListener("click", async event => {
  const routeButton = event.target.closest("[data-route]");
  if (routeButton) { route = me?.is_platform_admin ? "platform" : routeButton.dataset.route; location.hash = route; if ($("#sidebar").classList.contains("open")) setSidebarOpen(false); render(); window.scrollTo({ top: 0, behavior: "instant" }); return; }
  const button = event.target.closest("[data-action]"); if (!button) return;
  const action = button.dataset.action, id = button.dataset.id;
  try {
    if (action === "close-modal") closeModal();
    if (action === "new-customer") newCustomer();
    if (action === "new-equipment") newEquipment(button.dataset.customer || "");
    if (action === "new-order") newOrder(button.dataset.customer || "", button.dataset.return || "");
    if (action === "new-return") newReturn();
    if (action === "log-return-contact") logReturnContact(id, button.dataset.outcome || "");
    if (action === "view-customer") viewCustomer(id);
    if (action === "view-equipment") viewEquipment(id);
    if (action === "field-mode") await fieldMode(id);
    if (action === "view-report") viewReport(id);
    if (action === "print-report") window.print();
    if (action === "clear-signature") clearSignature();
    if (action === "convert-return") { await api(`/api/returns/${id}/convert`, { method: "POST", body: "{}" }); await refresh(); toast("Ordem de serviço criada"); }
    if (action === "share-report") {
      const report = state.reports.find(item => item.id === id), item = order(report.order_id), c = customer(item.customer_id);
      window.open(`https://wa.me/55${c.phone}?text=${encodeURIComponent(`Olá, ${c.name}! O relatório técnico do atendimento ${item.id.toUpperCase()} está pronto. A Naxel agradece a confiança.`)}`, "_blank");
    }
    if (action === "export-data") { const data = await api("/api/backup"); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })); a.download = `naxel-care-backup-${today()}.json`; a.click(); URL.revokeObjectURL(a.href); toast("Backup exportado"); }
  } catch (error) { toast(error.message); }
});
document.addEventListener("input", event => {
  if (event.target.id === "customerSearch") drawCustomers(event.target.value);
  if (event.target.id === "orderSearch") drawOrders($("#orderFilter").value, event.target.value);
  if (event.target.id === "returnSearch") drawReturns($("#returnFilter").value, event.target.value);
});
document.addEventListener("change", async event => {
  if (event.target.id === "orderFilter") drawOrders(event.target.value, $("#orderSearch").value);
  if (event.target.id === "returnFilter") drawReturns(event.target.value, $("#returnSearch").value);
  if (event.target.id === "orderCustomer") fillEquipment(event.target.value);
  if (event.target.id === "returnCustomer") { const el = $("#returnEquipment"); el.innerHTML = options(state.equipment.filter(item => item.customer_id === event.target.value), "Sem equipamento"); }
  if (event.target.id === "photoInput") await filesToData(event.target.files || []);
  if (event.target.id === "platformOrganization") {
    const creating = !event.target.value;
    $("#newOrganizationField").hidden = !creating;
    $("#platformOrganizationName").required = creating;
    $("#platformRoleField").hidden = creating;
  }
});
document.addEventListener("submit", async event => {
  event.preventDefault(); const form = event.target; const data = Object.fromEntries(new FormData(form));
  try {
    if (form.id === "loginForm") { const result = await api("/api/login", { method: "POST", body: JSON.stringify(data) }); me = result.user; csrfToken = result.csrfToken || ""; showApp(); await refresh(); return; }
    if (form.id === "platformInviteForm") {
      const result = await api("/api/platform/invitations", { method: "POST", body: JSON.stringify(data) });
      form.reset(); $("#platformOrganization").dispatchEvent(new Event("change", { bubbles: true }));
      await refresh(); toast(result.invited ? "Convite enviado para o e-mail" : "Acesso vinculado à empresa"); return;
    }
    if (form.id === "customerForm") await api("/api/customers", { method: "POST", body: JSON.stringify(data) });
    if (form.id === "equipmentForm") await api("/api/equipment", { method: "POST", body: JSON.stringify(data) });
    if (form.id === "orderForm") await api("/api/orders", { method: "POST", body: JSON.stringify(data) });
    if (form.id === "returnForm") await api("/api/returns", { method: "POST", body: JSON.stringify(data) });
    if (form.id === "returnContactForm") await api(`/api/returns/${form.dataset.id}/contacts`, { method: "POST", body: JSON.stringify(data) });
    if (form.id === "settingsForm") { data.warrantyDefault = Number(data.warrantyDefault || 0); await api("/api/settings", { method: "PUT", body: JSON.stringify(data) }); }
    if (form.id === "fieldForm") {
      data.checklist = $$(`input[name="check"]:checked`).map(input => input.value); data.photos = pendingPhotos.map(photo => photo.path);
      const canvas = $("#signature"); data.signature = signatureDirty ? canvas.toDataURL("image/png") : "";
      if (!data.notes.trim()) throw new Error("Descreva o diagnóstico e o serviço realizado.");
      await api(`/api/orders/${form.dataset.id}/complete`, { method: "POST", body: JSON.stringify(data) });
      route = "reports"; location.hash = route;
    }
    closeModal(); await refresh(); toast(form.id === "fieldForm" ? "Atendimento concluído e laudo gerado" : form.id === "returnContactForm" ? "Contato registrado na Central" : "Dados salvos com sucesso");
  } catch (error) {
    if (form.id === "loginForm") $("#loginError").textContent = error.message; else toast(error.message);
  }
});
$("#menuButton").addEventListener("click", () => setSidebarOpen(!$("#sidebar").classList.contains("open")));
$("#sidebarBackdrop").addEventListener("click", () => setSidebarOpen(false));
$("#logoutButton").addEventListener("click", async () => { await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {}); me = null; csrfToken = ""; showLogin(); });
$("#modalRoot").addEventListener("click", event => { if (event.target.classList.contains("modal-backdrop")) closeModal(); });
window.addEventListener("hashchange", () => { route = location.hash.replace("#", "") || "dashboard"; if (me) { render(); window.scrollTo({ top: 0, behavior: "instant" }); } });
document.addEventListener("keydown", event => {
  const modal = $(".modal");
  if (event.key === "Escape") {
    if (modal) closeModal();
    else if ($("#sidebar").classList.contains("open")) setSidebarOpen(false);
    return;
  }
  if (event.key !== "Tab" || !modal) return;
  const focusable = [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(element => element.getClientRects().length);
  if (!focusable.length) { event.preventDefault(); modal.focus(); return; }
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

function authTokensFromFragment() {
  const params = new URLSearchParams(location.hash.slice(1));
  const accessToken = params.get("access_token"), refreshToken = params.get("refresh_token");
  return accessToken && refreshToken ? { access_token: accessToken, refresh_token: refreshToken } : null;
}

(async function boot() {
  try {
    const invitationTokens = authTokensFromFragment();
    let result;
    if (invitationTokens) {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      result = await api("/api/auth/callback", { method: "POST", body: JSON.stringify(invitationTokens) });
    } else result = await api("/api/me");
    me = result.user; csrfToken = result.csrfToken || "";
    route = me.is_platform_admin ? "platform" : (NAV.some(item => item[0] === route) ? route : "dashboard");
    if (location.hash.replace("#", "") !== route) history.replaceState(null, "", `${location.pathname}${location.search}#${route}`);
    showApp(); await refresh(); window.scrollTo({ top: 0, behavior: "instant" });
  } catch { showLogin(); }
})();
