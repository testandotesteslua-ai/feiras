const appOrigin = "https://testandotesteslua-ai.github.io";
const app = appOrigin + "/feiras/";
const db = Deno.env.get("SUPABASE_URL")!;
const callback = "https://guiieswqphjixidbtzvs.supabase.co/functions/v1/mercado-pago-oauth-retorno";
const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const clientId = Deno.env.get("MERCADO_PAGO_CLIENT_ID");
const clientSecret = Deno.env.get("MERCADO_PAGO_CLIENT_SECRET");
const mercadoPago = "https://api.mercadopago.com";
const attempts = "/rest/v1/mp_oauth_tentativas_teste";
const connections = "/rest/v1/mp_conexoes_teste";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sandboxOrder = /^ORDTST[A-Z0-9]{10,40}$/;
const encoder = new TextEncoder();
const common = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const cors = {
  ...common,
  "Access-Control-Allow-Origin": appOrigin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

function json(data: object, status = 200) {
  return Response.json(data, { status, headers: cors });
}

function back(result: string) {
  return new Response(null, { status: 303, headers: { ...common, Location: app + "?mp-conexao=" + result } });
}

class OrderError extends Error {
  constructor(readonly status: number, readonly codes: string[]) {
    super("Mercado Pago order rejected");
  }
}

async function requestJson(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(9000) });
  if (!response.ok) {
    const endpoint = new URL(url);
    if (endpoint.origin === mercadoPago && endpoint.pathname.startsWith("/v1/orders")) {
      const error = await response.json().catch(() => null);
      const rawCodes = [error?.error, ...(Array.isArray(error?.errors) ? error.errors.map((item: { code?: unknown } | null) => item?.code) : [])];
      const codes = rawCodes.filter((code) => typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code)).slice(0, 5);
      console.warn("Mercado Pago orders request rejected", { status: response.status, codes });
      throw new OrderError(response.status, codes);
    }
    throw new Error("request:" + response.status);
  }
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

function database(path: string, init: RequestInit = {}) {
  return requestJson(db + path, {
    ...init,
    headers: { apikey: service, Authorization: "Bearer " + service, "Content-Type": "application/json", ...init.headers },
  });
}

async function canConnect(user: string, org: string) {
  const [[profile], [organization]] = await Promise.all([
    database("/rest/v1/perfis?select=eh_admin&id=eq." + user),
    database("/rest/v1/organizacoes?select=id&id=eq." + org + "&criado_por=eq." + user + "&status=eq.ativa"),
  ]);
  return profile?.eh_admin === true && !!organization;
}

function b64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

async function stateHash(state: string) {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(state))));
}

async function tokenKey() {
  const key = await crypto.subtle.importKey("raw", encoder.encode(clientSecret!), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256", salt: encoder.encode(db), info: encoder.encode("colanessa-mercado-pago-teste"),
  }, key, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encryptToken(token: string, org: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(org) }, await tokenKey(), encoder.encode(token));
  return b64(iv) + "." + b64(new Uint8Array(ciphertext));
}

async function decryptToken(value: string, org: string) {
  const [iv, cipher] = value.split(".").map((part) => Uint8Array.from(atob(part), (char) => char.charCodeAt(0)));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(org) }, await tokenKey(), cipher);
  return new TextDecoder().decode(plaintext);
}

async function receive(url: URL) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code && !state && !url.searchParams.has("error")) {
    return new Response("Cola Nessa — endereço de retorno do Mercado Pago.", { headers: { ...common, "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (!state || !/^[a-f0-9-]{72}$/i.test(state)) return back("invalida");

  const filters = new URLSearchParams({ estado_hash: "eq." + await stateHash(state), expira_em: "gt." + new Date().toISOString() });
  const [attempt] = await database(attempts + "?" + filters, {
    method: "DELETE", headers: { Prefer: "return=representation" },
  });
  if (!attempt || !await canConnect(attempt.user_id, attempt.organizacao_id)) return back("invalida");
  if (!code || url.searchParams.has("error")) return back("cancelada");
  if (!clientId || !clientSecret) return back("configuracao");

  const token = await requestJson(mercadoPago + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code",
      code, redirect_uri: callback, test_token: "false",
    }),
  });
  const seller = String(token?.user_id ?? "");
  if (!/^[0-9]+$/.test(seller) || !Number.isFinite(token?.expires_in) || token.expires_in <= 0 ||
      !await isOrdersTestSeller(token?.access_token, seller)) return back("ambiente");

  await database(connections + "?on_conflict=organizacao_id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      organizacao_id: attempt.organizacao_id, vendedor_id: seller,
      token_cifrado: "orders:" + await encryptToken(token.access_token, attempt.organizacao_id),
      expira_em: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      tentativa: crypto.randomUUID(), order_id: null, checkout_url: null,
    }),
  });
  return back("conectada");
}

function checkoutUrl(value: string) {
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || url.origin !== "https://www.mercadopago.com.br" || url.username || url.password) {
    console.warn("Mercado Pago returned an invalid checkout URL");
    throw new Error("checkout inválido");
  }
  return url.href;
}

async function isOrdersTestSeller(token: unknown, seller: string) {
  if (typeof token !== "string" || !token.startsWith("APP_USR-")) return false;
  const account = await requestJson(mercadoPago + "/users/me", {
    headers: { Authorization: "Bearer " + token },
  });
  return String(account?.id ?? "") === seller &&
    Array.isArray(account?.tags) && account.tags.includes("test_user");
}

async function testSplit(row: any, org: string) {
  const token = await decryptToken(row.token_cifrado.slice("orders:".length), org);
  if (!await isOrdersTestSeller(token, row.vendedor_id)) {
    return json({ erro: "O Mercado Pago não confirmou esta conta como vendedor de teste." }, 409);
  }
  const headers = { Authorization: "Bearer " + token };
  const ref = "colanessa-split-teste-" + row.tentativa;
  const order = row.order_id
    ? await requestJson(mercadoPago + "/v1/orders/" + row.order_id, { headers })
    : await requestJson(mercadoPago + "/v1/orders", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Idempotency-Key": row.tentativa },
      body: JSON.stringify({
        type: "online", processing_mode: "manual", total_amount: "10.00", marketplace_fee: "1.00",
        external_reference: ref, items: [{ title: "Teste de divisão Cola Nessa", quantity: 1, unit_price: "10.00" }],
      }),
    });
  if (!sandboxOrder.test(order?.id ?? "") || order.external_reference !== ref ||
      Number(order.total_amount) !== 10) {
    console.warn("Mercado Pago test order validation failed", {
      sandbox: sandboxOrder.test(order?.id ?? ""), referenceMatches: order?.external_reference === ref,
      amountMatches: Number(order?.total_amount) === 10,
    });
    return json({ erro: "O Mercado Pago devolveu uma cobrança que o Cola Nessa não conseguiu confirmar como teste." }, 502);
  }
  const checkout = checkoutUrl(row.checkout_url ?? order.checkout_url);
  if (!row.order_id) {
    await database(connections + "?organizacao_id=eq." + org + "&tentativa=eq." + row.tentativa, {
      method: "PATCH", body: JSON.stringify({ order_id: order.id, checkout_url: checkout }),
    });
  }
  return json({ checkout, id: order.id, status: order.status, pago: Number(order.total_paid_amount) === 10 });
}

async function operate(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ erro: "Entre no Cola Nessa." }, 401);
  const userResponse = await fetch(db + "/auth/v1/user", {
    headers: { apikey: anon, Authorization: authorization }, signal: AbortSignal.timeout(5000),
  });
  if (!userResponse.ok) return json({ erro: "Entre no Cola Nessa." }, 401);
  const user = await userResponse.json();
  if (!uuid.test(user.id ?? "") || user.is_anonymous) return json({ erro: "Entre no Cola Nessa." }, 401);
  const body = await req.json().catch(() => null);
  const org = body?.organizacao;
  if (typeof org !== "string" || !uuid.test(org) || !["status", "conectar", "cobranca"].includes(body.acao)) {
    return json({ erro: "Dados do teste inválidos." }, 400);
  }
  if (!await canConnect(user.id, org)) return json({ erro: "Teste disponível à administração na própria organização ativa." }, 403);
  if (!clientId || !clientSecret) return json({ erro: "Client ID ou Client Secret ainda ausente no Supabase." }, 503);
  const filter = "?organizacao_id=eq." + org;
  if (body.acao === "conectar") {
    const state = crypto.randomUUID() + crypto.randomUUID();
    await database(attempts + "?on_conflict=organizacao_id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        estado_hash: await stateHash(state), organizacao_id: org, user_id: user.id,
        expira_em: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }),
    });
    const url = new URL("https://auth.mercadopago.com.br/authorization");
    url.search = new URLSearchParams({
      client_id: clientId, response_type: "code", platform_id: "mp", redirect_uri: callback, state,
    }).toString();
    return json({ autorizacao: url.href });
  }

  const fields = body.acao === "status" ? "&select=vendedor_id,expira_em,order_id,token_cifrado" : "";
  const [row] = await database(connections + filter + fields);
  const active = row?.token_cifrado?.startsWith("orders:") && Date.parse(row.expira_em) > Date.now();
  if (body.acao === "status") {
    return json({ conectada: !!active, vendedor: active ? row.vendedor_id : null, order_id: active ? row.order_id : null });
  }
  if (!active) return json({ erro: "Conecta uma conta de vendedor de teste primeiro." }, 409);
  return testSplit(row, org);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method === "GET") {
    try { return await receive(new URL(req.url)); } catch { return back("erro"); }
  }
  if (req.method !== "POST") return json({ erro: "Método inválido." }, 405);
  try { return await operate(req); } catch (error) {
    if (error instanceof OrderError) {
      const diagnostic = [error.status, ...error.codes].join(" · ");
      return json({ erro: "O Mercado Pago recusou a cobrança de teste. Código: " + diagnostic }, 502);
    }
    const status = error instanceof Error && /^request:[0-9]{3}$/.test(error.message) ? Number(error.message.slice(8)) : undefined;
    return json({ erro: "Não foi possível concluir o teste do Mercado Pago.", ...(status && { codigo: status }) }, 502);
  }
});
