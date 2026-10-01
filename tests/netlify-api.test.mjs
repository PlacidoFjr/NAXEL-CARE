import test from "node:test";
import assert from "node:assert/strict";
import handler from "../netlify/functions/api.mjs";

test("a API hospedada nega sessão anônima sem consultar o banco", async () => {
  const response = await handler(new Request("https://naxel.example/api/data"));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "Sessão necessária." });
});

test("a rota de login valida configuração antes de qualquer rede externa", async () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  try {
    const response = await handler(new Request("https://naxel.example/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://naxel.example" },
      body: JSON.stringify({ email: "admin@example.com", password: "not-a-secret" }),
    }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "A conexão segura com o banco ainda não foi configurada.");
  } finally {
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = originalKey;
  }
});

test("a API rejeita login originado fora do domínio", async () => {
  const response = await handler(new Request("https://naxel.example/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://outro.example" },
    body: JSON.stringify({ email: "admin@example.com", password: "anything" }),
  }));
  assert.equal(response.status, 403);
});
