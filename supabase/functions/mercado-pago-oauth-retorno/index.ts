const appOrigin = "https://colanessa.pages.dev";
const app = appOrigin + "/";
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

class RequestError extends Error {
  constructor(readonly status: number) {
    super("request:" + status);
  }
}

async function requestJson(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new RequestError(response.status);
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
  const [organization] = await database("/rest/v1/organizacoes?select=id&id=eq." + org + "&criado_por=eq." + user + "&status=eq.ativa");
  return !!organization;
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
      code, redirect_uri: callback, test_token: false,
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
      controle_preferencia_id: null, controle_checkout_url: null,
      direta_order_id: null, direta_checkout_url: null,
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
  if (typeof token !== "string" || !(token.startsWith("APP_USR-") || token.startsWith("TEST-"))) return false;
  const account = await requestJson(mercadoPago + "/users/me", {
    headers: { Authorization: "Bearer " + token },
  });
  return String(account?.id ?? "") === seller &&
    Array.isArray(account?.tags) && account.tags.includes("test_user");
}

const chargeTable = "/rest/v1/mp_checkout_inscricoes";
const legacyChargeTable = "/rest/v1/mp_inscricoes_checkout_teste";
const webhookUrl = callback + "/pagamentos";
function readWebhookSecret(name: string) {
  const value = Deno.env.get(name)?.trim();
  return value && !/^[*•●·.]+$/u.test(value) ? value : undefined;
}

const checkoutWebhookSecret = readWebhookSecret("MERCADO_PAGO_CHECKOUT_WEBHOOK_SECRET");
const webhookSecret = checkoutWebhookSecret || readWebhookSecret("MERCADO_PAGO_WEBHOOK_TEST_SECRET");
// The existing Feira A is the pilot organization. Sandbox payments never update other events.
const pilotOrganization = "efbef4e2-687c-4d21-9dd6-502fc377bd71";
const preferenceId = /^[0-9]+-[a-z0-9-]+$/i;
const numericId = /^[0-9]{1,30}$/;

function activeConnection(row: any) {
  return !!row?.token_cifrado?.startsWith("orders:") && Date.parse(row.expira_em) > Date.now();
}

async function sellerToken(row: any, org: string) {
  return decryptToken(row.token_cifrado.slice("orders:".length), org);
}

function paymentMatches(payment: any, charge: any) {
  return payment?.live_mode === false && payment.currency_id === "BRL" &&
    payment.external_reference === charge.referencia && String(payment.collector_id) === charge.vendedor_id &&
    typeof payment.transaction_amount === "number" &&
    Math.round(payment.transaction_amount * 100) === charge.total_centavos &&
    numericId.test(String(payment.id));
}

async function closePreference(id: string, headers: Record<string, string>) {
  const end = new Date(Date.now() - 1000);
  await requestJson(mercadoPago + "/checkout/preferences/" + id, {
    method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      expires: true,
      expiration_date_from: new Date(end.getTime() - 86400000).toISOString(),
      expiration_date_to: end.toISOString(),
    }),
  });
}

async function applyPayment(payment: any, charge: any, headers: Record<string, string>) {
  if (!paymentMatches(payment, charge)) return "ignorado";
  const result = await database("/rest/v1/rpc/mp_registrar_pagamento_inscricao", {
    method: "POST",
    body: JSON.stringify({
      p_referencia: charge.referencia, p_pagamento: String(payment.id), p_vendedor: charge.vendedor_id,
      p_centavos: charge.total_centavos, p_moeda: payment.currency_id, p_teste: payment.live_mode === false,
      p_status: payment.status,
    }),
  });
  if (result === "duplicado" || result === "revisao") {
    console.warn("Pagamento de teste requer revisão", { referencia: charge.referencia, situacao: result });
  }
  if (payment.status === "approved" && ["confirmado", "duplicado", "revisao"].includes(result)) {
    await closePreference(charge.preferencia_id, headers).catch(() => {
      console.warn("Não foi possível encerrar a preferência já conciliada", { referencia: charge.referencia });
    });
  }
  return result;
}

async function paymentById(id: string, headers: Record<string, string>) {
  try {
    return await requestJson(mercadoPago + "/v1/payments/" + id, { headers });
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) return null;
    throw error;
  }
}

async function reconcile(charge: any, headers: Record<string, string>, paymentId?: string) {
  let returnedPayment;
  if (paymentId && numericId.test(paymentId)) {
    const payment = await paymentById(paymentId, headers).catch(() => null);
    if (paymentMatches(payment, charge)) {
      if (payment.status === "approved") {
        await applyPayment(payment, charge, headers);
        return;
      }
      returnedPayment = payment;
    }
  }
  const query = new URLSearchParams({ external_reference: charge.referencia, limit: "50" });
  const payments = await requestJson(mercadoPago + "/v1/payments/search?" + query, { headers });
  const matches = (Array.isArray(payments?.results) ? payments.results : [])
    .filter((payment: any) => paymentMatches(payment, charge));
  const approved = matches.filter((payment: any) => payment.status === "approved");
  if (approved.length) {
    for (const payment of approved) await applyPayment(payment, charge, headers);
    return;
  }
  const last = matches.find((payment: any) => String(payment.id) === charge.pagamento_id) ??
    matches.find((payment: any) => ["pending", "in_process", "authorized", "in_mediation"].includes(payment.status)) ??
    returnedPayment ?? matches[0];
  if (last) await applyPayment(last, charge, headers);
}

async function paymentWebhook(req: Request, url: URL) {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!webhookSecret) return new Response(null, { status: 503 });
  const ids = url.searchParams.getAll("data.id");
  const id = ids[0] ?? "";
  const requestId = req.headers.get("x-request-id") ?? "";
  const signature = req.headers.get("x-signature") ?? "";
  const validId = ids.length === 1 && numericId.test(id);
  const validRequestId = /^[a-z0-9_-]{1,128}$/i.test(requestId);
  if (!validId || !validRequestId || signature.length > 512) {
    console.warn("MP checkout webhook: metadados invalidos", { validId, validRequestId, signaturePresent: !!signature });
    return new Response(null, { status: 401 });
  }
  const fields = signature.split(",").map((part) => part.trim());
  const timestamps = fields.filter((part) => part.startsWith("ts="));
  const hashes = fields.filter((part) => part.startsWith("v1="));
  const ts = timestamps[0]?.slice(3) ?? "";
  const hash = hashes[0]?.slice(3) ?? "";
  if (timestamps.length !== 1 || hashes.length !== 1 || !/^\d{10,13}$/.test(ts) || !/^[a-f0-9]{64}$/i.test(hash)) {
    console.warn("MP checkout webhook: formato de assinatura invalido", { signaturePresent: !!signature });
    return new Response(null, { status: 401 });
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = Uint8Array.from(hash.match(/../g)!, (byte) => parseInt(byte, 16));
  if (!await crypto.subtle.verify("HMAC", key, bytes, encoder.encode(`id:${id};request-id:${requestId};ts:${ts};`))) {
    console.warn("MP checkout webhook: assinatura nao confere", { checkoutSecretConfigured: !!checkoutWebhookSecret });
    return new Response(null, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (body?.type !== "payment") return new Response(null, { status: 200 });
  const reference = url.searchParams.get("ref") ?? "";
  let [charge] = uuid.test(reference) ? await database(chargeTable + "?referencia=eq." + reference) : [];
  if (uuid.test(reference) && !charge) return new Response(null, { status: 200 });
  if (charge && !charge.preferencia_id) return new Response(null, { status: 503 });
  // The URL reference and webhook body only route the lookup. The seller's API verifies all payment data.
  const seller = charge?.vendedor_id ?? String(body.user_id ?? "");
  if (!numericId.test(seller)) return new Response(null, { status: 200 });
  const filters = "vendedor_id=eq." + seller + (charge ? "&organizacao_id=eq." + charge.organizacao_id : "");
  const rows = await database(connections + "?" + filters);
  if (!rows.length) return new Response(null, { status: 200 });
  const connection = rows.find(activeConnection);
  if (!connection) return new Response(null, { status: 503 });
  const headers = { Authorization: "Bearer " + await sellerToken(connection, connection.organizacao_id) };
  const payment = await paymentById(id, headers);
  if (String(payment?.id) !== id || !uuid.test(payment?.external_reference ?? "")) {
    return new Response(null, { status: payment || !charge ? 200 : 503 });
  }
  if (!charge) [charge] = await database(chargeTable + "?referencia=eq." + payment.external_reference);
  if (charge?.preferencia_id) await applyPayment(payment, charge, headers);
  return new Response(null, { status: 200 });
}

async function recoverPreference(reference: string, headers: Record<string, string>) {
  const query = new URLSearchParams({ external_reference: reference, limit: "2" });
  const list = await requestJson(mercadoPago + "/checkout/preferences/search?" + query, { headers });
  const entries = Array.isArray(list?.elements) ? list.elements : [];
  if (entries.length !== 1 || !preferenceId.test(entries[0]?.id ?? "")) return null;
  return requestJson(mercadoPago + "/checkout/preferences/" + entries[0].id, { headers });
}

async function inscriptionCheckout(user: string, body: any) {
  const id = body.inscricao;
  if (typeof id !== "string" || !uuid.test(id)) return json({ erro: "Inscrição inválida." }, 400);
  const ins = await database("/rest/v1/rpc/mp_dados_inscricao_teste", {
    method: "POST", body: JSON.stringify({ p_inscricao: id, p_dono: user }),
  });
  if (!ins?.edicoes) return json({ erro: "Inscrição indisponível." }, 404);
  const edition = ins.edicoes;
  const org = edition.organizacao_id;
  if (org !== pilotOrganization) return json({ disponivel: false });
  const filter = "?inscricao_id=eq." + id;
  const [[connection], [saved], [organization], [legacy]] = await Promise.all([
    database(connections + "?organizacao_id=eq." + org),
    database(chargeTable + filter),
    database("/rest/v1/organizacoes?select=id&id=eq." + org + "&status=eq.ativa"),
    database(legacyChargeTable + filter + "&select=preferencia_id,referencia,vendedor_id"),
  ]);
  let charge = saved;
  const price = ins.valor_combinado ?? (ins.dia_unico && edition.preco_dia != null ? edition.preco_dia
    : ins.tamanho === "unico" ? edition.preco_unico : ins.tamanho === "3m" ? edition.preco_3m : edition.preco_2m);
  const total = Math.round(Number(price) * 100);
  const eligible = !!organization && ins.status === "confirmada" && !ins.isento && !ins.pago && !ins.pago_sinal &&
    !(Number(ins.valor_pago) > 0) && !(Number(ins.credito_usado) > 0) && !ins.tem_comprovante &&
    !edition.gratuita && !edition.cancelada_em && Number.isSafeInteger(total) && total > 0 && total <= 2147483647;
  const active = !!webhookSecret && activeConnection(connection) && (!charge || charge.vendedor_id === connection.vendedor_id);
  const response = (checkout?: string) => json({
    disponivel: eligible && active,
    aprovado: charge?.situacao === "confirmado",
    situacao: charge?.situacao ?? "novo",
    total_centavos: charge?.total_centavos ?? total,
    ...(checkout && { checkout }),
  });
  if (body.acao === "inscricao-status" || !active || !eligible || charge?.aprovado_em) return response();
  const token = await sellerToken(connection, org);
  const headers = { Authorization: "Bearer " + token };
  if (charge?.preferencia_id) {
    await reconcile(charge, headers, body.pagamento);
    [charge] = await database(chargeTable + filter);
    if (charge?.total_centavos !== total && !charge?.aprovado_em) {
      await closePreference(charge.preferencia_id, headers);
      return json({ erro: "O valor da edição mudou. Peça à organização para conferir a cobrança antes de pagar." }, 409);
    }
    return response(body.acao === "inscricao-checkout" && ["novo", "recusado", "cancelado"].includes(charge?.situacao)
      ? checkoutUrl(charge.checkout_url) : undefined);
  }
  if (body.acao !== "inscricao-checkout") return response();
  if (!await isOrdersTestSeller(token, connection.vendedor_id)) {
    return json({ erro: "Reconecte uma conta de vendedor de teste para emitir o checkout." }, 409);
  }
  if (!charge && legacy?.preferencia_id) {
    if (legacy.vendedor_id !== connection.vendedor_id || !preferenceId.test(legacy.preferencia_id)) {
      return json({ erro: "A cobrança anterior precisa ser revisada antes de abrir outro checkout." }, 409);
    }
    const query = new URLSearchParams({ external_reference: legacy.referencia, limit: "50" });
    await closePreference(legacy.preferencia_id, headers);
    const previous = await requestJson(mercadoPago + "/v1/payments/search?" + query, { headers });
    if (!Array.isArray(previous?.results) || previous.results.some((payment: any) =>
      !["rejected", "cancelled", "refunded", "charged_back"].includes(payment.status))) {
      return json({ erro: "A cobrança anterior precisa ser revisada antes de abrir outro checkout." }, 409);
    }
  }
  let created = false;
  if (!charge) {
    [charge] = await database(chargeTable + "?on_conflict=inscricao_id", {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({ inscricao_id: id, organizacao_id: org, vendedor_id: connection.vendedor_id, total_centavos: total }),
    });
    if (!charge) return json({ erro: "O checkout está sendo preparado. Consulte novamente em instantes." }, 409);
    created = true;
  }
  if (charge.total_centavos !== total) return json({ erro: "O valor da inscrição mudou e precisa de revisão." }, 409);
  const attemptFilter = filter + "&referencia=eq." + charge.referencia + "&preferencia_id=is.null";
  let preference;
  if (created) {
    const returnUrl = app + "?" + new URLSearchParams({ abrir: "ed", id: ins.edicao_id, "mp-inscricao": "1" });
    const notificationUrl = webhookUrl + "?" + new URLSearchParams({ ref: charge.referencia, source_news: "webhooks" });
    try {
      preference = await requestJson(mercadoPago + "/checkout/preferences", {
        method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Idempotency-Key": charge.referencia },
        body: JSON.stringify({
          external_reference: charge.referencia, notification_url: notificationUrl,
          items: [{ id, title: "Inscrição de teste no Cola Nessa", quantity: 1, currency_id: "BRL", unit_price: total / 100 }],
          back_urls: { success: returnUrl, pending: returnUrl, failure: returnUrl }, auto_return: "approved",
        }),
      });
    } catch (error) {
      if (error instanceof RequestError && [400, 401, 403, 422].includes(error.status)) {
        await database(chargeTable + attemptFilter, { method: "DELETE" });
      }
      throw error;
    }
  } else {
    preference = await recoverPreference(charge.referencia, headers);
    if (!preference) return json({ erro: "Checkout em confirmação. Consulte novamente antes de tentar pagar." }, 409);
  }
  const item = preference?.items?.[0];
  if (!preferenceId.test(preference?.id ?? "") || preference.external_reference !== charge.referencia ||
    String(preference.collector_id) !== charge.vendedor_id || Number(preference.marketplace_fee ?? 0) !== 0 ||
    preference.items.length !== 1 || item?.id !== id || item.currency_id !== "BRL" ||
    item.quantity !== 1 || Math.round(Number(item.unit_price) * 100) !== total) {
    return json({ erro: "O Mercado Pago retornou uma preferência diferente da inscrição." }, 502);
  }
  const checkout = checkoutUrl(preference.init_point);
  await database(chargeTable + attemptFilter, {
    method: "PATCH", body: JSON.stringify({ preferencia_id: preference.id, checkout_url: checkout }),
  });
  return response(checkout);
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
  if (["inscricao-status", "inscricao-checkout", "inscricao-consultar"].includes(body?.acao)) {
    return inscriptionCheckout(user.id, body);
  }
  const org = body?.organizacao;
  if (typeof org !== "string" || !uuid.test(org) || !["status", "conectar"].includes(body.acao)) {
    return json({ erro: "Dados do teste inválidos." }, 400);
  }
  if (!await canConnect(user.id, org)) return json({ erro: "Disponível à proprietária da organização ativa." }, 403);
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

  const [row] = await database(connections + filter + "&select=vendedor_id,expira_em,token_cifrado");
  const active = activeConnection(row);
  return json({ conectada: active, vendedor: active ? row.vendedor_id : null });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  if (url.pathname.endsWith("/pagamentos")) {
    try {
      return await paymentWebhook(req, url);
    } catch (error) {
      console.warn("Falha ao reconciliar webhook do Mercado Pago", { status: error instanceof RequestError ? error.status : null });
      return new Response(null, { status: 503 });
    }
  }
  if (req.method === "GET") {
    try { return await receive(new URL(req.url)); } catch { return back("erro"); }
  }
  if (req.method !== "POST") return json({ erro: "Método inválido." }, 405);
  try { return await operate(req); } catch (error) {
    const status = error instanceof RequestError ? error.status : undefined;
    return json({ erro: "Não foi possível acessar o Mercado Pago de teste.", ...(status && { codigo: status }) }, 502);
  }
});
