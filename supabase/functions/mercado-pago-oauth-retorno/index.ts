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

async function testSplit(row: any, org: string, controle: boolean, direta: boolean) {
  const token = direta
    ? Deno.env.get("MERCADO_PAGO_TEST_ACCESS_TOKEN")
    : await decryptToken(row.token_cifrado.slice("orders:".length), org);
  if (direta && (!token || row.vendedor_id !== "3870233502")) {
    return json({ erro: "Credencial direta indisponível para comparar com este vendedor de teste." }, 409);
  }
  if (!await isOrdersTestSeller(token, row.vendedor_id)) {
    return json({ erro: "O Mercado Pago não confirmou esta conta como vendedor de teste." }, 409);
  }
  const headers = { Authorization: "Bearer " + token };
  const idColumn = direta ? "direta_order_id" : controle ? "controle_preferencia_id" : "order_id";
  const urlColumn = direta ? "direta_checkout_url" : controle ? "controle_checkout_url" : "checkout_url";
  const id = row[idColumn];
  const semComissao = controle || direta;
  const suffix = direta ? "-dir" : controle ? "-ctrl" : "";
  const key = row.tentativa + suffix;
  const ref = "colanessa-split-teste-" + key;
  const returnUrls = {
    success_url: app + "?mp-conexao=pedido-aprovado",
    failure_url: app + "?mp-conexao=pedido-rejeitado",
    pending_url: app + "?mp-conexao=pedido-pendente",
    auto_return: "approved",
  };
  const order = id
    ? await requestJson(mercadoPago + "/v1/orders/" + id, { headers })
    : await requestJson(mercadoPago + "/v1/orders", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Idempotency-Key": key },
      body: JSON.stringify({
        type: "online", processing_mode: "manual", total_amount: "10.00",
        ...(semComissao ? {} : { marketplace_fee: "1.00" }),
        external_reference: ref, items: [{ title: "Teste de divisão Cola Nessa", quantity: 1, unit_price: "10.00" }],
        config: { online: returnUrls },
      }),
    });
  if (!sandboxOrder.test(order?.id ?? "") || order.external_reference !== ref ||
      (id && order.id !== id) || Number(order.total_amount) !== 10 ||
      (semComissao && Number(order.marketplace_fee ?? 0) !== 0)) {
    console.warn("Mercado Pago test order validation failed", {
      sandbox: sandboxOrder.test(order?.id ?? ""), referenceMatches: order?.external_reference === ref,
      amountMatches: Number(order?.total_amount) === 10,
    });
    return json({ erro: "O Mercado Pago devolveu uma cobrança que o Cola Nessa não conseguiu confirmar como teste." }, 502);
  }
  const checkout = checkoutUrl(row[urlColumn] ?? order.checkout_url);
  if (!id) {
    console.info("Retorno da cobrança Orders de teste", {
      controle, direta, confirmado: Object.entries(returnUrls).every(([key, value]) => order.config?.online?.[key] === value),
    });
    const [saved] = await database(connections + "?organizacao_id=eq." + org +
      "&tentativa=eq." + row.tentativa + "&" + idColumn + "=is.null", {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ [idColumn]: order.id, [urlColumn]: checkout }),
    });
    if (!saved) return json({ erro: "A cobrança de teste mudou. Consulta de novo no painel." }, 409);
  }
  const code = (value: unknown) => typeof value === "string" && /^[a-z0-9_]{1,80}$/i.test(value) ? value : undefined;
  const payments = Array.isArray(order.transactions?.payments) ? order.transactions.payments : [];
  const details = [...new Set([
    code(order.status), code(order.status_detail),
    ...payments.slice(-5).flatMap((p: any) => [code(p?.status), code(p?.status_detail)]),
  ].filter(Boolean))];
  const paid = Number(order.total_paid_amount) === 10;
  if (id) {
    const applicationId = String(order.integration_data?.application_id ?? "");
    const sponsorId = String(order.integration_data?.sponsor?.id ?? "");
    console.info("Consulta de Orders de teste", {
      order_id: order.id, controle, direta, status: details, pagamentos: payments.length, pago: paid,
      marketplace_fee: Number(order.marketplace_fee ?? 0),
      aplicacao: /^[0-9]{1,30}$/.test(applicationId) ? applicationId : null,
      mesma_aplicacao_oauth: applicationId ? applicationId === clientId : null,
      patrocinador: /^[0-9]{1,30}$/.test(sponsorId) ? sponsorId : null,
    });
    if (["failed", "rejected", "expired", "canceled", "cancelled"].includes(order.status)) {
      return json({ erro: "Mercado Pago: " + details.join(" · ") }, 409);
    }
  }
  return json({ checkout, id: order.id, status: order.status, pago: paid });
}

const feiraA = "efbef4e2-687c-4d21-9dd6-502fc377bd71";
const feiraB = "58bcfaa0-2945-4929-b18b-c33e02761476";
const preferenceId = /^[0-9]+-[a-z0-9-]+$/i;

async function testPreference(row: any, org: string, controle: boolean) {
  const token = await decryptToken(row.token_cifrado.slice("orders:".length), org);
  if (!await isOrdersTestSeller(token, row.vendedor_id)) {
    return json({ erro: "O Mercado Pago não confirmou esta conta como vendedor de teste." }, 409);
  }
  const headers = { Authorization: "Bearer " + token };
  const idColumn = controle ? "controle_preferencia_id" : "order_id";
  const urlColumn = controle ? "controle_checkout_url" : "checkout_url";
  const id = row[idColumn];
  const fee = controle ? 0 : 1;
  const key = controle ? row.tentativa + "-controle" : row.tentativa;
  const ref = "colanessa-split-preference-teste-" + key;
  if (preferenceId.test(id ?? "")) {
    const search = new URLSearchParams({ external_reference: ref, limit: "30" });
    const result = await requestJson(mercadoPago + "/v1/payments/search?" + search, { headers });
    const matches = (Array.isArray(result?.results) ? result.results : []).filter((payment: any) =>
      payment.external_reference === ref && String(payment.collector_id) === row.vendedor_id &&
      payment.currency_id === "BRL" && Number(payment.transaction_amount) === 10 && payment.live_mode === false
    );
    const approved = matches.some((payment: any) => payment.status === "approved");
    if (!matches.length) {
      const ordersQuery = new URLSearchParams({ preference_id: id });
      try {
        const orders = await requestJson(mercadoPago + "/merchant_orders/search?" + ordersQuery, { headers });
        const list = Array.isArray(orders?.elements) ? orders.elements : [];
        console.info("Pedidos do Checkout Pro de teste", {
          controle, orders: list.length,
          payments: list.reduce((count: number, order: any) =>
            count + (Array.isArray(order?.payments) ? order.payments.length : 0), 0),
        });
      } catch (error) {
        console.info("Consulta de pedidos do Checkout Pro indisponível", {
          status: error instanceof OrderError ? error.status : undefined,
        });
      }
    }
    const status = matches[0]?.status;
    const detail = matches[0]?.status_detail;
    console.info("Consulta do split Checkout Pro de teste", {
      returned: Array.isArray(result?.results) ? result.results.length : 0,
      matched: matches.length,
      controle, approved, status, detail,
    });
    return json({ checkout: checkoutUrl(row[urlColumn]), id, status, pago: approved });
  }

  const returnPage = app + "?mp-conexao=conectada";
  const preference = await requestJson(mercadoPago + "/checkout/preferences", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", "X-Idempotency-Key": key },
    body: JSON.stringify({
      external_reference: ref,
      ...(controle ? {} : { marketplace_fee: fee }),
      items: [{ title: "Teste de divisão Cola Nessa", quantity: 1, currency_id: "BRL", unit_price: 10 }],
      back_urls: { success: returnPage, pending: returnPage, failure: returnPage },
      auto_return: "approved",
    }),
  });
  if (!preferenceId.test(preference?.id ?? "") || preference.external_reference !== ref ||
      String(preference.collector_id) !== row.vendedor_id || Number(preference.marketplace_fee ?? 0) !== fee) {
    return json({ erro: "O Mercado Pago não confirmou a preferência de teste com a comissão esperada." }, 502);
  }
  const checkout = checkoutUrl(preference.init_point);
  const previous = id ? "eq." + id : "is.null";
  const [saved] = await database(connections + "?organizacao_id=eq." + org +
    "&tentativa=eq." + row.tentativa + "&" + idColumn + "=" + previous, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ [idColumn]: preference.id, [urlColumn]: checkout }),
  });
  if (!saved) return json({ erro: "A cobrança de teste mudou. Consulta de novo no painel." }, 409);
  return json({ checkout, id: preference.id, status: "created", pago: false });
}


const planTable = "/rest/v1/mp_planos_teste";
const chargeTable = "/rest/v1/mp_inscricoes_checkout_teste";
const plans = ["avulso", "gestao", "essencial", "pro"];
function quote(base: number, plan: string, exempt: boolean, pass: boolean) {
  const fee = plan === "avulso" && !exempt ? Math.min(500, Math.round(base * 3 / 100)) : 0;
  return { base_centavos: base, comissao_centavos: fee, total_centavos: base + (pass ? fee : 0) };
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
  const filter = "?inscricao_id=eq." + id;
  const [[plan], [connection], [charge], [organization]] = await Promise.all([
    database(planTable + "?organizacao_id=eq." + org),
    database(connections + "?organizacao_id=eq." + org),
    database(chargeTable + filter),
    database("/rest/v1/organizacoes?select=id&id=eq." + org + "&status=eq.ativa"),
  ]);
  const price = ins.valor_combinado ?? (ins.dia_unico && edition.preco_dia != null
    ? edition.preco_dia : ({ unico: edition.preco_unico, "2m": edition.preco_2m, "3m": edition.preco_3m } as Record<string, unknown>)[ins.tamanho]);
  const base = Math.round(Number(price) * 100);
  const eligible = !!organization && ins.status === "confirmada" && !ins.isento && !ins.pago && !ins.pago_sinal &&
    !(Number(ins.valor_pago) > 0) && !(Number(ins.credito_usado) > 0) && !ins.tem_comprovante &&
    !edition.gratuita && !edition.cancelada_em && Number.isSafeInteger(base) && base > 0 && base <= 2147483000;
  const active = !!connection?.token_cifrado?.startsWith("orders:") && Date.parse(connection.expira_em) > Date.now();
  const available = eligible && active && !!plan && plan.plano !== "gestao";
  const values = charge ?? (available ? quote(base, plan.plano, plan.primeira_edicao_id === ins.edicao_id, plan.repassar) : null);
  const response = (row: any, checkout?: string) => json({
    disponivel: available || !!row?.preferencia_id, aprovado: !!row?.aprovado_em,
    ...(values && { base_centavos: values.base_centavos, total_centavos: values.total_centavos }),
    ...(checkout && { checkout }),
  });
  if (body.acao === "inscricao-status") return response(charge);
  if (charge?.aprovado_em) return response(charge);
  if (!active || !organization || (charge && charge.vendedor_id !== connection.vendedor_id)) {
    return json({ erro: "A conexão do vendedor de teste está indisponível." }, 409);
  }
  const token = await decryptToken(connection.token_cifrado.slice("orders:".length), org);
  if (!token.startsWith("APP_USR-") || !await isOrdersTestSeller(token, connection.vendedor_id)) return json({ erro: "Reconecte o vendedor de teste para emitir a credencial usada pelo Checkout Pro." }, 409);
  const headers = { Authorization: "Bearer " + token };
  if (charge?.preferencia_id) {
    const query = new URLSearchParams({ external_reference: charge.referencia, limit: "50" });
    const payments = await requestJson(mercadoPago + "/v1/payments/search?" + query, { headers });
    const payment = Array.isArray(payments?.results) && payments.results.find((entry: any) =>
      entry.live_mode === false && entry.status === "approved" && entry.currency_id === "BRL" &&
      entry.external_reference === charge.referencia && String(entry.collector_id) === charge.vendedor_id &&
      Math.round(Number(entry.transaction_amount) * 100) === charge.total_centavos && /^[0-9]+$/.test(String(entry.id)));
    if (payment) {
      await database(chargeTable + filter + "&aprovado_em=is.null", {
        method: "PATCH", body: JSON.stringify({ pagamento_id: String(payment.id), aprovado_em: new Date().toISOString() }),
      });
      return response({ ...charge, aprovado_em: true });
    }
    return response(charge, eligible ? checkoutUrl(charge.checkout_url) : undefined);
  }
  if (!available) return json({ erro: "O checkout não está disponível para esta inscrição." }, 409);
  if (charge) return json({ erro: "Já existe uma tentativa em processamento para esta inscrição." }, 409);
  const [created] = await database(chargeTable + "?on_conflict=inscricao_id", {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ inscricao_id: id, organizacao_id: org, plano: plan.plano, vendedor_id: connection.vendedor_id, ...values }),
  });
  if (!created) return json({ erro: "Já existe uma tentativa em processamento para esta inscrição." }, 409);
  const paymentRef = filter + "&referencia=eq." + created.referencia;
  const upstream = await fetch(mercadoPago + "/checkout/preferences", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, signal: AbortSignal.timeout(12000),
    body: JSON.stringify({
      external_reference: created.referencia,
      items: [{ id, title: "Inscrição de teste Colanessa", quantity: 1, currency_id: "BRL", unit_price: created.total_centavos / 100 }],
      ...(created.comissao_centavos > 0 ? { marketplace_fee: created.comissao_centavos / 100 } : {}),
      back_urls: { success: app, pending: app, failure: app },
    }),
  });
  if (!upstream.ok) {
    if ([400, 401, 403, 422].includes(upstream.status)) await database(chargeTable + paymentRef, { method: "DELETE" });
    return json({ erro: "Mercado Pago recusou a preferência de teste (HTTP " + upstream.status + ")." }, 502);
  }
  const preference = await upstream.json();
  if (!preferenceId.test(preference.id ?? "") || preference.external_reference !== created.referencia ||
      String(preference.collector_id) !== created.vendedor_id ||
      Math.round(Number(preference.marketplace_fee ?? 0) * 100) !== created.comissao_centavos) {
    return json({ erro: "A preferência retornada não corresponde à cobrança de teste." }, 502);
  }
  const checkout = checkoutUrl(preference.init_point);
  await database(chargeTable + paymentRef, {
    method: "PATCH", body: JSON.stringify({ preferencia_id: preference.id, checkout_url: checkout }),
  });
  return response({ ...created, preferencia_id: preference.id }, checkout);
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
  if (body?.acao === "inscricao-status" || body?.acao === "inscricao-checkout") return inscriptionCheckout(user.id, body);
  const org = body?.organizacao;
  if (typeof org !== "string" || !uuid.test(org) || !["status", "conectar", "cobranca", "cobranca-sem-comissao", "cobranca-direta", "plano"].includes(body.acao)) {
    return json({ erro: "Dados do teste inválidos." }, 400);
  }
  if (!await canConnect(user.id, org)) return json({ erro: "Disponível à proprietária da organização ativa." }, 403);
  if (!clientId || !clientSecret) return json({ erro: "Client ID ou Client Secret ainda ausente no Supabase." }, 503);
  if (body.acao === "plano") {
    if (!plans.includes(body.plano) || (body.primeira && (typeof body.primeira !== "string" || !uuid.test(body.primeira)))) {
      return json({ erro: "Configuração de teste inválida." }, 400);
    }
    if (body.primeira) {
      const [edition] = await database("/rest/v1/edicoes?select=id&id=eq." + body.primeira + "&organizacao_id=eq." + org, {
        headers: { apikey: anon, Authorization: authorization },
      });
      if (!edition) return json({ erro: "A edição não pertence à organização." }, 400);
    }
    await database(planTable + "?on_conflict=organizacao_id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ organizacao_id: org, plano: body.plano, repassar: body.repassar === true, primeira_edicao_id: body.primeira || null }),
    });
    return json({ salvo: true });
  }
  if (["cobranca", "cobranca-sem-comissao", "cobranca-direta"].includes(body.acao)) {
    const [profile] = await database("/rest/v1/perfis?select=eh_admin&id=eq." + user.id);
    if (profile?.eh_admin !== true) return json({ erro: "Teste legado restrito à administração da plataforma." }, 403);
  }
  const controle = body.acao === "cobranca-sem-comissao";
  const controleDisponivel = org === feiraA || org === feiraB;
  const direta = body.acao === "cobranca-direta";
  if (direta && org !== feiraB) return json({ erro: "Teste com credencial direta disponível na Feira B." }, 403);
  if (controle && !controleDisponivel) return json({ erro: "Teste sem comissão disponível nas feiras A e B." }, 403);
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

  const fields = body.acao === "status" ? "&select=vendedor_id,expira_em,order_id,token_cifrado,controle_preferencia_id,direta_order_id" : "";
  const [row] = await database(connections + filter + fields);
  const active = row?.token_cifrado?.startsWith("orders:") && Date.parse(row.expira_em) > Date.now();
  if (body.acao === "status") {
    return json({
      plano_teste: (await database(planTable + filter))[0] ?? null,
      conectada: !!active,
      vendedor: active ? row.vendedor_id : null,
      order_id: active && (org !== feiraA || preferenceId.test(row.order_id ?? "")) ? row.order_id : null,
      controle_disponivel: !!active && controleDisponivel,
      direta_disponivel: !!active && org === feiraB && row.vendedor_id === "3870233502",
      direta_criada: !!active && org === feiraB && sandboxOrder.test(row.direta_order_id ?? ""),
      controle_criado: !!active && controleDisponivel &&
        (org === feiraA ? preferenceId : sandboxOrder).test(row.controle_preferencia_id ?? ""),
    });
  }
  if (!active) return json({ erro: "Conecta uma conta de vendedor de teste primeiro." }, 409);
  return org === feiraA ? testPreference(row, org, controle) : testSplit(row, org, controle, direta);
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
